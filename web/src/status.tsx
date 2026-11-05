import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert, Badge, Button, ConfigProvider, Empty, Flex, Progress, Radio, Segmented,
  Table, Tag, Tooltip, Typography,
} from 'antd';
import type { TableColumnsType, ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Globe2 } from 'lucide-react';
import { readInstances, readStatus } from './data';
import type { InitialData, Item, Range, State, StatusBundle } from './data';
import { StatusSkeleton } from './loading.mjs';
import routeMark from './assets/routepilot-mark.svg';
import japanFlag from './assets/jp.svg';

const labels = {
  heartbeat: '主机心跳',
  service: '节点服务',
  egress: '固定出口',
  edge4: 'IPv4 入口',
  edge6: 'IPv6 入口',
  connections: '节点连接数',
} as const;
const states = {
  ok: { label: '健康', color: '#159b76' },
  degraded: { label: '缓慢', color: '#bd9425' },
  down: { label: '异常', color: '#d3635b' },
  unknown: { label: '无数据', color: '#e0e5e3' },
} as const;
const windows = { '24h': '24 小时', '7d': '7 天', '30d': '30 天' };
const tooltipTrigger: ('hover' | 'focus' | 'click')[] =
  window.matchMedia('(hover: none)').matches ? ['click'] : ['hover', 'focus'];
const countryFlags: Record<string, string> = { JP: japanFlag };

const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const displayTime = (ts: number) => dateTimeFormat.format(ts * 1000);
const displayPeriod = (start: number, end: number) => {
  const first = new Date(start * 1000);
  const last = new Date(end * 1000);
  const ending = first.toDateString() === last.toDateString()
    ? timeFormat.format(last)
    : displayTime(end);
  return displayTime(start) + ' – ' + ending;
};
const number = (value: number) => value.toLocaleString('zh-CN');
const theme: ThemeConfig = {
  token: {
    colorPrimary: '#244b3f',
    colorText: '#22392f',
    colorTextSecondary: '#627168',
    colorBorderSecondary: '#e9edea',
    colorBgLayout: '#ffffff',
    borderRadius: 8,
    fontFamily: 'Manrope, "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: 14,
  },
  components: {
    Table: {
      headerBg: '#ffffff',
      headerColor: '#627168',
      headerSplitColor: 'transparent',
      cellPaddingBlock: 21,
      cellPaddingInline: 16,
      rowHoverBg: '#ffffff',
    },
    Segmented: {
      trackBg: '#f2f4f3',
      itemSelectedBg: '#ffffff',
      itemSelectedColor: '#22392f',
      itemHoverBg: 'transparent',
      itemActiveBg: 'transparent',
      boxShadowTertiary: 'none',
    },
    Tooltip: { colorBgSpotlight: '#ffffff', colorTextLightSolid: '#22392f' },
    Radio: {
      buttonBg: '#f2f5f3',
      buttonColor: '#53665b',
      buttonSolidCheckedBg: '#244b3f',
      buttonSolidCheckedHoverBg: '#305e50',
      buttonSolidCheckedActiveBg: '#1d3d33',
      buttonSolidCheckedColor: '#ffffff',
    },
  },
};

function StatusPage({ initial }: { initial: InitialData }) {
  const [instances, setInstances] = useState(initial.instances);
  const [instanceId, setInstanceId] = useState<string | null>(initial.instances[0]?.id ?? null);
  const [instanceError, setInstanceError] = useState(initial.instanceError);
  const [range, setRange] = useState<Range>('24h');
  const [bundle, setBundle] = useState<StatusBundle | null>(initial.bundle);
  const data = bundle?.instanceId === instanceId ? bundle.windows[range] : null;
  const [error, setError] = useState(initial.error);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const initialPoll = useRef<{ id?: string; completedAt: number }>({ id: initial.instances[0]?.id, completedAt: initial.completedAt });
  const periods = useMemo(() => data ? Array.from({ length: 72 }, (_, index) => {
    const start = data.start + index * data.width;
    return displayPeriod(start, Math.min(start + data.width, data.at));
  }) : [], [data?.start, data?.width, data?.at]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if (!instanceError || !online) return;
    const controller = new AbortController();
    let pending = false;
    let timer: number | undefined;
    async function loadInstances() {
      if (pending || timer !== undefined || document.hidden) return;
      pending = true;
      try {
        const entries = await readInstances(controller.signal);
        if (!controller.signal.aborted) {
          setInstances(entries);
          setInstanceId(entries[0].id);
          setInstanceError(false);
        }
      } catch {
        if (!controller.signal.aborted) schedule(60_000);
      } finally {
        pending = false;
      }
    }
    function schedule(delay: number) {
      timer = window.setTimeout(() => { timer = undefined; void loadInstances(); }, delay);
    }
    schedule(Math.max(0, 60_000 - (Date.now() - initial.completedAt)));
    document.addEventListener('visibilitychange', loadInstances);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', loadInstances);
    };
  }, [instanceError, initial.completedAt, online]);

  useEffect(() => {
    if (!instanceId || !online) return;
    const controller = new AbortController();
    let pending = false;
    let timer: number | undefined;

    async function load() {
      if (pending || timer !== undefined || document.hidden) return;
      pending = true;
      try {
        const next = await readStatus(instanceId!, controller.signal);
        if (!controller.signal.aborted) {
          setBundle(next);
          setError(false);
          setNow(Date.now() / 1000);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        pending = false;
        if (!controller.signal.aborted) {
          schedule(60_000);
        }
      }
    }

    function schedule(delay: number) {
      timer = window.setTimeout(() => { timer = undefined; void load(); }, delay);
    }
    // The bootstrap already fetched this instance while the UI code was downloading.
    if (initialPoll.current.id === instanceId) {
      schedule(Math.max(0, 60_000 - (Date.now() - initialPoll.current.completedAt)));
      initialPoll.current.id = undefined;
    } else void load();
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [instanceId, online]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 15_000);
    return () => clearInterval(timer);
  }, []);

  if (!data && !error && !instanceError && online) return <StatusSkeleton />;

  const expired = !data || now - data.at > 150;
  const currentState = (item: Item): State =>
    !online || expired || error || !item.at || now - item.at > 150 ? 'unknown' : item.status;
  const traffic = online && !error && data?.lastReport && now - data.lastReport <= 150 &&
    data.traffic?.month === new Date(now * 1000).toISOString().slice(0, 7) ? data.traffic : null;
  const remaining = traffic ? Math.min(100, Math.max(0, traffic.remainingGB / traffic.planGB * 100)) : null;
  const quotaColor = remaining !== null && remaining < 10 ? states.down.color
    : remaining !== null && remaining < 25 ? states.degraded.color : states.ok.color;

  const columns: TableColumnsType<Item> = [
    {
      title: '检查项目',
      key: 'name',
      width: 152,
      className: 'check-name',
      render: (_, item) => <span className="check-label">
        <Badge color={states[currentState(item)].color} role="img" aria-label={'当前状态：' + states[currentState(item)].label} />
        <span>{labels[item.id]}</span>
      </span>,
    },
    {
      title: '历史状态',
      key: 'history',
      className: 'check-history',
      render: (_, item) => (
        <Flex gap={3} align="end" className="history-bars" aria-label={labels[item.id] + '历史状态'}>
          {item.history.map((status, index) => {
            const start = data!.start + index * data!.width;
            const period = periods[index];
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
                  // Keep hit targets fixed; only the painted bars expand and displace neighbors.
                  style={{ '--bar-color': states[status].color, backgroundColor: 'transparent', height, border: 0 } as CSSProperties}
                  aria-label={labels[item.id] + '，' + period + '，' + label}
                />
              </Tooltip>
            );
          })}
        </Flex>
      ),
    },
    {
      title: '成功率',
      key: 'rate',
      align: 'right',
      width: 84,
      className: 'check-rate',
      render: (_, item) => (
        <span aria-label={'成功率 ' + (item.rate === null ? '暂无数据' : item.rate.toFixed(2) + '%')}>
          {item.rate === null ? '—' : Number(item.rate.toFixed(2)) + '%'}
        </span>
      ),
    },
    {
      title: '建连耗时',
      key: 'latency',
      align: 'right',
      width: 102,
      className: 'check-latency',
      render: (_, item) => {
        const latency = currentState(item) === 'unknown' || item.latency === null ? '—' : item.latency + ' ms';
        return <span aria-label={'建连耗时 ' + latency}>{latency}</span>;
      },
    },
  ];

  return (
    <ConfigProvider theme={theme} locale={zhCN}>
      <div className="status-page">
        <header className="site-header">
          <a className="brand" href="/" aria-label="route-pilot 首页">
            <img src={routeMark} alt="" width={40} height={40} />
            <span>route-pilot</span>
          </a>
          {data && <time dateTime={new Date(data.at * 1000).toISOString()}>更新于 {displayTime(data.at)}</time>}
        </header>
        <main>
          <nav className="instance-navigation" aria-label="监控实例">
            <Radio.Group
              aria-label="选择实例"
              className="instance-tabs"
              optionType="button"
              buttonStyle="solid"
              name="instance"
              value={instanceId}
              options={instances.map(instance => ({
                value: instance.id,
                label: <span className="instance-label">
                  {instance.country && countryFlags[instance.country]
                    ? <img className="country-flag" src={countryFlags[instance.country]} alt={instance.country} width={21} height={14} />
                    : <Globe2 size={16} aria-hidden="true" />}
                  <span>{instance.name}</span>
                </span>,
              }))}
              onChange={({ target: { value } }) => {
                if (value !== instanceId) {
                  setInstanceId(value);
                  setBundle(null);
                  setError(false);
                  setActiveTooltip(null);
                }
              }}
            />
          </nav>
          {!online && <Alert type="warning" title="设备已离线，联网后自动恢复" showIcon className="status-alert" />}
          {online && instanceError && <Alert type="warning" title="暂时无法读取实例列表" showIcon className="status-alert" />}
          {online && error && <Alert type="warning" title="读取失败，正在自动重试" showIcon className="status-alert" />}
          {online && data && expired && !error && <Alert type="warning" title="数据已过期，等待更新" showIcon className="status-alert" />}

          <section className="traffic-row" aria-label="剩余流量">
            <div className="traffic-label">
              <h2>剩余流量</h2>
              <Tag className="period-tag">每月</Tag>
            </div>
            <Flex align="center" className="traffic-meter">
              <Progress
                className="quota-progress"
                percent={remaining ?? 0}
                strokeColor={quotaColor}
                railColor="#edf0ee"
                size={['100%', 8]}
                showInfo={false}
                aria-label="本月剩余流量百分比"
              />
            </Flex>
            <Flex vertical align="flex-end" gap={4} className="traffic-summary">
              <span className="quota-percentage">{remaining === null ? '—' : Number(remaining.toFixed(1)) + '%'}</span>
              <span className="traffic-amount">
                {traffic ? <>{number(traffic.remainingGB)} <span>/ {number(traffic.planGB)} GB</span></> : '待更新'}
              </span>
            </Flex>
          </section>

          <section aria-labelledby="history-title" className="history-section">
            <Flex justify="space-between" align="center" gap={16} className="section-heading">
              <h2 id="history-title">稳定性记录</h2>
              <Segmented<Range>
                aria-label="时间范围"
                value={range}
                options={Object.entries(windows).map(([value, label]) => ({ value: value as Range, label }))}
                onChange={value => {
                  if (value !== range) {
                    setRange(value);
                    setActiveTooltip(null);
                  }
                }}
              />
            </Flex>
            <Table<Item>
                className="status-table"
                columns={columns}
                dataSource={data?.checks ?? []}
                rowKey="id"
                pagination={false}
                tableLayout="fixed"
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" /> }}
            />
            <Flex className="history-legend" gap={18} justify="center" wrap>
              {Object.values(states).map(state => <Badge key={state.label} color={state.color} text={state.label} />)}
            </Flex>
          </section>

          {!!data?.events.length && (
            <section className="events-section" aria-labelledby="events-title">
              <h2 id="events-title">状态变化</h2>
              <Table
                size="small"
                showHeader={false}
                pagination={false}
                rowKey={event => event.id + '-' + event.at}
                dataSource={data.events}
                columns={[
                  { key: 'name', render: (_, event) => labels[event.id] },
                  { key: 'status', render: (_, event) => <Badge color={states[event.status].color} text={states[event.status].label} /> },
                  { key: 'time', align: 'right', render: (_, event) => <time>{displayTime(event.at)}</time> },
                ]}
              />
            </section>
          )}
        </main>
      </div>
    </ConfigProvider>
  );
}

export function mount(initial: InitialData) {
  createRoot(document.getElementById('root')!).render(<StatusPage initial={initial} />);
}
