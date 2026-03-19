/**
 * Generate VCS batch JSON with dynamic participant add/remove/pause from event timeline.
 */

export function writeVcsBatchFromEvents(
  timeline,
  videoTrackDescs,
  {
    durationInFrames = 0,
    fps = 30,
    outputSize = { w: 1280, h: 720 },
    initialParams = {},
    windowStart = 0,
  }
) {
  const vcsBatch = {
    compositionId: 'daily:baseline',
    durationInFrames,
    framesPerSecond: fps,
    outputSize,
    eventsByFrame: {},
  };

  // Build a mapping from trackSessionNum to slot index + descriptor
  const trackToSlotIdx = new Map();
  for (const [idx, desc] of videoTrackDescs.entries()) {
    trackToSlotIdx.set(desc.trackSessionNum, idx);
  }

  // Build a mapping from participantId to their video slot index
  const participantToSlotIdx = new Map();
  for (const desc of videoTrackDescs) {
    if (desc && !participantToSlotIdx.has(desc.participantId)) {
      participantToSlotIdx.set(desc.participantId, trackToSlotIdx.get(desc.trackSessionNum));
    }
  }

  // Collect all grid-affecting events from the timeline, sorted by time
  const gridEvents = [];

  // For each participant with a video track, check if they had an earlier
  // audio track. If so, show a paused placeholder from the audio start
  // until the video track appears.
  for (const [participantId, participant] of timeline.participants) {
    const slotIdx = participantToSlotIdx.get(participantId);
    if (slotIdx === undefined) continue; // participant not in our video render set

    const desc = videoTrackDescs[slotIdx];
    const videoTrackNum = desc.trackSessionNum;
    const videoTrack = timeline.tracks.get(videoTrackNum);
    if (!videoTrack) continue;

    // Find the earliest audio track for this participant
    let earliestAudioStart = null;
    for (const audioNum of participant.audioTrackNums) {
      const audioTrack = timeline.tracks.get(audioNum);
      if (audioTrack?.startOffsetSecs != null) {
        if (earliestAudioStart === null || audioTrack.startOffsetSecs < earliestAudioStart) {
          earliestAudioStart = audioTrack.startOffsetSecs;
        }
      }
    }

    // If audio started before video, emit a paused placeholder at audio start
    if (
      earliestAudioStart != null &&
      videoTrack.startOffsetSecs != null &&
      earliestAudioStart < videoTrack.startOffsetSecs
    ) {
      gridEvents.push({
        timeSecs: earliestAudioStart,
        action: 'add-paused',
        slotIdx,
        desc,
      });
    }
  }

  for (const [trackSessionNum, track] of timeline.tracks) {
    if (track.kind !== 'video') continue;

    const slotIdx = trackToSlotIdx.get(trackSessionNum);
    if (slotIdx === undefined) continue; // track not in our render set

    const desc = videoTrackDescs[slotIdx];

    // Track added event.
    // If firstFrameSecs > startOffsetSecs, add as paused first (placeholder)
    // then transition to active when real frames begin.
    if (track.startOffsetSecs != null) {
      if (desc.firstFrameSecs && desc.firstFrameSecs > track.startOffsetSecs + 0.1) {
        gridEvents.push({
          timeSecs: track.startOffsetSecs,
          action: 'add-paused',
          slotIdx,
          desc,
        });
        gridEvents.push({
          timeSecs: desc.firstFrameSecs,
          action: 'add',
          slotIdx,
          desc,
        });
      } else {
        gridEvents.push({
          timeSecs: track.startOffsetSecs,
          action: 'add',
          slotIdx,
          desc,
        });
      }
    }

    // Pause/resume events
    for (const interval of track.pauseIntervals) {
      gridEvents.push({
        timeSecs: interval.pauseAt,
        action: 'pause',
        slotIdx,
        desc,
      });
      if (interval.resumeAt != null) {
        gridEvents.push({
          timeSecs: interval.resumeAt,
          action: 'resume',
          slotIdx,
          desc,
        });
      }
    }

    // Track removed event
    if (track.removedAtSecs != null) {
      gridEvents.push({
        timeSecs: track.removedAtSecs,
        action: 'remove',
        slotIdx,
        desc,
      });
    }
  }

  gridEvents.sort((a, b) => a.timeSecs - b.timeSecs);

  // Build initial state by replaying events up to windowStart
  let activeVideoInputSlots = [];

  const preWindowEvents = gridEvents.filter(
    (e) => e.timeSecs < windowStart
  );
  const windowEvents = gridEvents.filter(
    (e) => e.timeSecs >= windowStart
  );

  for (const ev of preWindowEvents) {
    applyGridEvent(activeVideoInputSlots, ev);
  }

  // Emit initial state at frame 0
  vcsBatch.eventsByFrame[0] = {
    activeVideoInputSlots: [...activeVideoInputSlots],
    params: {
      mode: 'grid',
      'videoSettings.showParticipantLabels': true,
      enableLayoutAnims: true,
      'toast.source': 'chatMessages',
      'toast.duration_secs': 5,
      'toast.showIcon': false,
      ...initialParams,
    },
  };

  // Emit events within the window
  for (const ev of windowEvents) {
    const timeSinceWindowStart = ev.timeSecs - windowStart;
    if (timeSinceWindowStart >= durationInFrames / fps) break;

    const frameIdx = Math.round(timeSinceWindowStart * fps);
    if (frameIdx < 0) continue;

    activeVideoInputSlots = [...activeVideoInputSlots];
    applyGridEvent(activeVideoInputSlots, ev);

    const batchEv = vcsBatch.eventsByFrame[frameIdx] ?? {};
    batchEv.activeVideoInputSlots = [...activeVideoInputSlots];
    vcsBatch.eventsByFrame[frameIdx] = batchEv;
  }

  // Emit chat messages as standard source messages
  if (timeline.chatMessages) {
    for (const msg of timeline.chatMessages) {
      const timeSinceWindowStart = msg.timeSecs - windowStart;
      if (timeSinceWindowStart < 0 || timeSinceWindowStart >= durationInFrames / fps) continue;

      const frameIdx = Math.round(timeSinceWindowStart * fps);
      const batchEv = vcsBatch.eventsByFrame[frameIdx] ?? {};
      batchEv.standardSourceMessage = {
        sourceId: 'chatMessages',
        data: {
          key: msg.key,
          senderDisplayName: msg.senderDisplayName,
          text: msg.text,
        },
      };
      vcsBatch.eventsByFrame[frameIdx] = batchEv;
    }
  }

  return vcsBatch;
}

function applyGridEvent(slots, ev) {
  const { action, slotIdx, desc } = ev;

  switch (action) {
    case 'add':
    case 'resume':
      slots[slotIdx] = {
        id: desc.videoInputId,
        displayName: desc.displayName,
      };
      break;
    case 'add-paused':
      // Only apply if slot isn't already occupied (don't override active video)
      if (!slots[slotIdx]) {
        slots[slotIdx] = {
          id: desc.videoInputId,
          displayName: desc.displayName,
          paused: true,
        };
      }
      break;
    case 'pause':
      slots[slotIdx] = {
        id: desc.videoInputId,
        displayName: desc.displayName,
        paused: true,
      };
      break;
    case 'remove':
      slots[slotIdx] = null;
      break;
  }
}
