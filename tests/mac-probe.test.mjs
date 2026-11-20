import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMacProbe,ingestMacProbe} from '../cloud/mac-probe.mjs';
const valid=()=>({schema:1,ts:1000,path:'physical-interface',protocol:'tcp-connect',results:[{family:4,outcome:'timeout',ms:null},{family:6,outcome:'ok',ms:190.3}]});
test('TCP outcomes do not become fabricated latency or packet loss',()=>{
 assert.deepEqual(normalizeMacProbe(valid(),1001),[{id:'link',ts:1000,status:'ok',latency:190}]);
 const v=valid();v.results[0].outcome='unavailable';assert.equal(normalizeMacProbe(v,1001)[0].status,'ok');
 v.results[1].ms=800;assert.equal(normalizeMacProbe(v,1001)[0].status,'degraded');
});
test('reject stale, duplicate, wrong path and invalid measurement',()=>{
 for(const change of [v=>v.ts=700,v=>v.ts=1020,v=>v.results[0].family=6,v=>v.path='tun',v=>v.results[0].ms=0,v=>v.results[1].ms=NaN,v=>v.results[1].ms=5001]){
  const v=valid();change(v);assert.throws(()=>normalizeMacProbe(v,1000));
 }
});
test('disabled or wrong credential cannot write',async()=>{
 let writes=0;const env={DB:{batch:()=>writes++}};
 assert.equal((await ingestMacProbe(new Request('https://example.test/private/mac-probe-ingest',{method:'POST'}),env,1000)).status,401);
 assert.equal(writes,0);
});
const token='test-only-not-a-real-credential-123456789';
const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),v=>v.toString(16).padStart(2,'0')).join('');
function request(body, credential=token){return new Request('https://example.test/private/mac-probe-ingest',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});}
test('credential is scoped, bounded, and rate limited',async()=>{
 let rows=[];
 const env={MAC_PROBE_SHA256:hash,DB:{prepare:query=>({bind:(...args)=>({query,args})}),batch:statements=>{rows=statements;}}};
 assert.equal((await ingestMacProbe(request(valid(),'wrong'),env,1000)).status,401);
 assert.equal((await ingestMacProbe(request('x'.repeat(2049)),env,1000)).status,413);
 assert.equal((await ingestMacProbe(request({...valid(),results:[{family:4,outcome:'ok',ms:10}]}),env,1000)).status,400);
 assert.equal(rows.length,0);
 assert.equal((await ingestMacProbe(request(valid()),env,1000)).status,200);
 assert.deepEqual(rows.map(r=>r.args[0]),['link']);
 assert(rows.every(r=>r.query.includes('ON CONFLICT DO NOTHING')));
 env.PRIVATE_LIMIT={limit:async()=>({success:false})};
 assert.equal((await ingestMacProbe(request(valid()),env,1000)).status,429);
});

test('private history exposes coverage and expires current samples',async()=>{
 const {database}=await import('./d1.mjs');
 const {macProbeSummaries}=await import('../cloud/mac-probe.mjs');
 const {sql,DB}=database();
 try{
  sql.prepare('INSERT INTO samples VALUES(?,?,?,?,?,?)').run('link',21,1260,'ok',190,'private');
  let s=(await macProbeSummaries(DB,1800))['24h'];
  let c=s.checks[0];assert.equal(c.status,'unknown');assert.equal(c.latency,null);
  assert.equal(c.samples,1);assert.equal(c.history.at(-1),'ok');assert.equal(c.coverage.at(-1),10);
  s=(await macProbeSummaries(DB,1261))['24h'];c=s.checks[0];assert.equal(c.status,'ok');assert.equal(c.latency,190);
  assert.equal(c.history.at(-1),'ok'); // A measured interval keeps its state even with partial coverage.
 }finally{sql.close();}
});

test('combine valid families, never average missing values as zero',()=>{
 const v=valid();v.results[0]={family:4,outcome:'ok',ms:300};v.results[1].ms=200;
 assert.equal(normalizeMacProbe(v,1000)[0].latency,250);
 v.results[1]={family:6,outcome:'timeout',ms:null};assert.equal(normalizeMacProbe(v,1000)[0].latency,300);
 v.results[0]={family:4,outcome:'failed',ms:null};assert.equal(normalizeMacProbe(v,1000)[0].status,'down');
 v.results.forEach(r=>r.outcome='unavailable');assert.equal(normalizeMacProbe(v,1000)[0].status,'unknown');
});
