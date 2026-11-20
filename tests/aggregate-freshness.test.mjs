import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshFor, measurementFresh } from '../web/src/freshness.ts';
test('aggregate snapshots expire at 25 minutes, legacy stays at 150 seconds', () => {
  assert.equal(measurementFresh(1000,2500,1500),true);
  assert.equal(measurementFresh(1000,2501,1500),false);
  assert.equal(measurementFresh(1000,1150),true);
  assert.equal(measurementFresh(1000,1151),false);
  assert.equal(measurementFresh(null,1000,1500),false);
  assert.equal(measurementFresh(2000,1000,1500),false);
  assert.equal(freshFor(Infinity),150);
  assert.equal(freshFor(86400),150);
});
