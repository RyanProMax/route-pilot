import { authenticatedAccount, digest, privateHeaders } from "./auth.mjs";
const json = (value, status = 200) =>
  Response.json(value, { status, headers: privateHeaders });
const random = (n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
const identity = (x) => typeof x === "string" && /^[a-f0-9]{24}$/.test(x);
const jobID = (x) => typeof x === "string" && /^[a-f0-9]{32}$/.test(x);
const label = (x) =>
  typeof x === "string" &&
  x === x.trim() &&
  x.length > 0 &&
  x.length <= 80 &&
  !/[\x00-\x1f\x7f]/.test(x);
const actions = ["create", "rename", "revoke", "rotate", "publish"];
const audit = (db, now, account, action, id, outcome) =>
  db
    .prepare(
      "INSERT INTO admin_events(at,account_id,action,device_id,outcome) VALUES(?,?,?,?,?)",
    )
    .bind(now, account, action, id, outcome);
async function seal(env, id, token, files) {
  const token_hash = await digest(token),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(env.SUBSCRIPTION_KEY), (x) => x.charCodeAt(0)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const data = new TextEncoder().encode(
    JSON.stringify({ ...files, _token: token }),
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(
        `route-pilot:v1:${env.INSTANCE_ID}:${id}:${token_hash}`,
      ),
    },
    key,
    data,
  );
  const b64 = (a) => {
    const bytes = new Uint8Array(a);
    let text = "";
    for (let i = 0; i < bytes.length; i += 8192)
      text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
  };
  return { token_hash, iv: b64(iv), ciphertext: b64(ciphertext) };
}
function inventory(row) {
  return (
    row &&
    identity(row.id) &&
    label(row.label) &&
    ["clash", "shadowrocket"].includes(row.client) &&
    Number.isSafeInteger(row.created) &&
    row.created > 0 &&
    typeof row.revoked === "boolean"
  );
}

export async function adminAPI(request, env, now, helpers) {
  const url = new URL(request.url),
    path = url.pathname;
  if (
    !["/private/console", "/private/credentials"].includes(path) &&
    !path.startsWith("/private/control/") &&
    !/^\/private\/credentials\/[a-f0-9]{24}\/access$/.test(path)
  )
    return null;
  const { readBody, authorized, decrypt, hostLoad } = helpers,
    db = env.DB;
  if (path.startsWith("/private/control/")) {
    const header = request.headers.get("authorization") ?? "";
    if (
      !header.startsWith("Bearer ") ||
      !(await authorized(header.slice(7), env.CONTROL_SHA256))
    )
      return json({ error: "Unauthorized" }, 401);
    if (request.method !== "POST")
      return json({ error: "Method not allowed" }, 405);
    let body;
    try {
      body = await readBody(request, 550000);
      if (!body || Array.isArray(body) || typeof body !== "object")
        throw Error();
    } catch {
      return json({ error: "Invalid request" }, 400);
    }
    if (path === "/private/control/poll") {
      if (
        !Array.isArray(body.credentials) ||
        body.credentials.length > 512 ||
        body.credentials.some((x) => !inventory(x)) ||
        new Set(body.credentials.map((x) => x.id)).size !==
          body.credentials.length
      )
        return json({ error: "Invalid inventory" }, 400);
      await db.batch([
        db
          .prepare(
            "INSERT INTO control_agent(id,seen) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET seen=excluded.seen",
          )
          .bind(now),
        db
          .prepare(
            `INSERT INTO managed_credentials(id,label,client,created,updated,revoked)
     SELECT json_extract(value,'$.id'),json_extract(value,'$.label'),json_extract(value,'$.client'),json_extract(value,'$.created'),?,json_extract(value,'$.revoked') FROM json_each(?) WHERE 1
     ON CONFLICT(id) DO UPDATE SET label=excluded.label,client=excluded.client,updated=excluded.updated,revoked=MAX(managed_credentials.revoked,excluded.revoked)
     WHERE managed_credentials.label<>excluded.label OR managed_credentials.client<>excluded.client OR managed_credentials.revoked<excluded.revoked`,
          )
          .bind(now, JSON.stringify(body.credentials)),
        db
          .prepare(
            "UPDATE control_jobs SET state='failed',error='agent_timeout',finished=? WHERE state='running' AND lease_until<? AND attempts>=3",
          )
          .bind(now, now),
      ]);
      const lease = random(16);
      const job = await db
        .prepare(
          `UPDATE control_jobs SET state='running',lease=?,lease_until=?,attempts=attempts+1 WHERE id=(
    SELECT id FROM control_jobs WHERE state='queued' OR (state='running' AND lease_until<? AND attempts<3) ORDER BY created,id LIMIT 1)
    RETURNING id,action,device_id,payload,lease`,
        )
        .bind(lease, now + 120, now)
        .first();
      const credential = job
        ? await db
            .prepare(
              "SELECT id,label,client,created FROM managed_credentials WHERE id=?",
            )
            .bind(job.device_id)
            .first()
        : null;
      return json({
        job: job
          ? { ...job, payload: JSON.parse(job.payload), credential }
          : null,
      });
    }
    if (path === "/private/control/ack") {
      if (!jobID(body.id) || !jobID(body.lease) || typeof body.ok !== "boolean")
        return json({ error: "Invalid result" }, 400);
      const job = await db
        .prepare("SELECT * FROM control_jobs WHERE id=? AND lease=?")
        .bind(body.id, body.lease)
        .first();
      if (!job) return json({ error: "Lease expired" }, 409);
      if (["done", "failed"].includes(job.state)) return json({ ok: true });
      if (job.state !== "running") return json({ error: "Lease expired" }, 409);
      const guard =
        "EXISTS(SELECT 1 FROM control_jobs WHERE id=? AND lease=? AND state='running')";
      const guarded = (sql, args) =>
        db.prepare(sql).bind(...args, job.id, body.lease);
      const statements = [];
      if (body.ok) {
        const d = body.credential;
        if (
          !inventory(d) ||
          d.id !== job.device_id ||
          d.revoked !== (job.action === "revoke")
        )
          return json({ error: "Invalid credential" }, 400);
        if (
          job.action === "create" &&
          (d.label !== JSON.parse(job.payload).label ||
            d.client !== JSON.parse(job.payload).client)
        )
          return json({ error: "Invalid result" }, 400);
        if (
          job.action === "rename" &&
          d.label !== JSON.parse(job.payload).label
        )
          return json({ error: "Invalid result" }, 400);
        if (d.revoked)
          statements.push(
            guarded(
              "UPDATE subscriptions SET revoked=1,ciphertext='',iv='',updated=? WHERE id=? AND " +
                guard,
              [now, d.id],
            ),
          );
        else {
          if (
            !/^[A-Za-z0-9_-]{43}$/.test(body.token ?? "") ||
            !body.files ||
            Object.keys(body.files).sort().join(",") !==
              "clash.yaml,rules.conf,shadowrocket.txt" ||
            Object.values(body.files).some(
              (x) => typeof x !== "string" || !x.length || x.length > 150000,
            )
          )
            return json({ error: "Invalid profiles" }, 400);
          const sealed = await seal(env, d.id, body.token, body.files);
          statements.push(
            guarded(
              `INSERT INTO subscriptions(id,token_hash,ciphertext,iv,revoked,updated) SELECT ?,?,?,?,0,? WHERE ${guard}
      ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,ciphertext=excluded.ciphertext,iv=excluded.iv,revoked=0,updated=excluded.updated`,
              [d.id, sealed.token_hash, sealed.ciphertext, sealed.iv, now],
            ),
          );
        }
        statements.push(
          guarded(
            `INSERT INTO managed_credentials(id,label,client,created,updated,revoked) SELECT ?,?,?,?,?,? WHERE ${guard}
     ON CONFLICT(id) DO UPDATE SET label=excluded.label,client=excluded.client,updated=excluded.updated,revoked=excluded.revoked`,
            [d.id, d.label, d.client, d.created, now, Number(d.revoked)],
          ),
        );
      }
      const error = body.ok
        ? null
        : ["label_conflict", "unknown_credential", "apply_failed"].includes(
              body.error,
            )
          ? body.error
          : "apply_failed";
      statements.push(
        guarded(
          "INSERT INTO admin_events(at,account_id,action,device_id,outcome) SELECT ?,?,?,?,? WHERE " +
            guard,
          [
            now,
            job.account_id,
            job.action,
            job.device_id,
            body.ok ? "done" : "failed",
          ],
        ),
      );
      // Every write checks the lease in one D1 transaction; late acknowledgements cannot restore old credentials.
      statements.push(
        db
          .prepare(
            "UPDATE control_jobs SET state=?,finished=?,error=? WHERE id=? AND lease=? AND state='running'",
          )
          .bind(body.ok ? "done" : "failed", now, error, job.id, body.lease),
      );
      await db.batch(statements);
      const done = await db
        .prepare("SELECT state,lease FROM control_jobs WHERE id=?")
        .bind(job.id)
        .first();
      return done?.lease === body.lease &&
        ["done", "failed"].includes(done.state)
        ? json({ ok: true })
        : json({ error: "Lease expired" }, 409);
    }
    return json({ error: "Not found" }, 404);
  }
  const account = await authenticatedAccount(request, env, now);
  if (!account) return json({ error: "Unauthorized" }, 401);
  if (path === "/private/console" && request.method === "GET") {
    const month = new Date(now * 1000).toISOString().slice(0, 7);
    const results = await db.batch([
      db
        .prepare(
          `SELECT m.*,s.revoked AS download_revoked,s.id IS NOT NULL AS has_subscription,
    u.online,u.uplink,u.downlink,u.at,u.since,u.gaps FROM managed_credentials m LEFT JOIN subscriptions s ON s.id=m.id
    LEFT JOIN credential_usage u ON u.id=m.id AND u.month=? ORDER BY m.revoked,m.created DESC`,
        )
        .bind(month),
      db.prepare(
        "SELECT id,action,device_id,payload,state,created,finished,error FROM control_jobs ORDER BY created DESC,rowid DESC LIMIT 100",
      ),
      db.prepare("SELECT ts,metrics FROM reports ORDER BY minute DESC LIMIT 1"),
      db.prepare("SELECT seen FROM control_agent WHERE id=1"),
      db.prepare(
        "SELECT at,action,device_id,outcome FROM admin_events ORDER BY id DESC LIMIT 100",
      ),
    ]);
    const last = results[2].results[0],
      metrics = last ? JSON.parse(last.metrics) : {};
    return json({
      at: now,
      month,
      account: { email: account.email, role: account.role },
      instance: {
        id: env.INSTANCE_ID,
        name: env.INSTANCE_NAME ?? env.INSTANCE_ID,
        country: env.INSTANCE_COUNTRY ?? "",
      },
      reportedAt: last?.ts ?? null,
      serviceHealthy:
        !!last && now - last.ts <= 150 && metrics.proxy_service === "active",
      load: hostLoad(metrics, last?.ts, now),
      connections: Number.isSafeInteger(metrics.connections)
        ? metrics.connections
        : null,
      controlReady: !!env.CONTROL_SHA256,
      controlSeen: results[3].results[0]?.seen ?? null,
      credentials: results[0].results.map((r) => ({
        ...r,
        revoked: !!r.revoked,
        has_subscription: !!r.has_subscription,
        download_revoked: !!r.download_revoked,
        online: r.at && now - r.at <= 150 ? !!r.online : null,
      })),
      jobs: results[1].results.map((r) => ({
        ...r,
        payload: JSON.parse(r.payload),
      })),
      events: results[4].results,
    });
  }
  const access = /^\/private\/credentials\/([a-f0-9]{24})\/access$/.exec(path);
  if (access && request.method === "POST") {
    if (
      request.headers.get("origin") !== env.APP_ORIGIN ||
      url.origin !== env.APP_ORIGIN
    )
      return json({ error: "Forbidden" }, 403);
    const row = await db
      .prepare(
        "SELECT s.* FROM subscriptions s JOIN managed_credentials m ON m.id=s.id WHERE s.id=? AND s.revoked=0 AND m.revoked=0",
      )
      .bind(access[1])
      .first();
    if (!row) return json({ error: "Subscription unavailable" }, 404);
    let files;
    try {
      files = await decrypt(row, env);
    } catch {
      return json({ error: "Subscription unavailable" }, 503);
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(files._token ?? ""))
      return json({ error: "Publish subscription first" }, 409);
    await audit(db, now, account.id, "access", access[1], "done").run();
    return json({
      urls: Object.fromEntries(
        ["clash.yaml", "shadowrocket.txt", "rules.conf"].map((name) => [
          name,
          env.APP_ORIGIN + "/sub/" + files._token + "/" + name,
        ]),
      ),
    });
  }
  if (path === "/private/credentials" && request.method === "POST") {
    if (
      request.headers.get("origin") !== env.APP_ORIGIN ||
      url.origin !== env.APP_ORIGIN
    )
      return json({ error: "Forbidden" }, 403);
    if (!env.CONTROL_SHA256)
      return json({ error: "Control agent unavailable" }, 503);
    let body;
    try {
      body = await readBody(request, 4096);
      if (!body || Array.isArray(body) || typeof body !== "object")
        throw Error();
    } catch {
      return json({ error: "Invalid request" }, 400);
    }
    if (!jobID(body.requestId) || !actions.includes(body.action))
      return json({ error: "Invalid operation" }, 400);
    const old = await db
      .prepare("SELECT id,account_id FROM control_jobs WHERE id=?")
      .bind(body.requestId)
      .first();
    if (old)
      return old.account_id === account.id
        ? json({ ok: true, id: old.id }, 202)
        : json({ error: "Conflict" }, 409);
    if (["create", "rename"].includes(body.action) && !label(body.label))
      return json({ error: "Invalid name" }, 400);
    if (
      body.action === "create" &&
      !["clash", "shadowrocket"].includes(body.client)
    )
      return json({ error: "Invalid client" }, 400);
    const id = body.action === "create" ? random(12) : body.deviceId;
    if (!identity(id)) return json({ error: "Invalid credential" }, 400);
    if (body.action === "create") {
      const count = await db
        .prepare("SELECT count(*) n FROM managed_credentials WHERE revoked=0")
        .first();
      if (count.n >= 32)
        return json({ error: "Credential limit reached" }, 409);
    } else if (
      !(await db
        .prepare("SELECT id FROM managed_credentials WHERE id=? AND revoked=0")
        .bind(id)
        .first())
    )
      return json({ error: "Credential unavailable" }, 409);
    if (
      await db
        .prepare(
          "SELECT id FROM control_jobs WHERE device_id=? AND state IN ('queued','running')",
        )
        .bind(id)
        .first()
    )
      return json({ error: "Operation in progress" }, 409);
    if (
      ["create", "rename"].includes(body.action) &&
      (await db
        .prepare(
          "SELECT id FROM managed_credentials WHERE label=? AND revoked=0 AND id<>?",
        )
        .bind(body.label, id)
        .first())
    )
      return json({ error: "Name already exists" }, 409);
    const payload = {
      ...(body.label ? { label: body.label } : {}),
      ...(body.action === "create" ? { client: body.client } : {}),
    };
    const statements = [
      db
        .prepare(
          "INSERT INTO control_jobs(id,account_id,action,device_id,payload,created) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          body.requestId,
          account.id,
          body.action,
          id,
          JSON.stringify(payload),
          now,
        ),
      audit(db, now, account.id, body.action, id, "queued"),
    ];
    if (body.action === "create")
      statements.push(
        db
          .prepare(
            "INSERT INTO managed_credentials(id,label,client,created,updated,revoked) VALUES(?,?,?,?,?,0)",
          )
          .bind(id, body.label, body.client, now, now),
      );
    if (body.action === "revoke")
      statements.push(
        db
          .prepare("UPDATE subscriptions SET revoked=1,updated=? WHERE id=?")
          .bind(now, id),
      );
    try {
      await db.batch(statements);
    } catch {
      return json({ error: "Operation conflict" }, 409);
    }
    return json({ ok: true, id: body.requestId }, 202);
  }
  return json({ error: "Method not allowed" }, 405);
}
