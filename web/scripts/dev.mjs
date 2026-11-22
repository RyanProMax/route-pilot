import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer, loadEnv } from 'vite';
import { macPreview } from './dev-link.mjs';
import { nextUsageUpdate, refreshCloudflareUsage } from '../../cloud/cloudflare-usage.mjs';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const cloudRoot = fileURLToPath(new URL('../../cloud/', import.meta.url));
const require = createRequire(new URL('../../cloud/package.json', import.meta.url));
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');
let worker, server, usageTimer, stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(usageTimer);
  await Promise.allSettled([server?.close(), worker?.dispose()]);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  const env = loadEnv('development', webRoot, 'ROUTEPILOT_');
  const publicOrigin = env.ROUTEPILOT_PUBLIC_ORIGIN;
  const clientFile = env.ROUTEPILOT_DEV_GOOGLE_CLIENT_FILE;
  const adminEmail = env.ROUTEPILOT_DEV_ADMIN_EMAIL?.trim().toLowerCase();
  const siteOrigin = (clientFile ? 'https' : 'http') + '://127.0.0.1:5173';
  const localLogin = !clientFile && env.ROUTEPILOT_DEV_LOCAL_LOGIN === '1';
  // Optional local reader keeps an operator's existing CLI session on the machine
  // that owns it. Only the normalized usage report crosses into the dev Worker.
  const reader = env.ROUTEPILOT_DEV_CF_USAGE_READER;
  const usageBindings = reader
    ? {CF_USAGE_PREVIEW_SCOPE:'preview:' + createHash('sha256').update(path.resolve(reader)).digest('hex')}
    : env.ROUTEPILOT_CF_USAGE_TOKEN ? {
      CF_USAGE_TOKEN:env.ROUTEPILOT_CF_USAGE_TOKEN, CF_USAGE_ACCOUNT_ID:env.ROUTEPILOT_CF_USAGE_ACCOUNT_ID,
      CF_USAGE_PROJECTS:env.ROUTEPILOT_CF_USAGE_PROJECTS || '{}', CF_USAGE_CYCLE_DAY:env.ROUTEPILOT_CF_USAGE_CYCLE_DAY || '1',
    } : {};
  const workerOrigin = 'https://127.0.0.1:8787';
  const appOrigin = clientFile ? siteOrigin : workerOrigin;
  let tls, googleBindings = {};
  if (clientFile) {
    const { web } = JSON.parse(await readFile(clientFile, 'utf8'));
    if (!web?.redirect_uris?.includes(siteOrigin + '/private/auth/google/callback') ||
        !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(web.client_id) ||
        typeof web.client_secret !== 'string' || web.client_secret.length < 16 || web.client_secret.length > 1024) {
      throw Error('Use a Google Web client JSON registered for ' + siteOrigin + '/private/auth/google/callback');
    }
    if (!adminEmail || adminEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      throw Error('Set ROUTEPILOT_DEV_ADMIN_EMAIL to the allowed local Google account.');
    }
    if (!env.ROUTEPILOT_DEV_TLS_CERT || !env.ROUTEPILOT_DEV_TLS_KEY) {
      throw Error('Set ROUTEPILOT_DEV_TLS_CERT and ROUTEPILOT_DEV_TLS_KEY to local HTTPS certificate and key paths.');
    }
    tls = { cert: await readFile(env.ROUTEPILOT_DEV_TLS_CERT), key: await readFile(env.ROUTEPILOT_DEV_TLS_KEY) };
    googleBindings = { GOOGLE_CLIENT_ID: web.client_id, GOOGLE_CLIENT_SECRET: web.client_secret };
  }
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.origin !== publicOrigin || url.username || url.password) {
      throw Error('ROUTEPILOT_PUBLIC_ORIGIN must be an HTTPS origin without credentials or a path.');
    }
  }
  const catalog = JSON.parse(await readFile(path.join(webRoot, 'public/instances.json'), 'utf8'));
  if (catalog.length !== 1) throw Error('Local development requires a single instance in web/public/instances.json.');
  const [instance] = catalog;
  const bundle = await build({
    entryPoints: [path.join(cloudRoot, 'worker.mjs')],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['cloudflare:*'],
  });
  worker = new Miniflare({
    host: '127.0.0.1', port: 8787, upstream: appOrigin,
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-01',
    d1Databases: ['DB'], d1Persist: path.join(cloudRoot, localLogin ? '.wrangler/demo-d1' : '.wrangler/local-d1'),
    bindings: {
      INSTANCE_ID: instance.id, INSTANCE_NAME: instance.name, INSTANCE_COUNTRY: instance.country ?? '',
      APP_ORIGIN: appOrigin,
      ...googleBindings,
      ...usageBindings,
    },
  });
  await worker.ready;
  const db = await worker.getD1Database('DB');
  await db.prepare('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)').run();
  const migrations = (await readdir(path.join(cloudRoot, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    if (await db.prepare('SELECT name FROM local_migrations WHERE name=?').bind(name).first()) continue;
    const sql = await readFile(path.join(cloudRoot, 'migrations', name), 'utf8');
    await db.batch([
      db.prepare(sql),
      db.prepare('INSERT INTO local_migrations(name) VALUES(?)').bind(name),
    ]);
  }
  if (clientFile) {
    await db.prepare("INSERT INTO rp_accounts(id,email,role,created) VALUES(?,?,'admin',?) ON CONFLICT(email) DO NOTHING")
      .bind(randomUUID(), adminEmail, Math.floor(Date.now() / 1000)).run();
  }
  // This plugin runs only in the opt-in loopback development server, with a separate local D1.
  const localSession = {
    name: 'local-development-session',
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__dev/session') return next();
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST' || req.headers.origin !== siteOrigin ||
            req.headers.host !== new URL(siteOrigin).host || req.socket.remoteAddress !== '127.0.0.1') {
          res.statusCode = 403;
          return res.end();
        }
        try {
          const token = randomBytes(32).toString('hex');
          const hash = createHash('sha256').update(token).digest('hex');
          const now = Math.floor(Date.now() / 1000);
          await db.batch([
            db.prepare("INSERT INTO rp_accounts(id,email,role,created) VALUES('local-demo','local@routepilot.invalid','admin',?) ON CONFLICT(id) DO NOTHING").bind(now),
            db.prepare('DELETE FROM rp_sessions WHERE expires <= ?').bind(now),
            db.prepare("INSERT INTO rp_sessions(hash,account_id,expires) VALUES(?,'local-demo',?)").bind(hash, now + 8 * 3600),
          ]);
          res.setHeader('Set-Cookie', '__Host-routepilot=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800');
          res.statusCode = 204;
          res.end();
        } catch (error) { next(error); }
      });
    },
  };
  const localProxy = {
    target: workerOrigin.replace('https:', 'http:'), changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (out, req) => {
        if (localLogin && req.headers.origin === siteOrigin && req.headers.host === new URL(siteOrigin).host) {
          out.setHeader('origin', appOrigin);
        }
      });
    },
  };
  const proxy = Object.fromEntries(['/status', '/private', '/sub', '/api/report'].map(prefix => [prefix, localProxy]));
  if (publicOrigin) {
    const upstream = {
      target: publicOrigin, changeOrigin: true, secure: true,
      configure(server) {
        server.on('proxyReq', out => {
          out.removeHeader('cookie');
          out.removeHeader('authorization');
        });
      },
    };
    proxy['/instances.json'] = upstream;
    proxy['/status'] = upstream;
  }
  server = await createServer({
    define: { 'import.meta.env.ROUTEPILOT_LOCAL_LOGIN': JSON.stringify(localLogin) },
    plugins: [
      ...(localLogin ? [localSession] : []),
      ...(env.ROUTEPILOT_DEV_MAC_SSH_HOST ? [await macPreview(env.ROUTEPILOT_DEV_MAC_SSH_HOST, env.ROUTEPILOT_DEV_MAC_INSTANCE, publicOrigin, env.ROUTEPILOT_DEV_MAC_HISTORY_FILE)] : []),
    ],
    configFile: path.join(webRoot, 'vite.config.ts'),
    root: path.join(webRoot, 'status'),
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true, https: tls,
      proxy,
    },
  });
  await server.listen();
  if (reader || usageBindings.CF_USAGE_ACCOUNT_ID) {
    const read = reader ? async () => {
      const {stdout} = await promisify(execFile)('python', [reader], {timeout:70000, windowsHide:true, maxBuffer:2e6});
      return JSON.parse(stdout);
    } : undefined;
    const tick = async () => {
      const started = Date.now();
      try { await refreshCloudflareUsage({...usageBindings, DB:db}, started, read); }
      catch { console.error('Daily Cloudflare usage collection failed.'); }
      if (!stopping) usageTimer = setTimeout(tick, Math.max(1, nextUsageUpdate(started) - Date.now()));
    };
    void tick();
  }
  console.log('Route Pilot: ' + siteOrigin + '/');
  console.log('API: local workerd + persistent D1, using cloud/worker.mjs.');
  if (publicOrigin) console.log('Public node data: ' + publicOrigin);
  if (localLogin) console.log('Local development login enabled. Sessions and administration use an isolated demo D1.');
  console.log(clientFile ? 'Google login uses the local administrator allowlist and D1.' : 'Google login is unconfigured locally. See docs/admin-login.md.');
} catch (error) {
  console.error(error);
  await stop();
  process.exitCode = 1;
}
