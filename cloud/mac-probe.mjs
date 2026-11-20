import { validEchoCounts, normalizeWindows, aggregateStatements, lastWindow, validateWindowSequence, readAggregates, applyAggregates, appendAggregateEvents, invalidateAggregateCache } from './aggregate.mjs';
import { tcpStatus } from './probe-policy.mjs';

// Dedicated credential can write only the combined link measurement, never VPS health.
export function normalizeMacProbe(input, now) {
  if (input?.schema !== 1 || input.path !== 'physical-interface' || input.protocol !== 'tcp-connect' ||
      !Number.isSafeInteger(input.ts) || input.ts > now + 15 || now - input.ts > 120 ||
      !Array.isArray(input.results) || input.results.length !== 2) throw Error('Invalid probe');
  if (input.icmp !== undefined && !validEchoCounts(input.icmp?.sent, input.icmp?.received, 3)) throw Error('ICMP counts');
  const seen = new Set();
  const results = input.results.map(r => {
    if (![4, 6].includes(r.family) || seen.has(r.family)) throw Error('Invalid family');
    seen.add(r.family);
    if (!['ok', 'timeout', 'failed', 'unavailable'].includes(r.outcome)) throw Error('Invalid outcome');
    if (r.outcome === 'ok' ? !Number.isFinite(r.ms) || r.ms < 0 || r.ms >= 5000 : r.ms !== null) throw Error('Invalid duration');
    return {id: `mac${r.family}`, ts: input.ts,
      status: r.outcome === 'ok' ? tcpStatus(r.ms, 500) : ['timeout','failed'].includes(r.outcome) ? 'down' : 'unknown',
      latency: r.outcome === 'ok' ? r.ms : null};
  });
  const valid = results.filter(r => r.latency !== null);
  const latency = valid.length ? Math.round(valid.reduce((sum,r) => sum+r.latency,0)/valid.length) : null;
  return [{id:'link',ts:input.ts,latency,status:latency !== null ? tcpStatus(latency,500) : results.some(r=>r.status==='down') ? 'down' : 'unknown'}];
}

export async function ingestMacProbe(request, env, now) {
  const reply = (data, status) => Response.json(data, {status, headers:{'Cache-Control':'no-store'}});
  const bearer = request.headers.get('authorization') || '';
  if (!env.MAC_PROBE_SHA256 || !bearer.startsWith('Bearer ') || bearer.length > 207) return reply({error:'Unauthorized'},401);
  const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bearer.slice(7)));
  const digest = Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
  if (digest !== env.MAC_PROBE_SHA256) return reply({error:'Unauthorized'},401);
  if (env.PRIVATE_LIMIT && !(await env.PRIVATE_LIMIT.limit({key:'mac-probe'})).success) return reply({error:'Rate limited'},429);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({error:'JSON required'},400);
  // Bound the body even when no Content-Length header was provided.
  const reader=request.body?.getReader(); let raw='', size=0; const decoder=new TextDecoder();
  if (!reader) return reply({error:'Body required'},400);
  while (true) {
    const {done,value}=await reader.read(); if(done) break;
    size+=value.byteLength;
    if(size>131072) {await reader.cancel();return reply({error:'Too large'},413);}
    raw+=decoder.decode(value,{stream:true});
  }
  let input;
  try {input=JSON.parse(raw+decoder.decode());}catch{return reply({error:size>2048?'Too large':'Invalid JSON'},size>2048?413:400);}
  if(input?.schema===2){
    if(!Number.isSafeInteger(input.ts)||Math.abs(now-input.ts)>120)return reply({error:'Invalid timestamp'},400);
    if(input.ackOnly===true)return reply({accepted:true,last_window:await lastWindow(env.DB,'mac')},200);
    let windows;
    try{
      windows=normalizeWindows(input.windows,'mac',now);
      for(const w of windows){
        if(w.last!==null){
          if(!Number.isSafeInteger(w.last.ts)||w.last.ts<w.start||w.last.ts>=w.start+1200)throw Error('last');
          w.last={ts:w.last.ts,checks:normalizeMacProbe(w.last,w.last.ts)};
        }
      }
      await validateWindowSequence(env.DB,'mac',windows,now);
    }catch{return reply({error:'Invalid aggregate'},400);}
    await env.DB.batch(aggregateStatements(env.DB,'mac',windows));
    invalidateAggregateCache(env.DB,'mac');
    return reply({accepted:true,last_window:await lastWindow(env.DB,'mac')},200);
  }
  if(size>2048)return reply({error:'Too large'},413);
  let rows;
  try {rows=normalizeMacProbe(input,now);} catch {return reply({error:'Invalid or expired probe'},400);}
  const statements = [];
  if (input.icmp) {
    // The first sample for a minute owns both its TCP and ICMP measurements.
    const minute = Math.floor(input.ts / 60);
    statements.push(env.DB.prepare(`INSERT INTO link_packet_buckets(width,bucket,sent,received)
      SELECT width,(CAST(? AS INTEGER)/width)*width,?,? FROM (SELECT 1200 AS width UNION ALL SELECT 8400 UNION ALL SELECT 36000)
      WHERE NOT EXISTS (SELECT 1 FROM samples WHERE check_id='link' AND minute=?)
      ON CONFLICT(width,bucket) DO UPDATE SET sent=sent+excluded.sent,received=received+excluded.received`)
      .bind(input.ts, input.icmp.sent, input.icmp.received, minute));
  }
  await env.DB.batch([...statements, ...rows.map(r=>env.DB.prepare('INSERT INTO samples(check_id,minute,ts,status,message,latency) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING')
    .bind(r.id,Math.floor(r.ts/60),r.ts,r.status,'Mac physical-interface TCP connect',r.latency))]);
  return reply({accepted:true},200);
}

export function historyBuckets(db, width, start, linkOnly = false) {
  return db.prepare(`SELECT b.*, p.sent AS packets_sent, p.received AS packets_received
    FROM buckets b LEFT JOIN link_packet_buckets p
      ON b.check_id='link' AND p.width=b.width AND p.bucket=b.bucket
    WHERE b.width=? AND b.bucket>=? AND b.bucket<? ${linkOnly ? "AND b.check_id='link'" : ''}`)
    .bind(width, start, start + 72 * width);
}

// Also retained in the console response for existing clients.
export async function macProbeSummaries(db, now) {
  const ranges={"24h":1200,"7d":8400,"30d":36000};
  const bounds=Object.entries(ranges).map(([range,width])=>({range,width,start:(Math.floor(now/width)-71)*width}));
  const [latest,...histories]=await db.batch([
    db.prepare("SELECT check_id,ts,status,latency FROM latest WHERE check_id IN ('link')"),
    ...bounds.map(b=>historyBuckets(db,b.width,b.start,true))
  ]);
  const aggregate=await readAggregates(db,'mac',Math.min(...bounds.map(b=>b.start)));
  const events={results:[]};appendAggregateEvents(aggregate,events);
  applyAggregates(aggregate,'mac',bounds,latest,{results:[]},histories);
  return Object.fromEntries(bounds.map((b,index)=>[b.range,{
    at:now,start:b.start,width:b.width,lastReport:null,connections:null,traffic:null,load:null,events:events.results.filter(e=>e.ts>=b.start).map(e=>({id:e.check_id,status:e.status,at:e.ts})),
    checks: latest.results.some(row => row.check_id === 'link')
      ? [linkSummary(b, now, latest, histories[index])] : []
  }]));
}

// Both views use the same typed measurements. No probe reports or addresses leave this projection.
export function linkSummary({ start, width }, now, latest, buckets) {
  const last = latest.results.find(row => row.check_id === 'link');
  const history = Array(72).fill('unknown');
  const coverage = Array(72).fill(null);
  const intervals = Array(72).fill(null);
  let samples = 0, success = 0, failed = 0, slow = 0;
  let latencySum = 0, latencyCount = 0, maxLatency = null;
  for (const row of buckets.results) {
    if (row.check_id !== 'link') continue;
    const slot = (row.bucket - start) / width;
    const expected = Math.max(1, Math.ceil((Math.min(now, row.bucket + width) - row.bucket) / 60));
    const valid = row.n - row.missing;
    coverage[slot] = Math.min(100, Math.round(100 * valid / expected));
    intervals[slot] = {
      meanLatency: row.latency_n ? Math.round(row.latency_sum / row.latency_n) : null,
      replyRate: row.packets_sent ? 100 * row.packets_received / row.packets_sent : null,
    };
    history[slot] = row.down ? 'down' : row.slow ? 'degraded' : row.ok ? 'ok' : 'unknown';
    samples += valid;
    success += row.ok + row.slow;
    failed += row.down;
    slow += row.slow;
    latencySum += row.latency_sum;
    latencyCount += row.latency_n;
    if (row.latency_max != null) maxLatency = Math.max(maxLatency ?? 0, row.latency_max);
  }
  const freshFor = last?.freshFor ?? 150;
  const fresh = last && last.ts <= now + 15 && now - last.ts <= freshFor;
  return {
    id: 'link', at: last?.ts ?? null, freshFor, cadence: last?.cadence ?? 60,
    status: fresh ? last.status : 'unknown', latency: fresh ? last.latency : null,
    samples, rate: samples ? 100 * success / samples : null, failedSamples: failed, slowSamples: slow,
    meanLatency: latencyCount ? Math.round(latencySum / latencyCount) : null, maxLatency, history, coverage, intervals,
  };
}
