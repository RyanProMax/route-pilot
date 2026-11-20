// Only the two advertised reporting cadences may extend a measurement's lifetime.
export function freshFor(value?: number): number {
  return value === 1500 ? 1500 : 150;
}
export function measurementFresh(at: number | null | undefined, now: number, cadence?: number): boolean {
  return typeof at === 'number' && Number.isFinite(at) && at <= now + 15 && now - at <= freshFor(cadence);
}
