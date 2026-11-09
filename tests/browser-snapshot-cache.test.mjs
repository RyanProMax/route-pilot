import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readInitialData, readStatus, cachedStatus } from '../web/src/data.ts';
const now = Date.now()/1000;
const instances = [{id:'tokyo',name:'东京节点',country:'JP'}];
function bundle(at=now) {
  return {instanceId:'tokyo',windows:Object.fromEntries(['24h','7d','30d'].map(key=>[key,{
    at,start:at-({ '24h':1200,'7d':8400,'30d':36000 }[key])*72,width:({ '24h':1200,'7d':8400,'30d':36000 }[key]),lastReport:at-10,load:{cpu:5,memory:20,disk:30,load1:0.1},
    checks:[{id:'heartbeat',status:'ok',at:at-10,latency:null,rate:100,history:['ok']}],events:[],
  }]))};
}
function setup(t) {
  const original=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');const store=new Map();
  Object.defineProperty(globalThis,'sessionStorage',{value:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},configurable:true});
  t.after(()=>original?Object.defineProperty(globalThis,'sessionStorage',original):delete globalThis.sessionStorage);
  let calls=0;
  t.mock.method(globalThis,'fetch',async path=>{calls++;return Response.json(path==='/instances.json'?instances:bundle());});
  return {store,calls:()=>calls};
}
test('reload immediately restores public data without waiting for network; requests revalidation',async t=>{
  const {store,calls}=setup(t);const initial=await readInitialData();assert(initial.bundle);assert.equal(calls(),2);
  const cached=await readInitialData();assert.equal(calls(),2);assert.equal(cached.completedAt,0);assert.deepEqual(cached.bundle,initial.bundle);
  assert([...store.keys()].every(key=>key.startsWith('routepilot:public:')));
  assert.equal(cachedStatus('other-node'),null);
});
test('corrupt, expired, future and wrong-instance caches never replace valid UI data',async t=>{
  const {store}=setup(t);await readInitialData();
  const key='routepilot:public:v1:status:tokyo',original=store.get(key);
  const overflow=bundle();overflow.windows['24h'].width=1e308;
  for(const raw of ['{',JSON.stringify({savedAt:Date.now(),value:overflow}),JSON.stringify({savedAt:Date.now()-86400001,value:bundle()}),JSON.stringify({savedAt:Date.now()+1000,value:bundle()}),
    JSON.stringify({savedAt:Date.now(),value:{...bundle(),instanceId:'other-node'}}),
    JSON.stringify({savedAt:Date.now(),value:bundle(now-86401)}),
    JSON.stringify({savedAt:Date.now(),value:{...bundle(),windows:{'24h':{checks:[null]}}}})]) {
    store.set(key,raw);assert.equal(cachedStatus('tokyo'),null);
  }
  store.set(key,original);assert(cachedStatus('tokyo'));
});
test('failed refreshes, older responses and aborted requests preserve the last-good cache',async t=>{
  const {store}=setup(t);await readInitialData();const before=store.get('routepilot:public:v1:status:tokyo');
  t.mock.method(globalThis,'fetch',async()=>{throw Error('offline');});await assert.rejects(readStatus('tokyo'));assert.equal(store.get('routepilot:public:v1:status:tokyo'),before);
  t.mock.method(globalThis,'fetch',async()=>Response.json(bundle(now-60)));assert.equal((await readStatus('tokyo')).windows['24h'].at,now);
  const controller=new AbortController();controller.abort();t.mock.method(globalThis,'fetch',async()=>Response.json(bundle(now+10)));
  await readStatus('tokyo',controller.signal);assert.equal(store.get('routepilot:public:v1:status:tokyo'),before);
});
test('storage rejection is optional and never blocks successful online data',async t=>{
  setup(t);Object.defineProperty(globalThis,'sessionStorage',{get(){throw Error('storage denied');},configurable:true});
  const initial=await readInitialData();assert(initial.bundle);assert.equal(initial.error,false);
});
