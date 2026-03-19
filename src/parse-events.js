/**
 * Parses a Daily raw-tracks event JSON into a structured RecordingTimeline.
 */

const CONTENT_TYPE_EXTS = {
  'video/webm': '.webm',
  'audio/webm': '.webm',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
  'audio/mp4': '.aac',
};

function contentTypeToExt(contentType) {
  if (contentType && CONTENT_TYPE_EXTS[contentType]) {
    return CONTENT_TYPE_EXTS[contentType];
  }
  // Default to .webm for unknown or missing content types
  return '.webm';
}

export function parseEventJson(eventJson) {
  const { events } = eventJson;
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Event JSON has no events array');
  }

  // Derive recordingStartTs from the first recording-media-started URI prefix
  let recordingStartTs = null;
  for (const ev of events) {
    if (ev.type === 'recording-media-started') {
      const uriParts = ev.data.uri.split('/');
      const filename = uriParts[uriParts.length - 1];
      const dashIdx = filename.indexOf('-');
      if (dashIdx > 0) {
        recordingStartTs = parseInt(filename.substring(0, dashIdx), 10);
        break;
      }
    }
  }
  if (!recordingStartTs) {
    throw new Error('Could not derive recordingStartTs from event data');
  }

  const recordingStartSecs = recordingStartTs / 1000;

  const tracks = new Map(); // trackSessionNum -> TrackSession
  const participants = new Map(); // participantId -> { displayName, videoTrackNums[], audioTrackNums[] }
  let chatMessages = null;

  for (const ev of events) {
    const { type, participant_id, data } = ev;

    if (type === 'track-added') {
      const {
        trackSessionNum,
        kind,
        trackType,
        displayName,
        paused,
      } = data;

      const track = {
        trackSessionNum,
        participantId: participant_id,
        displayName,
        kind,
        trackType,
        filename: null,
        contentType: null,
        mediaStartTime: null,
        startOffsetSecs: null,
        pauseIntervals: [],
        removedAtSecs: null,
      };

      // If track starts paused, open a pause interval at event time
      if (paused) {
        track.pauseIntervals.push({
          pauseAt: ev.ts - recordingStartSecs,
          resumeAt: null,
        });
      }

      tracks.set(trackSessionNum, track);

      // Update participant map
      if (!participants.has(participant_id)) {
        participants.set(participant_id, {
          displayName,
          videoTrackNums: [],
          audioTrackNums: [],
        });
      }
      const p = participants.get(participant_id);
      // Update display name to latest
      p.displayName = displayName;

      if (kind === 'video') {
        p.videoTrackNums.push(trackSessionNum);
      } else if (kind === 'audio') {
        p.audioTrackNums.push(trackSessionNum);
      }
    } else if (type === 'recording-media-started') {
      const { trackSessionNum, uri, mediaStartTime, contentType } = data;
      const track = tracks.get(trackSessionNum);
      if (!track) {
        console.warn(
          `recording-media-started for unknown trackSessionNum ${trackSessionNum}`
        );
        continue;
      }

      // Derive filename from URI: last path component + extension from content type
      const uriParts = uri.split('/');
      const uriBasename = uriParts[uriParts.length - 1];
      const ext = contentTypeToExt(contentType);
      track.filename = uriBasename + ext;
      track.contentType = contentType ?? null;
      track.mediaStartTime = mediaStartTime;
      track.startOffsetSecs = mediaStartTime - recordingStartSecs;
    } else if (type === 'track-paused') {
      const { trackSessionNum } = data;
      const track = tracks.get(trackSessionNum);
      if (!track) continue;

      // Open a pause interval
      const lastPause = track.pauseIntervals[track.pauseIntervals.length - 1];
      if (lastPause && lastPause.resumeAt === null) {
        // Already paused, ignore duplicate
        continue;
      }
      track.pauseIntervals.push({
        pauseAt: ev.ts - recordingStartSecs,
        resumeAt: null,
      });
    } else if (type === 'track-resumed') {
      const { trackSessionNum } = data;
      const track = tracks.get(trackSessionNum);
      if (!track) continue;

      // Close the last open pause interval
      const lastPause = track.pauseIntervals[track.pauseIntervals.length - 1];
      if (lastPause && lastPause.resumeAt === null) {
        lastPause.resumeAt = ev.ts - recordingStartSecs;
      }
    } else if (type === 'chat-msg') {
      // Only collect actual chat messages, not reactions
      if (data.event === 'chat-msg' && data.message) {
        if (!chatMessages) chatMessages = [];
        chatMessages.push({
          timeSecs: ev.ts - recordingStartSecs,
          senderDisplayName: data.name ?? '',
          text: data.message,
          key: `chat_${chatMessages.length}`,
        });
      }
    } else if (type === 'track-removed') {
      const { trackSessionNum } = data;
      const track = tracks.get(trackSessionNum);
      if (!track) continue;

      track.removedAtSecs = ev.ts - recordingStartSecs;

      // Close any open pause interval
      const lastPause = track.pauseIntervals[track.pauseIntervals.length - 1];
      if (lastPause && lastPause.resumeAt === null) {
        lastPause.resumeAt = track.removedAtSecs;
      }
    }
  }

  // Compute session duration from the last event timestamp
  const lastEvent = events[events.length - 1];
  const sessionDurationSecs = lastEvent.ts - recordingStartSecs;

  return {
    recordingStartTs,
    tracks,
    participants,
    chatMessages: chatMessages ?? [],
    sessionDurationSecs,
  };
}
