#!/usr/bin/env zx
import 'zx/globals';

const rawTracksDir = argv['input-raw-tracks-dir'] ?? argv['i'];
if (!rawTracksDir) {
  echo`Must provide --input-raw-tracks-dir (or -i)`;
  process.exit(1);
}
if (!fs.existsSync(rawTracksDir)) {
  echo`Directory not found: ${rawTracksDir}`;
  process.exit(1);
}

// Check if an event JSON already exists — if so, suggest composite-from-events
const eventJsonFiles = fs.readdirSync(rawTracksDir).filter(
  (f) => f.endsWith('.event.json')
);
if (eventJsonFiles.length > 0) {
  echo`\nNote: This directory contains an event JSON file:`;
  echo`  ${eventJsonFiles[0]}`;
  echo``;
  echo`The event JSON provides richer metadata (display names, pause/resume,`;
  echo`chat messages) than a filename-derived manifest. Consider using the`;
  echo`composite-from-events tool instead:`;
  echo``;
  echo`  npm run composite-from-events -- -i ${path.resolve(rawTracksDir, eventJsonFiles[0])} --vcs-sdk-path \$PATH_TO_VCS_SDK`;
  echo``;
}

const manifest = {
  recordingStartTs: -1,
  participants: [],
};

for (const file of fs.readdirSync(rawTracksDir)) {
  const ext = path.extname(file);
  if (ext !== '.webm') continue;

  const re = /^(?:.+\/)*(\d+)-(.{36})-(.*)-(\d+)\.(\w+)/;
  const match = file.match(re);
  if (!match) {
    console.error(`Filename doesn't match expected pattern: ${file}`);
    continue;
  }

  const recStartTs = parseInt(match[1], 10);
  const uuid = match[2];
  const mediaType = match[3];
  const trackStartTs = parseInt(match[4], 10);
  const startOffsetSecs = (trackStartTs - recStartTs) / 1000;

  console.log(
    `rec ${recStartTs} : uuid ${uuid}, mediaType ${mediaType}, ts ${startOffsetSecs}`
  );

  if (
    manifest.recordingStartTs >= 0 &&
    recStartTs !== manifest.recordingStartTs
  ) {
    console.error(
      `Will ignore file belonging to other recording: got ${recStartTs}, expected ${manifest.recordingStartTs} based on other files in dir`
    );
    continue;
  }

  manifest.recordingStartTs = recStartTs;

  let p = manifest.participants.find((p) => p.id === uuid);
  if (!p) {
    p = { id: uuid, tracks: [] };
    manifest.participants.push(p);
  }

  p.tracks.push({
    file,
    mediaType,
    startTs: trackStartTs,
    startOffsetSecs,
  });
}

const outFile = path.resolve(
  rawTracksDir,
  `raw-tracks-manifest-${manifest.recordingStartTs}.json`
);
fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
