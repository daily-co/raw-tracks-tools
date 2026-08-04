/**
 * Tests for where an audio track lands on the recording timeline.
 *
 * The bug these guard against: gapless transcoded (WAV/AAC) sources are not on
 * the recording timeline. Server-side, recording_start_ts is applied only to the
 * WebM muxer, so a transcoded file's first sample is the participant's first
 * media, and its probe.startTime is ~0. Trusting the file put every participant
 * at the start of the call, so someone who joined 17 seconds in had their audio
 * slid 17 seconds early. For a genuinely late joiner it is minutes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAudioAnalysis,
  isGaplessTranscodedTrack,
} from '../src/audio-analysis.js';

const SESSION_SECS = 3360;

test('isGaplessTranscodedTrack only treats non-webm as transcoded', () => {
  assert.equal(isGaplessTranscodedTrack({ contentType: 'audio/webm' }), false);
  assert.equal(isGaplessTranscodedTrack({ contentType: 'audio/wav' }), true);
  assert.equal(isGaplessTranscodedTrack({ contentType: 'audio/mp4' }), true);
  // A missing contentType means the default webm path, not transcoded. Getting
  // this backwards would misplace every track on older recordings.
  assert.equal(isGaplessTranscodedTrack({}), false);
  assert.equal(isGaplessTranscodedTrack({ contentType: null }), false);
  assert.equal(isGaplessTranscodedTrack({ contentType: '' }), false);
});

test('webm tracks are anchored on the file, not the events JSON', () => {
  // Real numbers from the T-3173 recording: the file's own first pts is the
  // trustworthy anchor here, and it differs slightly from the JSON offset.
  const track = { trackSessionNum: 551001, contentType: 'audio/webm', startOffsetSecs: 17.363 };
  const probe = { startTime: 17.19 };

  const a = buildAudioAnalysis(track, probe, SESSION_SECS);

  assert.equal(a.isVideo, false);
  assert.equal(a.startTime, 17.19, 'webm head offset comes from the probe');
  // sessionDurationSecs is in the JSON timeline, so it has to be converted into
  // the file's pts space to serve as an end time.
  assert.ok(
    Math.abs(a.endTime - (SESSION_SECS + (17.19 - 17.363))) < 1e-9,
    `endTime should carry the pts offset, got ${a.endTime}`
  );
});

test('transcoded tracks are anchored on the events JSON, not the file', () => {
  // Same participant, same recording, but transcoded output. probe.startTime is
  // ~0 because the file begins at their first media.
  const track = { trackSessionNum: 551001, contentType: 'audio/wav', startOffsetSecs: 17.363 };
  const probe = { startTime: 0 };

  const a = buildAudioAnalysis(track, probe, SESSION_SECS);

  assert.equal(
    a.startTime,
    17.363,
    'a transcoded track must be placed by its join offset, not by the file'
  );
  assert.notEqual(a.startTime, probe.startTime, 'trusting probe.startTime is the bug');
  // No pts conversion, because startOffsetSecs is already in the JSON timeline.
  assert.equal(a.endTime, SESSION_SECS);
});

test('a transcoded track keeps its offset even when the file looks pre-padded', () => {
  // Guards the tempting shortcut of inferring placement from the file: a
  // transcoded file can report a small non-zero start_time for encoder reasons
  // while still not being on the recording timeline.
  const track = { trackSessionNum: 7, contentType: 'audio/mp4', startOffsetSecs: 240.5 };
  const a = buildAudioAnalysis(track, { startTime: 0.021 }, SESSION_SECS);
  assert.equal(a.startTime, 240.5);
});

test('a transcoded track with no startOffsetSecs fails loudly', () => {
  // There is no fallback worth having: the file cannot say where it belongs, so
  // guessing would silently misplace a participant. Better to stop.
  const track = { trackSessionNum: 9, contentType: 'audio/wav', startOffsetSecs: null };
  assert.throws(
    () => buildAudioAnalysis(track, { startTime: 0 }, SESSION_SECS),
    /startOffsetSecs/,
    'must name the missing field'
  );
});

test('a missing probe result fails loudly', () => {
  assert.throws(
    () => buildAudioAnalysis({ trackSessionNum: 3, contentType: 'audio/webm' }, null, SESSION_SECS),
    /No probe result/
  );
});
