// Operational warning threshold, not an SLA or a measurement of client latency.
// Only affects newly collected samples; historical readings are not reclassified.
export function tcpStatus(elapsed, configured) {
  if (!Number.isFinite(elapsed) || elapsed < 0) return "unknown";
  const value = Number(configured);
  const threshold = Number.isFinite(value) && value > 0 && value < 6000 ? value : 1000;
  return elapsed >= threshold ? "degraded" : "ok";
}
