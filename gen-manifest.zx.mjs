#!/usr/bin/env zx
import 'zx/globals';

const rawTracksDir = argv['input-raw-tracks-dir'] ?? argv['i'];

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
