import * as fs from "node:fs";
import * as Path from "node:path";
import * as childProcess from "node:child_process";

// this could be configurable
const g_stderrTempFilePrefix = "rawtracks_ffprobe_";

export async function runFfprobeCommandAsync(contextId, args) {
  if (!Array.isArray(args)) {
    throw new Error("Invalid args for ffprobe");
  }
  if (!args.includes("-hide_banner")) {
    args = ["-hide_banner"].concat(args);
  }

  console.log("cmd:  ffprobe", args.join(" "));

  const stderrOutPath = Path.resolve(
    "/tmp",
    `${g_stderrTempFilePrefix}${contextId}.txt`
  );
  try {
    fs.rmSync(stderrOutPath);
  } catch (e) {}

  const child = childProcess.spawn("ffprobe", args, {});

  const ret = {
    streams: [],
    frames: [],
  };

  child.stdout.on("data", (data) => {
    let str = data.toString();
    let idx;

    let numItems = 0;
    while ((idx = str.indexOf("[")) !== -1) {
      numItems++;
      str = str.substring(idx);

      if (str.indexOf("[FRAME]") === 0) {
        if ((idx = str.indexOf("[/FRAME]")) < 0) {
          console.error("** frame end marker missing");
          throw new Error("Unsupported data");
        }
        ret.frames.push(
          parseFfprobeItem(
            str.substring("[FRAME]".length, idx),
            kItemTypes_frame
          )
        );
        str = str.substring(idx + "[/FRAME]".length);
      } else if (str.indexOf("[STREAM]") === 0) {
        if ((idx = str.indexOf("[/STREAM]")) < 0) {
          console.error("** stream end marker missing");
          throw new Error("Unsupported data");
        }
        ret.streams.push(
          parseFfprobeItem(
            str.substring("[STREAM]".length, idx),
            kItemTypes_stream
          )
        );
        str = str.substring(idx + "[/STREAM]".length);
      } else {
        console.error("** unknown data from ffprobe: " + str);
        throw new Error("Unsupported data");
      }
    }
  });

  child.on("error", (err) => {
    throw new Error(`ffprobe child error: ${err.message}`);
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  if (exitCode) {
    throw new Error(
      `ffprobe subprocess exited with ${exitCode}, log at: ${stderrOutPath}`
    );
  }

  return ret;
}

function parseFfprobeItem(str, itemTypes) {
  const d = {};
  const lines = str.split("\n");

  const { knownFloatKeys, knownIntKeys } = itemTypes;

  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const l = line.substring(0, idx);
    let r = line.substring(idx + 1);

    if (knownIntKeys.includes(l)) r = parseInt(r, 10);
    else if (knownFloatKeys.includes(l)) r = parseFloat(r);

    d[l] = r;
  }
  return d;
}

const kItemTypes_frame = {
  knownIntKeys: [
    "pts",
    "pkt_dts",
    "pkt_duration",
    "duration",
    "width",
    "height",
    "stream_index",
  ],
  knownFloatKeys: ["pts_time", "pkt_dts_time", "duration_time"],
};

const kItemTypes_stream = {
  knownIntKeys: [
    "index",
    "width",
    "height",
    "coded_width",
    "coded_height",
    "start_pts",
  ],
  knownFloatKeys: ["start_time"],
};
