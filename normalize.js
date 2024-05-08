import * as Path from "node:path";
import { parseArgs } from "node:util";

import { analyzeTrack } from "./src/analyze-track.js";
import {
  normalizeAudioTrackToAAC,
  normalizeVideoTrackToM4V,
} from "./src/render-track.js";
import { runFfmpegCommandAsync } from "./src/ffexec.js";

const args = parseArgs({
  options: {
    input: {
      type: "string",
      short: "i",
      multiple: true,
    },
    output_dir: {
      type: "string",
      short: "o",
    },
  },
});

if (args.values.input.length < 1) {
  console.error("input is required using -i (can provide multiple files)");
  process.exit(1);
}

const outputDir = args.values.output_dir || Path.dirname(args.values.input[0]);

let videoPath;
let audioPath;
let combinedOutputPath;

for (const inputPath of args.values.input) {
  const basename = Path.basename(inputPath, Path.extname(inputPath));

  const analysis = await analyzeTrack(`analyze_${basename}`, inputPath);

  if (analysis.isVideo) {
    const videoOutputPath = Path.resolve(
      outputDir,
      basename + "_normalized.m4v"
    );

    await normalizeVideoTrackToM4V(
      basename,
      analysis,
      inputPath,
      videoOutputPath
    );
    videoPath = videoOutputPath;
    combinedOutputPath = Path.resolve(outputDir, basename + "_combined.mp4");
  } else {
    const audioOutputPath = Path.resolve(
      outputDir,
      basename + "_normalized.aac"
    );

    await normalizeAudioTrackToAAC(
      basename,
      analysis,
      inputPath,
      audioOutputPath
    );
    audioPath = audioOutputPath;
  }
}

if (videoPath && audioPath && combinedOutputPath) {
  const basename = Path.basename(
    combinedOutputPath,
    Path.extname(combinedOutputPath)
  );

  const args = [
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-c",
    "copy",
    "-map",
    "0:0",
    "-map",
    "1:0",
    combinedOutputPath,
  ];
  await runFfmpegCommandAsync(`combine_${basename}`, args);

  console.log("combined video and audio written to: %s", combinedOutputPath);
}
