import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollVisible } from '../web/src/polling.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));
function browser(t) {
  const cleanups = [];
  const originals = Object.fromEntries(['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { hidden: false }), nav = { onLine: true };
  for (const [key, value] of Object.entries({window:win, document:doc, navigator:nav})) Object.defineProperty(globalThis, key, {value, configurable:true});
  t.mock.timers.enable({apis:['setTimeout','Date'], now:1_000_000});
  t.after(() => { for (const cleanup of cleanups) cleanup(); for (const key in originals) originals[key] ? Object.defineProperty(globalThis,key,originals[key]) : delete globalThis[key]; });
  return {win, doc, nav, cleanup: fn => cleanups.push(fn), tick: ms => t.mock.timers.tick(ms)};
}

test('resume bypasses pending minute timer, pauses hidden work and deduplicates concurrent events', async t => {
  const {win,doc,tick,cleanup}=browser(t); let calls=0;
  const stop=pollVisible(async()=>{calls++;}); cleanup(stop); await settle();
  assert.equal(calls,1); tick(5000);
  doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));
  tick(240000); await settle(); assert.equal(calls,1);
  doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));win.dispatchEvent(new Event('focus'));win.dispatchEvent(new Event('pageshow'));
  assert.equal(calls,2);await settle();tick(60000);await settle();assert.equal(calls,3);
});

test('background cancellation, offline and quick reconnect never leave polling stuck', async t => {
  const {win,doc,nav,tick,cleanup}=browser(t);const signals=[];
  const stop=pollVisible(signal=>{signals.push(signal);return new Promise(()=>{});});cleanup(stop);
  doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert(signals[0].aborted);
  doc.hidden=false;nav.onLine=false;win.dispatchEvent(new Event('offline'));tick(10);
  nav.onLine=true;win.dispatchEvent(new Event('online'));tick(990);assert.equal(signals.length,2);
  assert(!signals[1].aborted);stop();assert(signals[1].aborted);tick(60000);assert.equal(signals.length,2);
});

test('hung requests are bounded and retry without waiting for a suspended fetch promise', async t => {
  const {tick,cleanup}=browser(t);const signals=[];let errors=0;
  const stop=pollVisible(signal=>{signals.push(signal);return new Promise(()=>{});},{onError:()=>errors++});cleanup(stop);
  tick(15000);assert(signals[0].aborted);assert.equal(errors,1);
  tick(15000);assert.equal(signals.length,2);stop();tick(60000);assert.equal(errors,1);
});

test('failures retry quietly, initial delay is respected, false stops regular polling', async t => {
  const {tick,win,cleanup}=browser(t);let calls=0,errors=0;
  const stop=pollVisible(async()=>{calls++;if(calls===1)throw Error();return false;},{initialDelay:60000,onError:()=>errors++});cleanup(stop);
  tick(5000);win.dispatchEvent(new Event('focus'));await settle();assert.equal(calls,1);assert.equal(errors,1);
  tick(15000);await settle();assert.equal(calls,2);tick(60000);assert.equal(calls,2);
  win.dispatchEvent(new Event('pageshow'));await settle();assert.equal(calls,3);
});
