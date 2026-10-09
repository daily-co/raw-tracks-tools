/**
 * Lightweight ffprobe that reads stream-level metadata plus sampled frames
 * for video tracks (to catch WebRTC resolution ramp-up without a full scan).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

    // H.264 (level 5.2 / videotoolbox) can't encode frames larger than 4096x2304,
    // e.g. Retina screen shares, so fit within that box keeping aspect ratio.
    const scale = Math.min(1, 4096 / maxW, 2304 / maxH);
    if (scale < 1) {
      maxW = Math.floor((maxW * scale) / 2) * 2;
      maxH = Math.floor((maxH * scale) / 2) * 2;
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

/**
 * Returns the end time (absolute media PTS, seconds) of stream 0 by scanning
 * packets, for files without a duration header (e.g. live-written webm).
 * Uses execFile rather than runFfprobeCommandAsync: that helper only parses
 * [FRAME]/[STREAM] sections and can't handle large chunked output.
 */
export async function probeMediaEndSecs(inputPath) {
  const { stdout } = await promisify(execFile)(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', '0',
      '-show_entries', 'packet=pts_time,duration_time',
      '-of', 'csv=p=0',
      inputPath,
    ],
    { maxBuffer: 256 * 1024 * 1024 }
  );
  let end = 0;
  for (const line of stdout.split('\n')) {
    const [pts, dur] = line.split(',').map(parseFloat);
    if (isFinite(pts)) end = Math.max(end, pts + (isFinite(dur) ? dur : 0));
  }
  return end;
}
