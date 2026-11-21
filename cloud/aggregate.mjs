// A completed window is immutable. Its unique source/start key makes retries
// exactly-once. Readers combine these rows with untouched legacy rollups.
const allowed={vps:['heartbeat','xray'],mac:['link']};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export function validEchoCounts(sent, received, limit) {
  return integer(sent, 1, limit) && integer(received, 0, sent);
}
export function normalizeWindows(windows,source,now) {
  if(!Object.hasOwn(allowed,source)||!Array.isArray(windows)||windows.length>16)throw Error('windows');
  const seen=new Set();let previous=-1;
  return windows.map(w=>{
    if(!integer(w?.start,now-31*86400,now-1200)||w.start%1200||seen.has(w.start))throw Error('window time');
    if(w.start<=previous)throw Error('window order');previous=w.start;seen.add(w.start);
    if(!Array.isArray(w.checks)||w.checks.length!==allowed[source].length)throw Error('checks');
    const ids=new Set();
    const checks=w.checks.map(c=>{
      if(!allowed[source].includes(c?.id)||ids.has(c.id))throw Error('check');ids.add(c.id);
      if(c.n!==20||!['ok','slow','down','missing','latency_n'].every(k=>integer(c[k],0,20))||
        c.ok+c.slow+c.down+c.missing!==20||!integer(c.latency_sum,0,100000)||
        c.latency_n>c.ok+c.slow||
        (c.latency_n===0 ? c.latency_sum!==0||c.latency_max!==null :
          !integer(c.latency_max,0,5000)||c.latency_sum<c.latency_max||c.latency_sum>c.latency_max*c.latency_n))throw Error('counts');
      if(source==='vps'&&(c.latency_n||c.latency_sum||c.latency_max!==null))throw Error('host latency');
      const check = Object.fromEntries(['id','n','ok','slow','down','missing','latency_sum','latency_n','latency_max'].map(k=>[k,c[k]]));
      for (const prefix of ['packets_', 'ipv6_packets_']) {
        const sent = prefix + 'sent', received = prefix + 'received';
        if (!(sent in c || received in c)) continue;
        if (source !== 'mac' || !validEchoCounts(c[sent], c[received], 60)) throw Error('ICMP counts');
        check[sent] = c[sent];
        check[received] = c[received];
      }
      return check;
    });
    let connections;
    if(source==='vps'){
      const c=w.connections;
      if(!c||!integer(c.samples,0,20)||!integer(c.peak,0,1e9)||(c.device_peak!==null&&!integer(c.device_peak,0,1e9)))throw Error('connections');
      connections={samples:c.samples,peak:c.peak,device_peak:c.device_peak};
    }else if(w.connections!==undefined)throw Error('scope');
    if(w.last==null&&(checks.some(c=>c.missing!==20 || c.packets_sent || c.ipv6_packets_sent)||connections?.samples>0))throw Error('missing snapshot');
    const events=w.events??[];
    if(!Array.isArray(events)||events.length>40||events.some(e=>!allowed[source].includes(e?.id)||!integer(e.ts,w.start,w.start+1199)||!['ok','degraded','down','unknown'].includes(e.status)||(e.previous!==null&&!['ok','degraded','down','unknown'].includes(e.previous))))throw Error('events');
    return {start:w.start,checks,...(connections?{connections}:{}),last:w.last??null,events:events.map(e=>({id:e.id,ts:e.ts,status:e.status,previous:e.previous}))};
  });
}
export function aggregateStatements(db,source,windows) {
  return windows.map(w=>db.prepare('INSERT INTO aggregate_windows(source,start,payload) VALUES(?,?,?) ON CONFLICT DO NOTHING')
    .bind(source,w.start,JSON.stringify(w)));
}
export async function lastWindow(db,source) {
  const row=await db.prepare('SELECT start FROM aggregate_windows WHERE source=? ORDER BY start DESC LIMIT 1').bind(source).first();
  return row?.start??null;
}
export async function validateWindowSequence(db,source,windows,now) {
  const last=await lastWindow(db,source);
  let previous=last;
  for(const w of windows) {
    if(last!==null&&w.start<=last)continue;
    // A queue older than retention may resume at the first retained window.
    if(previous!==null&&previous>=now-31*86400&&w.start!==previous+1200)throw Error('window gap');
    const overlap=await db.prepare(`SELECT 1 AS found FROM samples WHERE check_id IN (${allowed[source].map(()=>'?').join(',')}) AND minute>=? AND minute<? LIMIT 1`)
      .bind(...allowed[source],w.start/60,(w.start+1200)/60).first();
    if(overlap)throw Error('legacy overlap');
    previous=w.start;
  }
}

export function aggregateRead(db,source,start) {
  return db.prepare('SELECT start,payload FROM aggregate_windows WHERE source=? AND start>=? ORDER BY start').bind(source,start);
}
export async function latestAggregate(db,source) {
  const row=await db.prepare('SELECT payload FROM aggregate_windows WHERE source=? ORDER BY start DESC LIMIT 1').bind(source).first();
  return row?JSON.parse(row.payload):null;
}
export function applyAggregates(records,source,bounds,latest,reports,histories,connections) {
  for(const record of records.results??records){
    const w=typeof record.payload==='string'?JSON.parse(record.payload):record;
    if(w.last){
      const {ts}=w.last;
      if(source==='vps'&&(!reports.results[0]||ts>reports.results[0].ts))
        reports.results[0]={ts,...w.last.metrics,metrics:JSON.stringify(w.last.metrics),freshFor:1500,cadence:1200};
      for(const c of w.last.checks??[]){
        const index=latest.results.findIndex(r=>r.check_id===c.id);
        if(index<0||ts>latest.results[index].ts){
          const row={check_id:c.id,ts,status:c.status,latency:c.latency,freshFor:1500,cadence:1200};
          if(index<0)latest.results.push(row);else latest.results[index]=row;
        }
      }
    }
    const checks=[...w.checks];
    if(w.observedEgress){
      const o=w.observedEgress,index=latest.results.findIndex(r=>r.check_id==='egress');
      if(index<0||o.ts>latest.results[index].ts){const row={check_id:'egress',ts:o.ts,status:o.status,latency:null,freshFor:1500,cadence:1200};if(index<0)latest.results.push(row);else latest.results[index]=row;}
      // One observed upload is one observation, not twenty fabricated samples.
      checks.push({id:'egress',n:1,ok:+(o.status==='ok'),slow:0,down:+(o.status==='down'),missing:+(o.status==='unknown'),latency_sum:0,latency_n:0,latency_max:null,observedTs:o.ts});
    }
    bounds.forEach((b,index)=>{
      for(const c of checks){
        const bucket=Math.floor((c.observedTs??w.start)/b.width)*b.width;
        if(bucket<b.start||bucket>=b.start+72*b.width)continue;
        let row=histories[index].results.find(r=>r.bucket===bucket&&r.check_id===c.id);
        if(!row){row={check_id:c.id,bucket,n:0,ok:0,slow:0,down:0,missing:0,latency_sum:0,latency_n:0,latency_max:null};histories[index].results.push(row);}
        if (source === 'mac') {
          for (const prefix of ['packets_', 'ipv6_packets_']) {
            const sent = prefix + 'sent', received = prefix + 'received';
            if (!c[sent]) continue;
            row[sent] = (row[sent] ?? 0) + c[sent];
            row[received] = (row[received] ?? 0) + c[received];
          }
        }
        row.aggregated=true;
        for(const key of ['n','ok','slow','down','missing','latency_sum','latency_n'])row[key]+=c[key];
        if(c.latency_max!==null)row.latency_max=Math.max(row.latency_max??0,c.latency_max);
      }
      if(source==='vps'&&w.connections&&connections){
        const bucket=Math.floor(w.start/b.width)*b.width;
        if(bucket<b.start||bucket>=b.start+72*b.width)return;
        let row=connections[index].results.find(r=>r.bucket===bucket);
        if(!row&&!w.connections.samples)return;
        if(!row){row={bucket,samples:0,peak:0,device_peak:null};connections[index].results.push(row);}
        row.aggregated=true;if(!w.connections.samples)return;row.samples+=w.connections.samples;row.peak=Math.max(row.peak,w.connections.peak);
        if(w.connections.device_peak!==null)row.device_peak=Math.max(row.device_peak??0,w.connections.device_peak);
      }
    });
  }
}

const rowCaches=new WeakMap();
export function invalidateAggregateCache(db,source){rowCaches.get(db)?.delete(source);}
export async function readAggregates(db,source,start){
  let cache=rowCaches.get(db);if(!cache){cache=new Map();rowCaches.set(db,cache);}
  const key=source,now=Date.now(),hit=cache.get(key);
  if(hit&&hit.until>now&&hit.start<=start)return {results:hit.rows.filter(r=>r.start>=start)};
  const [result]=await db.batch([aggregateRead(db,source,start)]);
  cache.set(key,{until:now+300000,start,rows:result.results});
  return result;
}

export function appendAggregateEvents(records,events){
  for(const row of records.results){const w=JSON.parse(row.payload);for(const e of w.events??[])events.results.push({check_id:e.id,ts:e.ts,status:e.status});}
  events.results.sort((a,b)=>b.ts-a.ts);events.results.splice(60);
}
