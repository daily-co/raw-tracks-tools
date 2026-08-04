/**
 * Where does an audio track belong on the recording timeline?
 *
 * This lives in its own module because getting it wrong is invisible: the
 * output is a valid audio file either way, just with a participant in the wrong
 * place. The composite mix path and the individual-tracks export path used to
 * answer this question separately and gave contradictory answers, so it is now
 * one pure function with tests.
 */

/**
 * Gapless transcoded sources are the WAV or AAC files produced when
 * enable_raw_tracks_transcoded_audio is set on the room or domain. Anything
 * else is the default Opus-in-WebM output.
 */
export function isGaplessTranscodedTrack(track) {
  return Boolean(track.contentType) && track.contentType !== 'audio/webm';
}

/**
 * Build the analysis object normalizeAudioTrack needs, deciding the head offset
 * that places this track on the recording timeline.
 *
 * @param track   parsed track from the events JSON (contentType, startOffsetSecs)
 * @param probe   probeTrack result for this track (startTime)
 * @param sessionDurationSecs  timeline.sessionDurationSecs
 */
export function buildAudioAnalysis(track, probe, sessionDurationSecs) {
  if (!probe) {
    throw new Error(`No probe result for track ${track.trackSessionNum}`);
  }

  // A gapless transcoded source is NOT on the recording timeline. Server-side,
  // recording_start_ts is applied only to the WebM muxer: the WAV path has no
  // muxer at all and the AAC path muxes with offset-to-zero, so the file's first
  // sample is the participant's first media rather than recording time zero.
  // The head offset therefore has to come from the events JSON, because the file
  // itself cannot say where it belongs. probe.startTime is ~0 for these, and
  // trusting it drops every participant to the start of the call.
  if (isGaplessTranscodedTrack(track)) {
    if (track.startOffsetSecs == null) {
      throw new Error(
        `Track ${track.trackSessionNum} is transcoded (${track.contentType}) but has ` +
          `no startOffsetSecs, so it cannot be placed on the recording timeline`
      );
    }
    // startOffsetSecs is already in the events-JSON timeline, so unlike the WebM
    // branch there is no pts conversion to apply to the end time either.
    return {
      isVideo: false,
      startTime: track.startOffsetSecs,
      endTime: sessionDurationSecs,
    };
  }

  // WebM carries real recording-relative timestamps, so the file itself is the
  // better source for the head offset. adelay pads from time 0 to
  // probe.startTime, matching the video normalization which pads with black from
  // 0 to first frame. Both files share the same timeline: position T = recording
  // time T. sessionDurationSecs comes from the events JSON, so it needs
  // converting into the file's pts space to be used as an end time.
  const ptsOffset = probe.startTime - track.startOffsetSecs;

  return {
    isVideo: false,
    startTime: probe.startTime,
    endTime: sessionDurationSecs + ptsOffset,
  };
}
