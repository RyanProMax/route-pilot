const sessionName = '__Host-routepilot';
const views = {
  credentials: ['凭证管理', 'credentials', 2],
  activity: ['操作记录', 'credentials', 2],
  cloudflare: ['Cloudflare 用量', 'cloudflare', 3],
};

async function sessionState(request, env, url) {
  const matches = (request.headers.get('Cookie') ?? '').split(';')
    .map(value => value.trim()).filter(value => value.startsWith(sessionName + '='));
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].slice(sessionName.length + 1))) return 'guest';
  const headers = new Headers({ Cookie: matches[0] });
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) headers.set('CF-Connecting-IP', ip);
  let timer;
  try {
    const response = await Promise.race([
      env.ROUTEPILOT_SERVER.fetch(new Request(new URL('/private/session', url), { headers })),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); }),
    ]);
    return response?.status === 204 ? 'admin' : response?.status === 401 ? 'guest' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method) || !['/', '/index.html'].includes(url.pathname)) return env.ASSETS.fetch(request);
    const [state, asset] = await Promise.all([
      request.method === 'HEAD' ? 'unknown' : sessionState(request, env, url),
      env.ASSETS.fetch(new Request(new URL('/', url), { method: request.method })),
    ]);
    if (!asset.ok || !asset.headers.get('Content-Type')?.startsWith('text/html')) return asset;

    const headers = new Headers(asset.headers);
    for (const name of ['ETag', 'Last-Modified', 'Content-Length']) headers.delete(name);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('CDN-Cache-Control', 'no-store');
    headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
    if (request.method === 'HEAD') return new Response(null, { status: asset.status, headers });
    const page = url.searchParams.get('view');
    const view = state !== 'guest' && Object.hasOwn(views, page) ? views[page] : null;
    const nav = view?.[1] ?? 'overview';
    return new HTMLRewriter()
      .on('#root', { element: el => el.setAttribute('data-session', state) })
      .on('[data-shell-account]', { element(el) {
        if (el.getAttribute('data-shell-account') === state) el.removeAttribute('hidden');
        else el.remove();
      } })
      .on('[data-shell-nav]', { element(el) { if (state === 'admin') el.removeAttribute('hidden'); else el.remove(); } })
      .on('[data-shell-tab]', { element(el) {
        if (el.getAttribute('data-shell-tab') === nav) el.setAttribute('aria-current', 'page');
      } })
      .on('[data-shell-pill]', { element: el => el.setAttribute('style', `grid-column:${view?.[2] ?? 1};border-radius:999px`) })
      .on('[data-shell-overview]', { element: el => { if (view) el.remove(); } })
      .on('[data-shell-private]', { element(el) { if (view) el.removeAttribute('hidden'); else el.remove(); } })
      .on('[data-shell-private-title]', { element: el => { if (view) el.setInnerContent(view[0]); } })
      .transform(new Response(asset.body, { status: asset.status, headers }));
  },
};
