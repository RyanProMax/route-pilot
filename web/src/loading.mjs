import { createElement as h } from 'react';
import { Flex, Skeleton } from 'antd';

const block = (width, height, key) => h('div', {
  key, className: 'skeleton-block', style: { width, height },
}, h(Skeleton.Input, { active: true, size: 'small', style: { width: '100%', height: '100%', minWidth: 0 } }));

// Rendered by the build as well as React: the first HTML already has the complete loading layout.
export function StatusSkeleton() {
  return h('div', { className: 'status-page page-loading', role: 'status', 'aria-label': '正在加载节点状态', 'aria-busy': true },
    h('header', { className: 'site-header', 'aria-hidden': true },
      h(Flex, { gap: 10, align: 'center', className: 'skeleton-brand' }, block(40, 40), block(152, 28)),
      block(108, 12)),
    h('main', { 'aria-hidden': true },
      h('div', { className: 'instance-navigation' }, block(136, 44)),
      h('section', { className: 'traffic-row' },
        h(Flex, { gap: 9, align: 'center', className: 'traffic-label' }, block(66, 16), block(42, 19)),
        h('div', { className: 'traffic-meter' }, block('100%', 8)),
        h(Flex, { vertical: true, align: 'flex-end', gap: 4, className: 'traffic-summary' }, block(44, 18), block(144, 24))),
      h('section', { className: 'host-metrics' },
        ...Array.from({length:4}, (_,i) => h('div', {key:i}, block('100%',14), block('100%',4)))),
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
