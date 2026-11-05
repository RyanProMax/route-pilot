import assert from "node:assert/strict";
import { test } from "node:test";
import { readStatus } from "../cloud/status-cache.mjs";

test("only canonical public reads can query D1 and enter the shared cache", async () => {
  let reads=0;
  const db={
    prepare() {return {bind() {return this;}};},
    async batch(queries) {reads++;return queries.map(()=>({results:[]}));}
  };
  const get=(path,method="GET")=>readStatus(new Request("https://status.example.com"+path,{method}), db, 1000);
  for (const w of ["24h","7d","30d"]) {
    const reply=await get("/status/"+w+".json");
    assert.equal(reply.status,200);
    assert.match(reply.headers.get("Cache-Control"),/public, max-age=60, s-maxage=60/);
    const body=await reply.json();
    assert.equal(body.at,1000);
    assert.equal(body.checks.length,5);
  }
  assert.equal((await get("/status/24h.json?bust=5")).status,400);
  assert.equal((await get("/status/24h.json","POST")).status,405);
  assert.equal(await get("/status/custom.json"),null);
  assert.equal(reads,3);
  const primary=await get("/status/node-1/7d.json");
  const body=await primary.json();
  assert.equal(body.instanceId,"node-1");
  assert.equal(body.checks.length,6);
  const before=reads;
  assert.equal(await get("/status/another-instance/7d.json"),null);
  assert.equal(reads,before);
  const other=await readStatus(new Request("https://status.example.com/status/second/7d.json"),db,1000,1024,"second");
  assert.equal((await other.json()).instanceId,"second");
  const beforeBundle=reads;
  const bundleReply=await get("/status/node-1/all.json");
  assert.match(bundleReply.headers.get("Cache-Control"),/public, max-age=60, s-maxage=60/);
  const bundle=await bundleReply.json();
  assert.equal(bundle.instanceId,"node-1");
  assert.deepEqual(Object.keys(bundle.windows),["24h","7d","30d"]);
  assert(Object.values(bundle.windows).every(summary=>summary.at===1000 && summary.checks.length===6));
  assert.equal(reads,beforeBundle+1);
  assert.equal((await get("/status/node-1/all.json?bust=5")).status,400);
  assert.equal((await get("/status/node-1/all.json","POST")).status,405);
  assert.equal(await get("/status/another-instance/all.json"),null);
  assert.equal(await get("/status/all.json"),null);
  assert.equal(reads,beforeBundle+1);
  assert.equal(await (await get("/status/node-1/all.json","HEAD")).text(),"");
  assert.equal(await (await get("/status/24h.json","HEAD")).text(),"");
  db.batch=async()=>{throw new Error("sensitive info");};
  const failed=await get("/status/24h.json");
  assert.equal(failed.status,503);
  assert.equal(failed.headers.get("Cache-Control"),"no-store");
  assert(!(await failed.text()).includes("sensitive info"));
  assert.equal((await get("/status/node-1/all.json")).status,503);
});
