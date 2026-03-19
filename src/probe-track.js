/**
 * Lightweight ffprobe that reads stream-level metadata plus sampled frames
 * for video tracks (to catch WebRTC resolution ramp-up without a full scan).
 */

import { runFfprobeCommandAsync } from './ffprobe.js';

export async function probeTrack(ctxName, inputPath) {
  const { streams } = await runFfprobeCommandAsync(ctxName, [
    '-show_streams',
    inputPath,
  ], { quiet: true });

  if (!streams || streams.length < 1) {
    throw new Error(`No streams found in ${inputPath}`);
  }

  const stream = streams[0];
  const isVideo = stream.codec_type === 'video';

  const result = {
    isVideo,
    codec: stream.codec_name,
    startTime: stream.start_time ?? 0,
  };

  if (isVideo) {
    // Stream header resolution may be the initial (low) WebRTC resolution.
    // Sample frames at a few points to find the actual max resolution.
    // We must offset sample points by start_time since WebM PTS is absolute.
    let maxW = stream.width;
    let maxH = stream.height;

    const startPts = stream.start_time ?? 0;
    const offsets = [1, 5, 15, 30, 60];
    const samplePoints = offsets.map((t) => `%${startPts + t}`);

    try {
      const { frames: sampledFrames } = await runFfprobeCommandAsync(
        `${ctxName}_sample`,
        [
          '-select_streams',
          'v:0',
          '-show_frames',
          '-show_entries',
          'frame=width,height,pts_time,duration_time',
          '-read_intervals',
          samplePoints.join(','),
          inputPath,
        ],
        { quiet: true }
      );
      for (const frame of sampledFrames) {
        if (frame.width > maxW) maxW = frame.width;
        if (frame.height > maxH) maxH = frame.height;
      }
    } catch (e) {
      console.warn(
        `Warning: frame sampling failed for ${inputPath}, using stream header resolution: ${e.message}`
      );
    }

    result.videoSize = { w: maxW, h: maxH };

    // Parse frame rate from r_frame_rate (e.g. "30/1").
    // WebM stream headers often report unreliable rates (e.g. 1000/1),
    // so clamp to a reasonable range.
    let frameRate = 30;
    const fpsStr = stream.r_frame_rate;
    if (fpsStr) {
      const slashIdx = fpsStr.indexOf('/');
      if (slashIdx > 0) {
        const num = parseFloat(fpsStr.substring(0, slashIdx));
        const den = parseFloat(fpsStr.substring(slashIdx + 1));
        if (isFinite(num) && isFinite(den) && den > 0) {
          const parsed = num / den;
          // Only use parsed rate if it's in a sane range for video
          if (parsed >= 1 && parsed <= 120) {
            frameRate = parsed;
          }
        }
      }
    }
    result.frameRate = frameRate;
  } else {
    result.sampleRate = stream.sample_rate
      ? parseInt(stream.sample_rate, 10)
      : 48000;
  }

  return result;
}
