import { createElement as h } from 'react';
import { Flex, Skeleton } from 'antd';
import { ChevronDown, LogIn, Moon, Sun } from 'lucide-react';

const block = (width, height, key) => h('div', {
  key, className: 'skeleton-block', style: { width, height },
}, h(Skeleton.Input, { active: true, size: 'small', style: { width: '100%', height: '100%', minWidth: 0 } }));

// Rendered by the build as well as React: the first HTML already has the complete loading layout.
export function StatusSkeleton() {
  return h('div', { className: 'status-page page-loading' },
    h('header', { className: 'site-header app-header' },
      h('a', { href: '/', className: 'console-brand', 'aria-label': 'Route Pilot 状态首页' },
        h('img', { src: '/routepilot-mark.svg', width: 32, height: 32, alt: '' }), h('span', null, 'Route Pilot')),
      h('nav', { className: 'app-navigation', 'aria-label': '管理导航', 'data-shell-nav': '', hidden: true },
        h('span', { className: 'app-navigation-pill', 'aria-hidden': true, 'data-shell-pill': '' }),
        ...[['overview', '首页'], ['credentials', '凭证管理'], ['cloudflare', 'Cloudflare 用量']].map(([view, label], i) =>
          h('a', { key: view, href: view === 'overview' ? '/' : '/?view=' + view, 'data-shell-tab': view,
            style: { gridColumn: i + 1 } }, label))),
      h('div', { className: 'header-actions' },
        h('span', { className: 'shell-control shell-theme', 'aria-hidden': true },
          h(Sun, { size: 18, className: 'shell-sun' }), h(Moon, { size: 17, className: 'shell-moon' })),
        h('span', { className: 'ant-btn account-button shell-control', 'data-shell-account': 'admin', hidden: true },
          '管理员', h(ChevronDown, { size: 13, strokeWidth: 1.65, 'aria-hidden': true })),
        h('span', { className: 'shell-control shell-login', 'data-shell-account': 'guest', hidden: true },
          h(LogIn, { size: 16, 'aria-hidden': true }), '登录'))),
    h('main', { className: 'console-main', 'data-shell-private': '', hidden: true, 'aria-busy': true },
      h('h1', { 'data-shell-private-title': '' }), h(Skeleton, { active: true, paragraph: { rows: 4 } })),
    h('main', { 'data-shell-overview': '', 'aria-hidden': true, 'aria-busy': true },
      h('section', { className: 'node-overview' },
        block(128, 36), h('div', { className: 'instance-navigation' }, block(136, 38))),
      h('section', { className: 'host-metrics' },
        ...Array.from({length:4}, (_,i) => h('div', {key:i, className:'host-metric'},
          h('div', {className:'metric-heading'}, block(30,30), block(42,16)), block(72,34), block('100%',5)))),
      h('section', { className: 'history-section history-card' },
        h(Flex, { justify: 'space-between', align: 'center', gap: 16, className: 'section-heading' }, block(96, 18), block(166, 36)),
        h('div', { className: 'skeleton-table' },
          h('div', { className: 'skeleton-table-head' },
            ...[64, 64, 40, 60].map((width, i) => h('div', { className: 'skeleton-cell', key: i }, block(width, 12)))),
          ...Array.from({ length: 5 }, (_, i) => h('div', { className: 'skeleton-table-row', key: i },
            h('div', { className: 'skeleton-cell skeleton-name' }, block(98, 14)),
            h('div', { className: 'skeleton-cell skeleton-history' }, block('100%', 26)),
            h('div', { className: 'skeleton-cell skeleton-rate' }, block(44, 12)),
            h('div', { className: 'skeleton-cell skeleton-latency' }, block(56, 12))))),
        h(Flex, { gap: 18, wrap: true, className: 'history-footer history-legend' },
          ...Array.from({ length: 4 }, (_, i) => block(48, 12, i))))));
}
