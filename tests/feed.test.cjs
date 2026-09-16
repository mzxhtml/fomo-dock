const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const source = readFileSync(resolve(__dirname, '../feed-content.js'), 'utf8');
const context = vm.createContext({ window: {}, console });
vm.runInContext(source.replace('  if (document.documentElement) start();', `
  globalThis.feed = { eventIdentity, isNativeDuplicate, measureGmgnColumns, visibleEvents,
    setEvents(list) { events = list; }, setMonitor(value) { loadMonitor(value); } };
  return;
  if (document.documentElement) start();`), context);
const { feed } = context;
const event = { key: 'a', source: 'fomo', type: 'buy', tx: '0xAA', addr: '0xToken', handle: 'alice', chain: 'bsc', ts: 1800000000000, usd: 100 };
const native = { side: 'buy', tx: '0xAA', addr: '0xtoken', chain: 'bsc', ts: event.ts, usd: 100 };

test('native dedupe requires matching chain, token, side and transaction hash', () => {
  assert.equal(feed.isNativeDuplicate(event, native), true);
  assert.equal(feed.isNativeDuplicate(event, { ...native, tx: '0xBB' }), false);
  assert.equal(feed.isNativeDuplicate({ ...event, tx: '' }, native), false);
  assert.equal(feed.isNativeDuplicate(event, { ...native, tx: '' }), false);
  assert.equal(feed.isNativeDuplicate(event, { ...native, side: 'sell' }), false);
  assert.equal(feed.isNativeDuplicate(event, { ...native, chain: 'eth' }), false);
  assert.equal(feed.isNativeDuplicate(event, { ...native, addr: '0xOtherToken' }), false);
});

test('high-volume identical amounts retain distinct transactions and hashless events', () => {
  feed.setMonitor({ connected: true, watch: ['alice'], globalTradeMinUsd: 0 });
  feed.setEvents(Array.from({ length: 30 }, (_, i) => ({ ...event, key: String(i), tx: i < 20 ? `0x${i}` : '' })));
  assert.equal(feed.visibleEvents([native]).length, 30);
  feed.setEvents([event, { ...event, key: 'repeat' }, { ...event, key: 'other-side', type: 'sell' }]);
  assert.equal(feed.visibleEvents([]).length, 2);
});

test('GMGN grid tracks match unequal native gaps and padding at different zoom scales', () => {
  const makeBoxes = (scale) => [[10, 40], [60, 140], [210, 160], [375, 100], [485, 100]]
    .map(([left, width]) => ({ left: left * scale, width: width * scale, right: (left + width) * scale, height: 40 * scale }));
  const a = feed.measureGmgnColumns({ left: 0, right: 600, width: 600 }, makeBoxes(1));
  const b = feed.measureGmgnColumns({ left: 0, right: 750, width: 750 }, makeBoxes(1.25));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const tracks = a.columns.split(' ').map(parseFloat);
  assert.equal(tracks.length, 9);
  assert.ok(Math.abs(tracks.reduce((sum, n) => sum + n, 0) - 100) < 0.00001);
  assert.equal(a.left, '1.666667%');
  assert.equal(a.right, '2.500000%');
  const changed = makeBoxes(1); changed[1] = { left: 60, right: 195, width: 135, height: 40 };
  assert.notEqual(feed.measureGmgnColumns({ left: 0, right: 600, width: 600 }, changed).columns, a.columns);
});

test('GMGN hidden or overlapping cells fall back instead of emitting invalid layout', () => {
  assert.equal(feed.measureGmgnColumns({ width: 0 }, []), null);
  assert.equal(feed.measureGmgnColumns({ left: 0, right: 500, width: 500 },
    Array.from({ length: 5 }, () => ({ left: 0, right: 100, width: 100, height: 30 }))), null);
});
