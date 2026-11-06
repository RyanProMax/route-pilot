import {authAPI, authenticatedAccount, digest, privateHeaders} from './auth.mjs';
export {digest} from './auth.mjs';
// Private configuration and usage are never read by public-status.mjs.
const encoder = new TextEncoder();
export async function authorized(value, expected) {
  if (!value || value.length > 200 || !/^[a-f0-9]{64}$/.test(expected ?? '')) return false;
  const actual = await digest(value);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
const headers = privateHeaders;
const json = (body, status = 200, extra = {}) => Response.json(body, {status, headers:{...headers,...extra}});
export async function readBody(request, maximum) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw Error('body');
  const reader = request.body?.getReader();
  if (!reader) throw Error('body');
  let size = 0, raw = '';
  const decoder = new TextDecoder('utf-8', {fatal:true});
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {await reader.cancel(); throw Error('body');}
    raw += decoder.decode(value, {stream:true});
  }
  return JSON.parse(raw + decoder.decode());
}
function bytes(value) {return Uint8Array.from(atob(value), c => c.charCodeAt(0));}
export async function decrypt(row, env) {
  const key = await crypto.subtle.importKey('raw', bytes(env.SUBSCRIPTION_KEY), 'AES-GCM', false, ['decrypt']);
  const aad = encoder.encode(`route-pilot:v1:${env.INSTANCE_ID}:${row.id}:${row.token_hash}`);
  const plaintext = await crypto.subtle.decrypt({name:'AES-GCM', iv:bytes(row.iv), additionalData:aad}, key, bytes(row.ciphertext));
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
}
export async function privateAPI(request, env, now) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/sub/') && !path.startsWith('/private/')) return null;
  if (url.protocol !== 'https:' || (url.search && path!=='/private/auth/google/callback')) return json({error:'Not found'},404);
  // Rate limiting is best effort per CF location; authentication remains mandatory.
  if (env.PRIVATE_LIMIT && !(await env.PRIVATE_LIMIT.limit({key:request.headers.get('cf-connecting-ip') || 'unknown'})).success)
    return json({error:'Too many requests'},429,{'Retry-After':'60'});
  const authentication = await authAPI(request,env,now);
  if(authentication)return authentication;
  if (path.startsWith('/sub/')) {
    const match = /^\/sub\/([A-Za-z0-9_-]{43})\/(clash\.yaml|shadowrocket\.txt|rules\.conf)$/.exec(path);
    if (!match || !['GET','HEAD'].includes(request.method)) return json({error:'Not found'},404);
    const row = await env.DB.prepare('SELECT * FROM subscriptions WHERE token_hash=? AND revoked=0').bind(await digest(match[1])).first();
    if (!row) return json({error:'Not found'},404);
    let content;
    try {content = (await decrypt(row, env))[match[2]];} catch {return json({error:'Unavailable'},503);}
    if (typeof content !== 'string') return json({error:'Not found'},404);
    return new Response(request.method === 'HEAD' ? null : content, {headers:{...headers,
      'Content-Type':'text/plain; charset=utf-8', 'profile-update-interval':'24',
      'Content-Disposition':`attachment; filename="${match[2]}"`}});
  }
  if (path === '/private/overview' && request.method === 'GET') {
    if (!await authenticatedAccount(request,env,now)) return json({error:'Unauthorized'},401);
    const month = new Date(now*1000).toISOString().slice(0,7);
    const [usage, latest] = await env.DB.batch([
      env.DB.prepare('SELECT id,label,revoked,online,uplink,downlink,since,at,gaps FROM credential_usage WHERE month=? ORDER BY revoked,label').bind(month),
      env.DB.prepare('SELECT ts,metrics FROM reports ORDER BY minute DESC LIMIT 1')]);
    const last = latest.results[0], metrics = last ? JSON.parse(last.metrics) : {};
    return json({at:now,month,reportedAt:last?.ts ?? null,load:hostLoad(metrics,last?.ts,now),
      credentials:usage.results.map(row=>({...row,online:now-row.at<=150 ? !!row.online : null,revoked:!!row.revoked}))});
  }
  if (path.startsWith('/private/manage/')) {
    const header = request.headers.get('authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!await authorized(bearer,env.PROVISION_SHA256)) return json({error:'Unauthorized'},401);
    if (request.method !== 'POST') return json({error:'Method not allowed'},405);
    let body; try {body = await readBody(request,400_000);} catch {return json({error:'Invalid request'},400);}
    if (!/^[a-f0-9]{24}$/.test(body.id ?? '')) return json({error:'Invalid identity'},400);
    if (path === '/private/manage/revoke') {
      await env.DB.prepare('UPDATE subscriptions SET revoked=1,ciphertext=\'\',iv=\'\',updated=? WHERE id=?').bind(now,body.id).run();
      return json({ok:true});
    }
    if (path === '/private/manage/publish') {
      if (!/^[a-f0-9]{64}$/.test(body.token_hash ?? '') || !/^[A-Za-z0-9+/]{16}$/.test(body.iv ?? '') ||
          typeof body.ciphertext !== 'string' || body.ciphertext.length > 350_000) return json({error:'Invalid envelope'},400);
      try {
        const files = await decrypt(body,env);
        if (!Object.keys(files).length || Object.entries(files).some(([name,value]) =>
          !['clash.yaml','shadowrocket.txt','rules.conf'].includes(name) || typeof value !== 'string' || !value.length)) throw Error('files');
      } catch {return json({error:'Invalid envelope'},400);}
      await env.DB.prepare(`INSERT INTO subscriptions(id,token_hash,ciphertext,iv,revoked,updated) VALUES(?,?,?,?,0,?)
        ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,ciphertext=excluded.ciphertext,iv=excluded.iv,revoked=0,updated=excluded.updated`)
        .bind(body.id,body.token_hash,body.ciphertext,body.iv,now).run();
      return json({ok:true});
    }
  }
  return json({error:'Not found'},404);
}
export function hostLoad(metrics, ts, now) {
  if (!Number.isFinite(ts) || now-ts>150) return null;
  const percent = (used,total) => Number.isFinite(used) && Number.isFinite(total) && total>0 && used>=0 && used<=total ? Math.round(used/total*1000)/10 : null;
  return {cpu:Number.isFinite(metrics.cpu_percent) && metrics.cpu_percent>=0 && metrics.cpu_percent<=100 ? metrics.cpu_percent : null,
    memory:percent(metrics.memory_used,metrics.memory_total), disk:percent(metrics.disk_used,metrics.disk_total),
    load1:Number.isFinite(metrics.load1) ? metrics.load1 : null};
}
export function usageStatements(db, input, ts) {
  if (input === undefined) return [];
  const month = new Date(ts*1000).toISOString().slice(0,7);
  if (!Array.isArray(input) || input.length>32 || new Set(input.map(r=>r.id)).size !== input.length) throw Error('usage');
  return input.map(row => {
    if (!/^(?:[a-f0-9]{24}|legacy-\d{1,3})$/.test(row.id ?? '') || typeof row.label !== 'string' || !row.label.length || row.label.length>80 ||
        /[\x00-\x1f]/.test(row.label) || row.month!==month || typeof row.online!=='boolean' || typeof row.revoked!=='boolean' ||
        ['uplink','downlink','since','gaps'].some(k=>!Number.isSafeInteger(row[k]) || row[k]<0) || row.since>ts) throw Error('usage');
    return db.prepare(`INSERT INTO credential_usage(id,month,label,revoked,online,uplink,downlink,since,at,gaps) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id,month) DO UPDATE SET label=excluded.label,revoked=excluded.revoked,online=excluded.online,
      uplink=MAX(credential_usage.uplink,excluded.uplink),downlink=MAX(credential_usage.downlink,excluded.downlink),
      since=MIN(credential_usage.since,excluded.since),at=excluded.at,gaps=MAX(credential_usage.gaps,excluded.gaps)
      WHERE excluded.at>credential_usage.at`).bind(row.id,month,row.label,Number(row.revoked),Number(row.online),row.uplink,row.downlink,row.since,ts,row.gaps);
  });
}
