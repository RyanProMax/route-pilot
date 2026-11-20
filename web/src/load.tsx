import { Cpu, HardDrive, MemoryStick, type LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Card } from './beui/card';

export type HostLoad = { cpu: number | null; memory: number | null; disk: number | null; load1: number | null };

export function MetricCard({ label, icon: Icon, iconColor, value, percent, color }: {
  label: string; icon: LucideIcon; iconColor: string; value: ReactNode; percent: number | null; color?: string;
}) {
  return <Card className="host-metric" style={{ '--metric-icon': iconColor, '--metric-color': color } as CSSProperties}>
    <div className="metric-heading"><span className="metric-icon"><Icon size={17} aria-hidden /></span>{label}</div>
    <div className="metric-value">{value}</div>
    <div className="metric-track" role={percent === null ? undefined : 'meter'} aria-hidden={percent === null}
      aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <span style={{ width: (percent ?? 0) + '%' }} />
    </div>
  </Card>;
}

const resources = [
  { key: 'cpu', label: 'CPU', icon: Cpu, iconColor: 'var(--icon-cpu)' },
  { key: 'memory', label: '内存', icon: MemoryStick, iconColor: 'var(--icon-memory)' },
  { key: 'disk', label: '磁盘', icon: HardDrive, iconColor: 'var(--icon-disk)' },
] as const;

export function HostMetrics({ load, children }: { load?: HostLoad | null; children?: ReactNode }) {
  return <section className="host-metrics" aria-label="节点资源">
    {resources.map(({ key, ...props }) => {
      const value = load?.[key] ?? null;
      return <MetricCard key={key} {...props} percent={value}
        value={value === null ? '—' : <>{value}<small>%</small></>} />;
    })}
    {children}
  </section>;
}
