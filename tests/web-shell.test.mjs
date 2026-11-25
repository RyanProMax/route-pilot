import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { Miniflare } = createRequire(new URL('../cloud/package.json', import.meta.url))('miniflare');

const cookie = '__Host-routepilot=' + 'a'.repeat(64);
const shell = '<div id="root"><header><nav data-shell-nav hidden><span data-shell-pill></span><a data-shell-tab="overview">Home</a><a data-shell-tab="credentials">Credentials</a></nav><span data-shell-account="admin" hidden>Admin</span><span data-shell-account="guest" hidden>Login</span></header><main data-shell-overview>Overview</main><main data-shell-private hidden><h1 data-shell-private-title></h1></main></div>';

test('first HTML contains verified UI state only, never cookies or shared-cacheable account markup', async () => {
  let checks = 0;
  const mf = new Miniflare({
    modules: true, scriptPath: fileURLToPath(new URL('../cloud/web-shell.mjs', import.meta.url)), compatibilityDate: '2026-07-01',
    serviceBindings: {
      ASSETS: req => new URL(req.url).pathname.startsWith('/assets/')
        ? new Response('asset bytes', { headers: { 'Cache-Control': 'public, immutable' } })
        : new Response(shell, { headers: { 'Content-Type': 'text/html', 'ETag': '"static"', 'Content-Security-Policy': "default-src 'self'" } }),
      ROUTEPILOT_SERVER: req => {
        checks++;
        assert.equal(req.url, 'https://status.example.com/private/session');
        const token = req.headers.get('cookie');
        assert.match(token, /^__Host-routepilot=[a-f0-9]{64}$/);
        return new Response(null, { status: token === cookie ? 204 : token.includes('b') ? 401 : 503 });
      },
    },
  });
  try {
    const load = (path, cookie = '') => mf.dispatchFetch('https://status.example.com' + path, { headers: { cookie } });
    const guest = await load('/?view=credentials');
    assert.match(guest.headers.get('cache-control'), /private, no-store/);
    assert.equal(guest.headers.get('content-security-policy'), "default-src 'self'");
    assert.equal(guest.headers.get('etag'), null);
    const guestHTML = await guest.text();
    assert.match(guestHTML, /data-session="guest"/);
    assert.match(guestHTML, />Login</);
    assert.doesNotMatch(guestHTML, />Admin<|data-shell-nav|data-shell-private/);
    assert.equal(checks, 0);
    const admin = await load('/?view=activity', 'unrelated=do-not-forward; ' + cookie);
    const html = await admin.text();
    assert.match(html, /data-session="admin"/);
    assert.match(html, />Admin</);
    assert.match(html, /data-shell-tab="credentials" aria-current="page"/);
    assert.match(html, />操作记录</);
    assert.doesNotMatch(html, />Login<|data-shell-overview|__Host-routepilot|do-not-forward/);
    assert.match(admin.headers.get('cloudflare-cdn-cache-control'), /no-store/);
    assert.equal(checks, 1);
    assert.match(await (await load('/', cookie.replace(/a{64}$/, 'b'.repeat(64)))).text(), /data-session="guest"/);
    const unknown = await (await load('/?view=credentials', cookie.replace(/a{64}$/, 'c'.repeat(64)))).text();
    assert.match(unknown, /data-session="unknown"/);
    assert.match(unknown, />凭证管理</);
    assert.doesNotMatch(unknown, />Admin<|>Login</);
    const duplicate = await (await load('/', cookie + '; ' + cookie)).text();
    assert.match(duplicate, /data-session="guest"/);
    assert.equal(checks, 3);
    const asset = await load('/assets/app.js', cookie);
    assert.equal(await asset.text(), 'asset bytes');
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.equal(checks, 3);
  } finally { await mf.dispose(); }
});
