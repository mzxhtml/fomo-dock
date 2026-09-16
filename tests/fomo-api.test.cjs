const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(resolve(__dirname, '../background.js'), 'utf8');
const contentSource = readFileSync(resolve(__dirname, '../content.js'), 'utf8');
const address = '0x' + 'a'.repeat(40);
const payload = { kind: 'holders', networkId: 5042, tokenAddress: address };
const holders = { responseObject: [{ totalHolders: 2, topHolders: [{ userId: 'alice' }] }] };
const noopEvent = { addListener() {} };

function reply(status = 200, body = holders, headers = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: new Headers(headers), body: { cancel: async () => {} },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

async function flush() {
  // Drain nested storage, queue, parsing, and message microtasks without real delays.
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

function harness({ store = {}, responses = [], start = 1_800_000_000_000 } = {}) {
  let now = start;
  let timerId = 0;
  const timers = new Map();
  const calls = [];
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: ClockDate, URL, AbortController, console,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, init) => {
      calls.push({ url, init, at: now });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(url, init) : response || reply();
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === 'string') return { [keys]: store[keys] };
            if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
            return { ...keys, ...store };
          },
          async set(patch) { Object.assign(store, structuredClone(patch)); },
        },
        onChanged: noopEvent,
      },
      tabs: { query: async () => [], onRemoved: noopEvent, onUpdated: noopEvent },
      runtime: { onInstalled: noopEvent, onStartup: noopEvent, onMessage: noopEvent },
      alarms: { get: async () => ({}), clear: async () => {}, onAlarm: noopEvent },
    },
  });
  vm.runInContext(source, context);
  return {
    context, store, calls, now: () => now,
    async advance(ms) {
      const target = now + ms;
      await flush();
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

test('Arc API headers, mixed-feed aliases and token requests use network 5042', async () => {
  const h = harness();
  const result = await h.context.fetchTokenData(payload);
  assert.equal(result.total, 2);
  assert.ok(h.calls[0].init.headers['X-Supported-Chains'].split(',').includes('5042'));
  assert.equal(JSON.parse(new URL(h.calls[0].url).searchParams.get('tokens'))[0].networkId, 5042);
  for (const chainName of ['arc', 'chain5042', 'chain 5042', 'CHAIN5042']) {
    assert.equal(h.context.slimFomoEvent({ eventType: 'FOMO_BUY', ts: 1, chainName }).chain, 'arc');
  }
});

test('parallel tabs coalesce identical requests; cached list expires after 90 seconds', async () => {
  const h = harness();
  const results = await Promise.all(Array.from({ length: 8 }, () => h.context.fetchTokenData(payload)));
  assert.equal(h.calls.length, 1);
  assert.ok(results.every((result) => result.fetchedAt === results[0].fetchedAt));
  await h.advance(89_999);
  await h.context.fetchTokenData(payload);
  assert.equal(h.calls.length, 1);
  await h.advance(1);
  await h.context.fetchTokenData(payload);
  assert.equal(h.calls.length, 2);
});

test('holders, thesis, swaps and PnL share serial 1.5 second spacing', async () => {
  const h = harness();
  const requests = [
    h.context.fetchTokenData(payload),
    h.context.fetchTokenData({ ...payload, kind: 'thesis' }),
    h.context.fetchTokenData({ ...payload, kind: 'swaps' }),
    h.context.fetchUserPnl('alice'),
    h.context.fetchUserPnl('alice'),
  ];
  await flush();
  assert.equal(h.calls.length, 1);
  await h.advance(1499);
  assert.equal(h.calls.length, 1);
  await h.advance(3001);
  await Promise.all(requests);
  assert.equal(h.calls.length, 4);
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 1500);
});

test('slow response body holds the queue slot', async () => {
  let finishBody;
  const first = reply();
  first.text = () => new Promise((resolve) => { finishBody = resolve; });
  const h = harness({ responses: [first] });
  const a = h.context.fetchTokenData(payload);
  const b = h.context.fetchTokenData({ ...payload, kind: 'thesis' });
  await h.advance(3000);
  assert.equal(h.calls.length, 1);
  finishBody(JSON.stringify(holders));
  await flush();
  await h.advance(1500);
  await Promise.all([a, b]);
  assert.equal(h.calls[1].at - h.calls[0].at, 4500);
});

test('network failure releases the queue while retaining spacing', async () => {
  const h = harness({ responses: [new Error('offline')] });
  const a = h.context.fetchTokenData(payload);
  const b = h.context.fetchTokenData({ ...payload, kind: 'thesis' });
  assert.equal((await a).reason, 'network');
  await h.advance(1500);
  assert.equal((await b).ok, true);
});

test('stalled fetch times out and does not block later requests', async () => {
  const h = harness({ responses: [(_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('timeout')));
  })] });
  const a = h.context.fetchTokenData(payload);
  const b = h.context.fetchUserPnl('alice');
  await h.advance(25_000);
  assert.equal((await a).reason, 'network');
  await h.advance(1500);
  assert.equal((await b).ok, true);
});

test('429 blocks all pending requests and persists across service worker restarts', async () => {
  const h = harness({ responses: [reply(429, 'cloudflare', { 'Retry-After': '600' })] });
  const results = await Promise.all([
    h.context.fetchTokenData(payload),
    h.context.fetchTokenData({ ...payload, kind: 'thesis' }),
    h.context.fetchUserPnl('alice'),
  ]);
  assert.equal(h.calls.length, 1);
  assert.ok(results.every((result) => result.reason === 'rate-limited' && result.retryAfterMs === 600_000));
  const restarted = harness({ store: h.store, start: h.now() });
  assert.equal((await restarted.context.fetchTokenData(payload)).reason, 'rate-limited');
  assert.equal(restarted.calls.length, 0);
  await restarted.advance(600_000);
  assert.equal((await restarted.context.fetchTokenData(payload)).ok, true);
  assert.equal(restarted.store.fdFomoRateLimitV1.level, 0);
});

test('429 fallback escalates 5/10/20/30 minutes; HTTP-date Retry-After is respected', async () => {
  const h = harness({ responses: Array.from({ length: 4 }, () => reply(429)) });
  for (const minutes of [5, 10, 20, 30]) {
    const result = await h.context.fetchTokenData(payload);
    assert.equal(result.retryAfterMs, minutes * 60_000);
    await h.advance(result.retryAfterMs);
  }
  const start = h.now();
  const dated = harness({ start, responses: [reply(429, {}, { 'Retry-After': new Date(start + 3600_000).toUTCString() })] });
  assert.equal((await dated.context.fetchTokenData(payload)).retryAfterMs, 3600_000);
});

test('429 preserves expired cached list and PnL, but exposes stale flag and retry time', async () => {
  const h = harness({ responses: [reply(), reply(200, { responseObject: [
    { snapshotId: 1, pnl: 10, equity: 100 }, { snapshotId: 2, pnl: 30, equity: 130 },
  ] }), reply(429)] });
  const initial = await h.context.fetchTokenData(payload);
  const pnl = h.context.fetchUserPnl('alice');
  await h.advance(1500);
  assert.equal((await pnl).pnl, 20);
  await h.advance(600_000);
  const stale = await h.context.fetchTokenData(payload);
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, initial.fetchedAt);
  const stalePnl = await h.context.fetchUserPnl('alice');
  assert.equal(stalePnl.pnl, 20);
  assert.equal(stalePnl.stale, true);
  assert.equal(h.calls.length, 3);
});

test('430/431 and HTTP 200 unauthorized bodies produce login guidance, including PnL', async () => {
  for (const status of [200, 401, 430, 431]) {
    for (const token of [null, { token: 'test-token' }]) {
      const h = harness({ store: { fomoToken: token }, responses: [reply(status, { error: 'unauthorized' })] });
      assert.equal((await h.context.fetchTokenData(payload)).reason, token ? 'expired' : 'no-token');
      const p = harness({ store: { fomoToken: token }, responses: [reply(status, { message: 'Unauthenticated' })] });
      assert.equal((await p.context.fetchUserPnl('alice')).reason, token ? 'expired' : 'no-token');
    }
  }
  const blocked = harness({ responses: [reply(403, '<!doctype html>Cloudflare')] });
  assert.equal((await blocked.context.fetchTokenData(payload)).reason, 'blocked');
  const other = harness({ responses: [reply(431, { error: 'header too large' })] });
  assert.equal((await other.context.fetchTokenData(payload)).reason, 'http-431');
});

test('auth retry also uses request queue and only retries once with renewed token', async () => {
  const h = harness({
    store: { fomoToken: { token: 'old', refresh: 'refresh', exp: 2_000_000_000_000 } },
    responses: [reply(430, { error: 'unauthorized' }), reply()],
  });
  vm.runInContext("refreshSession = async () => ({ token: 'new', refresh: 'refresh' });", h.context);
  const result = h.context.fetchTokenData(payload);
  await h.advance(1500);
  assert.equal((await result).ok, true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].init.headers.Authorization, 'Bearer old');
  assert.equal(h.calls[1].init.headers.Authorization, 'Bearer new');
  assert.equal(h.calls[1].at - h.calls[0].at, 1500);
});

function contentHarness(hostname = 'gmgn.ai', pathname = `/arc/token/${address}`) {
  const status = { hidden: true, textContent: '', setAttribute() {} };
  const list = { children: [{}], dataset: {}, replaceChildren() { throw new Error('Existing list was replaced'); } };
  const panel = { classList: { toggle() {} }, querySelector: (selector) => selector === '.fd-list' ? list : status, contains: (node) => node === list };
  let response;
  let calls = 0;
  const context = vm.createContext({
    location: { hostname, pathname }, window: {}, console,
    chrome: { runtime: { getURL: (path) => path, sendMessage: (_message, done) => {
      calls++; if (typeof response === 'function') response(done); else done(response);
    } } },
  });
  const exposed = contentSource.replace('  chrome.storage.local.get(DEFAULTS).then((stored) => {', `
    globalThis.api = { tokenRoute, loadData, setPanel(value) { panel = value; },
      setPaused(value) { refreshPaused = value; }, get pending() { return refreshPending; } };
    return;
    chrome.storage.local.get(DEFAULTS).then((stored) => {`);
  vm.runInContext(exposed, context);
  context.api.setPanel(panel);
  return { api: context.api, list, status, calls: () => calls, respond: (value) => { response = value; } };
}

test('Arc routes work on GMGN and DeBot', () => {
  for (const [host, path] of [['gmgn.ai', `/arc/token/${address}`], ['debot.ai', `/token/arc/${address}`]]) {
    const h = contentHarness(host, path);
    assert.equal(h.api.tokenRoute().networkId, 5042);
    assert.equal(h.api.tokenRoute().address, address);
  }
});

test('cached snapshot does not rebuild list; rate limit retains content and pauses polling', async () => {
  const h = contentHarness();
  h.list.dataset = { fdDataKey: `holders|gmgn|arc|${address}`, fdFetchedAt: '1000' };
  h.respond({ ok: true, items: [], fetchedAt: 1000 });
  await h.api.loadData(true, 'auto');
  assert.equal(h.calls(), 1);
  h.respond({ ok: false, reason: 'rate-limited', retryAt: Date.now() + 300_000 });
  await h.api.loadData(true, 'auto');
  assert.equal(h.status.hidden, false);
  assert.match(h.status.textContent, /自动重试/);
  await h.api.loadData(true, 'auto');
  assert.equal(h.calls(), 2);
});

test('hover blocks auto and resume refresh, including a response arriving after pointer re-entry', async () => {
  for (const source of ['auto', 'resume']) {
    const h = contentHarness();
    h.api.setPaused(true);
    await h.api.loadData(true, source);
    assert.equal(h.calls(), 0);
    assert.equal(h.api.pending, true);
    h.api.setPaused(false);
    let finish;
    h.respond((done) => { finish = done; });
    const pending = h.api.loadData(true, source);
    h.api.setPaused(true);
    finish({ ok: true, items: [], fetchedAt: 2000 });
    await pending;
    assert.equal(h.calls(), 1);
    assert.equal(h.api.pending, true);
    assert.equal(h.list.dataset.fdFetchedAt, undefined);
  }
});
