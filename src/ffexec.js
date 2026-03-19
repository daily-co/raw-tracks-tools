import * as fs from "node:fs";
import * as Path from "node:path";
import * as childProcess from "node:child_process";

// this could be configurable
const g_stderrTempFilePrefix = "rawtracks_ffexec_";

export async function runFfmpegCommandAsync(contextId, args, opts = {}) {
  if (!Array.isArray(args)) {
    throw new Error("Invalid args for ffmpeg");
  }
  if (!args.includes("-y")) {
    // answer yes to any interactive questions
    args = ["-y"].concat(args);
  }

  const { onProgress } = opts;

  // If caller wants progress, add -progress pipe:1 so ffmpeg writes
  // structured progress data to stdout
  if (onProgress && !args.includes('-progress')) {
    args = ['-progress', 'pipe:1'].concat(args);
  }

  if (!opts.quiet) console.log("cmd:  ffmpeg", args.join(" "));

  const stderrOutPath = Path.resolve(
    "/tmp",
    `${g_stderrTempFilePrefix}${contextId}.txt`
  );
  try {
    fs.rmSync(stderrOutPath);
  } catch (e) {}

  const child = childProcess.spawn("ffmpeg", args, {
    // ffmpeg writes log output to stderr but it lets the output buffer fill up,
    // so the default of a pipe doesn't work. it will hang our process.
    // write the output to a tmp file instead
    stdio: ["pipe", "pipe", fs.openSync(stderrOutPath, "w")],
  });

  if (onProgress) {
    let buf = '';
    child.stdout.on('data', (data) => {
      buf += data.toString();
      // Each progress block ends with "progress=continue\n" or "progress=end\n"
      let idx;
      while ((idx = buf.indexOf('progress=')) !== -1) {
        const endIdx = buf.indexOf('\n', idx);
        if (endIdx < 0) break;

        const block = buf.substring(0, endIdx + 1);
        buf = buf.substring(endIdx + 1);

        // Parse key=value pairs from the block
        const info = {};
        for (const line of block.split('\n')) {
          const eqIdx = line.indexOf('=');
          if (eqIdx > 0) {
            info[line.substring(0, eqIdx)] = line.substring(eqIdx + 1);
          }
        }
        if (info.out_time_us) {
          onProgress({
            outTimeSecs: parseInt(info.out_time_us, 10) / 1000000,
            speed: info.speed,
            done: info.progress === 'end',
          });
        }
      }
    });
  }

  child.on("error", (err) => {
    throw new Error(`ffmpeg child error: ${err.message}`);
  });
  const exitCode = await new Promise((resolve, _reject) => {
    child.on("close", resolve);
  });
  if (exitCode) {
    throw new Error(
      `ffmpeg subprocess exited with ${exitCode}, log at: ${stderrOutPath}`
    );
  }

  return true;
}
