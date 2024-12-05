export function writeVcsBatchForTracks(
  vcsVideoInputTrackDescs,
  {
    durationInFrames = 0,
    fps = 30,
    outputSize = { w: 1280, h: 720 },
    initialParams = {},
  }
) {
  const vcsBatch = {
    compositionId: 'daily:baseline',
    durationInFrames,
    framesPerSecond: fps,
    outputSize,
    eventsByFrame: {},
  };

  let activeVideoInputSlots = [];

  vcsBatch.eventsByFrame[0] = {
    activeVideoInputSlots,
    params: { ...initialParams },
  };

  const videoTrackIndexesByStartFrame = new Map();

  for (const [idx, track] of vcsVideoInputTrackDescs.entries()) {
    const { startOffsetSecs = 0 } = track;
    const startFrame = Math.round(startOffsetSecs * fps);

    const arr = videoTrackIndexesByStartFrame.get(startFrame) ?? [];
    arr.push(idx);
    videoTrackIndexesByStartFrame.set(startFrame, arr);
  }

  const sortedStartFrames = [...videoTrackIndexesByStartFrame.keys()].sort(
    (a, b) => a - b
  );

  for (const frameIdx of sortedStartFrames) {
    const tracksStartingHere = videoTrackIndexesByStartFrame.get(frameIdx);
    const batchEv = vcsBatch.eventsByFrame[frameIdx] ?? {};

    activeVideoInputSlots = [...activeVideoInputSlots];

    for (const trackIdx of tracksStartingHere) {
      const t = vcsVideoInputTrackDescs[trackIdx];
      activeVideoInputSlots[trackIdx] = {
        id: t.videoInputId,
        displayName: t.participantId ?? `track${trackIdx}`,
      };
    }

    batchEv.activeVideoInputSlots = activeVideoInputSlots;

    vcsBatch.eventsByFrame[frameIdx] = batchEv;
  }

  return vcsBatch;

  for (const cutEv of cutEvents) {
    /*
      {
        "t": "3",
        "clips": ["s1"],
        "params": {
          "showTitleSlate": false
        }
      }
    */
    const { t: tc, clips, params } = cutEv;
    const t = parseClipTime(tc);
    const frame = Math.floor(t * fps);
    const batchEv = {};

    if (clips?.length > 0) {
      for (const clipId of clips) {
        const rclip = renderedClips.find((rc) => rc.clip?.id === clipId);
        if (!rclip) {
          throw new Error(`Cut specifies clip '${clipId}' that doesn't exist`);
        }
        const { videoInputId, seqDir, w, h, fps } = rclip;
        const { duration: durationTc } = rclip.clip;
        const duration = parseClipTime(durationTc);

        vcsRenderInputTimings.playbackEvents.push({
          frame,
          videoInputId,
          durationInFrames: Math.ceil(duration * fps),
          clipId,
          seqDir,
          w,
          h,
        });

        if (!batchEv.activeVideoInputSlots) batchEv.activeVideoInputSlots = [];
        batchEv.activeVideoInputSlots.push({
          id: videoInputId,
        });
      }
    }

    if (params && Object.keys(params).length > 0) {
      batchEv.params = { ...params };
    }

    vcsBatch.eventsByFrame[frame] = batchEv;
  }

  // -- write
  const batchJson = JSON.stringify(vcsBatch, null, 2);
  const inputTimings = JSON.stringify(vcsRenderInputTimings, null, 2);

  const batchOutFile = `${outFilePrefix}.vcsevents.json`;
  const inputTimingsOutFile = `${outFilePrefix}.vcsinputtimings.json`;

  fs.writeFileSync(batchOutFile, batchJson, { encoding: 'utf8' });
  fs.writeFileSync(inputTimingsOutFile, inputTimings, { encoding: 'utf8' });

  console.log(
    'JSON written to two files:\n%s\n%s',
    Path.resolve(batchOutFile),
    Path.resolve(inputTimingsOutFile)
  );
}
