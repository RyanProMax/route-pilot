import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { applyAggregates } from '../../cloud/aggregate.mjs';
import { linkSummary } from '../../cloud/mac-probe.mjs';

// Read closed windows and in-progress minutes in one SQLite snapshot across the rollover.
const exportWindows = `
import json, sqlite3, sys
from pathlib import Path
folder = Path.home() / 'Library/Application Support/routepilot/mac-probe'
sys.path.insert(0, str(folder))
from routepilot_aggregate import link_check
db = sqlite3.connect((folder / 'aggregate.sqlite3').as_uri() + '?mode=ro', uri=True)
keys = ('id','n','ok','slow','down','missing','latency_sum','latency_n','latency_max')
packet_keys = ('packets_sent','packets_received','ipv6_packets_sent','ipv6_packets_received')
db.execute('BEGIN')
output = []
for (payload,) in db.execute('SELECT payload FROM windows ORDER BY start'):
    w = json.loads(payload)
    last = w.get('last')
    check = next(c for c in w['checks'] if c['id'] == 'link')
    output.append({'start': w['start'], 'checks': [{k:check[k] for k in (*keys,*packet_keys) if k in check}],
                   'last': {'ts':last['ts'],'checks':[link_check(last)]} if last else None})
for (payload,) in db.execute('SELECT payload FROM minutes ORDER BY minute'):
    sample = json.loads(payload)
    ts = sample['last']['ts']
    check = next(c for c in sample['checks'] if c['id'] == 'link')
    ms, status = check['latency'], check['status']
    row = {'id':'link', 'n':1, 'ok':int(status=='ok'), 'slow':int(status=='degraded'),
           'down':int(status=='down'), 'missing':int(status=='unknown'),
           'latency_sum':ms or 0, 'latency_n':int(ms is not None), 'latency_max':ms}
    row.update({k:check[k] for k in packet_keys if k in check})
    output.append({'start':ts, 'minuteSample':True, 'checks':[row],
                   'last':{'ts':ts, 'checks':[{'id':'link','status':status,'latency':ms}]}})
db.close()
print(json.dumps(output, separators=(',',':')))
`;

export async function macPreview(host, instanceId, origin, historyFile) {
  if (!origin || !instanceId || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) || !/^[a-z][a-z0-9-]{0,39}$/.test(instanceId)) {
    throw Error('Set the public origin, Mac SSH alias and matching public instance ID for the probe preview.');
  }
  // Frozen pre-cutover D1 rollups are disjoint from the Mac's aggregate windows.
  let legacyBuckets = [];
  if (historyFile) {
    const archive = JSON.parse(await readFile(historyFile, 'utf8'));
    if (archive.instanceId !== instanceId || !Array.isArray(archive.buckets)) throw Error('Invalid legacy probe archive');
    legacyBuckets = archive.buckets;
  }
  let windows = [], nextRead = 0, pending;
  async function readWindows() {
    if (pending) return pending;
    if (Date.now() < nextRead) return windows;
    pending = new Promise(resolve => {
      const ssh = execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', host, 'python3 -B -'],
        { timeout: 6000, maxBuffer: 2_000_000, windowsHide: true }, (error, stdout) => {
          if (!error) {
            try { windows = JSON.parse(stdout); } catch { error = Error('Invalid probe cache'); }
          }
          if (error) console.warn('Mac probe preview unavailable. Retaining the last measured windows.');
          nextRead = Date.now() + 60_000;
          resolve(windows);
        });
      ssh.stdin.on('error', () => {});
      ssh.stdin.end(exportWindows);
    }).finally(() => { pending = undefined; });
    return pending;
  }

  const prefix = '/status/' + instanceId + '/';
  return {
    name: 'local-mac-probe-preview',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url ?? '';
        if (req.method !== 'GET' || !path.startsWith(prefix) ||
            !['all.json', '24h.json', '7d.json', '30d.json'].includes(path.slice(prefix.length))) return next();
        try {
          const upstream = await fetch(new URL(path, origin), { redirect: 'error', signal: AbortSignal.timeout(7000) });
          if (!upstream.ok) return next();
          const data = await upstream.json();
          if (data.instanceId !== instanceId) return next();
          for (const summary of data.windows ? Object.values(data.windows) : [data]) {
            const existing = summary.checks.findIndex(c => c.id === 'link');
            if (existing >= 0 && summary.checks[existing].intervals?.some(i => i && 'replyRate' in i)) continue;
            const records = (await readWindows()).filter(w => (w.minuteSample ? w.start : w.start + 1200) <= summary.at);
            const legacy = legacyBuckets.filter(b => b.width === summary.width && b.bucket >= summary.start && b.bucket <= summary.at);
            const latest = { results: [] };
            const buckets = { results: legacy.map(b => ({ ...b, check_id: 'link' })) };
            applyAggregates(records, 'mac', [summary], latest, { results: [] }, [buckets]);
            if (records.at(-1)?.minuteSample && latest.results.length) {
              Object.assign(latest.results[0], {freshFor:150, cadence:60});
            }
            const link = linkSummary(summary, summary.at, latest, buckets);
            if (existing >= 0) {
              if (records.length || legacy.length) summary.checks[existing] = link;
            } else {
              const index = summary.checks.findIndex(c => c.id === 'connections');
              summary.checks.splice(index < 0 ? summary.checks.length : index, 0, link);
            }
          }
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(data));
        } catch { next(); }
      });
    },
  };
}
