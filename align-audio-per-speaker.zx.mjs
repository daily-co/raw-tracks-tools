#!/usr/bin/env zx
import 'zx/globals';
import { fileURLToPath } from 'node:url';

import { parseEventJson } from './src/parse-events.js';
import { runFfmpegCommandAsync } from './src/ffexec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  2. Pick a shared length: the end of the last-ending audio track across everyone.
  3. For each participant, delay each of their audio files to its offset, mix the
     fragments onto one timeline, and pad to the shared length. The filter mirrors what
     render-track.js uses for the composite path (aresample=async=1 then adelay), so a
     WebRTC opus start timestamp does not throw the alignment off.

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

const outDir = argv['out'] ?? argv['o']
  ? path.resolve(argv['out'] ?? argv['o'])
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

/** Duration in seconds from the file's own header, or NaN if the container lacks one
 *  (default raw-tracks .webm has no duration header; gapless WAV always does). */
async function probeDurationSecs(filePath) {
  const res = await $({ quiet: true, nothrow: true })`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${filePath}`;
  return parseFloat(res.stdout.trim());
}

// Group audio tracks per speaker, keyed by user_id when set. A reconnect (leave + rejoin)
// reuses the same app-set user_id but gets a NEW participant_id, so grouping by user_id is
// what merges those two files back into one speaker. Fall back to participant_id when no
// user_id was set (e.g. a call with no meeting tokens).
const groups = new Map(); // key -> { name, tracks: [] }
for (const track of timeline.tracks.values()) {
  if (track.kind !== 'audio' || !track.filename) continue;
  const key = track.userId || track.participantId;
  if (!groups.has(key)) {
    groups.set(key, {
      name: track.userId || track.displayName || track.participantId,
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
    files.push({ path: filePath, offsetSecs });

    // Track end on the session timeline. Prefer the file's real duration (exact for WAV);
    // fall back to event-derived end when the container has no duration header.
    const dur = await probeDurationSecs(filePath);
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

// --- Step 3: Shared length = the end of the last-ending audio track across everyone ---
const targetSecs = Math.max(...speakers.map((s) => s.latestEnd));
echo`\nShared length: ${targetSecs.toFixed(3)}s across ${speakers.length} speaker(s)`;

// --- Step 4: Align each speaker ---
fs.mkdirpSync(outDir);

/** Make a participant name safe for a filename, and keep it unique across speakers. */
const usedNames = new Set();
function outNameFor(speaker) {
  let base = speaker.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!base) base = speaker.key;
  let name = base;
  if (usedNames.has(name)) name = `${base}_${speaker.key.slice(0, 8)}`;
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
    chains.push(`[${i}]aresample=async=1,adelay=${Math.floor(f.offsetSecs * 1000)}:all=1[a${i}]`);
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
