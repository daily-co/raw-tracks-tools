import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseEventJson, extendTimelineWithMediaEnds } from '../src/parse-events.js';
import { probeTrack, probeMediaEndSecs } from '../src/probe-track.js';

const REC_START = 1700000000000;
const PID = '11111111-1111-1111-1111-111111111111';

function trackEvents(num, kind, contentType, startSecs) {
  const trackType = `cam-${kind}`;
  return [
    {
      ts: startSecs,
      type: 'track-added',
      participant_id: PID,
      data: { trackSessionNum: num, kind, trackType, displayName: 'P1', paused: false },
    },
    {
      ts: startSecs,
      type: 'recording-media-started',
      participant_id: PID,
      data: {
        trackSessionNum: num,
        uri: `s3://bucket/${REC_START}.mp4-${PID}-${trackType}-${REC_START}`,
        contentType,
        mediaStartTime: startSecs,
      },
    },
  ];
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-test-'));
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
}

// Daily writes gapless AAC audio as .m4a files with contentType audio/mp4.
test('audio/mp4 tracks resolve to .m4a filenames', () => {
  const start = REC_START / 1000;
  const timeline = parseEventJson({ events: trackEvents(1, 'audio', 'audio/mp4', start) });
  assert.match(timeline.tracks.get(1).filename, /\.m4a$/);
});

// Some event JSONs have no track-removed / recording-media-finished events, so
// the last event is only a few hundred ms after start. Session length must come
// from the media itself.
test('session duration extends to media end when event JSON has no end events', () => {
  const start = REC_START / 1000;
  const timeline = parseEventJson({
    events: [...trackEvents(1, 'audio', 'audio/webm', start + 0.4), ...trackEvents(2, 'video', 'video/webm', start + 0.4)],
  });
  assert.ok(timeline.sessionDurationSecs < 1);

  extendTimelineWithMediaEnds(timeline, new Map([[1, 120.5], [2, 119.9]]));
  assert.equal(timeline.sessionDurationSecs, 120.5);
});

test('extendTimelineWithMediaEnds ignores tracks that have a removal event', () => {
  const start = REC_START / 1000;
  const timeline = parseEventJson({
    events: [
      ...trackEvents(1, 'audio', 'audio/webm', start),
      { ts: start + 10, type: 'track-removed', participant_id: PID, data: { trackSessionNum: 1 } },
    ],
  });
  extendTimelineWithMediaEnds(timeline, new Map([[1, 500]]));
  assert.equal(timeline.sessionDurationSecs, 10);
});

test('probeMediaEndSecs reads end time of a webm without a duration header', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=d=3', '-c:a', 'libopus', '-live', '1', file]);
  const end = await probeMediaEndSecs(file);
  assert.ok(Math.abs(end - 3) < 0.2, `expected ~3s, got ${end}`);
});

// Retina screen shares (e.g. 5852x3840) exceed the H.264 max frame size that
// VideoToolbox accepts (4096x2304), so normalization fails.
test('probeTrack caps video size to H.264 encodable limits', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'screen.webm');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=5852x3840:r=5:d=1', '-c:v', 'libvpx', file]);
  const { videoSize } = await probeTrack('test_cap', file);
  assert.ok(videoSize.w <= 4096 && videoSize.h <= 2304, `got ${videoSize.w}x${videoSize.h}`);
  assert.equal(videoSize.w % 2, 0);
  assert.equal(videoSize.h % 2, 0);
  assert.ok(Math.abs(videoSize.w / videoSize.h - 5852 / 3840) < 0.01);
});
