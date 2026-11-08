import { createElement as h } from 'react';
import { Flex, Skeleton } from 'antd';

const block = (width, height, key) => h('div', {
  key, className: 'skeleton-block', style: { width, height },
}, h(Skeleton.Input, { active: true, size: 'small', style: { width: '100%', height: '100%', minWidth: 0 } }));

// Rendered by the build as well as React: the first HTML already has the complete loading layout.
export function StatusSkeleton() {
  return h('div', { className: 'status-page page-loading', role: 'status', 'aria-label': '正在加载节点状态', 'aria-busy': true },
    h('header', { className: 'site-header', 'aria-hidden': true },
      h(Flex, { gap: 10, align: 'center', className: 'skeleton-brand' }, block(30, 30), block(145, 24)),
      block(80, 44)),
    h('main', { 'aria-hidden': true },
      h('section', { className: 'node-overview' },
        h('div', { className: 'instance-navigation' }, block(136, 44))),
      h('section', { className: 'host-metrics' },
        ...Array.from({length:4}, (_,i) => h('div', {key:i, className:'host-metric'},
          h('div', {className:'host-metric-label'}, block(42,18), block(72,34)), block('100%',3)))),
      h('section', { className: 'history-section' },
        h(Flex, { justify: 'space-between', align: 'center', gap: 16, className: 'section-heading' }, block(96, 18), block(166, 36)),
        h('div', { className: 'skeleton-table' },
          h('div', { className: 'skeleton-table-head' },
            ...[64, 64, 40, 60].map((width, i) => h('div', { className: 'skeleton-cell', key: i }, block(width, 12)))),
          ...Array.from({ length: 6 }, (_, i) => h('div', { className: 'skeleton-table-row', key: i },
            h('div', { className: 'skeleton-cell skeleton-name' }, block(98, 14)),
            h('div', { className: 'skeleton-cell skeleton-history' }, block('100%', 26)),
            h('div', { className: 'skeleton-cell skeleton-rate' }, block(44, 12)),
            h('div', { className: 'skeleton-cell skeleton-latency' }, block(56, 12))))),
        h(Flex, { gap: 18, justify: 'center', wrap: true, className: 'history-legend' },
          ...Array.from({ length: 4 }, (_, i) => block(48, 12, i))))));
}
