#!/usr/bin/env zx
import 'zx/globals';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';

import { writeVcsBatchForTracks } from './src/vcs-batch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/*
  Compositing process outline:

  - Check presence of VCS JavaScript SDK + vcsrender binary

  - Check available disk space

  - Normalize tracks from raw-tracks-manifest (if not in cache already)

  - Compute total duration

  - Write vcsevents.json file for entire duration
    * All participants must be assigned to VCS video ids already

  - Execute vcsevents.json with batch runner

  - Split total duration into N-second slices, and for each:
    * Extract slice of batch runner's output
    * Extract YUV seq slices of input videos (active during the slice)
    * Write vcs input timings JSON
    * Execute vcsrender
    * Clean up input slices
    * Convert output slice to MP4
  
  - Join output slices into single MP4

  - Write audio mix for entire duration (using already normalized audio tracks)

  - Mux output video + audio
*/

let vcsRenderDir = argv['vcsrender-path'];
if (!vcsRenderDir) {
  vcsRenderDir = '~/bin';
  echo`Defaulting VCSRender tool dir to ${vcsRenderDir}`;
}

let vcsSdkDir = argv['vcs-sdk-path'];
if (!vcsSdkDir) {
  echo`VCS SDK directory must be provided with --vcs-sdk-path`;
  process.exit(1);
}
// required external tools
const g_tools = {
  node: 'node',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  vcsRender: path.resolve(vcsRenderDir, 'build', 'vcsrender'),
  normalizeTrackScript: path.resolve(__dirname, 'normalize-track.js'),
  vcsBatchRunnerScript: path.resolve(vcsSdkDir, 'js', 'vcs-batch-runner.js'),
};
if (!fs.existsSync(g_tools.vcsRender)) {
  echo`VCSRender must be available`;
  process.exit(1);
}
if (!fs.existsSync(g_tools.vcsBatchRunnerScript)) {
  echo`VCS SDK directory must contain js subdir with the batch runner script`;
  process.exit(1);
}

// we can use a lot of temp files while rendering, so check there's enough
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

const rawTracksManifestPath = argv['input-raw-tracks-manifest'] ?? argv['i'];
if (!rawTracksManifestPath) {
  echo`Must provide --input-raw-tracks-manifest (or -i)`;
  process.exit(1);
}
const rawTracksManifest = fs.readJSONSync(rawTracksManifestPath);
if (!Array.isArray(rawTracksManifest.participants)) {
  echo`Invalid raw-tracks-manifest: no participants field`;
  process.exit(2);
}

const outputSize = { w: 1280, h: 720 };

const rawTracksRoot = path.dirname(path.resolve(rawTracksManifestPath));

// assign a VCS video id to all non-audio tracks that we find.
// there's a limit in VCSRender for # of simultaneous tracks, so keep track
// that we don't exceed the maximum allowed size of this array.
// this could be smarter: now we're assigning ids for the entire duration
// of the composite, but actually not all tracks may not be active for the
// whole session.
const vcsVideoInputTrackDescs = [];
const normalizedAudioFiles = [];
const MAX_VIDEO_IDS = 20;
let totalDuration_secs = -1;

echo`\n--- Normalize input tracks ---`;
for (const p of rawTracksManifest.participants) {
  const { id, tracks } = p;
  if (tracks.length < 1) {
    echo`Warning: participant ${id} has no tracks`;
    continue;
  }
  const [ok, dur] = await normalizeParticipantTracks(
    id,
    tracks,
    vcsVideoInputTrackDescs,
    normalizedAudioFiles
  );
  if (ok && dur > 0) {
    totalDuration_secs = Math.max(dur, totalDuration_secs);
  }
}
echo`---- Normalize finished.\n`;

if (totalDuration_secs <= 0) {
  echo`Couldn't get the session duration from video tracks, the data might be empty.`;
  process.exit(3);
}

const fps = 30;
const totalDuration_frames = Math.floor(fps * totalDuration_secs);

echo`Total duration: ${totalDuration_secs} s = ${totalDuration_frames} frames`;

// sort inputs by the timestamp, so the events are easier to read
// as video inputs are activated in order over time.
vcsVideoInputTrackDescs.sort((a, b) => {
  const ts_a = a.startTs;
  const ts_b = b.startTs;
  return ts_a - ts_b;
});

// VCS needs a numeric id for each input, so assign them using a recognizable prefix
const VIDEO_INPUT_ID_NUM_PREFIX = 1001;
for (const [idx, track] of vcsVideoInputTrackDescs.entries()) {
  track.videoInputId = VIDEO_INPUT_ID_NUM_PREFIX + idx;
}

echo`VCS video inputs: ${util.inspect(vcsVideoInputTrackDescs)}`;

const vcsBatch = writeVcsBatchForTracks(vcsVideoInputTrackDescs, {
  outputSize,
  durationInFrames: totalDuration_frames,
  fps,
  initialParams: {
    mode: 'grid',
    'videoSettings.showParticipantLabels': true,
  },
});

echo`VCS batch: ${util.inspect(vcsBatch, { depth: 100 })}`;

const tmpPath = tmpdir(
  `raw-tracks-composite_${rawTracksManifest.recordingStartTs}`
);
const vcsEventsJsonPath = path.resolve(tmpPath, 'raw-tracks.vcsevents.json');
echo`Writing to: ${vcsEventsJsonPath}`;
fs.writeJSONSync(vcsEventsJsonPath, vcsBatch);

const batchRunnerOutputDir = path.resolve(tmpPath, 'vcs-output');

let g_activeVideoInputSlots = [];

if (0) {
  echo`\n--- Executing VCS state batch runner ---`;

  await within(async () => {
    cd(path.resolve(vcsSdkDir, 'js'));

    await $({
      verbose: true,
    })`${g_tools.node} vcs-batch-runner.js --events_json ${vcsEventsJsonPath} --output_prefix ${batchRunnerOutputDir}/seq --clean_output_dir`;
  });
  echo`---- Batch runner finished.\n`;

  const framesPerSegment = Math.round(fps * 20);
  const numSegments = Math.ceil(totalDuration_frames / framesPerSegment);

  echo`\n--- Rendering ${numSegments} segment${numSegments > 1 ? 's' : ''} ---`;

  let ffmpegConcatFile = '';

  for (let segIdx = 0; segIdx < numSegments; segIdx++) {
    const startFrame = segIdx * framesPerSegment;
    const numFrames =
      segIdx < numSegments - 1
        ? framesPerSegment
        : totalDuration_frames % numSegments;

    const segTmpDir = path.resolve(tmpPath, `seg${segIdx}`);
    fs.emptyDirSync(segTmpDir);

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

  echo`\n---- Concatenating segments ----`;

  const concatTempPath = path.resolve(tmpPath, 'video-concat.txt');
  fs.writeFileSync(concatTempPath, ffmpegConcatFile, { encoding: 'utf-8' });
}
const concatTempPath = path.resolve(tmpPath, 'video-concat.txt');

const concatOutputM4v = path.resolve(tmpPath, 'video-concat.m4v');

await within(async () => {
  cd(tmpPath);
  await $`${g_tools.ffmpeg} -y -f concat -i ${concatTempPath} -c copy ${concatOutputM4v}`;
});

let muxedOutputMp4;
if (normalizedAudioFiles.length > 0) {
  echo`\n---- Mixing audio and muxing tracks ----`;

  const mixedOutputAac = path.resolve(tmpPath, 'audio-mix.aac');

  await mixAudioFromMediaFiles(normalizedAudioFiles, mixedOutputAac);

  echo`--- audio mix done, will mux.`;

  muxedOutputMp4 = path.resolve(tmpPath, 'final.mp4');

  await $`ffmpeg -hide_banner -y -i ${concatOutputM4v} -i ${mixedOutputAac} -c copy -map 0:0 -map 1:0 ${muxedOutputMp4}`;
}
const finalOutput = muxedOutputMp4 ?? concatOutputM4v;

const finalOutputDst = argv['output-video'] ?? argv['o'];
if (finalOutputDst) {
  fs.moveSync(finalOutput, finalOutputDst, { overwrite: true });
}

echo`\n------\nComposite-tracks tool has finished.`;
echo`Output at:\n${finalOutputDst ?? finalOutput}`;
process.exit(0);

// ----------------------------------------------------
// --- functions ---
// ----------------------------------------------------

// !!! this function has process.exit points that probably should throw instead
async function normalizeParticipantTracks(
  id,
  tracks,
  vcsVideoInputTrackDescs,
  normalizedAudioFiles
) {
  let camVideoFile, camAudioFile;
  let camVideoTrack;

  for (const t of tracks) {
    const { file, mediaType } = t;
    if (mediaType === 'cam-video') {
      if (camVideoFile) {
        echo`Multiple ${mediaType} tracks found for participant ${id} - this is not currently supported by the tool`;
        process.exit(2);
      }
      camVideoFile = path.resolve(rawTracksRoot, file);
      camVideoTrack = t;
    } else if (mediaType === 'cam-audio') {
      if (camVideoFile) {
        echo`Multiple ${mediaType} tracks found for participant ${id} - this is not currently supported by the tool`;
        process.exit(2);
      }
      camAudioFile = path.resolve(rawTracksRoot, file);
    }
  }

  let isVideo;
  let outputFile;

  if (camVideoFile && camAudioFile) {
    // sync and combine AV tracks
    if (!fs.existsSync(camVideoFile) || !fs.existsSync(camAudioFile)) {
      echo`Track files not found: video ${camVideoFile}, audio ${camAudioFile}`;
      process.exit(2);
    }
    isVideo = true;

    if (vcsVideoInputTrackDescs.length >= MAX_VIDEO_IDS) {
      echo`** Warning: unable to process video+audio for participant ${id}, max video ids reached`;
      return [false];
    }
    vcsVideoInputTrackDescs.push({ ...camVideoTrack, participantId: id });

    const ext = 'mp4';
    const basename = path.basename(camVideoFile, path.extname(camVideoFile));
    outputFile = path.resolve(g_cacheDir, `${basename}_combined.${ext}`);
    if (fs.existsSync(outputFile)) {
      echo`Found cached track for combined video+audio for ${id}`;
    } else {
      echo`Normalizing video+audio for ${id}...`;
      const output =
        await $`${g_tools.node} ${g_tools.normalizeTrackScript} --output_dir ${g_cacheDir} -i ${camVideoFile} -i ${camAudioFile}`.nothrow();
      if (output.exitCode !== 0) {
        echo`** Normalize failed:\n-- stderr: ${output.stderr}\n-- stdout: ${output.stdout}`;
        process.exit(3);
      }
    }
    normalizedAudioFiles.push(outputFile);
  } else {
    // single track, can be video or audio
    const track = tracks[0];
    const file = path.resolve(rawTracksRoot, track.file);
    if (!fs.existsSync(file)) {
      echo`Track file not found: ${file}`;
      process.exit(2);
    }

    isVideo = track.mediaType.indexOf('audio') === -1;

    if (isVideo) {
      if (vcsVideoInputTrackDescs.length >= MAX_VIDEO_IDS) {
        echo`** Warning: unable to process video track (${track.mediaType}) for participant ${id}, max video ids reached`;
        return [false];
      }
      vcsVideoInputTrackDescs.push({ ...track, participantId: id });
    }

    const ext = isVideo ? 'm4v' : 'aac';
    const basename = path.basename(file, path.extname(file));
    outputFile = path.resolve(g_cacheDir, `${basename}_normalized.${ext}`);
    if (fs.existsSync(outputFile)) {
      echo`Found cached track for type ${track.mediaType} for ${id}`;
    } else {
      echo`Normalizing base track of type ${track.mediaType} for ${id}...`;
      const output =
        await $`${g_tools.node} ${g_tools.normalizeTrackScript} --output_dir ${g_cacheDir} -i ${file}`.nothrow();
      if (output.exitCode !== 0) {
        echo`** Normalize failed:\n-- stderr: ${output.stderr}\n-- stdout: ${output.stdout}`;
        process.exit(3);
      }
    }
    if (!isVideo) {
      normalizedAudioFiles.push(outputFile);
    }
  }

  if (!fs.existsSync(outputFile)) {
    echo`** Normalize tool didn't write expected output: ${outputFile}`;
    process.exit(3);
  }
  if (isVideo) {
    const dur =
      await $`${g_tools.ffprobe} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${outputFile}`;
    if (!Number.isFinite(parseFloat(dur))) {
      echo`** Couldn't get duration for normalized video track ${outputFile}: output was: '${dur}'`;
      process.exit(3);
    }
    let dur_secs = parseFloat(dur);

    const size =
      await $`${g_tools.ffprobe} -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 ${outputFile}`;
    let [w, h] = size.stdout.split(',');
    w = parseInt(w, 10);
    h = parseInt(h, 10);
    if (w < 1 || h < 1 || w > 99999 || h > 99999) {
      // sanity check for data returned by tool
      echo`** Couldn't get size for normalized video track ${outputFile}: output was: '${size}'`;
      process.exit(3);
    }

    // add metadata to track info
    const t = vcsVideoInputTrackDescs.at(-1);
    t.file = outputFile;
    t.durationInSecs = dur_secs;
    t.w = w;
    t.h = h;

    return [true, dur_secs];
  }
  return [true];
}

// uses globals from the main script
async function renderSegment(segIdx, startFrame, numFrames, segTmpDir) {
  echo`Segment ${segIdx + 1} / ${numSegments}:  frames ${startFrame} - ${
    startFrame + numFrames
  }...`;

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
        // keep a copy of this state across segment
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

  for (const inputId of videoInputIdsActiveInSeg) {
    const t = vcsVideoInputTrackDescs[inputId - VIDEO_INPUT_ID_NUM_PREFIX];
    const srcVideoFile = t?.file;
    if (!srcVideoFile) {
      throw new Error(
        `Internal inconsistency: no track for inputId ${inputId}`
      );
    }
    echo`Should slice from ${srcVideoFile} - -ss ${startFrame / fps} -t ${
      numFrames / fps
    }`;

    const dstSeqDir = path.resolve(segTmpDir, `seq_${inputId}`);
    fs.emptyDirSync(dstSeqDir);

    seqDirs.push(dstSeqDir);

    await $`${g_tools.ffmpeg} -v error -ss ${startFrame / fps} -t ${
      numFrames / fps
    } -i ${srcVideoFile} -pix_fmt yuv420p -f segment -segment_time 0.01 ${dstSeqDir}/${inputId}_%06d.yuv`;

    vcsRenderInputTimings.playbackEvents.push({
      videoInputId: inputId,
      frame: 0,
      durationInFrames: numFrames,
      seqDir: dstSeqDir,
      w: t.w,
      h: t.h,
    });

    const numFiles = fs.readdirSync(dstSeqDir).length;
    minFramesInSeq = Math.min(minFramesInSeq, numFiles);
  }

  if (vcsRenderInputTimings.playbackEvents.length > 0) {
    // check that the generated inputs have the same duration.
    // they might get different lengths if there's an internal hiccup in ffmpeg's decoding
    // (I've seen this happen if there's a colorspace mismatch inside a video track).
    // in that case the best we can do is to use the minimum duration.
    if (minFramesInSeq !== numFrames) {
      if (minFramesInSeq <= 1) {
        // if there's only one frame written for a sequence, that indicates a problem in ffmpeg.
        // don't even try to render
        echo`Warning: segment ${segIdx} rendered inputs: got ${minFramesInSeq} frames vs expected ${numFrames}, can't render`;
        return '';
      }
      echo`Warning: segment ${segIdx} rendered inputs duration differs: got min ${minFramesInSeq} vs expected ${numFrames}`;
      vcsRenderInputTimings.durationInFrames = minFramesInSeq;
      for (const ev of vcsRenderInputTimings.playbackEvents) {
        ev.durationInFrames = minFramesInSeq;
      }
    }
  }

  echo` ... seg input timings: ${util.inspect(vcsRenderInputTimings)}`;

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

      echo`\n --- Executing VCS render... ---`;

      echo`build/vcsrender --oseq ${renderYuvSeqOutputDir} \
          --input_timings ${vcsInputTimingsJsonPath} \
          --jsonseq ${batchRunnerOutputDir} \
          -w ${outputSize.w} -h ${outputSize.h}`;

      await $`build/vcsrender --oseq ${renderYuvSeqOutputDir} \
          --input_timings ${vcsInputTimingsJsonPath} \
          --jsonseq ${batchRunnerOutputDir} \
          -w ${outputSize.w} -h ${outputSize.h}`;

      echo`\n --- Encoding video... ---`;

      await $`./convert_yuvseq_to_movie.sh ${renderYuvSeqOutputDir} ${outputSize.w}x${outputSize.h} ${fps} ${videoOutputPath}`;
    });
  } catch (e) {
    console.error(`** VCSRender failed: `, e);
    throw new Error('Unable to execute VCSRender');
  } finally {
    // clean up render temp files
    fs.emptyDirSync(renderYuvSeqOutputDir);
    for (const seqDir of seqDirs) {
      fs.emptyDirSync(seqDir);
    }
  }

  return videoOutputPath;
}

// uses one global from the main script
async function mixAudioFromMediaFiles(srcFiles, mixOutputPath) {
  const audioFiles = [];
  const tmpFiles = [];

  for (const src of srcFiles) {
    const ext = path.extname(src);
    if (ext === '.aac') {
      audioFiles.push(src);
    } else if (ext === '.mp4') {
      const basename = path.basename(src, ext);
      const tmpFile = path.resolve(g_cacheDir, `${basename}_audio.aac`);

      echo`Extracting audio for ${src}...`;

      await $`ffmpeg -v error -y -i ${src} -vn -acodec copy ${tmpFile}`;

      audioFiles.push(tmpFile);
      tmpFiles.push(tmpFile);
    } else {
      console.warn(`Unknown file in audio mix list, skipping: `, src);
    }
  }

  echo`Mixing...`;
  const mixInputArgs = [];
  let mixInputCount = 0;
  for (const file of audioFiles) {
    mixInputArgs.push('-i', file);
    mixInputCount++;
  }
  await $`ffmpeg -v error -y ${mixInputArgs} -vn -filter_complex amix=inputs=${mixInputCount} ${mixOutputPath}`;
}
