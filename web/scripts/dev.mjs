import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer, loadEnv } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const cloudRoot = fileURLToPath(new URL('../../cloud/', import.meta.url));
const require = createRequire(new URL('../../cloud/package.json', import.meta.url));
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');
let worker, server, stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([server?.close(), worker?.dispose()]);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  const publicOrigin = process.env.ROUTEPILOT_PUBLIC_ORIGIN ?? loadEnv('development', webRoot, 'ROUTEPILOT_').ROUTEPILOT_PUBLIC_ORIGIN;
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
    host: '127.0.0.1', port: 8787, https: true,
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-01',
    d1Databases: ['DB'], d1Persist: path.join(cloudRoot, '.wrangler/local-d1'),
    bindings: {
      INSTANCE_ID: instance.id, INSTANCE_NAME: instance.name, INSTANCE_COUNTRY: instance.country ?? '',
      APP_ORIGIN: 'https://127.0.0.1:8787',
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
  server = await createServer({
    configFile: path.join(webRoot, 'vite.config.ts'),
    root: path.join(webRoot, 'status'),
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true,
      ...(publicOrigin ? { proxy: Object.fromEntries(['/instances.json', '/status'].map(prefix => [prefix, {
        target: publicOrigin, changeOrigin: true, secure: true,
        configure(proxy) {
          proxy.on('proxyReq', request => {
            request.removeHeader('cookie');
            request.removeHeader('authorization');
          });
        },
      }])) } : {}),
    },
  });
  await server.listen();
  console.log('Route Pilot: http://127.0.0.1:5173/');
  console.log('API: local workerd + persistent D1, using cloud/worker.mjs.');
  if (publicOrigin) console.log('Public node data: ' + publicOrigin);
  console.log('No sample reports or administrator accounts are inserted. Google login is unconfigured locally.');
} catch (error) {
  console.error(error);
  await stop();
  process.exitCode = 1;
}
