import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkIntervalStatus, tcpStatus } from '../cloud/probe-policy.mjs';
test('TCP warning threshold is explicit, configurable and excludes invalid timings', () => {
  assert.equal(tcpStatus(999), 'ok');
  assert.equal(tcpStatus(1000), 'degraded');
  assert.equal(tcpStatus(5999), 'degraded');
  assert.equal(tcpStatus(500, '400'), 'degraded');
  for (const value of [undefined, '', -1, 'abc', Infinity, 6000]) assert.equal(tcpStatus(1000, value), 'degraded');
  for (const value of [NaN, Infinity, -1]) assert.equal(tcpStatus(value), 'unknown');
});

test('link history grades the observed interval averages and keeps missing distinct from zero', () => {
  const cases = [
    [263, 100, 100*49/60, 'degraded'], [257, 100, 100*53/60, 'degraded'],
    [199, 100, 91, 'ok'], [200, 100, 100, 'degraded'], [500, 100, 100, 'degraded'], [501, 100, 100, 'down'],
    [150, 100, 90, 'degraded'], [150, 100, 80, 'degraded'], [150, 100, 79, 'down'],
    [150, 85, 100, 'degraded'], [150, 75, 100, 'down'], [150, 100, 0, 'down'],
    [150, 100, null, 'ok'], [null, 0, null, 'down'], [null, null, null, 'unknown'],
  ];
  for (const [latency, connect, ping, state] of cases) assert.equal(linkIntervalStatus(latency, connect, ping), state);
});
