const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const background = readFileSync(resolve(__dirname, '../background.js'), 'utf8');
const mirrorScript = readFileSync(resolve(__dirname, '../fomo-auth.js'), 'utf8');
const STATE = 'fdFomoKeeperTabsV1';
const RECOVERY = 'fdFomoRecoveryV1';
const START = 1_800_000_000_000;
const jwt = (exp) => `header.${Buffer.from(JSON.stringify({ exp: exp / 1000 })).toString('base64url')}.signature`;
const appTab = (id, extra = {}) => ({ id, url: 'https://fomo.family/token', pinned: false, active: false, discarded: false, ...extra });

async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => [...listeners].map((fn) => fn(...args)), listeners };
}
function storage(data) {
  return {
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, data[key]]));
      return { ...keys, ...data };
    },
    async set(patch) { Object.assign(data, structuredClone(patch)); },
  };
}

function harness({ tabs = [], local = {}, session = {}, sdk = 'ready', initialKeeper = [], renewedExp = 0 } = {}) {
  let now = START;
  let nextId = 100;
  let timerId = 0;
  const timers = new Map();
  const calls = { created: [], removed: [], updated: [], reloaded: [], sdk: [], files: [] };
  const alarms = new Map();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const tabApi = {
    query: async () => tabs.map((tab) => ({ ...tab })),
    get: async (id) => { const tab = tabs.find((tab) => tab.id === id); if (!tab) throw Error('closed'); return { ...tab }; },
    create: async (options) => { const tab = appTab(++nextId, options); tabs.push(tab); calls.created.push(tab.id); return { ...tab }; },
    update: async (id, patch) => {
      const tab = tabs.find((tab) => tab.id === id);
      if (!tab) throw Error('closed');
      calls.updated.push({ id, ...patch });
      Object.assign(tab, patch);
      return { ...tab };
    },
    remove: async (id) => { calls.removed.push(id); tabs.splice(tabs.findIndex((tab) => tab.id === id), 1); },
    reload: async (id) => { calls.reloaded.push(id); },
    sendMessage: async () => ({ ok: true }),
    onRemoved: event(), onUpdated: event(),
  };
  const chrome = {
    storage: { local: storage(local), session: storage(session), onChanged: event() },
    runtime: { id: 'fomo-test', onInstalled: event(), onStartup: event(), onMessage: event() },
    tabs: tabApi,
    alarms: {
      get: async (name) => alarms.get(name),
      create: async (name, options) => alarms.set(name, { scheduledTime: options.when, ...options }),
      clear: async (name) => alarms.delete(name), onAlarm: event(),
    },
    scripting: { executeScript: async (details) => {
      if (details.files) {
        calls.files.push(details.files);
        if (renewedExp) await context.mirrorFomoSession({ token: jwt(renewedExp) }, {
          id: chrome.runtime.id, tab: await tabApi.get(details.target.tabId), frameId: 0,
        });
        return [{ result: undefined }];
      }
      if (details.func.name === 'pageWasKeeper') return [{ result: initialKeeper.includes(details.target.tabId) }];
      calls.sdk.push({ id: details.target.tabId, renew: details.args[0] });
      const status = typeof sdk === 'function' ? sdk(details) : sdk;
      return [{ result: details.args[0] && status === 'ready'
        ? { status: 'renewed', exp: renewedExp || local.fomoToken?.exp || now + 3600_000 }
        : { status } }];
    } },
  };
  const context = vm.createContext({ chrome, Date: ClockDate, URL, atob, console, crypto: require('node:crypto').webcrypto,
    AbortController, AbortSignal, TextDecoder,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(background, context);
  return { context, chrome, tabs, local, session, calls, alarms,
    async advance(ms) {
      await flush();
      const target = now + ms;
      while (true) {
        const due = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
      }
      now = target; await flush();
    },
  };
}

test('parallel owner requests create one keeper and remember its ID after SPA navigation and worker restart', async () => {
  const h = harness({ sdk: 'not-ready' });
  const owners = await Promise.all(Array.from({ length: 5 }, () => h.context.ensureSessionOwner()));
  assert.equal(h.calls.created.length, 1);
  assert.ok(owners.every((owner) => owner.id === owners[0].id));
  assert.equal(h.tabs[0].url, 'https://fomo.family/token?fomo_dock_keeper=1');
  h.tabs[0].url = 'https://fomo.family/tokens/arc/0x123';
  const restart = harness({ tabs: h.tabs, session: h.session });
  assert.equal((await restart.context.ensureSessionOwner()).id, owners[0].id);
  assert.equal(restart.calls.created.length, 0);
  assert.equal(restart.calls.updated.some((patch) => patch.url), false);
});

test('pending navigation is reused and query failure never causes a new tab', async () => {
  const h = harness({ tabs: [appTab(1, { url: 'about:blank', pendingUrl: 'https://fomo.family/token', status: 'loading' })], sdk: 'not-ready' });
  assert.equal((await h.context.ensureSessionOwner()).id, 1);
  assert.equal(h.calls.created.length, 0);
  h.chrome.tabs.query = async () => { throw Error('query failed'); };
  assert.equal(await h.context.ensureSessionOwner(), null);
  assert.equal(h.calls.created.length, 0);
});

test('legacy keeper identity is recovered and only its marketing root is migrated', async () => {
  const h = harness({ tabs: [appTab(1, { url: 'https://fomo.family/', pinned: true })], initialKeeper: [1] });
  await h.context.ensureSessionOwner();
  assert.deepEqual(h.session[STATE].owned, [1]);
  assert.equal(h.tabs[0].url, 'https://fomo.family/token?fomo_dock_keeper=1');
  assert.equal(h.calls.created.length, 0);
  h.tabs[0].url = 'https://fomo.family/tokens/eth/0x123';
  await h.context.ensureSessionOwner();
  assert.equal(h.tabs[0].url, 'https://fomo.family/tokens/eth/0x123');
  assert.equal(h.calls.updated.filter((patch) => patch.url).length, 1);
});

test('cleanup removes only inactive owned keepers after a usable replacement exists', async () => {
  const h = harness({ tabs: [appTab(1, { active: true }), appTab(2, { pinned: true }),
    appTab(3, { pinned: true, active: true }), appTab(4, { pinned: true })],
    session: { [STATE]: { owned: [2, 3], checked: [2, 3] } } });
  assert.equal((await h.context.ensureSessionOwner()).id, 1);
  assert.deepEqual(h.calls.removed, [2]);
  assert.deepEqual(h.tabs.map((tab) => tab.id), [1, 3, 4]);
  const unavailable = harness({ tabs: [appTab(2, { pinned: true }), appTab(3, { pinned: true })],
    session: { [STATE]: { owned: [2, 3], checked: [2, 3] } }, sdk: 'sdk-missing' });
  await unavailable.context.ensureSessionOwner();
  assert.equal(unavailable.calls.removed.length, 0);
  assert.equal(unavailable.calls.created.length, 0);
});

test('unpinning permanently hands a keeper to the user, including a quick repin', async () => {
  const h = harness({ tabs: [appTab(1, { active: true }), appTab(2, { pinned: true })],
    session: { [STATE]: { owned: [2], checked: [2] } } });
  h.chrome.tabs.onUpdated.emit(2, { pinned: false }, appTab(2));
  // The actual tab has already been repinned before queued cleanup runs.
  await h.context.ensureSessionOwner();
  assert.equal(h.calls.removed.length, 0);
  assert.deepEqual(h.session[STATE].owned, []);
  assert.ok(h.session[STATE].checked.includes(2));
});

test('heartbeats cannot create, reload or remove tabs', async () => {
  const h = harness({ tabs: [appTab(1), appTab(2, { pinned: true })] });
  for (let i = 0; i < 5; i++) await h.context.recordHeartbeat({ visible: true, keeper: true }, { tab: h.tabs[0] });
  assert.equal(h.calls.created.length + h.calls.removed.length + h.calls.updated.length + h.calls.reloaded.length, 0);
  assert.equal(h.local.fomoPage.keeper, false);
});

test('renewal works without refresh token, coalesces callers and mirrors the new SDK token', async () => {
  const exp = START + 30_000;
  const h = harness({ tabs: [appTab(1, { active: true })], local: { fomoToken: { token: jwt(exp), exp } }, renewedExp: START + 3600_000 });
  const result = await Promise.all(Array.from({ length: 4 }, () => h.context.refreshSession()));
  assert.ok(result.every((token) => token.exp === START + 3600_000));
  assert.equal(h.calls.sdk.filter((call) => call.renew).length, 1);
  assert.equal(h.calls.created.length, 0);
  assert.equal(h.calls.files.length, 1);
  assert.equal(h.local[RECOVERY].status, 'ready');
  assert.equal(h.local.fomoToken.refresh, undefined);
  await h.context.refreshSession();
  assert.equal(h.calls.sdk.filter((call) => call.renew).length, 1);
});

test('failed recovery backs off across worker restarts and reuses a signed-out tab', async () => {
  const exp = START - 1000;
  const local = { fomoToken: { token: jwt(exp), exp } };
  const h = harness({ local, sdk: 'signed-out' });
  assert.equal(await h.context.refreshSession(), null);
  assert.equal(h.calls.created.length, 1);
  const restart = harness({ local, tabs: h.tabs, session: h.session, sdk: 'signed-out' });
  assert.equal(await restart.context.refreshSession(), null);
  assert.equal(restart.calls.sdk.length, 0);
  await restart.advance(300_000);
  assert.equal(await restart.context.refreshSession(), null);
  assert.equal(restart.calls.created.length, 0);
});

test('startup does not open pages for a valid long-lived token, signed-out extension or disabled extension', async () => {
  for (const local of [{}, { fomoToken: { token: 'existing', exp: START + 3600_000 } },
    { fdEnabled: false, fomoToken: { token: 'expired', exp: START - 1 } }]) {
    const h = harness({ local });
    await h.context.keepSessionAlive(true);
    assert.equal(h.calls.created.length, 0);
    assert.equal(h.calls.sdk.length, 0);
  }
});

test('unresponsive SDK probe times out and keeps the existing keeper', async () => {
  const h = harness({ tabs: [appTab(1, { pinned: true })],
    session: { [STATE]: { owned: [1], checked: [1] } },
    local: { fomoToken: { token: 'expired', exp: START - 1 } } });
  h.chrome.scripting.executeScript = () => new Promise(() => {});
  const recovery = h.context.refreshSession();
  await h.advance(10_000);
  assert.equal(await recovery, null);
  assert.equal(h.calls.created.length + h.calls.removed.length, 0);
  assert.equal(h.local[RECOVERY].status, 'page-unavailable');
  await h.context.refreshSession();
  assert.equal(h.calls.created.length, 0);
});

test('expiry alarm is scheduled before token expiry and removed when disabled', async () => {
  const h = harness({ local: { fomoToken: { token: 'existing', exp: START + 600_000 } } });
  await h.context.scheduleSessionExpiry();
  assert.equal(h.alarms.get('fomo-dock-expiry').when, START + 570_000);
  h.local.fdEnabled = false;
  await h.context.scheduleSessionExpiry();
  assert.equal(h.alarms.has('fomo-dock-expiry'), false);
});

test('concurrent mirror messages cannot overwrite a newer token; untrusted senders are ignored', async () => {
  const h = harness();
  const sender = { id: 'fomo-test', frameId: 0, tab: appTab(1) };
  const newer = jwt(START + 3600_000);
  const older = jwt(START + 600_000);
  await Promise.all([h.context.mirrorFomoSession({ token: newer }, sender), h.context.mirrorFomoSession({ token: older }, sender)]);
  assert.equal(h.local.fomoToken.token, newer);
  assert.equal((await h.context.mirrorFomoSession({ token: jwt(START + 7200_000) }, { ...sender, tab: { url: 'https://gmgn.ai/' } })).ok, false);
  assert.equal(h.local.fomoToken.token, newer);
  h.local.fomoToken.refresh = 'legacy-secret';
  await h.context.mirrorFomoSession({ token: newer }, sender);
  assert.equal(h.local.fomoToken.refresh, undefined);
});

test('SDK bridge invokes only getAccessToken and returns metadata without credentials', async () => {
  const h = harness();
  let calls = 0;
  const sdk = { ready: true, authenticated: true, login() { throw Error('login not allowed'); },
    logout() { throw Error('logout not allowed'); }, getAccessToken: async () => { calls++; return jwt(START + 3600_000); } };
  h.context.location = { origin: 'https://fomo.family' };
  h.context.document = { body: { __reactFiber$test: { memoizedProps: { value: sdk } } }, querySelectorAll: () => [] };
  assert.equal((await h.context.pageSdkAccess()).status, 'ready');
  assert.equal(calls, 0);
  const result = await h.context.pageSdkAccess(true);
  assert.deepEqual(Object.keys(result).sort(), ['exp', 'status']);
  assert.equal(result.status, 'renewed');
  assert.equal(calls, 1);
  sdk.authenticated = false;
  assert.equal((await h.context.pageSdkAccess(true)).status, 'signed-out');
  assert.equal(calls, 1);
});

test('mirror is read-only, reinjection replaces timers, and invalidation stops background work', async () => {
  const timers = new Map();
  let id = 0;
  const reads = [];
  const messages = [];
  const localStorage = { 'privy:token': JSON.stringify(jwt(START + 3600_000)), 'privy:refresh_token': 'secret' };
  Object.defineProperty(localStorage, 'getItem', { value: (key) => { reads.push(key); return localStorage[key]; } });
  Object.defineProperty(localStorage, 'setItem', { value: () => { throw Error('Must not write to FOMO storage'); } });
  const onMessage = event();
  const runtime = { id: 'fomo-test', onMessage, sendMessage: async (message) => { messages.push(message); return { ok: true }; } };
  const window = { localStorage, setInterval: (fn) => { timers.set(++id, fn); return id; }, clearInterval: (id) => timers.delete(id),
    addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window, chrome: { runtime }, location: { origin: 'https://fomo.family' }, atob,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } });
  vm.runInContext(mirrorScript, context);
  await flush();
  assert.equal(timers.size, 2);
  assert.equal(messages.filter((message) => message.type === 'fomo-session-observed').length, 1);
  assert.equal(reads.includes('privy:refresh_token'), false);
  vm.runInContext(mirrorScript, context);
  await flush();
  assert.equal(timers.size, 2);
  assert.equal(onMessage.listeners.size, 1);
  runtime.sendMessage = async () => { throw Error('Extension context invalidated.'); };
  for (const timer of [...timers.values()]) timer();
  await flush();
  assert.equal(timers.size, 0);
  assert.equal(onMessage.listeners.size, 0);
});

const monitorSender = (id = 1) => ({ id: 'fomo-test', frameId: 0,
  url: 'https://www.985monitor.xyz/', tab: { id, url: 'https://www.985monitor.xyz/' } });
const monitorClaim = { account: '0xAlice', prefsStamp: '{}', visible: true };
const monitorBody = (token = 'readonly-new') => ({ ok: true,
  session: { token, expiresAt: START + 90 * 86_400_000 },
  config: { connected: true, account: { userId: '0xAlice', displayName: 'Alice' }, fomo: { watch: ['alice'] } },
});

test('monitor lease coordinates all tabs and commits session plus preferences atomically', async () => {
  const h = harness();
  const [a, b, c] = await Promise.all([1, 2, 3].map((id) => h.context.acquireMonitorSync(monitorClaim, monitorSender(id))));
  assert.equal(a.ok, true);
  assert.equal(b.ok || c.ok, false);
  assert.ok(a.clientId);
  assert.equal((await h.context.finishMonitorSync({ lease: a.lease, status: 200, body: monitorBody() }, monitorSender(2))).ok, false);
  assert.equal((await h.context.finishMonitorSync({ lease: a.lease, status: 200, body: monitorBody() }, monitorSender())).ok, true);
  assert.equal(h.local.monitor985SessionV1.token, 'readonly-new');
  assert.equal(h.local.monitorFomoConfig.connected, true);
  assert.equal((await h.context.acquireMonitorSync(monitorClaim, monitorSender(2))).reason, 'fresh');
});

test('monitor lease survives worker restart, expires, and rejects old responses', async () => {
  const h = harness();
  const a = await h.context.acquireMonitorSync(monitorClaim, monitorSender());
  const restarted = harness({ local: h.local, session: h.session });
  assert.equal((await restarted.context.acquireMonitorSync(monitorClaim, monitorSender(2))).ok, false);
  await restarted.advance(30_001);
  const b = await restarted.context.acquireMonitorSync(monitorClaim, monitorSender(2));
  assert.equal(b.ok, true);
  assert.equal(b.clientId, a.clientId);
  assert.equal((await restarted.context.finishMonitorSync({ lease: a.lease, status: 200, body: monitorBody('old') }, monitorSender())).reason, 'stale-lease');
  assert.equal((await restarted.context.finishMonitorSync({ lease: b.lease, status: 200, body: monitorBody() }, monitorSender(2))).ok, true);
});

test('monitor 429 shares Retry-After cooldown and invalid origins cannot acquire a lease', async () => {
  const h = harness();
  assert.equal((await h.context.acquireMonitorSync(monitorClaim, { ...monitorSender(), url: 'https://gmgn.ai/' })).ok, false);
  const lease = await h.context.acquireMonitorSync(monitorClaim, monitorSender());
  await h.context.finishMonitorSync({ lease: lease.lease, status: 429, retryAfterMs: 600_000 }, monitorSender());
  const restart = harness({ local: h.local, session: h.session });
  await restart.advance(599_999);
  assert.equal((await restart.context.acquireMonitorSync(monitorClaim, monitorSender(2))).ok, false);
  await restart.advance(1);
  assert.equal((await restart.context.acquireMonitorSync(monitorClaim, monitorSender(2))).ok, true);
});

test('monitor stale 401/config and background accounts cannot overwrite a new session', async () => {
  const old = { token: 'old', accountId: '0xAlice', expiresAt: START + 30_000 };
  const h = harness({ local: { monitor985SessionV1: old } });
  const lease = await h.context.acquireMonitorSync(monitorClaim, monitorSender());
  assert.equal(await h.context.markMonitor985Disconnected('unauthorized', true, old), false);
  await h.context.finishMonitorSync({ lease: lease.lease, status: 200, body: monitorBody() }, monitorSender());
  assert.equal(await h.context.markMonitor985Disconnected('unauthorized', true, old), false);
  assert.equal(await h.context.applyMonitor985Config(monitorBody('old').config, old), false);
  assert.equal(h.local.monitor985SessionV1.token, 'readonly-new');
  assert.equal((await h.context.acquireMonitorSync({ ...monitorClaim, account: '0xBob', visible: false }, monitorSender(2))).reason, 'background-account');
});

test('monitor page 401 retains still-valid readonly session instead of disconnecting another tab', async () => {
  const old = { token: 'old', accountId: '0xAlice', expiresAt: START + 600_000 };
  const h = harness({ local: { monitor985SessionV1: old, monitorFomoConfig: { connected: true } } });
  const lease = await h.context.acquireMonitorSync(monitorClaim, monitorSender());
  await h.context.finishMonitorSync({ lease: lease.lease, status: 401 }, monitorSender());
  assert.equal(h.local.monitor985SessionV1.token, 'old');
  assert.equal(h.local.monitorFomoConfig.connected, true);
});

test('late feed success/401 cannot populate cache or invalidate a switched monitor session', async () => {
  for (const status of [200, 401]) {
    const old = { token: 'old', accountId: '0xAlice', expiresAt: START + 600_000 };
    const h = harness({ local: { monitor985SessionV1: old,
      monitor985SyncStateV1: { connected: true, syncedAt: START } } });
    let finish;
    let requests = 0;
    h.context.fetch = async () => { requests++; return new Promise((resolve) => { finish = resolve; }); };
    const feed1 = h.context.fetchFomoFeed();
    const feed2 = h.context.fetchFomoFeed();
    await flush();
    assert.equal(requests, 1);
    const lease = await h.context.acquireMonitorSync(monitorClaim, monitorSender());
    await h.context.finishMonitorSync({ lease: lease.lease, status: 200, body: monitorBody() }, monitorSender());
    finish({ status, ok: status === 200, headers: new Headers(), json: async () => ({ events: [
      { key: 'old-account-event', ts: START, eventType: 'FOMO_BUY', handle: 'alice' },
    ] }) });
    assert.equal((await feed1).reason, 'session-changed');
    assert.equal((await feed2).reason, 'session-changed');
    assert.equal(h.local.monitor985SessionV1.token, 'readonly-new');
    assert.equal(vm.runInContext('fomoFeedCache.events.length', h.context), 0);
  }
});

test('current feed 401 disconnects promptly without a transaction deadlock', async () => {
  const h = harness({ local: { monitor985SessionV1: { token: 'old', expiresAt: START + 600_000 },
    monitor985SyncStateV1: { connected: true, syncedAt: START } } });
  h.context.fetch = async () => ({ status: 401, json: async () => ({}) });
  assert.equal((await h.context.fetchFomoFeed()).reason, 'not-connected');
  assert.equal(h.local.monitor985SessionV1, null);
});

function rankBody(rows = [['alice', 'all', 3]]) {
  const text = `event: fomo-rank-collect\ndata: {"task":"ignore"}\n\nevent: fomo-ranks\r\ndata: ${JSON.stringify({ event: { updatedAt: START, ranks: rows } })}\r\n\r\n`;
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < text.length; i += 7) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 7)));
    controller.close();
  } });
}
const rankLocal = () => ({ monitor985SessionV1: { token: 'readonly', accountId: '0xAlice', expiresAt: START + 600_000 }, monitor985SyncStateV1: { connected: true } });

test('rank stream reads snapshots only, caches them across worker restarts and never advertises collection', async () => {
  const h = harness({ local: rankLocal() });
  let requests = 0;
  h.context.fetch = async (url, options) => {
    requests++;
    assert.equal(url, 'https://www.985monitor.xyz/api/extension/events-stream');
    assert.equal(options.method, undefined);
    assert.equal(options.headers.Authorization, 'Bearer readonly');
    return { status: 200, ok: true, body: rankBody() };
  };
  const [a, b] = await Promise.all([h.context.fetchFomoRanks(), h.context.fetchFomoRanks()]);
  assert.equal(a.ranks[0][2], 3); assert.equal(b.ranks.length, 1); assert.equal(requests, 1);
  const restart = harness({ local: h.local });
  restart.context.fetch = () => { throw Error('Cache should be reused'); };
  assert.equal((await restart.context.fetchFomoRanks()).ranks[0][0], 'alice');
});

test('rank data stays hidden without login or when disabled; stale and malformed rows are rejected', async () => {
  for (const local of [{}, { ...rankLocal(), fdShowKolRank: false }, { ...rankLocal(), fdEnabled: false }]) {
    const h = harness({ local }); let called = false;
    h.context.fetch = async () => { called = true; throw Error('Unexpected request'); };
    assert.equal((await h.context.fetchFomoRanks()).ranks.length, 0); assert.equal(called, false);
  }
  const h = harness();
  assert.equal(h.context.normalizeKolRanks({ updatedAt: START - 86_400_001, ranks: [['a', 'all', 1]] }), null);
  const result = h.context.normalizeKolRanks({ updatedAt: START, ranks: [['@Alice', 'all', 3], ['alice', '7d', 1], ['bad', 'all', -1], ['x', 'bogus', 1], ['<script>', 'all', 1]] });
  assert.equal(result.ranks.length, 1);
  assert.equal(result.ranks[0][0], 'alice');
});

test('late rank snapshot cannot cross accounts and 401 hides ranks', async () => {
  const h = harness({ local: rankLocal() });
  h.context.fetch = async () => {
    h.local.monitor985SessionV1 = { token: 'new', accountId: '0xBob', expiresAt: START + 600_000 };
    return { status: 200, ok: true, body: rankBody() };
  };
  assert.equal((await h.context.fetchFomoRanks()).ok, false);
  assert.equal(h.local.fdKolRanksV1, undefined);
  h.context.fetch = async () => ({ status: 401 });
  assert.equal((await h.context.fetchFomoRanks()).ok, false);
  assert.equal(h.local.monitor985SyncStateV1.connected, false);
});
