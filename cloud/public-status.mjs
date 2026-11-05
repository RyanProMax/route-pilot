// The public projection only reads typed measurements. Operational messages and reports stay private.
export const windows = { "24h": 1200, "7d": 8400, "30d": 36000 };
const ids = { heartbeat: "heartbeat", xray: "service", egress: "egress", edge4: "edge4", edge6: "edge6" };
const states = new Set(["ok", "degraded", "down", "unknown"]);
const safeStatus = value => states.has(value) ? value : "unknown";

function connectionRange(count) {
  if (!Number.isSafeInteger(count) || count < 0) return null;
  if (count < 10) return "<10";
  if (count < 30) return "<30";
  if (count < 50) return "<50";
  if (count < 100) return "<100";
  return "≥100";
}

export async function publicSummary(db, window, now, planGB) {
  return (await publicSummaries(db, [window], now, planGB))[window];
}

export async function publicSummaries(db, ranges, now, planGB) {
  const bounds = ranges.map(window => {
    const width = windows[window];
    return { window, width, start: (Math.floor(now / width) - 71) * width };
  });
  // Read current measurements once and retain each window's original resolution.
  const [latest, reports, events, ...histories] = await db.batch([
    db.prepare("SELECT check_id, ts, status, latency FROM latest"),
    db.prepare("SELECT ts, json_extract(metrics, '$.connections') AS connections, json_extract(metrics, '$.devices') AS devices, json_extract(metrics, '$.month_tx_bytes') AS usedBytes FROM reports ORDER BY minute DESC LIMIT 1"),
    db.prepare("SELECT check_id, status, ts FROM events WHERE ts>=? ORDER BY ts DESC, id DESC LIMIT 60")
      .bind(now - 72 * Math.max(...bounds.map(({ width }) => width))),
    ...bounds.flatMap(({ width, start }) => [
      db.prepare("SELECT check_id, bucket, n, ok, slow, down, missing FROM buckets WHERE width=? AND bucket>=? AND bucket<?")
        .bind(width, start, start + 72 * width),
      db.prepare("SELECT bucket, samples, peak, device_peak FROM connection_buckets WHERE width=? AND bucket>=? AND bucket<?")
        .bind(width, start, start + 72 * width)
    ])
  ]);
  return Object.fromEntries(bounds.map(({ window, width, start }, index) => [window,
    summarize(width, start, now, planGB, latest, reports, events, histories[index * 2], histories[index * 2 + 1])
  ]));
}

function summarize(width, start, now, planGB, latest, reports, events, buckets, connections) {
  const checks = Object.entries(ids).map(([internal, id]) => {
    const reading = latest.results.find(row => row.check_id === internal);
    const history = Array(72).fill("unknown");
    let total = 0, ok = 0;
    for (const b of buckets.results.filter(row => row.check_id === internal)) {
      const slot = (b.bucket - start) / width;
      history[slot] = b.down ? "down" : b.slow ? "degraded" : b.ok ? "ok" : "unknown";
      total += b.n - b.missing;
      ok += b.ok + b.slow;
    }
    const fresh = reading && now - reading.ts <= 150;
    return { id, status: fresh ? safeStatus(reading.status) : "unknown", at: reading?.ts ?? null,
      latency: fresh ? reading.latency : null, samples: total, rate: total ? 100 * ok / total : null, history };
  });
  const report = reports.results[0];
  const currentConnections = report && now - report.ts <= 150 ? connectionRange(report.connections) : null;
  const connectionHistory = Array(72).fill(null);
  const deviceHistory = Array(72).fill(null);
  let connectionSamples = 0;
  for (const bucket of connections.results) {
    connectionHistory[(bucket.bucket - start) / width] = connectionRange(bucket.peak);
    deviceHistory[(bucket.bucket - start) / width] = Number.isSafeInteger(bucket.device_peak) ? bucket.device_peak : null;
    connectionSamples += bucket.samples;
  }
  checks.push({
    id: "connections", status: currentConnections === null ? "unknown" : "ok",
    at: report?.ts ?? null, latency: null, rate: null, samples: connectionSamples,
    value: currentConnections, values: connectionHistory, deviceHistory,
    devices: currentConnections !== null && Number.isSafeInteger(report?.devices) && report.devices >= 0 ? report.devices : null,
    history: connectionHistory.map(value => value === null ? "unknown" : "ok")
  });
  const month = new Date(now * 1000).toISOString().slice(0, 7);
  const freshTraffic = report && now - report.ts <= 150 &&
    new Date(report.ts * 1000).toISOString().startsWith(month) &&
    Number.isSafeInteger(report.usedBytes) && report.usedBytes >= 0 &&
    Number.isSafeInteger(planGB) && planGB > 0;
  const traffic = freshTraffic ? {
    month, planGB, remainingGB: Math.round(Math.max(0, planGB - report.usedBytes / 1e9))
  } : null;
  return { at: now, start, width, checks, lastReport: report?.ts ?? null,
    connections: currentConnections, traffic,
    events: events.results.filter(e => e.ts >= now - 72 * width && Object.hasOwn(ids, e.check_id)).map(e => ({
      id: ids[e.check_id], status: safeStatus(e.status), at: e.ts
    })) };
}
