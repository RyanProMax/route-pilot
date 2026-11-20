import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tcpStatus } from '../cloud/probe-policy.mjs';
test('TCP warning threshold is explicit, configurable and excludes invalid timings', () => {
  assert.equal(tcpStatus(999), 'ok');
  assert.equal(tcpStatus(1000), 'degraded');
  assert.equal(tcpStatus(5999), 'degraded');
  assert.equal(tcpStatus(500, '400'), 'degraded');
  for (const value of [undefined, '', -1, 'abc', Infinity, 6000]) assert.equal(tcpStatus(1000, value), 'degraded');
  for (const value of [NaN, Infinity, -1]) assert.equal(tcpStatus(value), 'unknown');
});
