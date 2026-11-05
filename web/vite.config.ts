import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createCache, extractStyle, StyleProvider } from '@ant-design/cssinjs';
import { StatusSkeleton } from './src/loading.mjs';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), {
    name: 'status-loading-shell',
    transformIndexHtml(html, context) {
      const cache = createCache();
      const skeleton = renderToString(createElement(StyleProvider, { cache }, createElement(StatusSkeleton)));
      const app = Object.values(context.bundle ?? {}).find(entry =>
        entry.type === 'chunk' && entry.facadeModuleId?.endsWith('/src/status.tsx'));
      // This chunk is always needed: start it at HTML parsing, alongside the data preload.
      if (app) html = html.replace('</head>', `<link rel="modulepreload" crossorigin href="/${app.fileName}"/></head>`);
      // The page stylesheet is only a few KB: inline it so the skeleton needs no CSS round trip.
      html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (tag, href: string) => {
        const asset = context.bundle?.[href.replace(/^\//, '')];
        return asset?.type === 'asset' ? `<style data-routepilot>${asset.source}</style>` : tag;
      });
      return html.replace('<div id="root"></div>', '<div id="root">' + skeleton + '</div>')
        // Library styles precede app CSS, both before and after client style insertion.
        .replace('</title>', '</title>' + extractStyle(cache));
    },
  }, VitePWA({
    registerType: 'autoUpdate',
    injectRegister: 'script-defer',
    includeManifestIcons: false,
    manifest: {
      id: '/', name: 'route-pilot', short_name: 'route-pilot', lang: 'zh-CN',
      description: '节点服务状态与稳定性记录',
      start_url: '/', scope: '/', display: 'standalone',
      theme_color: '#ffffff', background_color: '#ffffff',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      cacheId: 'routepilot-static',
      skipWaiting: true,
      clientsClaim: true,
      globPatterns: ['offline.html', 'offline.js', 'icons/*.png'],
      cleanupOutdatedCaches: true,
      navigateFallback: null,
      // Only document navigations get an offline fallback. Do not cache status or instance data.
      runtimeCaching: [{
        urlPattern: ({ request, url }) => request.mode === 'navigate' && url.origin === self.location.origin && url.pathname === '/',
        handler: 'NetworkOnly',
        options: { precacheFallback: { fallbackURL: '/offline.html' } },
      }],
    },
  })],
  root: 'status',
  resolve: { alias: { '/src': fileURLToPath(new URL('./src', import.meta.url)) } },
  publicDir: '../public',
  server: { proxy: { '/status': 'http://127.0.0.1:8787' } },
  build: { outDir: '../dist-status', emptyOutDir: true, assetsInlineLimit: 0 },
});
