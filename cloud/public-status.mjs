import { readAggregates, applyAggregates, appendAggregateEvents } from './aggregate.mjs';
import { historyBuckets, linkSummary } from './mac-probe.mjs';
// The public projection only reads typed measurements. Operational messages and reports stay private.
import { hostLoad } from './private-api.mjs';
export const windows = { "24h": 1200, "7d": 8400, "30d": 36000 };
const coreIds = { heartbeat: "heartbeat", xray: "service", egress: "egress" };
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

export async function publicSummary(db, window, now, planGB, legacyEntries = false) {
  return (await publicSummaries(db, [window], now, planGB, legacyEntries))[window];
}

export async function publicSummaries(db, ranges, now, planGB, legacyEntries = false) {
  const bounds = ranges.map(window => {
    const width = windows[window];
    return { window, width, start: (Math.floor(now / width) - 71) * width };
  });
  // Read current measurements once and retain each window's original resolution.
  const [latest, reports, events, ...histories] = await db.batch([
    db.prepare("SELECT check_id, ts, status, latency FROM latest"),
    db.prepare("SELECT ts, json_extract(metrics, '$.cpu_percent') AS cpu_percent, json_extract(metrics, '$.load1') AS load1, json_extract(metrics, '$.memory_used') AS memory_used, json_extract(metrics, '$.memory_total') AS memory_total, json_extract(metrics, '$.disk_used') AS disk_used, json_extract(metrics, '$.disk_total') AS disk_total, json_extract(metrics, '$.connections') AS connections, json_extract(metrics, '$.devices') AS devices, json_extract(metrics, '$.month_tx_bytes') AS usedBytes FROM reports ORDER BY minute DESC LIMIT 1"),
    db.prepare("SELECT check_id, status, ts FROM events WHERE ts>=? ORDER BY ts DESC, id DESC LIMIT 60")
      .bind(now - 72 * Math.max(...bounds.map(({ width }) => width))),
    ...bounds.flatMap(({ width, start }) => [
      historyBuckets(db, width, start),
      db.prepare("SELECT bucket, samples, peak, device_peak FROM connection_buckets WHERE width=? AND bucket>=? AND bucket<?")
        .bind(width, start, start + 72 * width)
    ])
  ]);
  const start = Math.min(...bounds.map(b => b.start));
  const aggregate = await readAggregates(db, 'vps', start);
  const mac = await readAggregates(db, 'mac', start);
  const ids = legacyEntries && !aggregate.results.length ? { ...coreIds, edge4: 'edge4', edge6: 'edge6' } : coreIds;
  const buckets = bounds.map((_, i) => histories[i * 2]);
  applyAggregates(mac, 'mac', bounds, latest, reports, buckets);

  appendAggregateEvents(aggregate,events);
  applyAggregates(aggregate,'vps',bounds,latest,reports,buckets,bounds.map((_,i)=>histories[i*2+1]));
  return Object.fromEntries(bounds.map(({ window, width, start }, index) => [window,
    summarize(ids, width, start, now, planGB, latest, reports, events, histories[index * 2], histories[index * 2 + 1])
  ]));
}

function summarize(ids, width, start, now, planGB, latest, reports, events, buckets, connections) {
  const checks = Object.entries(ids).map(([internal, id]) => {
    const reading = latest.results.find(row => row.check_id === internal);
    const history = Array(72).fill("unknown");
    let total = 0, ok = 0, failed = 0, slow = 0, latencySum = 0, latencyN = 0,maxLatency=null;
    for (const b of buckets.results.filter(row => row.check_id === internal)) {
      const slot = (b.bucket - start) / width;
      const expected=Math.max(1,Math.ceil((Math.min(now,b.bucket+width)-b.bucket)/(internal==='egress'?1200:60)));
      history[slot] = b.down ? "down" : b.slow ? "degraded" : b.aggregated&&(b.missing>0||b.n<expected) ? "unknown" : b.ok ? "ok" : "unknown";
      total += b.n - b.missing;
      ok += b.ok + b.slow;
      failed += b.down; slow += b.slow;
      latencySum += b.latency_sum; latencyN += b.latency_n;
      if(b.latency_max!==undefined&&b.latency_max!==null)maxLatency=Math.max(maxLatency??0,b.latency_max);
    }
    const fresh = reading && now - reading.ts <= (reading.freshFor??150);
    return { id, freshFor:reading?.freshFor??150,cadence:reading?.cadence??60,status: fresh ? safeStatus(reading.status) : "unknown", at: reading?.ts ?? null,
      latency: fresh ? reading.latency : null, samples: total, rate: total ? 100 * ok / total : null,
      failedSamples: failed, slowSamples: slow,
      maxLatency,meanLatency: latencyN ? Math.round(latencySum / latencyN) : null, history };
  });
  const report = reports.results[0];
  const currentConnections = report && now - report.ts <= (report.freshFor??150) ? connectionRange(report.connections) : null;
  const connectionHistory = Array(72).fill(null);
  const deviceHistory = Array(72).fill(null);
  let connectionSamples = 0;
  const connectionHealth=Array(72).fill("unknown");
  for (const bucket of connections.results) {
    connectionHistory[(bucket.bucket - start) / width] = connectionRange(bucket.peak);
    deviceHistory[(bucket.bucket - start) / width] = Number.isSafeInteger(bucket.device_peak) ? bucket.device_peak : null;
    connectionSamples += bucket.samples;
    const slot=(bucket.bucket-start)/width;
    const expected=Math.max(1,Math.ceil((Math.min(now,bucket.bucket+width)-bucket.bucket)/60));
    connectionHealth[slot]=bucket.aggregated&&bucket.samples<expected?'unknown':'ok';
  }
  checks.push(linkSummary({start, width}, now, latest, buckets));
  checks.push({
    id: "connections",freshFor:report?.freshFor??150,cadence:report?.cadence??60,status: currentConnections === null ? "unknown" : "ok",
    at: report?.ts ?? null, latency: null, rate: null, samples: connectionSamples,
    value: currentConnections, values: connectionHistory, deviceHistory,
    devices: currentConnections !== null && Number.isSafeInteger(report?.devices) && report.devices >= 0 ? report.devices : null,
    history: connectionHealth
  });
  const month = new Date(now * 1000).toISOString().slice(0, 7);
  const freshTraffic = report && now - report.ts <= (report.freshFor??150) &&
    new Date(report.ts * 1000).toISOString().startsWith(month) &&
    Number.isSafeInteger(report.usedBytes??report.month_tx_bytes) && (report.usedBytes??report.month_tx_bytes) >= 0 &&
    Number.isSafeInteger(planGB) && planGB > 0;
  const traffic = freshTraffic ? {
    month, planGB, remainingGB: Math.round(Math.max(0, planGB - (report.usedBytes??report.month_tx_bytes) / 1e9))
  } : null;
  return { at: now, start, width,freshFor:report?.freshFor??150,cadence:report?.cadence??60,checks, lastReport: report?.ts ?? null,
    connections: currentConnections, traffic, load:hostLoad(report ?? {},report?.ts,now,report?.freshFor??150),
    events: events.results.filter(e => e.ts >= now - 72 * width && Object.hasOwn(ids, e.check_id)).map(e => ({
      id: ids[e.check_id], status: safeStatus(e.status), at: e.ts
    })) };
}
