import { runFfprobeCommandAsync } from "./ffprobe.js";

export async function analyzeTrack(ctxName, inputPath) {
  const { frames, streams } = await runFfprobeCommandAsync(ctxName, [
    "-show_frames",
    "-show_streams",
    inputPath,
  ]);

  if (streams?.length !== 1) {
    console.error("Expected one stream in file, got: %d", streams?.length);
    throw new Error("Invalid input file");
  }
  const isVideo = streams[0]?.codec_type === "video";

  if (!frames || frames.length < 1) {
    console.error("No frames found in file.");
    throw new Error("Invalid input file");
  }

  const firstFrame = frames[0];
  if (
    !firstFrame.media_type ||
    firstFrame.media_type !== streams[0].codec_type
  ) {
    console.error("No media_type found in frame.");
    throw new Error("Invalid input file");
  }

  const lastFrame = frames[frames.length - 1];

  const ret = {
    streamMetadata: streams[0],
    isVideo,
    mediaType: streams[0].codec_type,
    numberOfFrames: frames.length,
    startTime: streams[0].start_time,
    endTime: lastFrame.pts_time + (lastFrame.duration_time || 0),
  };

  if (isVideo) {
    let w = firstFrame.width;
    let h = firstFrame.height;
    for (let i = 1; i < frames.length; i++) {
      w = Math.max(w, frames[i].width);
      h = Math.max(h, frames[i].height);
    }
    ret.videoSize = {
      w,
      h,
    };

    let fps = 30;
    const fpsStr = ret.streamMetadata.r_frame_rate;
    let idx;
    if ((idx = fpsStr.indexOf("/"))) {
      let nom = parseFloat(fpsStr.substring(idx));
      let den = parseFloat(fpsStr.substring(idx + 1));
      if (isFinite(nom) && isFinite(den) && den > 0) {
        fps = nom / den;
      }
    }
    ret.frameRate = fps;
  }

  ret.gaps = findGaps(frames);

  return ret;
}

// --- utility functions ---

function findGaps(frames) {
  const arr = [];
  const n = frames.length;

  const GAP_MIN_DURATION = 0.5;

  for (let i = 0; i < n; i++) {
    const frame = frames[i];
    const prevFrame = i > 0 ? frames[i - 1] : null;
    const prevFrameTime = prevFrame ? prevFrame.pts_time : 0;
    const intv = frame.pts_time - prevFrameTime;
    if (intv >= GAP_MIN_DURATION) {
      const prevFrameEnd = prevFrameTime + (prevFrame?.duration_time || 0);
      arr.push({
        start: prevFrameEnd,
        end: frame.pts_time,
      });
    }
  }

  return arr;
}
