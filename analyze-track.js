import * as Path from 'node:path';
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';

//import equal from "fast-deep-equal";

import { analyzeTrack } from './src/analyze-track.js';

const args = parseArgs({
  options: {
    input: {
      type: 'string',
      short: 'i',
    },
    startTime: {
      type: 'string',
      short: 's',
    },
  },
});

const inputPath = args.values.input;
if (!inputPath || inputPath.length < 1) {
  console.error('input is required (-i or --input)');
  process.exit(1);
}
if (!fs.existsSync(inputPath)) {
  console.error("input path doesn't exist: ", inputPath);
  process.exit(1);
}

const opts = {
  minGapDurationInSecs: 0.5,
};

let analysis = await analyzeTrack('analyze-run', inputPath, opts);

/*
// DEBUG: used this to verify that multiple calls to ffprobe will return the same result.
// there was a bug where this wasn't always the case, but it's fixed now.
if (1) {
  let n = 1;
  let maxRuns = 3;
  do {
    const ctxName = `analyze-run-${n + 1}`;
    const run2 = await analyzeTrack(ctxName, inputPath);
    if (equal(analysis, run2)) break;

    console.warn(
      "Warning: ffprobe analysis returned different result on %s",
      ctxName
    );
    console.log("gaps: ", analysis.gaps, run2.gaps);
    console.log(analysis);
    console.log("-----");
    console.log(run2);
    analysis = run2;
  } while (++n < maxRuns);

  if (n >= maxRuns) {
    throw new Error(`ffprobe output diverged after ${maxRuns} runs`);
  }
}
*/

console.log(analysis);

if (args.values.startTime) {
  const startTs = parseFloat(args.values.startTime);
  if (!Number.isFinite(startTs)) {
    throw new Error('invalid startTs: ', args.values.startTime);
  }
  const gapTimes = analysis.gaps.map((gap) => {
    const { start, end } = gap;
    const dur = end - start;
    const gapStartTs = startTs + start * 1000;
    const date = new Date(gapStartTs);
    return `  ${date.toISOString()} - gap duration ${dur.toFixed(3)} s`;
  });
  console.log('Timestamps for gaps:\n\n', gapTimes.join('\n'));
}
