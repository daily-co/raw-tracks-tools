#!/usr/bin/env zx
import 'zx/globals';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';

import { parseEventJson } from './src/parse-events.js';
import { probeTrack } from './src/probe-track.js';
import { normalizeVideoTrackToM4V, normalizeAudioTrack } from './src/render-track.js';
import { writeVcsBatchFromEvents } from './src/vcs-batch-from-events.js';
import { createStorageWatcher } from './src/storage-watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/*
  Event-driven compositing pipeline:

  1. Parse event JSON -> RecordingTimeline
  2. Apply --start/--duration to compute render window
  3. Identify tracks overlapping the window; resolve webm file paths
  4. Lightweight probe each webm (parallel)
  5. Build synthetic analysis objects (with event-derived gaps, clamped to window)
  6. Normalize video tracks to cache dir (parallel, up to 4 concurrent)
  7. Normalize audio tracks to cache dir (parallel)
  8. Generate VCS batch JSON from timeline + window
  9. Run VCS batch runner
  10. Render segments (20s chunks)
  11. Concatenate video segments
  12. Mix audio tracks with amix
  13. Mux video + audio -> final MP4
*/

// --- Parse CLI args ---

let vcsRenderDir = argv['vcsrender-path'];
const vcsSdkDir = argv['vcs-sdk-path'];
if (!vcsSdkDir) {
  echo`VCS SDK directory must be provided with --vcs-sdk-path`;
  process.exit(1);
}
if (!vcsRenderDir) {
  vcsRenderDir = path.resolve(vcsSdkDir, 'server-render', 'vcsrender');
}

const g_tools = {
  node: 'node',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  vcsRender: path.resolve(vcsRenderDir, 'build', 'vcsrender'),
  vcsBatchRunnerScript: path.resolve(vcsSdkDir, 'js', 'vcs-batch-runner.js'),
};
if (!fs.existsSync(g_tools.vcsRender)) {
  echo`VCSRender must be available at ${g_tools.vcsRender}`;
  process.exit(1);
}
if (!fs.existsSync(g_tools.vcsBatchRunnerScript)) {
  echo`VCS SDK directory must contain js subdir with the batch runner script`;
  process.exit(1);
}

// Verify VCS SDK has the features we need (layout animations, standardSourceMessage, etc.)
{
  const batchRunnerSrc = fs.readFileSync(g_tools.vcsBatchRunnerScript, 'utf-8');
  const batchUtilPath = path.resolve(vcsSdkDir, 'js', 'lib-node', 'batch-util.js');
  const batchUtilSrc = fs.existsSync(batchUtilPath) ? fs.readFileSync(batchUtilPath, 'utf-8') : '';

  const missing = [];
  if (!batchRunnerSrc.includes('layoutAnimations')) missing.push('layout animations');
  if (!batchRunnerSrc.includes('user_white_64')) missing.push('paused placeholder image');
  if (!batchUtilSrc.includes('standardSourceMessage')) missing.push('standardSourceMessage support');

  if (missing.length > 0) {
    echo`\nWarning: VCS SDK at ${vcsSdkDir} may be missing required features:`;
    for (const m of missing) echo`  - ${m}`;
    echo`The composite-from-events tool requires a VCS SDK version newer than 2026-03-19.`;
    echo`See the raw-tracks-tools README for required VCS SDK version.\n`;
  }
}

// check disk space
const volumeStats = fs.statfsSync(__dirname);
const spaceAvailableToUser_mb =
  (volumeStats.bsize * volumeStats.bavail) / (1024 * 1024);
const MIN_SPACE_MB = 4000;
if (spaceAvailableToUser_mb < MIN_SPACE_MB) {
  echo`You need at least ${MIN_SPACE_MB} megabytes of disk space on this volume.`;
  process.exit(5);
}

const g_cacheDir = path.resolve(__dirname, 'video-cache');
fs.mkdirpSync(g_cacheDir);

// Storage watcher — monitors disk usage during rendering
const storageWatcher = createStorageWatcher(__dirname, 10000);
storageWatcher.addDir('video-cache', g_cacheDir);

const eventJsonPath = argv['input'] ?? argv['i'];
if (!eventJsonPath) {
  echo`Must provide --input (or -i) path to event JSON`;
  process.exit(1);
}
const eventJsonDir = path.dirname(path.resolve(eventJsonPath));
const eventJson = fs.readJSONSync(eventJsonPath);

const outputSize = { w: 1280, h: 720 };
if (argv['w'] && argv['h']) {
  outputSize.w = parseInt(argv['w'], 10);
  outputSize.h = parseInt(argv['h'], 10);
  if (
    !Number.isFinite(outputSize.w) ||
    !Number.isFinite(outputSize.h) ||
    outputSize.w < 1 ||
    outputSize.h < 1
  ) {
    echo`Invalid output size specified: ${outputSize.w} x ${outputSize.h}`;
    process.exit(1);
  }
}

const fps = argv['fps'] ? parseFloat(argv['fps']) : 30;
if (!Number.isFinite(fps) || fps < 0.1) {
  echo`Invalid fps: ${fps}`;
  process.exit(2);
}

const windowStart = argv['start'] ? parseFloat(argv['start']) : 0;
const windowDurationArg = argv['duration'] ? parseFloat(argv['duration']) : null;

// composition params
let initialParams = {};
const paramsJsonFile = argv['params'] ?? argv['p'];
if (paramsJsonFile) {
  try {
    initialParams = fs.readJSONSync(paramsJsonFile);
  } catch (e) {
    echo`Error parsing params JSON file: ${e}`;
    process.exit(2);
  }
}

// --- Step 1: Parse event JSON ---
echo`\n--- Parsing event JSON ---`;
const timeline = parseEventJson(eventJson);
echo`Recording start: ${timeline.recordingStartTs} (${new Date(timeline.recordingStartTs).toISOString()})`;
echo`Session duration: ${timeline.sessionDurationSecs.toFixed(1)}s`;
echo`Tracks: ${timeline.tracks.size}, Participants: ${timeline.participants.size}`;

for (const [pid, p] of timeline.participants) {
  echo`  ${p.displayName}: ${p.videoTrackNums.length} video, ${p.audioTrackNums.length} audio`;
}

// --- Step 2: Compute render window ---
const windowDuration = Math.min(
  windowDurationArg ?? (timeline.sessionDurationSecs - windowStart),
  timeline.sessionDurationSecs - windowStart
);
if (windowDuration <= 0) {
  echo`Window start ${windowStart}s is past session end ${timeline.sessionDurationSecs.toFixed(1)}s`;
  process.exit(1);
}
const windowEnd = windowStart + windowDuration;
echo`\nRender window: ${windowStart}s - ${windowEnd.toFixed(1)}s (${windowDuration.toFixed(1)}s)`;

// --- Step 3: Identify tracks overlapping the window ---
const videoTracksInWindow = [];
const audioTracksInWindow = [];

for (const [trackSessionNum, track] of timeline.tracks) {
  if (!track.filename) {
    // No recording-media-started event for this track
    continue;
  }

  const trackStart = track.startOffsetSecs;
  const trackEnd = track.removedAtSecs ?? timeline.sessionDurationSecs;

  // Check if track overlaps the render window
  if (trackStart >= windowEnd || trackEnd <= windowStart) continue;

  const filePath = path.resolve(eventJsonDir, track.filename);
  if (!fs.existsSync(filePath)) {
    echo`Warning: track file not found: ${filePath}`;
    continue;
  }

  const trackInfo = {
    ...track,
    filePath,
    effectiveStart: Math.max(trackStart, windowStart),
    effectiveEnd: Math.min(trackEnd, windowEnd),
  };

  if (track.kind === 'video') {
    videoTracksInWindow.push(trackInfo);
  } else if (track.kind === 'audio') {
    audioTracksInWindow.push(trackInfo);
  }
}

// Sort video tracks by start time
videoTracksInWindow.sort((a, b) => a.startOffsetSecs - b.startOffsetSecs);

echo`\nTracks in window: ${videoTracksInWindow.length} video, ${audioTracksInWindow.length} audio`;

const MAX_VIDEO_IDS = 20;
if (videoTracksInWindow.length > MAX_VIDEO_IDS) {
  echo`Warning: ${videoTracksInWindow.length} video tracks exceed max ${MAX_VIDEO_IDS}, truncating`;
  videoTracksInWindow.length = MAX_VIDEO_IDS;
}

// Assign VCS video input IDs
const VIDEO_INPUT_ID_NUM_PREFIX = 1001;
for (const [idx, track] of videoTracksInWindow.entries()) {
  track.videoInputId = VIDEO_INPUT_ID_NUM_PREFIX + idx;
}

// --- Step 4: Probe each webm ---
echo`\n--- Probing tracks ---`;
const probeResults = new Map();

const probePromises = [];
const allTracksToProbe = [...videoTracksInWindow, ...audioTracksInWindow];
for (const track of allTracksToProbe) {
  probePromises.push(
    probeTrack(`probe_${track.trackSessionNum}`, track.filePath).then(
      (result) => {
        probeResults.set(track.trackSessionNum, result);
      }
    )
  );
}
await Promise.all(probePromises);
echo`Probed ${probeResults.size} tracks`;

// --- Step 5: Build synthetic analysis objects ---

function buildVideoAnalysis(track) {
  const probe = probeResults.get(track.trackSessionNum);
  if (!probe) throw new Error(`No probe result for track ${track.trackSessionNum}`);

  // normalizeVideoTrackToM4V works in the webm's native PTS space.
  // Event-derived timestamps are in recording-relative seconds.
  // These differ by a small offset:
  //   ptsOffset = probe.startTime - track.startOffsetSecs
  // e.g. webm PTS 1.025 vs event startOffset 0.633 → ptsOffset = 0.392
  //
  // To convert: PTS = recordingRelative + ptsOffset
  //
  // The normalized file covers the FULL track (not windowed) so it can be
  // cached and reused across runs with different --start/--duration values.
  // The render window is applied later during segment extraction (step 10).

  const ptsOffset = probe.startTime - track.startOffsetSecs;

  // All normalized files are padded to the full recording duration starting from
  // time 0 (recording start). This means every normalized file shares the same
  // coordinate space — seeking to time T in any file gives recording time T.
  // This simplifies AV sync: you can mux any normalized video + audio directly.

  // Initial gap: black from recording start to first frame
  const gaps = [];
  if (probe.startTime > 0.05) {
    gaps.push({ start: 0, end: probe.startTime });
  }

  // Pause intervals, converted to PTS space
  for (const interval of track.pauseIntervals) {
    const pauseAt = interval.pauseAt + ptsOffset;
    const resumeAt = (interval.resumeAt ?? (track.removedAtSecs ?? timeline.sessionDurationSecs)) + ptsOffset;

    gaps.push({
      start: pauseAt,
      end: resumeAt,
    });
  }

  // Trailing gap: black from track end to session end (if track was removed early)
  const trackEndPts = (track.removedAtSecs ?? timeline.sessionDurationSecs) + ptsOffset;
  const sessionEndPts = timeline.sessionDurationSecs + ptsOffset;
  if (trackEndPts < sessionEndPts - 0.1) {
    gaps.push({ start: trackEndPts, end: sessionEndPts });
  }

  const endTime = sessionEndPts;

  return {
    isVideo: true,
    startTime: probe.startTime,
    endTime,
    videoSize: probe.videoSize,
    frameRate: probe.frameRate || 30,
    gaps,
  };
}

function buildAudioAnalysis(track) {
  const probe = probeResults.get(track.trackSessionNum);
  if (!probe) throw new Error(`No probe result for track ${track.trackSessionNum}`);

  // adelay pads from time 0 to probe.startTime, matching the video normalization
  // which pads with black from 0 to first frame. Both files share the same
  // timeline: position T = recording time T.
  const ptsOffset = probe.startTime - track.startOffsetSecs;
  const sessionEndPts = timeline.sessionDurationSecs + ptsOffset;

  return {
    isVideo: false,
    startTime: probe.startTime,
    endTime: sessionEndPts,
  };
}

// --- Step 6 & 7: Normalize tracks ---
echo`\n--- Normalizing video tracks ---`;

const vcsVideoInputTrackDescs = [];
const normalizedVideoFiles = [];
const normalizedAudioFiles = [];

let normalizeVideosDone = 0;
let normalizeAudiosDone = 0;

// Normalize video tracks (up to 4 concurrent)
const VIDEO_CONCURRENCY = 4;
let videoIdx = 0;

async function normalizeNextVideo() {
  while (videoIdx < videoTracksInWindow.length) {
    const idx = videoIdx++;
    const track = videoTracksInWindow[idx];
    const analysis = buildVideoAnalysis(track);
    const basename = path.basename(track.filename, '.webm');
    const outputFile = path.resolve(g_cacheDir, `${basename}_normalized.m4v`);

    if (fs.existsSync(outputFile)) {
      normalizeVideosDone++;
      echo`[progress] Video ${normalizeVideosDone}/${videoTracksInWindow.length}: ${track.displayName} (cached)`;
    } else {
      // The full-file convert processes the entire webm (not just the render window),
      // so the progress estimate should use the full track duration for accuracy.
      // The webm covers from track.startOffsetSecs to removedAt (or session end).
      const fullTrackDurationSecs =
        (track.removedAtSecs ?? timeline.sessionDurationSecs) - track.startOffsetSecs;
      echo`[progress] Video ${idx + 1}/${videoTracksInWindow.length}: normalizing ${track.displayName} (~${Math.round(fullTrackDurationSecs)}s of media)...`;
      await normalizeVideoTrackToM4V(
        `evvid_${track.trackSessionNum}`,
        analysis,
        track.filePath,
        outputFile,
        {
          quiet: true,
          onProgress: ({ outTimeSecs, speed }) => {
            const pct = fullTrackDurationSecs > 0
              ? Math.min(100, (outTimeSecs / fullTrackDurationSecs) * 100)
              : 0;
            process.stdout.write(
              `\r[progress] Video ${idx + 1}/${videoTracksInWindow.length} ${track.displayName}: ${pct.toFixed(0)}% (${speed ?? '?'})   `
            );
          },
        }
      );
      process.stdout.write('\n');
      normalizeVideosDone++;
      echo`[progress] Video ${normalizeVideosDone}/${videoTracksInWindow.length}: ${track.displayName} done`;
    }

    // Probe the normalized output for dimensions and duration
    const dur =
      await $({quiet: true})`${g_tools.ffprobe} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${outputFile}`;
    const dur_secs = parseFloat(dur.stdout.trim());

    const size =
      await $({quiet: true})`${g_tools.ffprobe} -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ${outputFile}`;
    let [w, h] = size.stdout.trim().split(',');
    w = parseInt(w, 10);
    h = parseInt(h, 10);

    const probe = probeResults.get(track.trackSessionNum);
    const desc = {
      trackSessionNum: track.trackSessionNum,
      participantId: track.participantId,
      displayName: track.displayName,
      startOffsetSecs: track.startOffsetSecs,
      // PTS of first actual video frame (recording-relative).
      // Differs from startOffsetSecs by ~0.4-1s due to encoding/network delay.
      // Used by VCS batch to show placeholder until real frames arrive.
      firstFrameSecs: probe?.startTime ?? track.startOffsetSecs,
      videoInputId: track.videoInputId,
      file: outputFile,
      durationInSecs: dur_secs,
      w,
      h,
    };
    vcsVideoInputTrackDescs[idx] = desc;
    normalizedVideoFiles[idx] = outputFile;
  }
}

const videoWorkers = [];
for (let i = 0; i < Math.min(VIDEO_CONCURRENCY, videoTracksInWindow.length); i++) {
  videoWorkers.push(normalizeNextVideo());
}

// Normalize audio tracks concurrently
echo`\n--- Normalizing audio tracks ---`;
const audioPromises = audioTracksInWindow.map(async (track, audioIdx) => {
  // Gapless transcoded audio (WAV or AAC) is already silence-padded and can be
  // used directly without normalization.
  const isGaplessTranscoded =
    track.contentType && track.contentType !== 'audio/webm';

  if (isGaplessTranscoded) {
    normalizeAudiosDone++;
    echo`[progress] Audio ${normalizeAudiosDone}/${audioTracksInWindow.length}: ${track.displayName} (gapless transcoded, no normalization needed)`;
    normalizedAudioFiles.push(track.filePath);
    return;
  }

  const analysis = buildAudioAnalysis(track);
  const inputExt = path.extname(track.filename);
  const basename = path.basename(track.filename, inputExt);
  const outputFile = path.resolve(g_cacheDir, `${basename}_normalized.aac`);

  if (fs.existsSync(outputFile)) {
    normalizeAudiosDone++;
    echo`[progress] Audio ${normalizeAudiosDone}/${audioTracksInWindow.length}: ${track.displayName} (cached)`;
  } else {
    echo`[progress] Audio ${audioIdx + 1}/${audioTracksInWindow.length}: normalizing ${track.displayName}...`;
    await normalizeAudioTrack(
      `evaud_${track.trackSessionNum}`,
      analysis,
      track.filePath,
      outputFile,
      'aac',
      {
        quiet: true,
        onProgress: ({ outTimeSecs, speed }) => {
          process.stdout.write(
            `\r[progress] Audio ${audioIdx + 1}/${audioTracksInWindow.length} ${track.displayName}: ${outTimeSecs.toFixed(0)}s encoded (${speed ?? '?'})   `
          );
        },
      }
    );
    process.stdout.write('\n');
    normalizeAudiosDone++;
    echo`[progress] Audio ${normalizeAudiosDone}/${audioTracksInWindow.length}: ${track.displayName} done`;
  }
  normalizedAudioFiles.push(outputFile);
});

// Wait for both video and audio normalization
await Promise.all([...videoWorkers, ...audioPromises]);
echo`---- Normalize finished.\n`;

// --- Step 8: Generate VCS batch JSON ---
const totalDuration_secs = windowDuration;
const totalDuration_frames = Math.floor(fps * totalDuration_secs);

echo`Total render duration: ${totalDuration_secs.toFixed(1)}s = ${totalDuration_frames} frames at ${fps} fps`;

const vcsBatch = writeVcsBatchFromEvents(timeline, vcsVideoInputTrackDescs, {
  outputSize,
  durationInFrames: totalDuration_frames,
  fps,
  initialParams,
  windowStart,
});

const tmpPath = tmpdir(
  `raw-tracks-composite-events_${timeline.recordingStartTs}`
);
storageWatcher.addDir('render temp', tmpPath);

const vcsEventsJsonPath = path.resolve(tmpPath, 'raw-tracks.vcsevents.json');
fs.writeJSONSync(vcsEventsJsonPath, vcsBatch);

// --- Step 9: Run VCS batch runner ---
const batchRunnerOutputDir = path.resolve(tmpPath, 'vcs-output');

let g_activeVideoInputSlots = [];

echo`\n--- Executing VCS state batch runner ---`;

await within(async () => {
  cd(path.resolve(vcsSdkDir, 'js'));

  await $({quiet: true})`${g_tools.node} vcs-batch-runner.js --events_json ${vcsEventsJsonPath} --output_prefix ${batchRunnerOutputDir}/seq --clean_output_dir`;
});
echo`---- Batch runner finished.`;

// --- Step 10: Render segments ---
const framesPerSegment = Math.round(fps * 20);
const numSegments = Math.ceil(totalDuration_frames / framesPerSegment);

echo`\n--- Rendering ${numSegments} segment${numSegments > 1 ? 's' : ''} ---`;
storageWatcher.start();

let ffmpegConcatFile = '';
const renderStartTime = Date.now();

for (let segIdx = 0; segIdx < numSegments; segIdx++) {
  const startFrame = segIdx * framesPerSegment;
  const numFrames =
    segIdx < numSegments - 1
      ? framesPerSegment
      : totalDuration_frames - segIdx * framesPerSegment;

  const segTmpDir = path.resolve(tmpPath, `seg${segIdx}`);
  fs.emptyDirSync(segTmpDir);

  const pct = ((segIdx / numSegments) * 100).toFixed(0);
  const elapsedSecs = (Date.now() - renderStartTime) / 1000;
  let etaStr = '';
  if (segIdx > 0) {
    const secsPerSeg = elapsedSecs / segIdx;
    const remaining = secsPerSeg * (numSegments - segIdx);
    const mins = Math.floor(remaining / 60);
    const secs = Math.round(remaining % 60);
    etaStr = `, ETA: ${mins}m${secs}s`;
  }
  echo`[progress] Render segment ${segIdx + 1}/${numSegments} (${pct}%${etaStr})`;

  let segOutputM4v;
  try {
    segOutputM4v = await renderSegment(
      segIdx,
      startFrame,
      numFrames,
      segTmpDir
    );
  } catch (e) {
    console.error(
      `** renderSegment ${segIdx + 1} / ${numSegments} failed: ${e.message}`
    );
    process.exit(9);
  }
  if (segOutputM4v.length > 0) {
    ffmpegConcatFile += `file '${path.relative(tmpPath, segOutputM4v)}'\n`;
  }
}

const totalRenderSecs = ((Date.now() - renderStartTime) / 1000).toFixed(0);
echo`[progress] Rendering complete in ${totalRenderSecs}s`;

// --- Step 11: Concatenate segments ---
echo`\n---- Concatenating segments ----`;

const concatTempPath = path.resolve(tmpPath, 'video-concat.txt');
fs.writeFileSync(concatTempPath, ffmpegConcatFile, { encoding: 'utf-8' });

const concatOutputM4v = path.resolve(tmpPath, 'video-concat.m4v');

await within(async () => {
  cd(tmpPath);
  await $({quiet: true})`${g_tools.ffmpeg} -v error -y -f concat -i ${concatTempPath} -c copy ${concatOutputM4v}`;
});

// --- Step 12 & 13: Mix audio and mux ---
let muxedOutputMp4;
if (normalizedAudioFiles.length > 0) {
  echo`\n---- Mixing audio and muxing tracks ----`;

  const mixedOutputAac = path.resolve(tmpPath, 'audio-mix.aac');
  await mixAudioFromFiles(normalizedAudioFiles, mixedOutputAac, windowStart, totalDuration_secs);

  echo`--- audio mix done, will mux.`;

  muxedOutputMp4 = path.resolve(tmpPath, 'final.mp4');
  await $({quiet: true})`ffmpeg -hide_banner -v error -y -i ${concatOutputM4v} -i ${mixedOutputAac} -t ${totalDuration_secs} -c copy -map 0:0 -map 1:0 ${muxedOutputMp4}`;
}
const finalOutputTmp = muxedOutputMp4 ?? concatOutputM4v;

let finalOutputDst = argv['output-video'] ?? argv['o'];
if (!finalOutputDst) {
  let windowSuffix = '';
  if (windowStart > 0 || windowDurationArg != null) {
    windowSuffix = `_s${Math.round(windowStart)}`;
    if (windowDurationArg != null) windowSuffix += `_d${Math.round(windowDurationArg)}`;
  }
  finalOutputDst = path.resolve(
    eventJsonDir,
    `composite-events-${timeline.recordingStartTs}${windowSuffix}${path.extname(finalOutputTmp)}`
  );
}
fs.moveSync(finalOutputTmp, finalOutputDst, { overwrite: true });

fs.emptyDirSync(tmpPath);

storageWatcher.stop();
echo`\n${storageWatcher.summary()}`;

echo`\n------\nComposite-from-events tool has finished.`;
echo`Output at:\n${finalOutputDst}`;
process.exit(0);

// ----------------------------------------------------
// --- functions ---
// ----------------------------------------------------

async function renderSegment(segIdx, startFrame, numFrames, segTmpDir) {
  const videoInputIdsActiveInSeg = new Set();
  for (const inp of g_activeVideoInputSlots) {
    if (inp) videoInputIdsActiveInSeg.add(inp.id);
  }

  for (let i = startFrame; i < startFrame + numFrames; i++) {
    let ev;
    if ((ev = vcsBatch.eventsByFrame[i])) {
      if (ev.activeVideoInputSlots) {
        for (const inp of ev.activeVideoInputSlots) {
          if (inp) videoInputIdsActiveInSeg.add(inp.id);
        }
        g_activeVideoInputSlots = [...ev.activeVideoInputSlots];
      }
    }
  }

  const vcsRenderInputTimings = {
    startFrame,
    durationInFrames: numFrames,
    playbackEvents: [],
  };

  const seqDirs = [];
  let minFramesInSeq = numFrames;

  let maxFramesInSeq = 0;

  for (const inputId of videoInputIdsActiveInSeg) {
    const t = vcsVideoInputTrackDescs.find((d) => d?.videoInputId === inputId);
    const srcVideoFile = t?.file;
    if (!srcVideoFile) {
      throw new Error(
        `Internal inconsistency: no track for inputId ${inputId}`
      );
    }

    // All normalized files start at time 0 = recording start,
    // so seek position = absolute recording time.
    const seekInNormalized = windowStart + startFrame / fps;

    // Limit extraction to how much content this track actually has
    const trackAvailable = t.durationInSecs - seekInNormalized;
    const extractDuration = Math.min(numFrames / fps, Math.max(0, trackAvailable));

    if (extractDuration <= 0) continue;

    const dstSeqDir = path.resolve(segTmpDir, `seq_${inputId}`);
    fs.emptyDirSync(dstSeqDir);

    seqDirs.push(dstSeqDir);

    await $({quiet: true})`${g_tools.ffmpeg} -v error -ss ${seekInNormalized} -t ${
      extractDuration
    } -i ${srcVideoFile} -pix_fmt yuv420p -f segment -segment_time 0.01 ${dstSeqDir}/${inputId}_%06d.yuv`;

    const numFiles = fs.readdirSync(dstSeqDir).length;
    if (numFiles <= 0) continue;

    maxFramesInSeq = Math.max(maxFramesInSeq, numFiles);

    vcsRenderInputTimings.playbackEvents.push({
      videoInputId: inputId,
      frame: 0,
      durationInFrames: numFiles,
      seqDir: dstSeqDir,
      w: t.w,
      h: t.h,
    });
  }

  if (vcsRenderInputTimings.playbackEvents.length > 0) {
    // Use the longest input's frame count as the segment duration.
    // Shorter inputs will simply stop being composited when their frames run out.
    if (maxFramesInSeq < numFrames) {
      vcsRenderInputTimings.durationInFrames = maxFramesInSeq;
    }
  } else {
    // No video inputs for this segment
    return '';
  }

  const vcsInputTimingsJsonPath = path.resolve(
    segTmpDir,
    'seg.vcsinputtimings.json'
  );
  fs.writeJSONSync(vcsInputTimingsJsonPath, vcsRenderInputTimings);

  const renderYuvSeqOutputDir = path.resolve(segTmpDir, 'vcs-render-yuv');
  fs.emptyDirSync(renderYuvSeqOutputDir);

  const videoOutputPath = path.resolve(segTmpDir, `seg${segIdx}_video.m4v`);

  try {
    await within(async () => {
      cd(vcsRenderDir);

      await $({quiet: true})`build/vcsrender --oseq ${renderYuvSeqOutputDir} \
          --input_timings ${vcsInputTimingsJsonPath} \
          --jsonseq ${batchRunnerOutputDir} \
          -w ${outputSize.w} -h ${outputSize.h}`;

      // Encode YUV sequence to m4v (replaces convert_yuvseq_to_movie.sh with quiet ffmpeg)
      await $({quiet: true})`bash -c ${`cat "${renderYuvSeqOutputDir}"/*.yuv | ${g_tools.ffmpeg} -v error -f rawvideo -s ${outputSize.w}x${outputSize.h} -r ${fps} -pix_fmt yuv420p -i - -c:v libx264 -crf 18 -preset fast -b:v 5000k -maxrate 8000k -bufsize 10000k ${videoOutputPath}`}`;
    });
  } catch (e) {
    console.error(`** VCSRender failed for segment ${segIdx}: `, e.message);
    throw new Error('Unable to execute VCSRender');
  } finally {
    fs.emptyDirSync(renderYuvSeqOutputDir);
    for (const seqDir of seqDirs) {
      fs.emptyDirSync(seqDir);
    }
  }

  return videoOutputPath;
}

async function mixAudioFromFiles(srcFiles, mixOutputPath, seekStart = 0, duration = 0) {
  const audioFiles = [];
  const tmpFiles = [];

  for (const src of srcFiles) {
    const ext = path.extname(src);
    if (ext === '.aac' || ext === '.wav') {
      audioFiles.push(src);
    } else if (ext === '.mp4') {
      const basename = path.basename(src, ext);
      const tmpFile = path.resolve(g_cacheDir, `${basename}_audio.aac`);

      await $({quiet: true})`ffmpeg -v error -y -i ${src} -vn -acodec copy ${tmpFile}`;

      audioFiles.push(tmpFile);
      tmpFiles.push(tmpFile);
    } else {
      console.warn(`Unknown file in audio mix list, skipping: `, src);
    }
  }

  echo`Mixing ${audioFiles.length} audio tracks...`;
  // Use -ss before each -i to seek into the normalized audio at the window start,
  // and -t to limit to the window duration.
  const mixInputArgs = [];
  let mixInputCount = 0;
  for (const file of audioFiles) {
    if (seekStart > 0) mixInputArgs.push('-ss', seekStart);
    if (duration > 0) mixInputArgs.push('-t', duration);
    mixInputArgs.push('-i', file);
    mixInputCount++;
  }
  await $({quiet: true})`ffmpeg -v error -y ${mixInputArgs} -vn -filter_complex amix=inputs=${mixInputCount} -c:a aac -b:a 160k -ar 48000 ${mixOutputPath}`;
}
