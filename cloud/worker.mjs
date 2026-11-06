import { connect } from "cloudflare:sockets";
import { readStatus } from "./status-cache.mjs";
import { privateAPI, usageStatements } from "./private-api.mjs";


const clock = () => Math.floor(Date.now() / 1000);
const staleAfter = 150;

function response(body, status = 200, headers = {}) {
  return Response.json(body, {status, headers: {"Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff", ...headers}});
}
async function authorized(value, digest) {
  if (!value || !digest || value.length > 200) return false;
  const hashed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashed), x => x.toString(16).padStart(2, "0")).join("") === digest;
}
function sample(env, id, ts, status, message, latency = null) {
  return env.DB.prepare("INSERT INTO samples(check_id,minute,ts,status,message,latency) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(id, Math.floor(ts/60), ts, status, message, latency);
}
function normalizeReport(input, now) {
  if (input?.schema !== 1 || !Number.isSafeInteger(input.ts) || Math.abs(now-input.ts)>120) throw Error("timestamp");
  const m = input.metrics;
  const sec = m?.security;
  for (const name of ["memory_used","memory_total","disk_used","disk_total","load1","cpu_count","uptime_seconds","xray_restarts","connections"]) {
    if (!Number.isFinite(m?.[name]) || m[name]<0) throw Error(name);
  }
  if (!Number.isInteger(m.connections) || !m.memory_total || !m.disk_total || m.memory_used>m.memory_total || m.disk_used>m.disk_total) throw Error("metrics");
  const ports = (v) => {
    if (!Array.isArray(v) || v.length>64 || v.some(p=>!Number.isInteger(p)||p<1||p>65535)) throw Error("ports");
    return v;
  };
  if (!["active","inactive","failed","activating","deactivating","unknown"].includes(m.proxy_service)) throw Error("service");
  for (const key of ["ufw_active","fail2ban_active","sshd_jail_active","reporter_sandboxed"]) {
    if (typeof sec?.[key] !== "boolean") throw Error(key);
  }
  const security = {
    ssh_ports:ports(sec.ssh_ports), public_tcp_ports:ports(sec.public_tcp_ports),
    ufw_active:sec.ufw_active, fail2ban_active:sec.fail2ban_active, sshd_jail_active:sec.sshd_jail_active,
    banned_count:Number.isSafeInteger(sec.banned_count)?sec.banned_count:null,
    reporter_sandboxed:sec.reporter_sandboxed, legacy_packages:{}
  };
  for (const k of ["passwordauthentication","kbdinteractiveauthentication","permitrootlogin"]) {
    if (!["yes","no","prohibit-password","forced-commands-only","unknown"].includes(sec[k])) throw Error(k);
    security[k]=sec[k];
  }
  for (const k of ["wireguard","wireguard-tools","tinyproxy","tinyproxy-bin","shadowsocks-libev"]) {
    if (typeof sec.legacy_packages?.[k]!=="boolean") throw Error("packages");
    security.legacy_packages[k]=sec.legacy_packages[k];
  }
  const traffic = Number.isSafeInteger(m.month_tx_bytes) && m.month_tx_bytes >= 0
    ? {month_tx_bytes:m.month_tx_bytes} : {};
  return {ts:input.ts, usage:input.usage, metrics:{...Object.fromEntries(["memory_used","memory_total","disk_used","disk_total","load1","cpu_count","uptime_seconds","xray_restarts","connections","proxy_service"].map(k=>[k,m[k]])),...traffic,cpu_percent:Number.isFinite(m.cpu_percent) && m.cpu_percent>=0 && m.cpu_percent<=100 ? m.cpu_percent : null,devices:Number.isSafeInteger(m.devices) && m.devices >= 0 ? m.devices : null,security}};
}

async function ingest(request,env) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ") || !await authorized(header.slice(7),env.REPORT_SHA256)) return response({error:"Unauthorized"},401);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return response({error:"JSON required"},415);
  if (Number(request.headers.get("content-length"))>550000) return response({error:"Too large"},413);
  const reader=request.body?.getReader();
  if (!reader) return response({error:"Empty body"},400);
  let raw="", size=0;
  const decoder=new TextDecoder();
  for (;;) {
    const {done,value}=await reader.read();
    if (done) break;
    size+=value.byteLength;
    if (size>550000) {await reader.cancel();return response({error:"Too large"},413);}
    raw+=decoder.decode(value,{stream:true});
  }
  let report;
  try {report=normalizeReport(JSON.parse(raw+decoder.decode()),clock());}
  catch {return response({error:"Invalid or expired sample"},400);}
  const {ts,metrics}=report;
  let usage;
  try {usage=usageStatements(env.DB,report.usage,ts);} catch {return response({error:"Invalid usage"},400);}
  const actual=request.headers.get("cf-connecting-ip") || "";
  const serviceOK=metrics.proxy_service==="active" && metrics.security.public_tcp_ports.includes(Number(env.PORT));
  await env.DB.batch([
    ...usage,
    env.DB.prepare("INSERT INTO reports(minute,ts,metrics,egress) VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(Math.floor(ts/60),ts,JSON.stringify(metrics),actual),
    sample(env,"heartbeat",ts,"ok","已收到 VPS 自检"),
    sample(env,"xray",ts,serviceOK?"ok":"down",serviceOK?"Xray 正在运行并监听业务端口":"服务或本机监听异常"),
    sample(env,"egress",ts,!actual?"unknown":actual===env.IPV4?"ok":"down","上报源地址 "+(actual||"未知"))
  ]);
  return response({accepted:true});
}
async function probe(env,id,address,time) {
  let socket,timer;
  const before=Date.now();
  try {
    // The CONNECT authority needs brackets around an IPv6 literal.
    const hostname = address.includes(":") ? "[" + address + "]" : address;
    socket=connect({hostname,port:Number(env.PORT)});
    socket.closed.catch(()=>{});
    await Promise.race([socket.opened,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("timeout")),6000);})]);
    return sample(env,id,time,"ok","Cloudflare 已建立 TCP 连接",Date.now()-before);
  } catch {
    return sample(env,id,time,"down","Cloudflare TCP 连接失败或超时");
  } finally {
    clearTimeout(timer);
    if(socket) socket.close().catch(()=>{});
  }
}
async function observe(env,now) {
  const statements=await Promise.all([probe(env,"edge4",env.IPV4,now),env.IPV6 ? probe(env,"edge6",env.IPV6,now) : sample(env,"edge6",now,"unknown","未配置 IPv6 入口")]);
  const last=await env.DB.prepare("SELECT ts FROM reports ORDER BY minute DESC LIMIT 1").first();
  if (last && now-last.ts>staleAfter) statements.push(sample(env,"heartbeat",now-60,"unknown","超过 150 秒未收到 VPS 自检"));
  await env.DB.batch(statements);
}
async function prune(env,now) {
  const cutoff=now-31*86400;
  await env.DB.batch(["DELETE FROM samples WHERE ts<?","DELETE FROM reports WHERE minute<?","DELETE FROM events WHERE ts<?","DELETE FROM buckets WHERE bucket+width<?","DELETE FROM connection_buckets WHERE bucket+width<?"].map((sql,i)=>env.DB.prepare(sql).bind(i===1?Math.floor(cutoff/60):cutoff)));
  await env.DB.batch([env.DB.prepare("DELETE FROM control_jobs WHERE state IN ('done','failed') AND finished<?").bind(now-90*86400),
    env.DB.prepare('DELETE FROM admin_events WHERE at<?').bind(now-90*86400),env.DB.prepare('DELETE FROM rp_sessions WHERE expires<?').bind(now),
    env.DB.prepare('DELETE FROM oauth_attempts WHERE expires<?').bind(now),
    env.DB.prepare('DELETE FROM credential_usage WHERE month<?').bind(new Date((now-366*86400)*1000).toISOString().slice(0,7))]);
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if (url.pathname.startsWith('/private/') || url.pathname.startsWith('/sub/')) {
      try {return await privateAPI(request,env,clock());}
      catch {return response({error:'Unavailable'},503);}
    }
    if (url.protocol !== "https:") {
      if (!["GET","HEAD"].includes(request.method)) return response({error:"HTTPS required"},403);
      url.protocol = "https:";
      return new Response(null, {status:308, headers:{Location:url.toString(), "Cache-Control":"no-store"}});
    }
    if (url.pathname.startsWith("/status/")) {
      const status = await readStatus(request, env.DB, clock(), Number(env.PLAN_BANDWIDTH_GB), env.INSTANCE_ID);
      if (status) return status;
    }
    if (request.method === "POST" && (url.pathname === "/api/report" || /^\/i\/[a-f0-9]{64}$/.test(url.pathname))) {
      return ingest(request, env);
    }
    return response({error:"Not found"},404);
  },
  async scheduled(event,env) {
    const now=Math.floor(event.scheduledTime/1000);
    if(event.cron==="15 3 * * *") await prune(env,now);
    else await observe(env,now);
  }
};
