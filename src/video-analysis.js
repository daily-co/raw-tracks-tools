/**
 * Builds the analysis object consumed by normalizeVideoTrackToM4V for aligning one
 * raw-tracks video file onto the session timeline.
 *
 * Everything in the returned object is in the webm's native PTS space. Event-derived
 * timestamps are in recording-relative seconds; the two differ by a small offset:
 *   ptsOffset = probe.startTime - track.startOffsetSecs
 *   PTS = recordingRelativeSecs + ptsOffset
 *
 * The output covers PTS [outputStartPts, outputEndPts]: black before the track's first
 * frame, black during pauses, black after the track's content ends.
 */
export function buildVideoAnalysis(
  track,
  probe,
  { outputStartPts = 0, outputEndPts, trackEndSecs }
) {
  const ptsOffset = probe.startTime - track.startOffsetSecs;

  const gaps = [];

  // Initial gap: black from output start to first frame
  if (probe.startTime > outputStartPts + 0.05) {
    gaps.push({ start: outputStartPts, end: probe.startTime });
  }

  // Pause intervals, converted to PTS space. Clamped to the output window: when a
  // fragment's file runs past the next fragment's start, a pause near the boundary
  // could otherwise extend the output past outputEndPts.
  for (const interval of track.pauseIntervals) {
    const pauseAt = Math.max(interval.pauseAt + ptsOffset, outputStartPts);
    const resumeAt = Math.min(
      (interval.resumeAt ?? trackEndSecs) + ptsOffset,
      outputEndPts
    );
    if (resumeAt - pauseAt > 0.001) gaps.push({ start: pauseAt, end: resumeAt });
  }

  // Trailing gap: black from track end to output end (if track ends early)
  const trackEndPts = trackEndSecs + ptsOffset;
  if (trackEndPts < outputEndPts - 0.1) {
    gaps.push({ start: trackEndPts, end: outputEndPts });
  }

  return {
    isVideo: true,
    startTime: probe.startTime,
    outputStartTime: outputStartPts,
    endTime: outputEndPts,
    videoSize: probe.videoSize,
    frameRate: probe.frameRate || 30,
    ptsOffset,
    gaps,
  };
}
