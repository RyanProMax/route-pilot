export type TrafficQuota = { month: string; remainingGB: number; planGB: number };

// Both public and private views display the same current UTC-month estimate.
export function remainingTraffic(traffic: TrafficQuota | null | undefined, fresh: boolean, now: number) {
  if (!fresh || !traffic || !Number.isFinite(now) ||
      !Number.isFinite(traffic.planGB) || traffic.planGB <= 0 ||
      !Number.isFinite(traffic.remainingGB) || traffic.remainingGB < 0 || traffic.remainingGB > traffic.planGB ||
      traffic.month !== new Date(now * 1000).toISOString().slice(0, 7)) return null;
  const percent = traffic.remainingGB / traffic.planGB * 100;
  const level = percent < 10 ? 'down' : percent < 25 ? 'degraded' : 'ok';
  return { ...traffic, percent, level } as const;
}
