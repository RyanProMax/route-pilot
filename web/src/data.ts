export type State = 'ok' | 'degraded' | 'down' | 'unknown';
export type Key = 'heartbeat' | 'service' | 'egress' | 'edge4' | 'edge6' | 'connections';
export const ranges = ['24h', '7d', '30d'] as const;
export type Range = typeof ranges[number];
export type Instance = { id: string; name: string; country?: string };
export type Item = {
  id: Key; status: State; at: number | null; latency: number | null; rate: number | null;
  history: State[]; value?: string | null; values?: (string | null)[];
  devices?: number | null; deviceHistory?: (number | null)[];
};
export type Summary = {
  load?: import('./load').HostLoad | null;
  at: number; start: number; width: number; lastReport: number | null;
  traffic?: { month: string; remainingGB: number; planGB: number } | null;
  checks: Item[]; events: { id: Key; status: State; at: number }[];
};
export type StatusBundle = { instanceId: string; windows: Record<Range, Summary> };
export type InitialData = {
  instances: Instance[]; bundle: StatusBundle | null; instanceError: boolean;
  error: boolean; completedAt: number;
};

async function readJSON(path: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15_000);
  try {
    const response = await fetch(path, { signal: controller.signal });
    if (!response.ok) throw Error('Status unavailable');
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function readInstances(signal?: AbortSignal): Promise<Instance[]> {
  const entries: Instance[] = await readJSON('/instances.json', signal);
  if (!validInstances(entries)) throw Error('Invalid instances');
  if (!signal?.aborted) saveSnapshot('instances', entries);
  return entries;
}

function validInstances(entries: Instance[]) {
  return !(!Array.isArray(entries) || !entries.length || entries.some(instance =>
    !instance || !/^[a-z][a-z0-9-]{0,39}$/.test(instance.id) || typeof instance.name !== 'string' || !instance.name ||
    (instance.country !== undefined && !/^[A-Z]{2}$/.test(instance.country))
  ) || new Set(entries.map(instance => instance.id)).size !== entries.length);
}

export async function readStatus(instanceId: string, signal?: AbortSignal): Promise<StatusBundle> {
  const next: StatusBundle = await readJSON('/status/' + instanceId + '/all.json', signal);
  if (!validStatus(next, instanceId)) throw Error('Invalid status');
  const previous = cachedStatus(instanceId);
  if (previous && previous.windows['24h'].at > next.windows['24h'].at) return previous;
  if (!signal?.aborted) saveSnapshot('status:' + instanceId, next);
  return next;
}

const states = ['ok', 'degraded', 'down', 'unknown'];
const widths: Record<Range, number> = { '24h': 1200, '7d': 8400, '30d': 36000 };
const keys = ['heartbeat', 'service', 'egress', 'edge4', 'edge6', 'connections'];
const timestamp = (value: number) => Number.isFinite(value) && value >= 0 && value <= Date.now() / 1000 + 300;
const nullableNumber = (value: number | null) => value === null || Number.isFinite(value);
function validStatus(next: StatusBundle, instanceId: string) {
  return !!next && next.instanceId === instanceId && ranges.every(key => {
    const summary = next.windows?.[key];
    return summary && timestamp(summary.at) && timestamp(summary.start) && summary.width === widths[key] &&
      summary.start <= summary.at && summary.at <= summary.start + summary.width * 72 &&
      (summary.lastReport === null || timestamp(summary.lastReport)) &&
      (!summary.load || ['cpu', 'memory', 'disk', 'load1'].every(key => nullableNumber(summary.load![key as keyof NonNullable<Summary['load']>]))) &&
      Array.isArray(summary.checks) && summary.checks.length <= keys.length && summary.checks.every(item =>
        item && keys.includes(item.id) && states.includes(item.status) && (item.at === null || timestamp(item.at)) &&
        nullableNumber(item.latency) && nullableNumber(item.rate) &&
        Array.isArray(item.history) && item.history.length <= 72 && item.history.every(state => states.includes(state)) &&
        (!item.values || Array.isArray(item.values) && item.values.every(value => value === null || typeof value === 'string')) &&
        (!item.deviceHistory || Array.isArray(item.deviceHistory) && item.deviceHistory.every(nullableNumber))) &&
      Array.isArray(summary.events) && summary.events.every(event =>
        event && keys.includes(event.id) && states.includes(event.status) && timestamp(event.at));
  });
}

const SNAPSHOT_TTL = 24 * 60 * 60 * 1000;
const PREFIX = 'routepilot:public:v1:';
function saveSnapshot(key: string, value: unknown) {
  try { sessionStorage.setItem(PREFIX + key, JSON.stringify({ savedAt: Date.now(), value })); } catch { /* Storage is optional. */ }
}
function loadSnapshot(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const { savedAt, value } = JSON.parse(raw);
    if (!Number.isFinite(savedAt) || savedAt > Date.now() || Date.now() - savedAt > SNAPSHOT_TTL) {
      sessionStorage.removeItem(PREFIX + key); return null;
    }
    return value;
  } catch { return null; }
}
export function cachedStatus(instanceId: string): StatusBundle | null {
  const cached = loadSnapshot('status:' + instanceId) as StatusBundle;
  try { return validStatus(cached, instanceId) && Date.now() - cached.windows['24h'].at * 1000 <= SNAPSHOT_TTL ? cached : null; } catch { return null; }
}

export async function readInitialData(signal?: AbortSignal): Promise<InitialData> {
  const cachedInstances = loadSnapshot('instances') as Instance[];
  if (validInstances(cachedInstances)) {
    const cached = cachedStatus(cachedInstances[0].id);
    if (cached) return { instances: cachedInstances, bundle: cached, instanceError: false, error: false, completedAt: 0 };
  }
  let instances: Instance[] = [];
  let bundle: StatusBundle | null = null;
  let instanceError = false, error = false;
  try { instances = await readInstances(signal); } catch { instanceError = true; }
  if (instances.length) {
    try { bundle = await readStatus(instances[0].id, signal); } catch { error = true; }
  }
  return { instances, bundle, instanceError, error, completedAt: Date.now() };
}
