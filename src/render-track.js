import * as Path from 'node:path';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';

import { runFfmpegCommandAsync } from './ffexec.js';

const g_tempFilePrefix = 'rawtracks_';
let g_audioEncoderArgs;
let g_videoEncoderArgs;

function queryFfmpegEncoders() {
  try {
    const probe = childProcess.spawnSync(
      'ffmpeg',
      ['-hide_banner', '-encoders'],
      { encoding: 'utf-8' }
    );
    if (probe.status === 0) return probe.stdout;
  } catch (err) {
    console.warn('Unable to query ffmpeg encoders: %s', err?.message || err);
  }
  return '';
}

let g_encoderList;
function getEncoderList() {
  if (g_encoderList === undefined) {
    g_encoderList = queryFfmpegEncoders();
  }
  return g_encoderList;
}

function getAudioEncoderArgs() {
  if (g_audioEncoderArgs) return g_audioEncoderArgs;

  const encoders = getEncoderList();
  if (encoders.includes('libfdk_aac')) {
    g_audioEncoderArgs = [
      '-c:a',
      'libfdk_aac',
      '-b:a',
      '256k',
      '-profile:a',
      'aac_low',
      '-vbr',
      '0',
      '-ar',
      '48000',
    ];
  } else {
    console.warn(
      'libfdk_aac not available in ffmpeg build; falling back to builtin aac encoder.'
    );
    g_audioEncoderArgs = ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000'];
  }

  return g_audioEncoderArgs;
}

function getVideoEncoderArgs(bitRate) {
  if (g_videoEncoderArgs) return g_videoEncoderArgs;

  const encoders = getEncoderList();
  if (encoders.includes('h264_videotoolbox')) {
    console.log('Using h264_videotoolbox hardware encoder');
    g_videoEncoderArgs = ['-b:v', bitRate, '-c:v', 'h264_videotoolbox'];
  } else {
    console.log('h264_videotoolbox not available; using libx264 ultrafast');
    g_videoEncoderArgs = [
      '-b:v',
      bitRate,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
    ];
  }

  return g_videoEncoderArgs;
}

export async function normalizeAudioTrack(
  ctxName,
  analysis,
  inputPath,
  outputPath,
  codec = 'aac',
  opts = {}
) {
  if (analysis?.isVideo)
    throw new Error('normalizeAudioTrack expects audio input');

  if (analysis.startTime == null)
    throw new Error('normalizeAudioTrack expects startTime key');

  if (codec === 'wav') {
    await normalizeAudioTrackToWav(ctxName, analysis, inputPath, outputPath, opts);
    return;
  }

  if (codec !== 'aac') {
    throw new Error(`Unsupported audio codec "${codec}"`);
  }

  await normalizeAudioTrackToAAC(ctxName, analysis, inputPath, outputPath, opts);
}

async function normalizeAudioTrackToAAC(
  ctxName,
  analysis,
  inputPath,
  outputPath,
  opts = {}
) {
  // the audio version of this operation just pads the start with silence.
  // we don't need to do gap rendering like with video.

  const args = [
    '-i',
    inputPath,
    '-af',
    // ffmpeg quirk: aresample needs to come before adelay in the filter chain
    `aresample=async=1,adelay=${Math.floor(
      analysis.startTime * 1000
    )}:all=true`,
    ...getAudioEncoderArgs(),
  ];

  // Limit output duration if endTime is provided.
  // Without this, Opus in WebM can produce wildly wrong output durations
  // because the container has no reliable duration and aresample may over-extend.
  if (analysis.endTime > 0) {
    args.push('-t', analysis.endTime);
  }

  args.push(outputPath);
  await runFfmpegCommandAsync(`audio_${ctxName}`, args, opts);
}

async function normalizeAudioTrackToWav(
  ctxName,
  analysis,
  inputPath,
  outputPath,
  opts = {}
) {
  const args = [
    '-i',
    inputPath,
    '-af',
    `aresample=async=1,adelay=${Math.floor(
      analysis.startTime * 1000
    )}:all=true`,
    '-ar',
    '48000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
  ];
  if (analysis.endTime > 0) {
    args.push('-t', analysis.endTime);
  }
  args.push(outputPath);
  await runFfmpegCommandAsync(`audio_${ctxName}_wav`, args, opts);
}

export async function normalizeVideoTrackToM4V(
  ctxName,
  analysis,
  inputPath,
  outputPath,
  opts = {}
) {
  if (!analysis?.isVideo)
    throw new Error('normalizeVideoTrack expects video input');

  if (!analysis.endTime || analysis.startTime == null)
    throw new Error(
      'normalizeVideoTrack expects non-zero endTime and startTime key'
    );

  if (!Array.isArray(analysis.gaps)) {
    throw new Error('normalizeVideoTrack expects analysis.gaps to be set');
  }
  if (!analysis.videoSize.w || !analysis.videoSize.h)
    throw new Error('normalizeVideoTrack expects analysis.videoSize to be set');

  const { videoSize, frameRate = 30, endTime, gaps } = analysis;

  const segments = [];
  let t = 0;
  for (const gap of gaps) {
    if (gap.start > t) {
      segments.push({ start: t, end: gap.start, type: 'src' });
    }

    segments.push({ ...gap, type: 'gap' });

    t = gap.end;
  }
  if (t < endTime) {
    segments.push({ start: t, end: endTime, type: 'src' });
  }

  if (!opts.quiet) console.log('video segments to be written: ', segments);

  // TODO: allow caller to set this
  const bitRate = '5000k';

  const encoderArgs = getVideoEncoderArgs(bitRate);
  const baseArgs = ['-r', frameRate, ...encoderArgs];
  let args;

  const tmpDir = '/tmp';
  const tmpFiles = [];

  // first convert the entire input.
  // ffmpeg can't seek reliably within the original,
  // so we need this intermediate to be able to extract segments.
  const tmpSource = Path.resolve(
    tmpDir,
    `${g_tempFilePrefix}${ctxName}_full.m4v`
  );
  tmpFiles.push(tmpSource);

  // the file rendered in tmpSource will start at the first sample's time in the raw-tracks file,
  // so we must apply this offset to when extracting segments from it.
  const sourceOffset = analysis.startTime;

  args = [
    '-i',
    inputPath,
    '-vf',
    `scale=${videoSize.w}x${videoSize.h}:out_color_matrix=bt709:out_range=tv`,
    ...baseArgs,
    tmpSource,
  ];
  await runFfmpegCommandAsync(`convert_${ctxName}`, args, opts);

  let ffmpegConcatFile = '';

  for (let i = 0; i < segments.length; i++) {
    const { start, end, type } = segments[i];

    // round duration to milliseconds
    const duration = Math.round((end - start) * 1000) / 1000;

    const tmpFileName = `${g_tempFilePrefix}${ctxName}_seg${i}.m4v`;
    ffmpegConcatFile += `file '${tmpFileName}'\n`;

    const dst = Path.resolve(tmpDir, tmpFileName);
    tmpFiles.push(dst);

    if (type === 'gap') {
      const args = [
        '-f',
        'lavfi',
        '-i',
        `color=c=black:s=${videoSize.w}x${videoSize.h},format=yuv420p,scale=out_color_matrix=bt709:out_range=tv`,
        '-t',
        duration,
        ...baseArgs,
        dst,
      ];
      await runFfmpegCommandAsync(`rendergap_${i}_${ctxName}`, args, opts);
    } else {
      const args = [
        '-ss',
        start - sourceOffset,
        '-t',
        duration,
        '-i',
        tmpSource,
        '-c',
        'copy',
        dst,
      ];
      await runFfmpegCommandAsync(`extractseg_${i}_${ctxName}`, args, opts);
    }
  }

  const concatTempPath = Path.resolve(
    tmpDir,
    `${g_tempFilePrefix}${ctxName}_concat.txt`
  );
  fs.writeFileSync(concatTempPath, ffmpegConcatFile, { encoding: 'utf-8' });

  tmpFiles.push(concatTempPath);

  args = ['-f', 'concat', '-i', concatTempPath, '-c', 'copy', outputPath];
  await runFfmpegCommandAsync(`concat_${ctxName}`, args, opts);

  for (const path of tmpFiles) {
    fs.rmSync(path);
  }
}
