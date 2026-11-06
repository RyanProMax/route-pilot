import {
  Alert, Badge, ConfigProvider, Empty, Flex, Progress, Radio, Segmented,
  Table, Tag,
} from 'antd';
import {theme} from './theme';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TableColumnsType } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Globe2 } from 'lucide-react';
import { readInstances, readStatus } from './data';
import { remainingTraffic } from './traffic';
import type { InitialData, Item, Range, State, StatusBundle } from './data';
import { StatusSkeleton } from './loading.mjs';
import { HostMetrics } from './load';
import routeMark from './assets/routepilot-mark.svg';
import japanFlag from './assets/jp.svg';

import { HistoryBars, labels, states, windows, displayTime } from './status-history';
const countryFlags: Record<string, string> = { JP: japanFlag };
const number = (value: number) => value.toLocaleString('zh-CN');

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
  const traffic = remainingTraffic(data?.traffic, Boolean(online && !error && !expired && data?.lastReport && now - data.lastReport <= 150), now);
  const remaining = traffic?.percent ?? null;
  const quotaColor = states[traffic?.level ?? 'ok'].color;

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
        data && <HistoryBars item={item} data={data} instanceId={instanceId}
          activeTooltip={activeTooltip} setActiveTooltip={setActiveTooltip} />
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
                railColor="#e9edf3"
                size={['100%', 8]}
                showInfo={false}
                aria-label="本月剩余流量百分比"
              />
            </Flex>
            <Flex vertical align="flex-end" gap={4} className="traffic-summary">
              <span className="quota-percentage">{remaining === null ? '—' : Number(remaining.toFixed(1)) + '%'}</span>
              <span className="traffic-amount">
                {traffic ? <>约 {number(traffic.remainingGB)} <span>/ {number(traffic.planGB)} GB</span></> : '待更新'}
              </span>
            </Flex>
          </section>

          <HostMetrics load={!online || error || expired ? null : data?.load} />
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
        <footer className="public-footer"><a href="/admin/">管理控制台</a></footer>
      </div>
    </ConfigProvider>
  );
}

export function mount(initial: InitialData) {
  createRoot(document.getElementById('root')!).render(<StatusPage initial={initial} />);
}
