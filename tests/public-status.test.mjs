import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { publicSummaries, publicSummary, windows } from "../cloud/public-status.mjs";

test("public summaries omit operational fields, arbitrary messages and unexpected checks", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(readFileSync(new URL("../cloud/migrations/0001_monitor.sql", import.meta.url), "utf8"));
    const seed = "private-data-canary";
    sql.prepare("INSERT INTO reports VALUES(?,?,?,?)").run(1, 100, JSON.stringify({connections: 33, security: seed, month_tx_bytes:4_123_456_789}), seed);
    sql.exec(readFileSync(new URL("../cloud/migrations/0002_connection_history.sql", import.meta.url), "utf8"));
    sql.exec(readFileSync(new URL("../cloud/migrations/0003_device_history.sql", import.meta.url), "utf8"));
    for (const id of ["heartbeat", "xray", "egress", "edge4", "edge6", seed]) {
      sql.prepare("INSERT INTO samples VALUES(?,?,?,?,?,?)").run(id, 1, 100, "down", null, seed);
    }
    const db = {
      prepare(query) { return {query, args:[], bind(...args) {this.args=args;return this;}}; },
      batch(queries) {return queries.map(({query,args}) => ({results:sql.prepare(query).all(...args)}));}
    };
    for (const w of Object.keys(windows)) {
      const status=await publicSummary(db,w,120,1024);
      assert.equal(status.connections,"<50");
      assert.deepEqual(status.traffic,{month:"1970-01",planGB:1024,remainingGB:1020});
      assert(!JSON.stringify(status).includes("4123456789"));
      assert.equal(status.events.length,5);
      assert.equal(status.checks.length,6);
      assert(status.checks.slice(0,5).every(c=>c.history.length===72 && c.status==="down"));
      const count = status.checks.find(c=>c.id==="connections");
      assert.equal(count.value,"<50");
      assert.equal(count.values.at(-1),"<50");
      assert.equal(count.samples,1);
      assert.equal(count.values[0],null);
      assert(!JSON.stringify(status).includes(seed));
      assert(!JSON.stringify(status).includes("xray"));
    }
    const stale=await publicSummary(db,"24h",300,1024);
    assert.equal(stale.traffic,null);
    assert.equal(stale.connections,null);
    assert(stale.checks.every(c=>c.status==="unknown"));
    sql.prepare("INSERT INTO reports VALUES(?,?,?,?) ON CONFLICT DO NOTHING").run(2, 160, '{"connections":0,"devices":2}', seed);
    sql.prepare("INSERT INTO reports VALUES(?,?,?,?) ON CONFLICT DO NOTHING").run(2, 160, '{"connections":999}', seed);
    const idle = (await publicSummary(db,"24h",170,1024)).checks.at(-1);
    assert.equal(idle.value,"<10");
    assert.equal(idle.status,"ok");
    assert.equal(idle.values.at(-1),"<50");
    assert.equal(idle.samples,2);
    assert.equal(idle.devices,2);
    assert.equal(idle.deviceHistory.at(-1),2);
    for (const [n,want] of [[9,"<10"],[10,"<30"],[29,"<30"],[30,"<50"],[49,"<50"],[50,"<100"],[99,"<100"],[100,"≥100"]]) {
      sql.prepare("UPDATE reports SET metrics=? WHERE minute=2").run(JSON.stringify({connections:n,devices:0}));
      const c=(await publicSummary(db,"24h",170,1024)).checks.at(-1);
      assert.equal(c.value,want);assert.equal(c.devices,0);
    }
    sql.prepare("UPDATE reports SET ts=?").run(Date.UTC(2026,11,1)/1000-10);
    assert.equal((await publicSummary(db,"24h",Date.UTC(2026,11,1)/1000,1024)).traffic,null);
    sql.prepare("UPDATE reports SET ts=100, metrics='{}'").run();
    assert.equal((await publicSummary(db,"24h",120,1024)).traffic,null);
  } finally {sql.close();}
});

test("one batched read preserves all three resolutions, event windows and redaction", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    for (const migration of ["0001_monitor", "0002_connection_history", "0003_device_history"]) {
      sql.exec(readFileSync(new URL(`../cloud/migrations/${migration}.sql`, import.meta.url), "utf8"));
    }
    const now = Date.UTC(2026, 10, 5, 12) / 1000;
    const secret = "private-bundle-canary";
    for (const [age, status] of [[20 * 86400, "down"], [3 * 86400, "ok"], [3600, "degraded"], [10, "ok"]]) {
      const ts = now - age;
      sql.prepare("INSERT INTO samples VALUES(?,?,?,?,?,?)")
        .run("heartbeat", Math.floor(ts / 60), ts, status, 30, secret);
      sql.prepare("INSERT INTO reports VALUES(?,?,?,?)")
        .run(Math.floor(ts / 60), ts, JSON.stringify({connections:33, devices:2, month_tx_bytes:12345, security:secret}), secret);
    }
    let batches = 0, queries = 0;
    const db = {
      prepare(query) {return {query, args:[], bind(...args) {this.args=args;return this;}};},
      batch(statements) {
        batches++; queries += statements.length;
        return statements.map(({query,args})=>({results:sql.prepare(query).all(...args)}));
      }
    };
    const all = await publicSummaries(db, Object.keys(windows), now, 1024);
    assert.equal(batches, 1);
    assert.equal(queries, 9); // Current readings and report are shared, not fetched three times.
    for (const [range, width] of Object.entries(windows)) {
      assert.deepEqual(all[range], await publicSummary(db, range, now, 1024));
      assert.equal(all[range].width, width);
      assert(all[range].checks.every(check => check.history.length === 72));
      assert(all[range].events.every(event => event.at >= now - width * 72));
      assert.equal(all[range].checks.at(-1).devices, 2);
    }
    assert.equal(all['24h'].checks[0].samples, 2);
    assert.equal(all['7d'].checks[0].samples, 3);
    assert.equal(all['30d'].checks[0].samples, 4);
    assert.equal(all['24h'].events.length, 2);
    assert.equal(all['7d'].events.length, 3);
    assert.equal(all['30d'].events.length, 4);
    assert(!JSON.stringify(all).includes(secret));
    const stale = await publicSummaries(db, Object.keys(windows), now + 300, 1024);
    assert(Object.values(stale).every(summary => summary.traffic === null && summary.checks.every(check => check.status === 'unknown')));
  } finally {sql.close();}
});
