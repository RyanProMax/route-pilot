import { Badge, Button, Flex, Tooltip, Typography } from 'antd';
import type { CSSProperties } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Item, Summary } from './data';
export const labels = {
  heartbeat: '主机心跳',
  service: '节点服务',
  egress: '固定出口',
  edge4: 'IPv4 入口',
  edge6: 'IPv6 入口',
  connections: '节点连接数',
} as const;
export const states = {
  ok: { label: '健康', color: '#348267' },
  degraded: { label: '缓慢', color: '#a77c25' },
  down: { label: '异常', color: '#bf6057' },
  unknown: { label: '无数据', color: '#dddddd' },
} as const;
export const windows = { '24h': '24 小时', '7d': '7 天', '30d': '30 天' };
const tooltipTrigger: ('hover' | 'focus' | 'click')[] =
  window.matchMedia('(hover: none)').matches ? ['click'] : ['hover', 'focus'];

const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
export const displayTime = (ts: number) => dateTimeFormat.format(ts * 1000);
export const displayPeriod = (start: number, end: number) => {
  const first = new Date(start * 1000);
  const last = new Date(end * 1000);
  const ending = first.toDateString() === last.toDateString()
    ? timeFormat.format(last)
    : displayTime(end);
  return displayTime(start) + ' – ' + ending;
};

export function HistoryBars({ item, data, instanceId, activeTooltip, setActiveTooltip }: {
  item: Item; data: Summary; instanceId: string | null;
  activeTooltip: string | null; setActiveTooltip: Dispatch<SetStateAction<string | null>>;
}) {
  return (
        <Flex gap={3} align="end" className="history-bars" aria-label={labels[item.id] + '历史状态'}>
          {item.history.map((status, index) => {
            const start = data.start + index * data.width;
            const period = displayPeriod(start, Math.min(start + data.width, data.at));
            const tooltipId = instanceId + '-' + item.id + '-' + start;
            const count = item.values?.[index] ?? null;
            const credentials = item.deviceHistory?.[index] ?? null;
            const hasConnections = item.id === 'connections' && count !== null;
            const label = hasConnections
              ? (credentials !== null ? credentials + ' 个凭证，' : '') + count + ' 条连接'
              : states[status].label;
            const height = item.id === 'connections' && count !== null
              ? ({ '<10': '18%', '<30': '35%', '<50': '55%', '<100': '75%', '≥100': '100%' } as Record<string, string>)[count]
              : '100%';
            return (
              <Tooltip
                key={start}
                title={
                  <Flex vertical gap={6} className="history-tooltip">
                    {hasConnections ? <Flex align="center" gap={8}>
                      <Badge color={states[status].color} role="img" aria-label={states[status].label} />
                      <Flex align="center" gap={12} className="history-tooltip-metrics">
                        {credentials !== null && <Typography.Text><Typography.Text strong>{credentials}</Typography.Text> <Typography.Text type="secondary">个凭证</Typography.Text></Typography.Text>}
                        <Typography.Text><Typography.Text strong>{count}</Typography.Text> <Typography.Text type="secondary">条连接</Typography.Text></Typography.Text>
                      </Flex>
                    </Flex> : <Badge color={states[status].color} text={states[status].label} />}
                    <Typography.Text type="secondary" className="history-tooltip-period">{period}</Typography.Text>
                  </Flex>
                }
                trigger={tooltipTrigger}
                classNames={{ root: 'sample-tooltip' }}
                open={activeTooltip === tooltipId}
                onOpenChange={open => setActiveTooltip(current => open ? tooltipId : current === tooltipId ? null : current)}
                align={{ overflow: { adjustX: true, adjustY: true, shiftX: true } }}
                styles={{ root: { width: 'max-content', maxWidth: 'calc(100vw - 24px)' }, container: { padding: 0 } }}
                mouseEnterDelay={0.08}
                destroyOnHidden
              >
                <Button
                  type="text"
                  className="history-bar"
                  data-empty={item.id === "connections" && count === null || undefined}
                  // Keep hit targets fixed; only the painted bars expand and displace neighbors.
                  style={{ '--bar-color': states[status].color, backgroundColor: 'transparent', height, border: 0 } as CSSProperties}
                  aria-label={labels[item.id] + '，' + period + '，' + label}
                  onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setActiveTooltip(null); } }}
                />
              </Tooltip>
            );
          })}
        </Flex>
  );
}
