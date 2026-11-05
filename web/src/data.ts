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
  if (!Array.isArray(entries) || !entries.length || entries.some(instance =>
    !instance || !/^[a-z][a-z0-9-]{0,39}$/.test(instance.id) || typeof instance.name !== 'string' || !instance.name ||
    (instance.country !== undefined && !/^[A-Z]{2}$/.test(instance.country))
  ) || new Set(entries.map(instance => instance.id)).size !== entries.length) throw Error('Invalid instances');
  return entries;
}

export async function readStatus(instanceId: string, signal?: AbortSignal): Promise<StatusBundle> {
  const next: StatusBundle = await readJSON('/status/' + instanceId + '/all.json', signal);
  if (!next || next.instanceId !== instanceId || ranges.some(key => {
    const summary = next.windows?.[key];
    return !summary || !Array.isArray(summary.checks) || !Array.isArray(summary.events) ||
      !Number.isFinite(summary.at) || !Number.isFinite(summary.start) || !(summary.width > 0);
  })) throw Error('Invalid status');
  return next;
}

export async function readInitialData(signal?: AbortSignal): Promise<InitialData> {
  let instances: Instance[] = [];
  let bundle: StatusBundle | null = null;
  let instanceError = false, error = false;
  try { instances = await readInstances(signal); } catch { instanceError = true; }
  if (instances.length) {
    try { bundle = await readStatus(instances[0].id, signal); } catch { error = true; }
  }
  return { instances, bundle, instanceError, error, completedAt: Date.now() };
}
