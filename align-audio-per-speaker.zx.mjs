#!/usr/bin/env zx
import 'zx/globals';

import { parseEventJson } from './src/parse-events.js';
import { runFfmpegCommandAsync } from './src/ffexec.js';

/*
  Per-speaker audio alignment.

  Unlike composite-from-events (which renders one composited MP4), this produces one
  equal-length, front-aligned WAV per participant, all lined up on the same session
  timeline. That is what you want when you need clean, separate tracks per speaker: one
  file per person for an editor, a transcription pipeline, or diarization.

  How it works:

  1. Parse the event JSON -> RecordingTimeline. That gives each track's startOffsetSecs
     (where it begins on the session timeline) and the audio tracks grouped per
     participant. A reconnect splits a participant into more than one audio track; those
     are handled too.
  2. Pick a shared length: MAX(startOffset + duration) across ALL tracks, video included.
     Durations come from each file's own header, or from a packet scan for headerless
     containers (default raw-tracks .webm).
  3. For each participant, delay each of their audio files to its offset, mix the
     fragments onto one timeline, and pad to the shared length. The filter mirrors what
     render-track.js uses for the composite path (aresample=async=1 then adelay), so a
     WebRTC opus start timestamp does not throw the alignment off.

  Why audio only: the target use cases (multitrack editor, transcription, diarization)
  consume audio. Video tracks still contribute to the shared length (step 2), so the WAVs
  line up against a video edit. For rendered video use composite-from-events; to normalize
  a single video track use normalize-track.

  Output is 48 kHz mono pcm_s16le, which matches Daily's gapless transcoded audio
  (enable_raw_tracks_transcoded_audio: wav-48k-mono). Gapless WAV is the best input here:
  it is lossless and already gap-filled, so the align step is a pure delay-and-pad.

  Usage:
    npm run align-audio-per-speaker -- --input /path/to/recording.event.json
    npm run align-audio-per-speaker -- -i events.json --out ./aligned

  Requirements: Node 18+, ffmpeg + ffprobe in PATH. No VCS SDK needed (audio only).
*/

// --- Parse CLI args ---

const eventJsonPath = argv['input'] ?? argv['i'];
if (!eventJsonPath) {
  echo`Must provide --input (or -i) path to event JSON`;
  process.exit(1);
}
if (!fs.existsSync(eventJsonPath)) {
  echo`Event JSON not found: ${eventJsonPath}`;
  process.exit(1);
}
const eventJsonDir = path.dirname(path.resolve(eventJsonPath));
const eventJson = fs.readJSONSync(eventJsonPath);

const outArg = argv['out'] ?? argv['o'];
const outDir = outArg
  ? path.resolve(outArg)
  : path.resolve(eventJsonDir, 'per-speaker-audio');

// --- Step 1: Parse event JSON ---
echo`\n--- Parsing event JSON ---`;
const timeline = parseEventJson(eventJson);
echo`Recording start: ${timeline.recordingStartTs} (${new Date(timeline.recordingStartTs).toISOString()})`;
echo`Session duration: ${timeline.sessionDurationSecs.toFixed(1)}s`;
echo`Tracks: ${timeline.tracks.size}, Participants: ${timeline.participants.size}`;

// --- Step 2: Collect each participant's audio tracks and resolve files on disk ---

/** Resolve a track's filename to a real path. parseEventJson appends an extension from
 *  the content type, but the raw s3 file may have been saved without one, so try both. */
function resolveTrackFile(filename) {
  const withExt = path.resolve(eventJsonDir, filename);
  if (fs.existsSync(withExt)) return withExt;
  const noExt = path.resolve(eventJsonDir, path.basename(filename, path.extname(filename)));
  if (fs.existsSync(noExt)) return noExt;
  return null;
}

/** Duration in seconds. Reads the file's own header first (gapless WAV always has one).
 *  Default raw-tracks .webm has no duration header, so for those we fall back to scanning
 *  the packets and taking the last packet's pts + duration. Slower (reads the whole file,
 *  but no decode), and it gives the real media duration instead of an event-derived guess. */
async function probeDurationSecs(filePath) {
  const res = await $({ quiet: true, nothrow: true })`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${filePath}`;
  const headerDur = parseFloat(res.stdout.trim());
  if (Number.isFinite(headerDur)) return headerDur;

  const pkts = await $({ quiet: true, nothrow: true })`ffprobe -v error -select_streams 0 -show_entries packet=pts_time,duration_time -of csv=p=0 ${filePath}`;
  const lines = pkts.stdout.trim().split('\n');
  const [pts, pktDur] = (lines[lines.length - 1] ?? '').split(',').map(parseFloat);
  if (Number.isFinite(pts)) return pts + (Number.isFinite(pktDur) ? pktDur : 0);
  return NaN;
}

// Group audio tracks per speaker. A reconnect (leave + rejoin) reuses the same app-set
// identity but gets a NEW participant_id, so grouping by that identity is what merges the
// fragments back into one speaker. Prefer user_id, then user_name, then participant_id.
// (user_name is not guaranteed unique, so two different people sharing a name would merge;
// it is only a fallback for when user_id was not set on the token.)
const speakerKey = (track) => track.userId || track.userName || track.participantId;
// The name is only a human-readable label for output filenames and logs; it is never used
// as identity (that is speakerKey's job), so displayName is fine as a fallback here.
const speakerName = (track) => track.userName || track.displayName || speakerKey(track);
const groups = new Map(); // key -> { name, tracks: [] }
for (const track of timeline.tracks.values()) {
  if (track.kind !== 'audio' || !track.filename) continue;
  const key = speakerKey(track);
  if (!groups.has(key)) {
    groups.set(key, {
      name: speakerName(track),
      tracks: [],
    });
  }
  groups.get(key).tracks.push(track);
}

const speakers = []; // { key, name, files: [{ path, offsetSecs }], latestEnd }

for (const [key, group] of groups) {
  // Earliest fragment first, so a reconnect's files mix in time order.
  group.tracks.sort((a, b) => (a.startOffsetSecs ?? 0) - (b.startOffsetSecs ?? 0));

  const files = [];
  let latestEnd = 0;
  for (const track of group.tracks) {
    const filePath = resolveTrackFile(track.filename);
    if (!filePath) {
      echo`  ! ${group.name}: missing audio file "${track.filename}" in ${eventJsonDir} (skipping this track)`;
      continue;
    }

    const offsetSecs = Math.max(0, track.startOffsetSecs ?? 0);

    // Track end on the session timeline. Prefer the file's real duration (exact for WAV);
    // fall back to event-derived end when the container has no duration header.
    const dur = await probeDurationSecs(filePath);
    files.push({ path: filePath, offsetSecs, durSecs: Number.isFinite(dur) ? dur : null });
    const end = Number.isFinite(dur)
      ? offsetSecs + dur
      : (track.removedAtSecs ?? timeline.sessionDurationSecs);
    latestEnd = Math.max(latestEnd, end);
  }

  if (files.length === 0) continue;
  speakers.push({ key, name: group.name, files, latestEnd });
}

if (speakers.length === 0) {
  echo`No participants with resolvable audio files were found. Put the track files next to the event JSON.`;
  process.exit(1);
}

// --- Step 3: Shared length = MAX(startOffset + duration) across ALL tracks ---
// Video tracks count too (even though the output is audio only), so the aligned WAVs
// match the full session length when video ran past the last audio track, e.g. someone
// muted their mic but stayed on camera to the end.
let sessionEnd = Math.max(...speakers.map((s) => s.latestEnd));
for (const track of timeline.tracks.values()) {
  if (track.kind === 'audio' || !track.filename) continue;
  const filePath = resolveTrackFile(track.filename);
  if (!filePath) continue;
  const dur = await probeDurationSecs(filePath);
  const end = Number.isFinite(dur)
    ? Math.max(0, track.startOffsetSecs ?? 0) + dur
    : (track.removedAtSecs ?? 0);
  sessionEnd = Math.max(sessionEnd, end);
}
const targetSecs = sessionEnd;
echo`\nShared length: ${targetSecs.toFixed(3)}s across ${speakers.length} speaker(s)`;

// --- Step 4: Align each speaker ---
fs.mkdirpSync(outDir);

/** Make a participant name safe for a filename, and keep it unique across speakers.
 *  Every candidate (name, key fallback, uniqueness suffix) goes through the same
 *  sanitizer, so an event-supplied value can never smuggle a path separator or ".."
 *  into the output path. */
const usedNames = new Set();
const sanitize = (s) =>
  String(s).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
function outNameFor(speaker) {
  const safeKey = sanitize(speaker.key);
  const base = sanitize(speaker.name) || safeKey || 'speaker';
  let name = base;
  if (usedNames.has(name)) name = `${base}_${safeKey.slice(0, 8)}`;
  let n = 2;
  while (usedNames.has(name)) name = `${base}_${safeKey.slice(0, 8)}_${n++}`;
  usedNames.add(name);
  return name;
}

for (const speaker of speakers) {
  const outName = outNameFor(speaker);
  const outFile = path.resolve(outDir, `${outName}.wav`);

  // Build the filter graph: delay each fragment to its offset, then combine + pad.
  const inputArgs = [];
  const chains = [];
  speaker.files.forEach((f, i) => {
    inputArgs.push('-i', f.path);
    // aresample=async=1 must precede adelay (same quirk render-track.js documents): it
    // normalizes the stream's start timestamp so the offset and the final cut are exact.
    const parts = ['aresample=async=1'];
    // A WebRTC track ends (and sometimes starts) abruptly, so the join with the surrounding
    // silence is a hard step: an audible click and a full-scale spike in the waveform. A
    // short fade in/out at each fragment's edges ramps it to zero instead. 10 ms is below
    // what you can hear on speech.
    const fade = f.durSecs ? Math.min(0.01, f.durSecs / 4) : 0.01;
    parts.push(`afade=t=in:d=${fade}`);
    if (f.durSecs && f.durSecs > 2 * fade) {
      parts.push(`afade=t=out:st=${(f.durSecs - fade).toFixed(4)}:d=${fade}`);
    }
    parts.push(`adelay=${Math.floor(f.offsetSecs * 1000)}:all=1`);
    chains.push(`[${i}]${parts.join(',')}[a${i}]`);
  });
  const labels = speaker.files.map((_, i) => `[a${i}]`).join('');
  const combine = speaker.files.length > 1
    ? `${labels}amix=inputs=${speaker.files.length}:normalize=0,apad[out]`
    : `[a0]apad[out]`;
  const filter = [...chains, combine].join(';');

  const offsets = speaker.files.map((f) => `${f.offsetSecs.toFixed(2)}s`).join(', ');
  echo`  ${speaker.name}: ${speaker.files.length} file(s), offsets [${offsets}] -> ${outFile}`;

  await runFfmpegCommandAsync(
    `align_${outName}`,
    [
      '-hide_banner',
      '-loglevel', 'error',
      ...inputArgs,
      '-filter_complex', filter,
      '-map', '[out]',
      '-t', targetSecs.toFixed(3),
      '-ar', '48000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      outFile,
    ],
    { quiet: true }
  );
}

echo`\n------\nDone. One equal-length, front-aligned WAV per speaker in:\n${outDir}`;
process.exit(0);
