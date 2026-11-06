import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remainingTraffic } from '../web/src/traffic.ts';

const now = Date.UTC(2026, 10, 6, 10) / 1000;
const quota = { month: '2026-11', remainingGB: 1013, planGB: 1024 };

test('traffic consistently describes remaining allowance, including zero and low balances', () => {
  const normal = remainingTraffic(quota, true, now);
  assert.equal(normal.remainingGB, 1013);
  assert.equal(normal.percent, 1013 / 1024 * 100);
  assert.equal(normal.level, 'ok');
  for (const [remainingGB, level] of [[100, 'ok'], [25, 'ok'], [24, 'degraded'], [10, 'degraded'], [9, 'down'], [0, 'down']]) {
    const value = remainingTraffic({ ...quota, remainingGB, planGB: 100 }, true, now);
    assert.equal(value.percent, remainingGB);
    assert.equal(value.level, level);
  }
});

test('unavailable or invalid traffic never invents a full progress bar', () => {
  for (const value of [null, undefined, { ...quota, planGB: 0 }, { ...quota, planGB: -1 },
    { ...quota, planGB: Infinity }, { ...quota, planGB: NaN }, { ...quota, remainingGB: Infinity },
    { ...quota, remainingGB: NaN }, { ...quota, remainingGB: -1 }, { ...quota, remainingGB: 1025 }]) {
    assert.equal(remainingTraffic(value, true, now), null);
  }
  assert.equal(remainingTraffic(quota, false, now), null);
  assert.equal(remainingTraffic(quota, true, Infinity), null);
});

test('traffic belongs to the current UTC month, not the browser timezone', () => {
  const monthEnd = Date.UTC(2026, 11, 1) / 1000;
  assert(remainingTraffic(quota, true, monthEnd - 1));
  assert.equal(remainingTraffic(quota, true, monthEnd), null);
  assert(remainingTraffic({ ...quota, month: '2026-12' }, true, monthEnd));
});
