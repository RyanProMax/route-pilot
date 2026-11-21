import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {database} from './d1.mjs';
import {normalizeWindows,aggregateStatements,validateWindowSequence,readAggregates,invalidateAggregateCache,applyAggregates} from '../cloud/aggregate.mjs';
import {ingestMacProbe,macProbeSummaries} from '../cloud/mac-probe.mjs';
import {publicSummary} from '../cloud/public-status.mjs';
const counts=(id='link')=>({id,n:20,ok:20,slow:0,down:0,missing:0,latency_sum:id==='link'?3400:0,latency_n:id==='link'?20:0,latency_max:id==='link'?170:null});
const probe=(ts)=>({schema:1,ts,path:'physical-interface',protocol:'tcp-connect',results:[{family:4,outcome:'unavailable',ms:null},{family:6,outcome:'ok',ms:170}]});
const window=(start=1200)=>({start,checks:[counts()],last:probe(start+1140)});
const token='test-only-aggregate-credential-123456789';
const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),v=>v.toString(16).padStart(2,'0')).join('');
const request=body=>new Request('https://test/private/mac-probe-ingest',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
test('one row per source/window, retry and ACK cause no writes; old tables unchanged',async()=>{
 const {sql,DB}=database();const env={DB,MAC_PROBE_SHA256:hash};
 const old=Object.fromEntries(['samples','latest','events','buckets','reports'].map(t=>[t,sql.prepare('SELECT count(*) n FROM '+t).get().n]));
 const before=sql.prepare('SELECT total_changes() n').get().n;
 const ack=await ingestMacProbe(request({schema:2,ts:2460,ackOnly:true}),env,2460);assert.equal(ack.status,200);assert.equal((await ack.json()).last_window,null);
 assert.equal(sql.prepare('SELECT total_changes() n').get().n,before);
 const body={schema:2,ts:2460,windows:[window()]};
 assert.equal((await ingestMacProbe(request(body),env,2460)).status,200);
 assert.equal(sql.prepare('SELECT total_changes() n').get().n,before+1);
 assert.equal((await ingestMacProbe(request(body),env,2460)).status,200);
 assert.equal(sql.prepare('SELECT total_changes() n').get().n,before+1);
 for(const [t,n] of Object.entries(old))assert.equal(sql.prepare('SELECT count(*) n FROM '+t).get().n,n);
 const view=await macProbeSummaries(DB,2460);assert.equal(view['24h'].checks[0].status,'ok');assert.equal(view['24h'].checks[0].freshFor,1500);assert.equal(view['24h'].checks[0].meanLatency,170);
 for (const name of ['0002_connection_history.sql','0003_device_history.sql'])
   sql.exec(readFileSync(new URL('../cloud/migrations/'+name,import.meta.url),'utf8'));
 for (const range of ['24h','7d','30d']) {
   const guest=await publicSummary(DB,range,2460,100);
   assert.deepEqual(guest.checks.find(row=>row.id==='link'),view[range].checks[0]);
   assert(!JSON.stringify(guest).includes('physical-interface'));
 }
 assert.equal((await publicSummary(DB,'24h',3841,100)).checks.find(row=>row.id==='link').latency,null);
 assert.equal((await macProbeSummaries(DB,3841))['24h'].checks[0].status,'unknown');
});
test('validation rejects malformed counts, scopes, gaps, overlapping legacy, future snapshots',async()=>{
 const {sql,DB}=database();const env={DB,MAC_PROBE_SHA256:hash};
 for(const change of [w=>w.checks[0].ok=19,w=>w.start++,w=>w.checks[0].id='heartbeat',w=>w.last.ts=2500,w=>w.checks[0].latency_sum=2]){
  const w=window();change(w);assert.equal((await ingestMacProbe(request({schema:2,ts:2460,windows:[w]}),env,2460)).status,400);
 }
 sql.prepare('INSERT INTO samples(check_id,minute,ts,status,message) VALUES(?,?,?,?,?)').run('link',21,1260,'ok','legacy');
 assert.equal((await ingestMacProbe(request({schema:2,ts:2460,windows:[window()]}),env,2460)).status,400);
 sql.prepare('INSERT INTO aggregate_windows VALUES(?,?,?)').run('mac',0,JSON.stringify({start:0}));
 await assert.rejects(()=>validateWindowSequence(DB,'mac',normalizeWindows([window(2400)],'mac',3601),3601),/gap/);
});
test('cache isolates database/source, invalidates on insert, and does not extend freshness',async()=>{
 const a=database(),b=database();let reads=0;const original=a.DB.batch;a.DB.batch=async s=>{reads++;return original(s);};
 await readAggregates(a.DB,'mac',0);await readAggregates(a.DB,'mac',0);assert.equal(reads,1);
 await readAggregates(a.DB,'vps',0);assert.equal(reads,2);
 await b.DB.batch(aggregateStatements(b.DB,'mac',[{start:1200,checks:[]}]));assert.equal((await readAggregates(a.DB,'mac',0)).results.length,0);
 await a.DB.batch(aggregateStatements(a.DB,'mac',[{start:1200,checks:[]}]));invalidateAggregateCache(a.DB,'mac');assert.equal((await readAggregates(a.DB,'mac',0)).results.length,1);
});
test('public merge preserves old history, counts, peaks, traffic and observed-only egress',async()=>{
 const {sql,DB}=database();for(const name of ['0002_connection_history.sql','0003_device_history.sql'])sql.exec(readFileSync(new URL('../cloud/migrations/'+name,import.meta.url),'utf8'));
 sql.prepare('INSERT INTO samples(check_id,minute,ts,status,message) VALUES(?,?,?,?,?)').run('heartbeat',1,60,'ok','legacy');
 const partial={...counts('heartbeat'),ok:1,missing:19};
 const metrics={connections:8,devices:2,month_tx_bytes:1234567890,memory_used:50,memory_total:100,disk_used:30,disk_total:100,cpu_percent:12,load1:0.5};
 const w={start:1200,checks:[partial,{...counts('xray'),ok:19,down:1}],connections:{samples:1,peak:14,device_peak:3},last:{ts:2340,metrics,checks:[{id:'heartbeat',status:'ok',latency:null},{id:'xray',status:'ok',latency:null}]},observedEgress:{ts:2460,status:'ok'},events:[{id:'xray',ts:1800,status:'down',previous:'ok'}]};
 await DB.batch(aggregateStatements(DB,'vps',[w]));
 const view=await publicSummary(DB,'24h',2460,100);
 const heartbeat=view.checks.find(c=>c.id==='heartbeat'),service=view.checks.find(c=>c.id==='service'),egress=view.checks.find(c=>c.id==='egress');
 assert.equal(heartbeat.samples,2);assert.equal(heartbeat.history.at(-2),'unknown');assert.equal(service.history.at(-2),'down');assert.equal(egress.samples,1);
 assert.equal(view.load.memory,50);assert.equal(view.traffic.remainingGB,99);assert.equal(view.freshFor,1500);assert.equal(view.checks.at(-1).deviceHistory.at(-2),3);
 assert(view.events.some(e=>e.id==='service'&&e.status==='down'&&e.at===1800));
 assert.equal((await publicSummary(DB,'24h',3841,100)).load,null);
});

test('VPS schema2 authenticates, writes one aggregate row, preserves last sample time and freezes legacy cron at cutover',async()=>{
 const {default:worker}=await import('../cloud/worker.mjs');
 const {sql,DB}=database();for(const name of ['0002_connection_history.sql','0003_device_history.sql'])sql.exec(readFileSync(new URL('../cloud/migrations/'+name,import.meta.url),'utf8'));
 const now=Math.floor(Date.now()/1000),start=Math.floor(now/1200)*1200-1200;
 const metrics={memory_used:50,memory_total:100,disk_used:30,disk_total:100,load1:0.1,cpu_count:1,uptime_seconds:100,xray_restarts:0,connections:4,proxy_service:'active',cpu_percent:2,devices:1,month_tx_bytes:100,
 security:{ssh_ports:[22],public_tcp_ports:[443],ufw_active:true,fail2ban_active:true,sshd_jail_active:true,reporter_sandboxed:true,banned_count:0,passwordauthentication:'no',kbdinteractiveauthentication:'no',permitrootlogin:'no',legacy_packages:Object.fromEntries(['wireguard','wireguard-tools','tinyproxy','tinyproxy-bin','shadowsocks-libev'].map(k=>[k,false]))}};
 const w={start,checks:[counts('heartbeat'),counts('xray')],connections:{samples:20,peak:8,device_peak:2},last:{schema:1,ts:start+1140,metrics}};
 const env={DB,REPORT_SHA256:hash,PORT:'443',IPV4:'192.0.2.1',AGGREGATE_START:String(start)};
 const req=body=>new Request('https://test/api/report',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','cf-connecting-ip':'192.0.2.1'},body:JSON.stringify(body)});
 const before=sql.prepare('SELECT total_changes() n').get().n;
 const response=await worker.fetch(req({schema:2,ts:now,windows:[w]}),env);assert.equal(response.status,200);assert.equal((await response.json()).last_window,start);
 assert.equal(sql.prepare('SELECT total_changes() n').get().n,before+1);
 assert.equal(sql.prepare('SELECT count(*) n FROM samples').get().n,0);
 const stored=JSON.parse(sql.prepare('SELECT payload FROM aggregate_windows').get().payload);assert.equal(stored.last.ts,start+1140);assert.equal(stored.observedEgress.ts,now);
 const status=await publicSummary(DB,'24h',now,100);assert.equal(status.lastReport,start+1140);assert.equal(status.freshFor,1500);assert.equal(status.checks.find(c=>c.id==='egress').status,'ok');assert.equal(status.checks.find(c=>c.id==='egress').history.at(-1),'ok');
 await worker.scheduled({scheduledTime:now*1000,cron:'* * * * *'},env);assert.equal(sql.prepare('SELECT total_changes() n').get().n,before+1);
 assert.equal((await worker.fetch(req({schema:2,ts:now,ackOnly:true}),env)).status,200);assert.equal(sql.prepare('SELECT total_changes() n').get().n,before+1);
 assert.equal((await worker.fetch(req({schema:2,ts:now,windows:[w]}),env)).status,200);assert.equal(sql.prepare('SELECT total_changes() n').get().n,before+1);
 const invalid=structuredClone(w);invalid.start+=1200;invalid.last.ts=invalid.start-1;
 assert.equal((await worker.fetch(req({schema:2,ts:now,windows:[invalid]}),env)).status,400);
});

test('interval metrics weight measured TCP timings and ICMP packets across old and new samples', async () => {
  const {sql, DB} = database();
  const env = {DB, MAC_PROBE_SHA256:hash};
  try {
    const legacy = {...probe(60), icmp:{sent:3, received:0}, icmp6:{sent:3, received:0}};
    for (let i=0; i<2; i++) assert.equal((await ingestMacProbe(request(legacy),env,61)).status,200);
    assert.equal((await ingestMacProbe(request({...legacy, icmp:{sent:3,received:4}}),env,61)).status,400);
    const measured = window(1200);
    Object.assign(measured.checks[0], {latency_sum:2000,latency_max:100,packets_sent:30,packets_received:27});
    const old = window(2400);
    Object.assign(old.checks[0], {ok:19, slow:1, latency_max:618, ipv6_packets_sent:6, ipv6_packets_received:6});
    const invalid6 = structuredClone(old);
    invalid6.checks[0].ipv6_packets_received = 7;
    assert.throws(()=>normalizeWindows([invalid6],'mac',3601));
    const invalid = structuredClone(measured);
    invalid.checks[0].packets_received=31;
    assert.throws(()=>normalizeWindows([invalid],'mac',3601));
    const response=await ingestMacProbe(request({schema:2,ts:3601,windows:[measured,old]}),env,3601);
    assert.equal(response.status,200);
    const views=await macProbeSummaries(DB,3601);
    const daily=views['24h'].checks[0].intervals;
    assert.deepEqual(daily.slice(-4), [
      {meanLatency:170,connectRate:100,replyRate:0,ipv6ReplyRate:0,ping:{sent:3,received:0}},
      {meanLatency:100,connectRate:100,replyRate:90,ipv6ReplyRate:null,ping:{sent:30,received:27}},
      {meanLatency:170,connectRate:100,replyRate:null,ipv6ReplyRate:100,ping:{sent:6,received:6}}, null,
    ]);
    assert.deepEqual(views['24h'].checks[0].history.slice(-4), ['down','degraded','ok','unknown']);
    for (const range of ['7d','30d']) {
      const interval=views[range].checks[0].intervals.at(-1);
      assert.equal(interval.meanLatency,Math.round((170+2000+3400)/41));
      assert.equal(interval.replyRate,100*27/33);
      assert.equal(interval.ipv6ReplyRate,100*6/9);
      assert.deepEqual(interval.ping,{sent:9,received:6});
      assert.equal(views[range].checks[0].history.at(-1),'down');
    }
  } finally { sql.close(); }
});
