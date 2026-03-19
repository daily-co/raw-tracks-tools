/**
 * Monitors disk usage of tracked directories during compositing.
 * Periodically logs current and peak usage per directory, plus volume free space.
 */

import * as fs from 'node:fs';
import * as Path from 'node:path';

export function createStorageWatcher(volumePath, intervalMs = 5000) {
  const trackedDirs = new Map(); // label -> path
  let peakUsage = new Map(); // label -> bytes
  let totalPeakBytes = 0;
  let timer = null;
  let running = false;

  function addDir(label, dirPath) {
    trackedDirs.set(label, dirPath);
    if (!peakUsage.has(label)) {
      peakUsage.set(label, 0);
    }
  }

  function getDirSize(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = Path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          total += getDirSize(fullPath);
        } else if (entry.isFile()) {
          try {
            total += fs.statSync(fullPath).size;
          } catch (_) {}
        }
      }
    } catch (_) {}
    return total;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function sample() {
    let totalCurrentBytes = 0;
    const lines = [];

    for (const [label, dirPath] of trackedDirs) {
      const size = getDirSize(dirPath);
      totalCurrentBytes += size;
      const prev = peakUsage.get(label) ?? 0;
      if (size > prev) peakUsage.set(label, size);

      if (size > 0) {
        lines.push(`    ${label}: ${formatBytes(size)}`);
      }
    }

    if (totalCurrentBytes > totalPeakBytes) {
      totalPeakBytes = totalCurrentBytes;
    }

    // Volume free space
    let freeBytes = 0;
    try {
      const stats = fs.statfsSync(volumePath);
      freeBytes = stats.bsize * stats.bavail;
    } catch (_) {}

    if (lines.length > 0) {
      console.log(
        `[storage] current: ${formatBytes(totalCurrentBytes)}, peak: ${formatBytes(totalPeakBytes)}, free: ${formatBytes(freeBytes)}`
      );
      for (const line of lines) {
        console.log(line);
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(sample, intervalMs);
    timer.unref(); // don't keep process alive
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function summary() {
    const lines = [`[storage] Final summary — peak usage: ${formatBytes(totalPeakBytes)}`];
    for (const [label, peak] of peakUsage) {
      if (peak > 0) {
        lines.push(`    ${label}: peak ${formatBytes(peak)}`);
      }
    }

    let freeBytes = 0;
    try {
      const stats = fs.statfsSync(volumePath);
      freeBytes = stats.bsize * stats.bavail;
    } catch (_) {}
    lines.push(`    Volume free space: ${formatBytes(freeBytes)}`);

    return lines.join('\n');
  }

  return { addDir, start, stop, sample, summary };
}
