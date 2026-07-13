#!/usr/bin/env zx
import 'zx/globals';

import { parseEventJson } from './src/parse-events.js';
import { runFfmpegCommandAsync } from './src/ffexec.js';
import { probeTrack } from './src/probe-track.js';
import { normalizeVideoTrackToM4V } from './src/render-track.js';
import { buildVideoAnalysis } from './src/video-analysis.js';

/*
  Per-speaker track alignment.

  Unlike composite-from-events (which renders one composited MP4), this produces
  equal-length, front-aligned files per participant, all lined up on the same session
  timeline: one WAV per speaker, plus one silent MP4 per speaker with video (and a
  separate one for a screen share). That is what you want when you need clean, separate
  tracks per speaker: drop every file at time 0 in a multitrack editor, a transcription
  pipeline, or diarization, and everything lines up.

  How it works:

  1. Parse the event JSON -> RecordingTimeline. That gives each track's startOffsetSecs
     (where it begins on the session timeline) and the tracks grouped per participant.
     A reconnect splits a participant into more than one track; those are handled too.
  2. Pick a shared length: MAX(startOffset + duration) across ALL tracks. Durations come
     from each file's own header, or from a packet scan for headerless containers
     (default raw-tracks .webm).
  3. Audio: for each participant, delay each of their audio files to its offset, mix the
     fragments onto one timeline, and pad to the shared length. The filter mirrors what
     render-track.js uses for the composite path (aresample=async=1 then adelay), so a
     WebRTC opus start timestamp does not throw the alignment off.
  4. Video: for each participant, render one full-length file per track type (cam and
     screen share separately, since they overlap in time). Black is rendered wherever the
     speaker has no video: before join, during pauses, after leave, and between reconnect
     fragments. This reuses normalizeVideoTrackToM4V, the same battle-tested path
     composite-from-events uses, so webm quirks (resolution ramp-up, PTS offset,
     colorspace) are handled. Note this is a full re-encode; pass --no-video to skip it.

  Audio output is 48 kHz mono pcm_s16le, which matches Daily's gapless transcoded audio
  (enable_raw_tracks_transcoded_audio: wav-48k-mono). Gapless WAV is the best audio input:
  it is lossless and already gap-filled, so the align step is a pure delay-and-pad.
  Video output is H.264 MP4 at each speaker's max recorded resolution, 30 fps (--fps to
  override), silent (the aligned audio lives in the WAV next to it).

  Usage:
    npm run align-per-speaker -- --input /path/to/recording.event.json
    npm run align-per-speaker -- -i events.json --out ./aligned --no-video

  Requirements: Node 18+, ffmpeg + ffprobe in PATH. No VCS SDK needed.
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
  : path.resolve(eventJsonDir, 'per-speaker-tracks');

// --no-video (minimist turns it into argv.video === false)
const videoEnabled = argv['video'] !== false;

const fps = argv['fps'] ? parseFloat(argv['fps']) : 30;
if (!Number.isFinite(fps) || fps < 1) {
  echo`Invalid fps: ${argv['fps']}`;
  process.exit(1);
}

// --- Step 1: Parse event JSON ---
echo`\n--- Parsing event JSON ---`;
const timeline = parseEventJson(eventJson);
echo`Recording start: ${timeline.recordingStartTs} (${new Date(timeline.recordingStartTs).toISOString()})`;
echo`Session duration: ${timeline.sessionDurationSecs.toFixed(1)}s`;
echo`Tracks: ${timeline.tracks.size}, Participants: ${timeline.participants.size}`;

// --- Step 2: Group every track per speaker and resolve files on disk ---

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
 *  the packets: duration = last packet end - first packet start. Raw-tracks webm PTS is
 *  absolute (starts near the track's session offset), so the first packet's time must be
 *  subtracted. Slower (reads the whole file, but no decode), and it gives the real media
 *  duration instead of an event-derived guess. Results are cached per path. */
const durationCache = new Map();
async function probeDurationSecs(filePath) {
  if (durationCache.has(filePath)) return durationCache.get(filePath);

  let dur = NaN;
  const res = await $({ quiet: true, nothrow: true })`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${filePath}`;
  const headerDur = parseFloat(res.stdout.trim());
  if (Number.isFinite(headerDur)) {
    dur = headerDur;
  } else {
    const pkts = await $({ quiet: true, nothrow: true })`ffprobe -v error -select_streams 0 -show_entries packet=pts_time,duration_time -of csv=p=0 ${filePath}`;
    const lines = pkts.stdout.trim().split('\n');
    const [firstPts] = (lines[0] ?? '').split(',').map(parseFloat);
    const [lastPts, lastDur] = (lines[lines.length - 1] ?? '').split(',').map(parseFloat);
    if (Number.isFinite(firstPts) && Number.isFinite(lastPts)) {
      dur = lastPts + (Number.isFinite(lastDur) ? lastDur : 0) - firstPts;
    }
  }
  durationCache.set(filePath, dur);
  return dur;
}

// Group tracks per speaker. A reconnect (leave + rejoin) reuses the same app-set
// identity but gets a NEW participant_id, so grouping by that identity is what merges the
// fragments back into one speaker. Prefer user_id, then user_name, then participant_id.
// (user_name is not guaranteed unique, so two different people sharing a name would merge;
// it is only a fallback for when user_id was not set on the token.)
const speakerKey = (track) => track.userId || track.userName || track.participantId;
// The name is only a human-readable label for output filenames and logs; it is never used
// as identity (that is speakerKey's job), so displayName is fine as a fallback here.
const speakerName = (track) => track.userName || track.displayName || speakerKey(track);

const isScreenTrack = (track) => /screen/i.test(track.trackType ?? '');

const groups = new Map(); // key -> { name, audio: [], cam: [], screen: [] }
for (const track of timeline.tracks.values()) {
  if (!track.filename) continue;
  const key = speakerKey(track);
  if (!groups.has(key)) {
    groups.set(key, { name: speakerName(track), audio: [], cam: [], screen: [] });
  }
  const group = groups.get(key);
  if (track.kind === 'audio') {
    group.audio.push(track);
  } else if (track.kind === 'video') {
    (isScreenTrack(track) ? group.screen : group.cam).push(track);
  }
}

// Resolve every group's files, earliest fragment first, so a reconnect's files land in
// time order. Fragments carry { track, filePath, offsetSecs, durSecs, endSecs }.
async function resolveFragments(groupName, tracks, label) {
  tracks.sort((a, b) => (a.startOffsetSecs ?? 0) - (b.startOffsetSecs ?? 0));
  const fragments = [];
  for (const track of tracks) {
    const filePath = resolveTrackFile(track.filename);
    if (!filePath) {
      echo`  ! ${groupName}: missing ${label} file "${track.filename}" in ${eventJsonDir} (skipping this track)`;
      continue;
    }
    const offsetSecs = Math.max(0, track.startOffsetSecs ?? 0);

    // Track end on the session timeline. Prefer the file's real duration (exact for WAV);
    // fall back to event-derived end when the probe fails.
    const dur = await probeDurationSecs(filePath);
    const endSecs = Number.isFinite(dur)
      ? offsetSecs + dur
      : (track.removedAtSecs ?? timeline.sessionDurationSecs);
    fragments.push({
      track,
      filePath,
      offsetSecs,
      durSecs: Number.isFinite(dur) ? dur : null,
      endSecs,
    });
  }
  return fragments;
}

const speakers = []; // { key, name, audio: [frags], cam: [frags], screen: [frags] }
for (const [key, group] of groups) {
  const speaker = {
    key,
    name: group.name,
    audio: await resolveFragments(group.name, group.audio, 'audio'),
    cam: await resolveFragments(group.name, group.cam, 'video'),
    screen: await resolveFragments(group.name, group.screen, 'screen video'),
  };
  if (speaker.audio.length + speaker.cam.length + speaker.screen.length === 0) continue;
  speakers.push(speaker);
}

if (speakers.length === 0) {
  echo`No participants with resolvable track files were found. Put the track files next to the event JSON.`;
  process.exit(1);
}

// --- Step 3: Shared length = MAX(startOffset + duration) across ALL tracks ---
// Video tracks count too, so every output matches the full session length even when
// video ran past the last audio track (e.g. someone muted their mic but stayed on
// camera to the end).
let targetSecs = 0;
for (const speaker of speakers) {
  for (const frag of [...speaker.audio, ...speaker.cam, ...speaker.screen]) {
    targetSecs = Math.max(targetSecs, frag.endSecs);
  }
}
echo`\nShared length: ${targetSecs.toFixed(3)}s across ${speakers.length} speaker(s)`;

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
  speaker.outName = outNameFor(speaker);
}

// --- Step 4: Align each speaker's audio ---

async function renderSpeakerAudio(speaker) {
  const outFile = path.resolve(outDir, `${speaker.outName}.wav`);

  // Build the filter graph: delay each fragment to its offset, then combine + pad.
  const inputArgs = [];
  const chains = [];
  speaker.audio.forEach((f, i) => {
    inputArgs.push('-i', f.filePath);
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
  const labels = speaker.audio.map((_, i) => `[a${i}]`).join('');
  const combine = speaker.audio.length > 1
    ? `${labels}amix=inputs=${speaker.audio.length}:normalize=0,apad[out]`
    : `[a0]apad[out]`;
  const filter = [...chains, combine].join(';');

  const offsets = speaker.audio.map((f) => `${f.offsetSecs.toFixed(2)}s`).join(', ');
  echo`  ${speaker.name}: ${speaker.audio.length} audio file(s), offsets [${offsets}] -> ${outFile}`;

  await runFfmpegCommandAsync(
    `align_${speaker.outName}`,
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

echo`\n--- Aligning audio ---`;
for (const speaker of speakers) {
  if (speaker.audio.length === 0) continue;
  await renderSpeakerAudio(speaker);
}

// --- Step 5: Align each speaker's video ---

/** Render one full-length, aligned, silent video file from a speaker's (sorted,
 *  non-overlapping) fragments of one track type. Each fragment is normalized to cover
 *  its own slice of the timeline (black before its first frame, during pauses, and
 *  after its content ends); a reconnect concats the slices without re-encoding. */
async function renderSpeakerVideo(speaker, fragments, suffix, tmpPath) {
  const outFile = path.resolve(outDir, `${speaker.outName}${suffix}.mp4`);
  const ctxBase = `vid_${speaker.outName}${suffix}`;

  // Probe fragments for PTS start, max resolution, frame rate.
  for (const frag of fragments) {
    frag.probe = await probeTrack(`probe_${ctxBase}_${frag.track.trackSessionNum}`, frag.filePath);
  }

  // Common output size: the speaker's max recorded resolution, rounded up to even.
  const even = (n) => Math.ceil(n / 2) * 2;
  const videoSize = {
    w: even(Math.max(...fragments.map((f) => f.probe.videoSize?.w ?? 0), 16)),
    h: even(Math.max(...fragments.map((f) => f.probe.videoSize?.h ?? 0), 16)),
  };

  // Slice the timeline between fragments: fragment k covers [sliceStart, sliceEnd) where
  // sliceStart is 0 for the first fragment (black until it joins) and its own offset
  // after that, and sliceEnd is the next fragment's offset (targetSecs for the last).
  const slices = [];
  for (let k = 0; k < fragments.length; k++) {
    const sliceStart = k === 0 ? 0 : fragments[k].offsetSecs;
    const sliceEnd = k < fragments.length - 1 ? fragments[k + 1].offsetSecs : targetSecs;
    if (sliceEnd - sliceStart < 0.05) {
      echo`  ! ${speaker.name}: skipping zero-length video slice at ${sliceStart.toFixed(2)}s`;
      continue;
    }
    slices.push({ frag: fragments[k], sliceStart, sliceEnd });
  }
  if (slices.length === 0) return;

  const offsets = fragments.map((f) => `${f.offsetSecs.toFixed(2)}s`).join(', ');
  echo`  ${speaker.name}: ${fragments.length} video file(s), offsets [${offsets}], ${videoSize.w}x${videoSize.h} -> ${outFile}`;

  const segFiles = [];
  for (const [k, { frag, sliceStart, sliceEnd }] of slices.entries()) {
    const ptsOffset = frag.probe.startTime - frag.track.startOffsetSecs;
    // Real content ends at the earlier of the probed file end and the slice end.
    const contentEndSecs = Math.min(sliceEnd, frag.durSecs != null ? frag.endSecs : sliceEnd);
    const analysis = buildVideoAnalysis(frag.track, frag.probe, {
      outputStartPts: sliceStart + ptsOffset,
      outputEndPts: sliceEnd + ptsOffset,
      trackEndSecs: contentEndSecs,
    });
    analysis.videoSize = videoSize;
    analysis.frameRate = fps;

    const segFile = slices.length === 1
      ? outFile
      : path.resolve(tmpPath, `${ctxBase}_slice${k}.mp4`);
    if (segFile !== outFile) segFiles.push(segFile);

    // gopSizeFrames = 1s GOP: bounds how far a mid-file stream-copy cut (after a pause)
    // can snap to a keyframe, and keeps each slice's real duration close to its intended
    // length so a reconnect's later fragments do not drift on the concat'd timeline.
    await normalizeVideoTrackToM4V(`${ctxBase}_${k}`, analysis, frag.filePath, segFile, {
      quiet: true,
      gopSizeFrames: fps,
    });

    if (slices.length > 1) {
      const intendedSecs = sliceEnd - sliceStart;
      const actualSecs = await probeDurationSecs(segFile);
      durationCache.delete(segFile); // temp file; do not pollute the cache
      if (Number.isFinite(actualSecs) && Math.abs(actualSecs - intendedSecs) > 1.5 / fps) {
        echo`  ! ${speaker.name}: slice ${k} is ${actualSecs.toFixed(3)}s, expected ${intendedSecs.toFixed(3)}s; later fragments may shift by the difference`;
      }
    }
  }

  if (segFiles.length > 0) {
    // Concat the slices without re-encoding. All slices share encoder, size, and fps, so
    // stream copy is safe. The list uses paths relative to itself (concat's default).
    const listPath = path.resolve(tmpPath, `${ctxBase}_concat.txt`);
    fs.writeFileSync(
      listPath,
      segFiles.map((f) => `file '${path.basename(f)}'\n`).join(''),
      'utf-8'
    );
    await runFfmpegCommandAsync(
      `concat_${ctxBase}`,
      ['-f', 'concat', '-i', listPath, '-c', 'copy', '-t', targetSecs.toFixed(3), outFile],
      { quiet: true }
    );
    for (const f of segFiles) fs.rmSync(f, { force: true });
    fs.rmSync(listPath, { force: true });
  }
}

if (videoEnabled) {
  const videoJobs = [];
  for (const speaker of speakers) {
    if (speaker.cam.length > 0) videoJobs.push({ speaker, fragments: speaker.cam, suffix: '' });
    if (speaker.screen.length > 0) videoJobs.push({ speaker, fragments: speaker.screen, suffix: '_screen' });
  }

  if (videoJobs.length > 0) {
    echo`\n--- Aligning video (${videoJobs.length} file(s), this re-encodes; use --no-video to skip) ---`;
    const tmpPath = tmpdir(`align-per-speaker_${timeline.recordingStartTs}`);

    // Up to 4 concurrent renders, same as composite-from-events.
    const VIDEO_CONCURRENCY = 4;
    let jobIdx = 0;
    async function videoWorker() {
      while (jobIdx < videoJobs.length) {
        const { speaker, fragments, suffix } = videoJobs[jobIdx++];
        await renderSpeakerVideo(speaker, fragments, suffix, tmpPath);
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(VIDEO_CONCURRENCY, videoJobs.length); i++) {
      workers.push(videoWorker());
    }
    await Promise.all(workers);

    fs.emptyDirSync(tmpPath);
  }
}

echo`\n------\nDone. Equal-length, front-aligned per-speaker tracks in:\n${outDir}`;
process.exit(0);
