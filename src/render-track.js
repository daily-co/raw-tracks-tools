import * as Path from 'node:path';
import * as fs from 'node:fs';

import { runFfmpegCommandAsync } from './ffexec.js';

const g_tempFilePrefix = 'rawtracks_';

export async function normalizeAudioTrackToAAC(
  ctxName,
  analysis,
  inputPath,
  outputPath
) {
  if (analysis?.isVideo)
    throw new Error('normalizeAudioTrack expects audio input');

  if (analysis.startTime == null)
    throw new Error('normalizeAudioTrack expects startTime key');

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
    '-b:a',
    '256k',
    '-acodec',
    'aac',
    outputPath,
  ];
  await runFfmpegCommandAsync(`audio_${ctxName}`, args);
}

export async function normalizeVideoTrackToM4V(
  ctxName,
  analysis,
  inputPath,
  outputPath
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

  console.log('video segments to be written: ', segments);

  // TODO: allow caller to set this
  const bitRate = '5000k';

  const baseArgs = ['-r', frameRate, '-b:v', bitRate, '-c:v', 'libx264'];
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
  await runFfmpegCommandAsync(`convert_${ctxName}`, args);

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
      await runFfmpegCommandAsync(`rendergap_${i}_${ctxName}`, args);
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
      await runFfmpegCommandAsync(`extractseg_${i}_${ctxName}`, args);
    }
  }

  const concatTempPath = Path.resolve(
    tmpDir,
    `${g_tempFilePrefix}${ctxName}_concat.txt`
  );
  fs.writeFileSync(concatTempPath, ffmpegConcatFile, { encoding: 'utf-8' });

  tmpFiles.push(concatTempPath);

  //console.log('concat:\n', ffmpegConcatFile);

  args = ['-f', 'concat', '-i', concatTempPath, '-c', 'copy', outputPath];
  await runFfmpegCommandAsync(`concat_${ctxName}`, args);

  for (const path of tmpFiles) {
    fs.rmSync(path);
  }
}
