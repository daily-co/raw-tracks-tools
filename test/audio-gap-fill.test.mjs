/**
 * Regression test for audio gap filling in normalizeAudioTrack.
 *
 * Raw-tracks audio is Opus-in-WebM carrying real recording-relative
 * timestamps, so unrecovered packet loss leaves genuine holes in the PTS.
 * normalizeAudioTrack delegates hole filling to ffmpeg's aresample. With
 * aresample's default deadband (min_hard_comp=0.1) any hole under 100ms is
 * absorbed rather than filled, so the track slides early and only snaps back
 * once the running deficit crosses 100ms.
 *
 * The test builds two tracks with identical content: one clean, one with holes
 * that are all well under 100ms. If every hole is filled, the gapped track's
 * normalized output must be longer than the clean one by exactly the total
 * hole duration. Comparing the two cancels out fixed costs like Opus preskip,
 * so the test does not need to hardcode any encoder-specific fudge factor.
 *
 * Requires ffmpeg and ffprobe on PATH (the tool needs them anyway).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as Path from 'node:path';
import { execFileSync } from 'node:child_process';

import { normalizeAudioTrack } from '../src/render-track.js';
import { analyzeTrack } from '../src/analyze-track.js';

const SAMPLE_RATE = 48000;
const DURATION_SECS = 12;
// Holes are 20ms (one Opus packet) each, all far below aresample's 100ms
// default deadband, which is what makes them get absorbed instead of filled.
const HOLE_SIZE_SECS = 0.02;
const HOLE_TIMES = [1.5, 2.7, 3.9, 5.1, 6.3, 7.5, 8.7, 9.9];
const TOTAL_HOLE_SECS = HOLE_TIMES.length * HOLE_SIZE_SECS;
// Real raw-tracks files start some way into the recording, because a
// participant joins after the recording begins. Mimic that so the adelay
// start padding is exercised too.
const START_OFFSET_SECS = 1.2;

function makeWebm(outPath, holeTimes) {
  // asetpts and aresample must be built in one filter chain, and the file must
  // be written straight to WebM. Writing an intermediate WAV would renormalize
  // the timestamps and silently discard the holes we are trying to inject.
  const holeSamples = Math.round(HOLE_SIZE_SECS * SAMPLE_RATE);
  const offsetExpr = holeTimes.length
    ? '+' + holeTimes.map((t) => `${holeSamples}*gt(T,${t})`).join('+')
    : '';

  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${DURATION_SECS}:sample_rate=${SAMPLE_RATE}`,
      '-af',
      `asetpts='PTS+${Math.round(
        START_OFFSET_SECS * SAMPLE_RATE
      )}${offsetExpr}'`,
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      '-f',
      'webm',
      outPath,
    ],
    { stdio: 'pipe' }
  );
}

function countHoles(webmPath) {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_packets',
      '-show_entries',
      'packet=pts_time,duration_time',
      '-of',
      'csv=p=0',
      webmPath,
    ],
    { encoding: 'utf-8' }
  );

  const packets = out
    .split('\n')
    .map((l) => l.trim().split(','))
    .filter((f) => f.length >= 2 && f[0] && f[1])
    .map((f) => ({ pts: parseFloat(f[0]), dur: parseFloat(f[1]) }));

  let total = 0;
  let count = 0;
  for (let i = 1; i < packets.length; i++) {
    const gap = packets[i].pts - (packets[i - 1].pts + packets[i - 1].dur);
    if (gap > 0.005) {
      total += gap;
      count++;
    }
  }
  return { count, total };
}

function durationSecs(wavPath) {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      wavPath,
    ],
    { encoding: 'utf-8' }
  );
  return parseFloat(out.trim());
}

async function normalizeToWav(tmpDir, tag, holeTimes) {
  const inputPath = Path.join(tmpDir, `${tag}.webm`);
  const outputPath = Path.join(tmpDir, `${tag}_normalized.wav`);

  makeWebm(inputPath, holeTimes);

  const holes = countHoles(inputPath);
  const analysis = await analyzeTrack(`test_${tag}`, inputPath);
  assert.equal(analysis.isVideo, false, `${tag} should be an audio track`);

  await normalizeAudioTrack(`test_${tag}`, analysis, inputPath, outputPath, 'wav', {
    quiet: true,
  });

  return { holes, duration: durationSecs(outputPath) };
}

test('normalizeAudioTrack fills sub-100ms PTS holes', async (t) => {
  const tmpDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'rawtracks_test_'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const clean = await normalizeToWav(tmpDir, 'clean', []);
  const gapped = await normalizeToWav(tmpDir, 'gapped', HOLE_TIMES);

  // Sanity check the fixtures: holes must have survived into the container,
  // and the clean control must have none. If either fails, the test setup is
  // broken rather than the code under test.
  assert.equal(clean.holes.count, 0, 'clean control should have no PTS holes');
  assert.equal(
    gapped.holes.count,
    HOLE_TIMES.length,
    `expected ${HOLE_TIMES.length} PTS holes in the gapped input, found ${gapped.holes.count}`
  );
  assert.ok(
    Math.abs(gapped.holes.total - TOTAL_HOLE_SECS) < 0.005,
    `expected ${TOTAL_HOLE_SECS}s of holes, found ${gapped.holes.total}s`
  );

  // The only difference between the two tracks is the holes, so the gapped
  // output must be longer by exactly the total hole duration. Anything less is
  // a hole that got absorbed instead of filled. With aresample's default
  // deadband this comes out about 40ms short of the expected delta.
  const delta = gapped.duration - clean.duration;
  const missing = (TOTAL_HOLE_SECS - delta) * 1000;
  assert.ok(
    Math.abs(missing) < 3,
    `gapped output should be ${(TOTAL_HOLE_SECS * 1000).toFixed(0)}ms longer ` +
      `than the clean control, but it is ${(delta * 1000).toFixed(1)}ms longer ` +
      `(${missing.toFixed(1)}ms of holes were not filled)`
  );
});
