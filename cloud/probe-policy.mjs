// Operational warning threshold, not an SLA or a measurement of client latency.
// Only affects newly collected samples; historical readings are not reclassified.
export function tcpStatus(elapsed, configured) {
  if (!Number.isFinite(elapsed) || elapsed < 0) return "unknown";
  const value = Number(configured);
  const threshold = Number.isFinite(value) && value > 0 && value < 6000 ? value : 1000;
  return elapsed >= threshold ? "degraded" : "ok";
}

// Use pfSense's low/high gateway thresholds on the whole interval.
export function linkIntervalStatus(meanLatency, connectRate, pingRate) {
  if (meanLatency == null && connectRate == null && pingRate == null) return "unknown";
  const lowestRate = Math.min(connectRate ?? 100, pingRate ?? 100);
  if (meanLatency > 500 || lowestRate < 80) return "down";
  if (meanLatency >= 200 || lowestRate <= 90) return "degraded";
  return "ok";
}
