import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { database } from "./d1.mjs";
import { privateAPI, digest, decrypt } from "../cloud/private-api.mjs";
const origin = "https://status.example.com",
  now = Math.floor(Date.now() / 1000);
async function setup() {
  const { sql, DB } = database(),
    session = randomBytes(32).toString("hex"),
    control = randomBytes(36).toString("base64url");
  sql
    .prepare(
      "INSERT INTO rp_accounts(id,email,role,created) VALUES('admin','admin@example.com','admin',?)",
    )
    .run(now);
  sql
    .prepare(
      "INSERT INTO rp_sessions(hash,account_id,expires) VALUES(?,'admin',?)",
    )
    .run(await digest(session), now + 3600);
  const env = {
    DB,
    APP_ORIGIN: origin,
    INSTANCE_ID: "test",
    INSTANCE_NAME: "Test",
    CONTROL_SHA256: await digest(control),
    SUBSCRIPTION_KEY: randomBytes(32).toString("base64"),
  };
  const headers = {
    cookie: "__Host-routepilot=" + session,
    origin,
    "content-type": "application/json",
  };
  const call = (path, body, extra = {}, at = now) =>
    privateAPI(
      new Request(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      at,
    );
  const agent = (path, body, at = now) =>
    call(
      "/private/control/" + path,
      body,
      { authorization: "Bearer " + control },
      at,
    );
  return { sql, env, call, agent, control };
}
const id = () => randomBytes(16).toString("hex");
test("admin and control roles are separate; malformed and cross-origin requests fail closed", async () => {
  const { sql, call, agent } = await setup();
  try {
    assert.equal(
      (await call("/private/console", undefined, { cookie: "" })).status,
      401,
    );
    assert.equal(
      (
        await call(
          "/private/credentials",
          { requestId: id(), action: "create", label: "A", client: "clash" },
          { origin: "https://elsewhere.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await call("/private/control/poll", { credentials: [] })).status,
      401,
    );
    assert.equal((await call("/private/credentials", null)).status, 400);
    assert.equal((await agent("poll", null)).status, 400);
    assert.equal(
      (await agent("poll", { credentials: [{ id: "../../../etc" }] })).status,
      400,
    );
    assert.equal(
      (
        await call("/private/credentials", {
          requestId: id(),
          action: "exec",
          command: "whoami",
        })
      ).status,
      400,
    );
    sql.exec("UPDATE rp_accounts SET role='viewer'");
    assert.equal((await call("/private/console")).status, 401);
    sql.exec("UPDATE rp_accounts SET role='admin',disabled=1");
    assert.equal((await call("/private/console")).status, 401);
  } finally {
    sql.close();
  }
});
test("credential lifecycle: idempotent queue, encrypted export, rotation and complete revocation", async () => {
  const { sql, env, call, agent } = await setup();
  try {
    const requestId = id(),
      create = {
        requestId,
        action: "create",
        label: "Laptop",
        client: "clash",
      };
    assert.equal((await call("/private/credentials", create)).status, 202);
    assert.equal((await call("/private/credentials", create)).status, 202);
    assert.equal(sql.prepare("SELECT count(*) n FROM control_jobs").get().n, 1);
    let job = (await (await agent("poll", { credentials: [] })).json()).job;
    const device = {
      id: job.device_id,
      label: "Laptop",
      client: "clash",
      created: now,
      revoked: false,
    };
    const files = {
      "clash.yaml": "private-node-uuid",
      "shadowrocket.txt": "private-node",
      "rules.conf": "private-rules",
    };
    let token = randomBytes(32).toString("base64url");
    let ack = {
      id: job.id,
      lease: job.lease,
      ok: true,
      credential: device,
      token,
      files,
    };
    assert.equal((await agent("ack", ack)).status, 200);
    assert.equal((await agent("ack", ack)).status, 200);
    let row = sql.prepare("SELECT * FROM subscriptions").get();
    assert(!JSON.stringify(row).includes(token));
    assert(!JSON.stringify(row).includes(files["clash.yaml"]));
    assert.equal((await decrypt(row, env))._token, token);
    let consoleResponse = await call("/private/console");
    assert.match(consoleResponse.headers.get("cache-control"), /no-store/);
    let consoleText = await consoleResponse.text();
    assert(!consoleText.includes(token));
    assert(!consoleText.includes("private-node"));
    let access = await call(
      "/private/credentials/" + device.id + "/access",
      {},
    );
    assert.equal(access.status, 200);
    assert((await access.json()).urls["clash.yaml"].includes(token));
    assert.equal(
      (
        await call(
          "/private/credentials/" + device.id + "/access",
          {},
          { origin: "https://bad.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      await (await call("/sub/" + token + "/clash.yaml")).text(),
      files["clash.yaml"],
    );
    assert.equal((await call("/sub/" + token + "/_token")).status, 404);
    const old = token;
    await call("/private/credentials", {
      requestId: id(),
      action: "rotate",
      deviceId: device.id,
    });
    job = (await (await agent("poll", { credentials: [device] })).json()).job;
    token = randomBytes(32).toString("base64url");
    ack = { ...ack, id: job.id, lease: job.lease, token };
    assert.equal((await agent("ack", ack)).status, 200);
    assert.equal((await call("/sub/" + old + "/clash.yaml")).status, 404);
    assert.equal((await call("/sub/" + token + "/clash.yaml")).status, 200);
    await call("/private/credentials", {
      requestId: id(),
      action: "revoke",
      deviceId: device.id,
    });
    assert.equal((await call("/sub/" + token + "/clash.yaml")).status, 404);
    job = (await (await agent("poll", { credentials: [device] })).json()).job;
    assert.equal(
      (
        await agent("ack", {
          id: job.id,
          lease: job.lease,
          ok: true,
          credential: { ...device, revoked: true },
        })
      ).status,
      200,
    );
    assert.equal(
      sql.prepare("SELECT ciphertext FROM subscriptions").get().ciphertext,
      "",
    );
    assert.equal(
      sql.prepare("SELECT revoked FROM managed_credentials").get().revoked,
      1,
    );
    assert.equal(
      (await call("/private/credentials/" + device.id + "/access", {})).status,
      404,
    );
    // Delayed stale inventory must not resurrect a revoked identity.
    await agent("poll", { credentials: [device] });
    assert.equal(
      sql.prepare("SELECT revoked FROM managed_credentials").get().revoked,
      1,
    );
  } finally {
    sql.close();
  }
});
test("expired leases cannot commit a profile or mark failed work as successful", async () => {
  const { sql, agent, call } = await setup();
  try {
    await call("/private/credentials", {
      requestId: id(),
      action: "create",
      label: "Tablet",
      client: "shadowrocket",
    });
    const first = (await (await agent("poll", { credentials: [] })).json()).job;
    assert.equal(
      (await (await agent("poll", { credentials: [] })).json()).job,
      null,
    );
    const second = (
      await (await agent("poll", { credentials: [] }, now + 121)).json()
    ).job;
    const payload = {
      ok: true,
      credential: {
        id: first.device_id,
        label: "Tablet",
        client: "shadowrocket",
        created: now,
        revoked: false,
      },
      token: randomBytes(32).toString("base64url"),
      files: { "clash.yaml": "a", "shadowrocket.txt": "b", "rules.conf": "c" },
    };
    assert.equal(
      (
        await agent(
          "ack",
          { id: first.id, lease: first.lease, ...payload },
          now + 121,
        )
      ).status,
      409,
    );
    assert.equal(
      sql.prepare("SELECT count(*) n FROM subscriptions").get().n,
      0,
    );
    assert.equal(
      (
        await agent(
          "ack",
          {
            id: second.id,
            lease: second.lease,
            ok: false,
            error: "unexpected secret",
          },
          now + 122,
        )
      ).status,
      200,
    );
    const job = sql.prepare("SELECT * FROM control_jobs").get();
    assert.equal(job.state, "failed");
    assert.equal(job.error, "apply_failed");
    assert.equal(
      (
        await agent(
          "ack",
          { id: first.id, lease: second.lease, ...payload },
          now + 123,
        )
      ).status,
      200,
    );
    assert.equal(
      sql.prepare("SELECT count(*) n FROM subscriptions").get().n,
      0,
    );
  } finally {
    sql.close();
  }
});
