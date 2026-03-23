import * as Path from 'node:path';
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';

import { analyzeTrack } from './src/analyze-track.js';
import {
  normalizeAudioTrack,
  normalizeVideoTrackToM4V,
} from './src/render-track.js';
import { runFfmpegCommandAsync } from './src/ffexec.js';

const args = parseArgs({
  options: {
    input: {
      type: 'string',
      short: 'i',
      multiple: true,
    },
    output_dir: {
      type: 'string',
      short: 'o',
    },
    'audio-codec': {
      type: 'string',
    },
    'min-gap-duration': {
      type: 'string',
    },
  },
});

if (args.values.input.length < 1) {
  console.error(
    'input is required using -i (can provide multiple files in order to combine audio and video)'
  );
  process.exit(1);
}

const outputDir = args.values.output_dir || Path.dirname(args.values.input[0]);
if (args.values.output_dir) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const audioCodec = (args.values['audio-codec'] || 'aac').toLowerCase();
if (!['aac', 'wav'].includes(audioCodec)) {
  console.error('audio-codec must be either "aac" or "wav"');
  process.exit(1);
}

const minGapDuration = args.values['min-gap-duration']
  ? parseFloat(args.values['min-gap-duration'])
  : undefined;
if (minGapDuration !== undefined && (!Number.isFinite(minGapDuration) || minGapDuration < 0)) {
  console.error('min-gap-duration must be a non-negative number (in seconds)');
  process.exit(1);
}

let videoPath;
let audioPath;
let combinedOutputPath;

for (const inputPath of args.values.input) {
  if (!fs.existsSync(inputPath)) {
    console.error("input path doesn't exist: ", inputPath);
    process.exit(1);
  }
  const basename = Path.basename(inputPath, Path.extname(inputPath));

  const analyzeOpts = {};
  if (minGapDuration !== undefined) {
    analyzeOpts.minGapDurationInSecs = minGapDuration;
  }
  const analysis = await analyzeTrack(`analyze_${basename}`, inputPath, analyzeOpts);

  if (analysis.isVideo) {
    const videoOutputPath = Path.resolve(
      outputDir,
      basename + '_normalized.m4v'
    );

    await normalizeVideoTrackToM4V(
      basename,
      analysis,
      inputPath,
      videoOutputPath
    );
    videoPath = videoOutputPath;
    combinedOutputPath = Path.resolve(outputDir, basename + '_combined.mp4');
  } else {
    const audioExt = audioCodec === 'wav' ? '.wav' : '.aac';
    const audioOutputPath = Path.resolve(
      outputDir,
      basename + '_normalized' + audioExt
    );

    await normalizeAudioTrack(
      basename,
      analysis,
      inputPath,
      audioOutputPath,
      audioCodec
    );
    if (audioCodec === 'aac') {
      audioPath = audioOutputPath;
    }
  }
}

if (audioCodec === 'aac' && videoPath && audioPath && combinedOutputPath) {
  const basename = Path.basename(
    combinedOutputPath,
    Path.extname(combinedOutputPath)
  );

  const args = [
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-c',
    'copy',
    '-map',
    '0:0',
    '-map',
    '1:0',
    combinedOutputPath,
  ];
  await runFfmpegCommandAsync(`combine_${basename}`, args);

  fs.rmSync(videoPath);
  fs.rmSync(audioPath);

  console.log('combined video and audio written to: %s', combinedOutputPath);
}
