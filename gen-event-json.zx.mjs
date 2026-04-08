#!/usr/bin/env zx
import 'zx/globals';
import { randomUUID } from 'node:crypto';
import { analyzeTrack } from './src/analyze-track.js';

const rawTracksDir = argv['input-raw-tracks-dir'] ?? argv['i'];
if (!rawTracksDir) {
  echo`Must provide --input-raw-tracks-dir (or -i)`;
  process.exit(1);
}
if (!fs.existsSync(rawTracksDir)) {
  echo`Directory not found: ${rawTracksDir}`;
  process.exit(1);
}

const minGapDuration = argv['min-gap']
  ? parseFloat(argv['min-gap'])
  : 2.0;

// Check if an event JSON already exists
const existingEventJsonFiles = fs
  .readdirSync(rawTracksDir)
  .filter((f) => f.endsWith('.event.json'));
if (existingEventJsonFiles.length > 0) {
  echo`\nNote: This directory already contains an event JSON file:`;
  echo`  ${existingEventJsonFiles[0]}`;
  echo`You can use it directly with composite-from-events.`;
  echo``;
}

// --- Step 1: Scan directory and parse filenames ---

const FILENAME_RE = /^(\d+)-(.{36})-(.*)-(\d+)\.(\w+)$/;

const trackFiles = [];
let recordingStartTs = -1;

for (const file of fs.readdirSync(rawTracksDir)) {
  if (path.extname(file) !== '.webm') continue;

  const match = file.match(FILENAME_RE);
  if (!match) {
    echo`Warning: filename doesn't match expected pattern, skipping: ${file}`;
    continue;
  }

  const recStartTs = parseInt(match[1], 10);
  const uuid = match[2];
  const mediaType = match[3];
  const trackStartTs = parseInt(match[4], 10);

  if (recordingStartTs >= 0 && recStartTs !== recordingStartTs) {
    echo`Warning: ignoring file from different recording: ${file} (expected ${recordingStartTs})`;
    continue;
  }
  recordingStartTs = recStartTs;

  const kind = mediaType.includes('audio') ? 'audio' : 'video';
  const contentType = kind === 'audio' ? 'audio/webm' : 'video/webm';

  trackFiles.push({
    file,
    recStartTs,
    uuid,
    mediaType,
    trackStartTs,
    startOffsetSecs: (trackStartTs - recStartTs) / 1000,
    kind,
    contentType,
  });
}

if (trackFiles.length === 0) {
  echo`No .webm files matching raw-tracks filename pattern found in: ${rawTracksDir}`;
  process.exit(1);
}

// Sort by trackStartTs for deterministic ordering
trackFiles.sort((a, b) => a.trackStartTs - b.trackStartTs);

// Assign trackSessionNum values
for (let i = 0; i < trackFiles.length; i++) {
  trackFiles[i].trackSessionNum = i + 1;
}

// Assign display names per participant (by order of first appearance)
const participantNames = new Map();
let participantCounter = 0;
for (const t of trackFiles) {
  if (!participantNames.has(t.uuid)) {
    participantCounter++;
    participantNames.set(t.uuid, `Participant ${participantCounter}`);
  }
}

echo`\nFound ${trackFiles.length} tracks from ${participantNames.size} participant(s)`;
echo`Recording start: ${recordingStartTs} (${new Date(recordingStartTs).toISOString()})`;

// --- Step 2: Analyze tracks ---

echo`\n--- Analyzing tracks ---`;

const CONCURRENCY = 4;
const analyses = new Map(); // trackSessionNum -> analysis

for (let i = 0; i < trackFiles.length; i += CONCURRENCY) {
  const batch = trackFiles.slice(i, i + CONCURRENCY);
  const results = await Promise.all(
    batch.map(async (t) => {
      const inputPath = path.resolve(rawTracksDir, t.file);
      echo`Analyzing: ${t.file}`;
      const opts = {};
      if (minGapDuration !== undefined) {
        opts.minGapDurationInSecs = minGapDuration;
      }
      const analysis = await analyzeTrack(t.file, inputPath, opts);
      return { trackSessionNum: t.trackSessionNum, analysis };
    })
  );
  for (const { trackSessionNum, analysis } of results) {
    analyses.set(trackSessionNum, analysis);
  }
}

echo`Analysis complete.`;

// --- Step 3: Build events ---

const recordingStartSecs = recordingStartTs / 1000;
const events = [];

for (const t of trackFiles) {
  const analysis = analyses.get(t.trackSessionNum);
  const tsBase = recordingStartSecs + t.startOffsetSecs;

  // track-added
  events.push({
    ts: tsBase,
    type: 'track-added',
    participant_id: t.uuid,
    data: {
      trackSessionNum: t.trackSessionNum,
      kind: t.kind,
      trackType: t.mediaType,
      displayName: participantNames.get(t.uuid),
      paused: false,
    },
  });

  // recording-media-started
  // URI: last path component (without extension) is used by parseEventJson
  const filenameNoExt = path.basename(t.file, path.extname(t.file));
  events.push({
    ts: tsBase,
    type: 'recording-media-started',
    participant_id: t.uuid,
    data: {
      trackSessionNum: t.trackSessionNum,
      uri: `file:///./${filenameNoExt}`,
      contentType: t.contentType,
      mediaStartTime: t.trackStartTs / 1000,
    },
  });

  // Convert interior gaps to pause/resume events
  if (analysis.gaps && analysis.gaps.length > 0) {
    const ptsOffset = analysis.startTime - t.startOffsetSecs;

    for (const gap of analysis.gaps) {
      // Skip initial gap (from time 0 or before first real frame)
      if (gap.start < analysis.startTime + 0.05) continue;

      // Skip trailing gap (at or past track's content end)
      if (gap.end >= analysis.endTime - 0.05) continue;

      const pauseAtSecs = gap.start - ptsOffset;
      const resumeAtSecs = gap.end - ptsOffset;

      events.push({
        ts: recordingStartSecs + pauseAtSecs,
        type: 'track-paused',
        participant_id: t.uuid,
        data: {
          trackSessionNum: t.trackSessionNum,
        },
      });
      events.push({
        ts: recordingStartSecs + resumeAtSecs,
        type: 'track-resumed',
        participant_id: t.uuid,
        data: {
          trackSessionNum: t.trackSessionNum,
        },
      });
    }
  }

  // track-removed
  // Derive end time from analysis
  const ptsOffset = analysis.startTime - t.startOffsetSecs;
  const trackEndSecs = analysis.endTime - ptsOffset;

  events.push({
    ts: recordingStartSecs + trackEndSecs,
    type: 'track-removed',
    participant_id: t.uuid,
    data: {
      trackSessionNum: t.trackSessionNum,
      kind: t.kind,
      trackType: t.mediaType,
    },
  });
}

// Sort all events chronologically
events.sort((a, b) => a.ts - b.ts);

// --- Step 4: Build and write the event JSON ---

const eventJson = {
  format_id: 'daily-event-json',
  format_version: '2025-12-19',
  generated_by: 'gen-event-json',
  recording: {
    id: `generated-${recordingStartTs}`,
    type: 'raw-tracks',
    instance_id: `generated-${randomUUID()}`,
  },
  events,
};

// Compute session duration for summary
const lastEvent = events[events.length - 1];
const sessionDurationSecs = lastEvent.ts - recordingStartSecs;

let outputPath = argv['output'] ?? argv['o'];
if (!outputPath) {
  outputPath = path.resolve(
    rawTracksDir,
    `${recordingStartTs}.gen-event.json`
  );
}

fs.writeFileSync(outputPath, JSON.stringify(eventJson, null, 2) + '\n');

echo`\nGenerated event JSON with ${events.length} events`;
echo`Session duration: ${sessionDurationSecs.toFixed(1)}s`;
echo`Output: ${outputPath}`;

// Count pause/resume pairs
const pauseCount = events.filter((e) => e.type === 'track-paused').length;
if (pauseCount > 0) {
  echo`Detected ${pauseCount} pause interval(s) from gap analysis`;
}

echo`\nTo render a composite:`;
echo`  npm run composite-from-events -- -i ${outputPath} --vcs-sdk-path \$PATH_TO_VCS_SDK`;
