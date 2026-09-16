'use strict';

const FOMO_API = 'https://prod-api.fomo.family';
const SUPPORTED_CHAINS = '1,56,143,4663,5042,8453,1399811149';
const KEEPALIVE_ALARM = 'fomo-dock-keepalive';
const EXPIRY_ALARM = 'fomo-dock-expiry';
const KEEPER_URL = 'https://fomo.family/token?fomo_dock_keeper=1';
const KEEPER_STATE_KEY = 'fdFomoKeeperTabsV1';
const RECOVERY_STATE_KEY = 'fdFomoRecoveryV1';
const SESSION_RETRY_MS = 5 * 60_000;
const CACHE_TTL_MS = 90_000;
const CACHE_LIMIT = 80;
const REFRESH_AHEAD_MS = 20 * 60_000;

const responseCache = new Map();
const pnlCache = new Map();
const tokenRequests = new Map();
const pnlRequests = new Map();
const FOMO_REQUEST_GAP_MS = 1500;
const FOMO_RATE_LIMIT_KEY = 'fdFomoRateLimitV1';
const FOMO_BACKOFF_BASE_MS = 5 * 60_000;
const FOMO_BACKOFF_MAX_MS = 30 * 60_000;
let fomoRequestTail = Promise.resolve();
let fomoNextRequestAt = 0;
let fomoRateLimit = { until: 0, level: 0 };
let fomoRateLimitReady = null;
let keepAliveAt = 0;
let refreshInFlight = null;
let sessionOwnerQueue = Promise.resolve();
let sessionMirrorQueue = Promise.resolve();
const releasedKeeperIds = new Set();

// 985monitor 只向扩展签发读取 FOMO 推送的只读会话。
const MONITOR985_ORIGIN = 'https://www.985monitor.xyz';
const MONITOR985_CONFIG_URL = `${MONITOR985_ORIGIN}/api/extension/config`;
const FOMO_FEED_URL = `${MONITOR985_ORIGIN}/api/extension/fomo-events?limit=150`;
const MONITOR985_CONFIG_TTL_MS = 3 * 60_000;
const FOMO_FEED_MIN_INTERVAL_MS = 15_000;
const FOMO_FEED_KEEP = 150;
const FOMO_FEED_TYPE = {
  FOMO_BUY: 'buy', FOMO_SELL: 'sell', FOMO_SWAP: 'swap', FOMO_THESIS: 'thesis',
  FOMO_TRANSFER_IN: 'transferIn', FOMO_REFUND: 'refund',
};
const FOMO_CHAIN_SLUG = {
  bnb: 'bsc', bsc: 'bsc', sol: 'sol', solana: 'sol', eth: 'eth', ethereum: 'eth',
  base: 'base', robinhood: 'robinhood', 'chain 143': 'monad', monad: 'monad',
  arc: 'arc', chain5042: 'arc', 'chain 5042': 'arc',
};
let monitor985ConfigInflight = null;
let fomoFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
let fomoFeedEtag = '';
let fomoFeedFailCount = 0;
let fomoFeedBackoffUntil = 0;
let fomoFeedInflight = null;
const MONITOR_SYNC_KEY = 'fdMonitorSyncV1';
let monitorWriteTail = Promise.resolve();

function monitorTransaction(run) {
  const task = monitorWriteTail.then(run);
  monitorWriteTail = task.catch(() => {});
  return task;
}

function monitorAccount(value) {
  const text = String(value || '').trim();
  return /^0x/i.test(text) ? text.toLowerCase() : text;
}

function monitorSender(sender) {
  try {
    const url = new URL(sender?.url || sender?.tab?.url);
    return sender?.id === chrome.runtime.id && Number.isInteger(sender?.tab?.id)
      && (!sender.frameId || sender.frameId === 0) && url.protocol === 'https:'
      && /(^|\.)985monitor\.xyz$/.test(url.hostname);
  } catch { return false; }
}

async function monitorSessionIsCurrent(session) {
  const stored = await chrome.storage.local.get('monitor985SessionV1');
  return (stored.monitor985SessionV1?.token || '') === (session?.token || '');
}

function monitorConfigPatch(config, session) {
  const at = Date.now();
  return {
    monitorFomoConfig: { ...(config.fomo || {}), wallet: config.account.userId,
      connected: true, revision: config.revision, at },
    monitor985SyncStateV1: { connected: true, accountId: config.account.userId,
      displayName: String(config.account.displayName || ''), syncedAt: at,
      expiresAt: Number(session?.expiresAt || config.sessionExpiresAt) || 0 },
  };
}

function acquireMonitorSync(message, sender) {
  if (!monitorSender(sender)) return Promise.resolve({ ok: false });
  return monitorTransaction(async () => {
    const now = Date.now();
    const state = (await chrome.storage.session.get(MONITOR_SYNC_KEY))[MONITOR_SYNC_KEY] || {};
    if (state.retryAt > now || state.expiresAt > now) return { ok: false, reason: 'busy' };
    const stored = await chrome.storage.local.get({ monitor985SessionV1: null, monitor985ClientIdV1: '' });
    const session = stored.monitor985SessionV1;
    const account = monitorAccount(message.account);
    if (!account || account.length > 200) return { ok: false };
    const sameAccount = monitorAccount(session?.accountId) === account;
    if (session?.token && session.expiresAt > now && !sameAccount && message.visible !== true) {
      return { ok: false, reason: 'background-account' };
    }
    const needsRebind = !sameAccount || !session?.token || !(session.expiresAt > now + 24 * 60 * 60_000);
    const prefsStamp = String(message.prefsStamp || '').slice(0, 200_000);
    if (!needsRebind && state.prefsStamp === prefsStamp && state.account === account
      && now - Number(state.syncedAt || 0) < MONITOR985_CONFIG_TTL_MS) return { ok: false, reason: 'fresh' };
    const clientId = stored.monitor985ClientIdV1 || crypto.randomUUID();
    if (!stored.monitor985ClientIdV1) await chrome.storage.local.set({ monitor985ClientIdV1: clientId });
    const lease = crypto.randomUUID();
    await chrome.storage.session.set({ [MONITOR_SYNC_KEY]: {
      ...state, lease, tabId: sender.tab.id, expiresAt: now + 30_000,
      account, pendingPrefs: prefsStamp, baseToken: session?.token || '', clientId, needsRebind,
    } });
    return { ok: true, lease, clientId, needsRebind };
  });
}

function finishMonitorSync(message, sender) {
  if (!monitorSender(sender)) return Promise.resolve({ ok: false });
  return monitorTransaction(async () => {
    const state = (await chrome.storage.session.get(MONITOR_SYNC_KEY))[MONITOR_SYNC_KEY];
    if (!state || state.lease !== message.lease || state.tabId !== sender.tab.id || state.expiresAt <= Date.now()) {
      return { ok: false, reason: 'stale-lease' };
    }
    const stored = await chrome.storage.local.get('monitor985SessionV1');
    const current = stored.monitor985SessionV1;
    const stillCurrent = (current?.token || '') === state.baseToken;
    const config = message.body?.config;
    const incoming = message.body?.session;
    const validConfig = config?.connected === true && monitorAccount(config.account?.userId) === state.account;
    let active = current;
    if (incoming?.token && Number(incoming.expiresAt) > Date.now()) {
      active = { token: incoming.token, expiresAt: Number(incoming.expiresAt),
        clientId: incoming.clientId || state.clientId, accountId: config?.account?.userId };
    }
    const ok = stillCurrent && message.status >= 200 && message.status < 300 && message.body?.ok === true && validConfig
      && active?.token && Number(active.expiresAt) > Date.now()
      && (!state.needsRebind || Boolean(incoming?.token));
    if (ok) {
      await chrome.storage.local.set({ monitor985SessionV1: active, ...monitorConfigPatch(config, active) });
      if (active.token !== state.baseToken) resetFomoFeedCache();
    } else if (stillCurrent && message.status === 401 && !(current?.token && current.expiresAt > Date.now())) {
      await chrome.storage.local.set({ monitorFomoConfig: { connected: false, at: Date.now() },
        monitor985SyncStateV1: { connected: false, reason: 'login-required', checkedAt: Date.now() } });
    }
    const delay = Number(message.retryAfterMs);
    const retryMs = ok || message.cancelled ? 0
      : Math.max(message.status === 429 ? 60_000 : 30_000, Number.isFinite(delay) ? Math.min(delay, 86_400_000) : 0);
    // Persist the shared cooldown and remove the lease's session snapshot.
    await chrome.storage.session.set({ [MONITOR_SYNC_KEY]: {
      account: state.account, syncedAt: ok ? Date.now() : state.syncedAt || 0,
      prefsStamp: ok ? state.pendingPrefs : state.prefsStamp || '', retryAt: Date.now() + retryMs,
    } });
    return { ok: Boolean(ok), reason: stillCurrent ? undefined : 'session-changed' };
  });
}

async function monitor985Session() {
  const { monitor985SessionV1: session } = await chrome.storage.local.get({ monitor985SessionV1: null });
  if (!session?.token || !(Number(session.expiresAt) > Date.now())) return null;
  return session;
}

function resetFomoFeedCache() {
  fomoFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
  fomoFeedEtag = '';
  fomoFeedFailCount = 0;
  fomoFeedBackoffUntil = 0;
}

function markMonitor985Disconnected(reason, clearSession = false, session = null) {
  return monitorTransaction(async () => {
    if (!await monitorSessionIsCurrent(session)) return false;
    const sync = (await chrome.storage.session.get(MONITOR_SYNC_KEY))[MONITOR_SYNC_KEY];
    if (sync?.expiresAt > Date.now() && sync.baseToken === (session?.token || '')) return false;
    resetFomoFeedCache();
    const patch = {
      monitorFomoConfig: { connected: false, at: Date.now() },
      monitor985SyncStateV1: { connected: false, reason, checkedAt: Date.now() },
    };
    if (clearSession) patch.monitor985SessionV1 = null;
    await chrome.storage.local.set(patch);
    return true;
  });
}

function applyMonitor985Config(config, session) {
  return monitorTransaction(async () => {
    if (!config?.connected || !config?.account?.userId || !await monitorSessionIsCurrent(session)) return false;
    await chrome.storage.local.set(monitorConfigPatch(config, session));
    return true;
  });
}

async function refreshMonitor985Config(force = false) {
  if (monitor985ConfigInflight) return monitor985ConfigInflight;
  monitor985ConfigInflight = (async () => {
    const stored = await chrome.storage.local.get({ monitor985SessionV1: null, monitor985SyncStateV1: null });
    const session = stored.monitor985SessionV1;
    if (!session?.token || !(Number(session.expiresAt) > Date.now())) {
      await markMonitor985Disconnected('login-required', Boolean(session), session);
      return false;
    }
    if (!force && stored.monitor985SyncStateV1?.connected
      && Date.now() - Number(stored.monitor985SyncStateV1.syncedAt) < MONITOR985_CONFIG_TTL_MS) return true;
    try {
      const response = await fetch(MONITOR985_CONFIG_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
        cache: 'no-store', signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => null);
      if (response.status === 401) {
        await markMonitor985Disconnected('unauthorized', true, session);
        return false;
      }
      if (!response.ok || body?.ok !== true || !body?.config) throw new Error(`HTTP ${response.status}`);
      return applyMonitor985Config(body.config, session);
    } catch {
      return Boolean(stored.monitor985SyncStateV1?.connected);
    }
  })().finally(() => { monitor985ConfigInflight = null; });
  return monitor985ConfigInflight;
}

function slimFomoEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = FOMO_FEED_TYPE[String(raw.eventType || '')];
  if (!type) return null;
  const ts = Number(raw.ts) || Date.parse(raw.createdAt || '') || 0;
  if (!ts) return null;
  const chainName = String(raw.chainName || '').trim();
  const content = raw.content && typeof raw.content === 'object' ? raw.content : {};
  return {
    key: String(raw.key || '').slice(0, 120), source: 'fomo', type,
    handle: String(raw.handle || '').toLowerCase().slice(0, 64),
    name: String(raw.userName || raw.handle || '').slice(0, 48),
    avatar: String(raw.avatar || '').slice(0, 300),
    usd: Number(raw.usd) || 0,
    comment: String(raw.comment || content.comment || content.text
      || (type === 'refund' ? `链上交易失败 · ${String(raw.failReason || '已退款')}` : '')).slice(0, 1500),
    addr: String(raw.tokenAddress || '').slice(0, 96),
    chain: FOMO_CHAIN_SLUG[chainName.toLowerCase()] || chainName.toLowerCase(),
    chainName, symbol: String(raw.symbol || '').slice(0, 24),
    img: String(raw.tokenImage || '').slice(0, 300), mc: Number(raw.marketCap) || 0, ts,
    tx: String(raw.txHash || raw.transactionHash || raw.transaction_hash
      || content.txHash || content.transactionHash || content.transaction_hash || '').trim().slice(0, 180),
  };
}

function fetchFomoFeed() {
  if (fomoFeedInflight) return fomoFeedInflight;
  fomoFeedInflight = fetchFomoFeedOnce().finally(() => { fomoFeedInflight = null; });
  return fomoFeedInflight;
}

async function fetchFomoFeedOnce() {
  await refreshMonitor985Config(false);
  const session = await monitor985Session();
  if (!session) return { ok: false, reason: 'not-connected', events: [] };
  const now = Date.now();
  if (now - fomoFeedCache.fetchedAt < FOMO_FEED_MIN_INTERVAL_MS || now < fomoFeedBackoffUntil) {
    return { ok: true, ...fomoFeedCache, stale: true };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const headers = { Authorization: 'Bearer ' + session.token };
    if (fomoFeedEtag) headers['If-None-Match'] = fomoFeedEtag;
    let response;
    let body;
    try {
      response = await fetch(FOMO_FEED_URL, { headers, cache: 'no-store', signal: controller.signal });
      body = response.status === 304 ? null : await response.json().catch(() => null);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) {
      const changed = await markMonitor985Disconnected('unauthorized', true, session);
      return { ok: false, reason: changed ? 'not-connected' : 'session-changed', events: [] };
    }
    return await monitorTransaction(async () => {
      if (!await monitorSessionIsCurrent(session)) return { ok: false, reason: 'session-changed', events: [] };
      if (response.status === 304) {
        fomoFeedCache.fetchedAt = Date.now();
        fomoFeedFailCount = 0;
        return { ok: true, ...fomoFeedCache };
      }
      if (!response.ok) {
        const error = new Error('Feed request failed');
        if (response.status === 429) error.retryAfterMs = retryAfterMs(response, Date.now());
        throw error;
      }
      if (!body || !Array.isArray(body.events)) throw new Error('Invalid feed response');
      const events = body.events.map(slimFomoEvent).filter(Boolean)
        .sort((a, b) => b.ts - a.ts).slice(0, FOMO_FEED_KEEP);
      fomoFeedCache = { events, updatedAt: Number(body.updatedAt) || Date.now(), fetchedAt: Date.now() };
      fomoFeedEtag = response.headers.get('ETag') || '';
      fomoFeedFailCount = 0;
      fomoFeedBackoffUntil = 0;
      return { ok: true, ...fomoFeedCache };
    });
  } catch (error) {
    return monitorTransaction(async () => {
      if (!await monitorSessionIsCurrent(session)) return { ok: false, reason: 'session-changed', events: [] };
      fomoFeedFailCount += 1;
      const delay = Math.min(15 * 60_000, 60_000 * 2 ** (fomoFeedFailCount - 1));
      fomoFeedBackoffUntil = Date.now() + Math.max(delay, Number(error.retryAfterMs) || 0);
      if (fomoFeedCache.events.length) return { ok: true, ...fomoFeedCache, stale: true };
      return { ok: false, reason: 'fetch-failed', message: String(error?.message || '').slice(0, 120) };
    });
  }
}

let trendingPending = null;
let trendingCache = null;

function compactTrending(value) {
  const chains = { 1: 'eth', 56: 'bsc', 143: 'monad', 4663: 'robinhood', 5042: 'arc', 8453: 'base', 1399811149: 'sol' };
  const numeric = (n) => n !== null && n !== '' && Number.isFinite(Number(n)) ? Number(n) : null;
  const seen = new Set();
  return (Array.isArray(value) ? value : []).slice(0, 100).flatMap((raw) => {
    const token = raw?.token;
    const chain = chains[token?.networkId];
    let address = String(token?.address || '').trim();
    if (!chain || !(chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/).test(address)) return [];
    if (chain !== 'sol') address = address.toLowerCase();
    const key = `${chain}|${address}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const image = String(token.info?.imageSmallUrl || token.info?.imageThumbUrl || '');
    return [{ chain, address, symbol: String(token.symbol || '').slice(0, 24),
      image: /^https:\/\//.test(image) ? image.slice(0, 500) : '',
      price: numeric(raw.priceUSD), marketCap: numeric(raw.marketCap), change24: numeric(raw.change24),
      volume24: numeric(raw.volume24), holders: numeric(raw.holders) }];
  }).slice(0, 50);
}

function fetchFomoTrending() {
  if (trendingCache && Date.now() - trendingCache.at < CACHE_TTL_MS) return Promise.resolve(trendingCache.data);
  if (trendingPending) return trendingPending;
  trendingPending = (async () => {
    try {
      const { response, body, unauthorized, stored } = await authenticatedFetch('/proxy/trendingTokens', 'POST');
      if (unauthorized) return { ok: false, reason: stored?.token ? 'expired' : 'no-token' };
      if (!response.ok || body?.success === false || (body?.statusCode && Number(body.statusCode) !== 200)) {
        return { ok: false, reason: `http-${response.status}` };
      }
      if (!Array.isArray(body?.responseObject)) return { ok: false, reason: 'invalid-response' };
      const data = { ok: true, items: compactTrending(body.responseObject), fetchedAt: Date.now() };
      trendingCache = { at: Date.now(), data };
      return data;
    } catch (error) { return requestFailure(error, trendingCache); }
    finally { trendingPending = null; }
  })();
  return trendingPending;
}

const RANK_CACHE_KEY = 'fdKolRanksV1';
const RANK_MAX_AGE = 24 * 60 * 60_000;
let rankPending = null;
let rankController = null;
let rankGeneration = 0;

function normalizeKolRanks(raw) {
  const updatedAt = Number(raw?.updatedAt);
  if (!(updatedAt > Date.now() - RANK_MAX_AGE && updatedAt <= Date.now() + 60_000)) return null;
  const ranks = [];
  const seen = new Set();
  for (const row of (Array.isArray(raw.ranks) ? raw.ranks : []).slice(0, 500)) {
    if (!Array.isArray(row)) continue;
    const handle = String(row[0] || '').replace(/^@+/, '').toLowerCase();
    const rank = Number(row[2]);
    if (!/^[a-z0-9_.-]{1,40}$/.test(handle) || !['all', '30d', '7d', '24h'].includes(row[1])
      || !Number.isSafeInteger(rank) || rank <= 0 || rank > 10000 || seen.has(handle)) continue;
    seen.add(handle); ranks.push([handle, row[1], rank]);
  }
  return { updatedAt, ranks };
}

async function readRankSnapshot(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', type = '', data = [], bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return null;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (!line) {
          if (type === 'fomo-ranks') {
            try { const snapshot = normalizeKolRanks(JSON.parse(data.join('\n'))?.event); if (snapshot) return snapshot; } catch {}
          }
          type = ''; data = [];
        } else if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function fetchFomoRanks() {
  if (rankPending) return rankPending;
  const generation = rankGeneration;
  rankPending = (async () => {
    const options = await chrome.storage.local.get({ fdEnabled: true, fdShowKolRank: true,
      monitor985SyncStateV1: null, [RANK_CACHE_KEY]: null });
    const session = await monitor985Session();
    if (!options.fdEnabled || !options.fdShowKolRank || !session || !options.monitor985SyncStateV1?.connected) {
      return { ok: false, ranks: [] };
    }
    const cache = options[RANK_CACHE_KEY];
    const sameAccount = cache?.account === monitorAccount(session.accountId);
    const cached = sameAccount && normalizeKolRanks(cache);
    const current = async () => generation === rankGeneration && await monitorSessionIsCurrent(session);
    if (sameAccount && Date.now() < cache.retryAt) {
      return await current() ? { ok: true, ...(cached || { ranks: [] }) } : { ok: false, ranks: [] };
    }
    const controller = new AbortController(); rankController = controller;
    const timer = setTimeout(() => controller.abort(), 12_000);
    let snapshot = null;
    let retryMs = 5 * 60_000;
    try {
      // Read only the existing snapshot; never advertise a rank collector or upload data.
      const response = await fetch(`${MONITOR985_ORIGIN}/api/extension/events-stream`, {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${session.token}` },
        cache: 'no-store', signal: controller.signal,
      });
      if (response.status === 401) {
        await markMonitor985Disconnected('unauthorized', true, session);
        return { ok: false, ranks: [] };
      }
      if (response.status === 429) retryMs = Math.max(retryMs, retryAfterMs(response, Date.now()));
      if (response.ok && response.body) snapshot = await readRankSnapshot(response.body);
    } catch { /* Keep a recent snapshot on transient failure. */ }
    finally { clearTimeout(timer); controller.abort(); if (rankController === controller) rankController = null; }
    return monitorTransaction(async () => {
      if (!await current()) return { ok: false, ranks: [] };
      const result = snapshot || cached || { ranks: [], updatedAt: 0 };
      await chrome.storage.local.set({ [RANK_CACHE_KEY]: { ...result,
        account: monitorAccount(session.accountId), retryAt: Date.now() + retryMs } });
      return { ok: true, ...result };
    });
  })().finally(() => { rankPending = null; });
  return rankPending;
}

function jwtExpiry(token) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(part));
    return Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
  } catch {
    return 0;
  }
}

function putBounded(map, key, value, max = CACHE_LIMIT) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

function firstObjectArray(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (Array.isArray(value)) {
    if (!value.length || !value[0] || typeof value[0] !== 'object') return null;
    const nested = firstObjectArray(value[0], depth + 1);
    return nested && Object.keys(value[0]).length <= 4 ? nested : value;
  }
  for (const child of Object.values(value).slice(0, 30)) {
    const found = firstObjectArray(child, depth + 1);
    if (found?.length) return found;
  }
  return null;
}

function fomoTabUrl(tab) {
  try {
    const url = new URL(tab.pendingUrl || tab.url);
    return url.origin === 'https://fomo.family' ? url : null;
  } catch { return null; }
}

async function fomoTabs() {
  // Include pending navigations. A query error is not proof that no tab exists.
  return (await chrome.tabs.query({})).filter((tab) => fomoTabUrl(tab));
}

// Runs in FOMO's MAIN world. Use the page's existing Privy provider; return only
// status and expiry, never access/refresh tokens through DOM or page messages.
async function pageSdkAccess(renew = false) {
  if (location.origin !== 'https://fomo.family') return { status: 'wrong-origin' };
  const nodes = [document.body, ...document.querySelectorAll('body > *, #root > *, #app > *, header, main')].slice(0, 24);
  const seen = new Set();
  for (const node of nodes) {
    let fiber = Object.entries(node || {}).find(([key]) => key.startsWith('__reactFiber$'))?.[1];
    for (let depth = 0; fiber && depth < 120; depth++, fiber = fiber.return) {
      if (seen.has(fiber)) break;
      seen.add(fiber);
      const sdk = fiber.memoizedProps?.value;
      if (!sdk || typeof sdk.getAccessToken !== 'function' || typeof sdk.login !== 'function'
        || typeof sdk.logout !== 'function' || typeof sdk.ready !== 'boolean') continue;
      if (!sdk.ready) return { status: 'not-ready' };
      if (!sdk.authenticated) return { status: 'signed-out' };
      if (!renew) return { status: 'ready' };
      try {
        const token = await sdk.getAccessToken();
        const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const exp = Number(JSON.parse(atob(part)).exp) * 1000;
        return { status: exp > Date.now() ? 'renewed' : 'expired', exp };
      } catch { return { status: 'sdk-error' }; }
    }
  }
  return { status: 'sdk-missing' };
}

function pageWasKeeper() {
  try {
    const initial = new URL(performance.getEntriesByType('navigation')[0]?.name);
    return initial.origin === 'https://fomo.family' && initial.searchParams.get('fomo_dock_keeper') === '1';
  } catch { return false; }
}

async function runFomoScript(details, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      chrome.scripting.executeScript(details),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function sdkAccess(tabId, renew = false) {
  const result = await runFomoScript({ target: { tabId }, world: 'MAIN', func: pageSdkAccess, args: [renew] }, renew ? 12_000 : 5000);
  return result?.[0]?.result || { status: 'page-unavailable' };
}

function serializeOwner(run) {
  const task = sessionOwnerQueue.then(run);
  sessionOwnerQueue = task.catch(() => null);
  return task;
}

async function ensureSessionOwnerUnlocked() {
  const tabs = await fomoTabs();
  const saved = (await chrome.storage.session.get(KEEPER_STATE_KEY))[KEEPER_STATE_KEY] || {};
  const liveIds = new Set(tabs.map((tab) => tab.id));
  const checked = new Set((saved.checked || []).filter((id) => liveIds.has(id)));
  const owned = new Set((saved.owned || []).filter((id) => !releasedKeeperIds.has(id) && tabs.some((tab) => tab.id === id && tab.pinned)));
  const save = () => chrome.storage.session.set({ [KEEPER_STATE_KEY]: { owned: [...owned], checked: [...checked] } });
  for (const tab of tabs) {
    if (releasedKeeperIds.has(tab.id)) { checked.add(tab.id); continue; }
    if (owned.has(tab.id) || !tab.pinned) { checked.add(tab.id); continue; }
    if (checked.has(tab.id)) continue;
    let wasKeeper = fomoTabUrl(tab).searchParams.get('fomo_dock_keeper') === '1';
    if (!wasKeeper && !tab.discarded) {
      const result = await runFomoScript({ target: { tabId: tab.id }, func: pageWasKeeper });
      if (typeof result?.[0]?.result !== 'boolean') continue;
      wasKeeper = result[0].result;
    }
    if (tab.discarded && !wasKeeper) continue;
    checked.add(tab.id);
    if (wasKeeper) owned.add(tab.id);
  }
  await save();
  const isApp = (tab) => /^\/(token|tokens|profile)(?:\/|$)/.test(fomoTabUrl(tab)?.pathname || '');
  const keepers = tabs.filter((tab) => owned.has(tab.id)).sort((a, b) => a.id - b.id);
  const userApps = tabs.filter((tab) => !owned.has(tab.id) && isApp(tab))
    .sort((a, b) => Number(b.active) - Number(a.active));
  let owner;
  let ready = false;
  for (const tab of userApps.filter((tab) => !tab.discarded).slice(0, 3)) {
    if ((await sdkAccess(tab.id)).status === 'ready') { owner = tab; ready = true; break; }
  }
  // Loading, signed-out, or SDK-missing pages are reused instead of spawning more.
  owner ||= keepers.find((tab) => !tab.discarded) || keepers[0]
    || userApps.find((tab) => !tab.discarded) || userApps[0];
  if (!owner) {
    owner = await chrome.tabs.create({ url: KEEPER_URL, active: false, pinned: true });
    owned.add(owner.id);
    checked.add(owner.id);
    await save(); // Save before an SPA can remove the URL marker.
  }
  owner = await chrome.tabs.get(owner.id);
  if (!fomoTabUrl(owner)) return null;
  if (releasedKeeperIds.has(owner.id) || !owner.pinned) owned.delete(owner.id);
  const discarded = Boolean(owner.discarded);
  const migrate = owned.has(owner.id) && owner.pinned && fomoTabUrl(owner).pathname === '/';
  owner = await chrome.tabs.update(owner.id, { autoDiscardable: false, ...(migrate ? { url: KEEPER_URL } : {}) });
  if (discarded && !migrate) await chrome.tabs.reload(owner.id);
  if (migrate || discarded) ready = false;
  else if (!ready) ready = (await sdkAccess(owner.id)).status === 'ready';
  // Cleanup needs a usable replacement and fresh ownership checks. Active,
  // unpinned, and user-created tabs must never be removed.
  if (ready && isApp(owner)) {
    for (const tab of keepers) {
      if (tab.id === owner.id) continue;
      try {
        const replacement = await chrome.tabs.get(owner.id);
        if (!isApp(replacement) || replacement.discarded) break;
        const extra = await chrome.tabs.get(tab.id);
        if (releasedKeeperIds.has(tab.id) || !extra.pinned || !fomoTabUrl(extra)) { owned.delete(tab.id); continue; }
        if (extra.active) continue;
        await chrome.tabs.remove(tab.id);
        owned.delete(tab.id);
        checked.delete(tab.id);
      } catch { /* A concurrent tab close/navigation is harmless. */ }
    }
    await save();
  }
  return owner;
}

function ensureSessionOwner() {
  return serializeOwner(ensureSessionOwnerUnlocked).catch(() => null);
}

function releaseKeeper(tabId, removed = false, takeover = false) {
  if (takeover) releasedKeeperIds.add(tabId);
  return serializeOwner(async () => {
    const saved = (await chrome.storage.session.get(KEEPER_STATE_KEY))[KEEPER_STATE_KEY] || {};
    if (!takeover && !saved.owned?.includes(tabId) && !saved.checked?.includes(tabId)) return;
    const owned = (saved.owned || []).filter((id) => id !== tabId);
    const checked = new Set(saved.checked || []);
    if (removed) checked.delete(tabId);
    else checked.add(tabId); // Unpinning hands the page to the user, even if repinned.
    await chrome.storage.session.set({ [KEEPER_STATE_KEY]: { owned, checked: [...checked] } });
    if (removed) releasedKeeperIds.delete(tabId);
  });
}

async function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const stored = await chrome.storage.local.get({ fdEnabled: true, fomoToken: null, [RECOVERY_STATE_KEY]: null });
    const token = stored.fomoToken;
    if (!stored.fdEnabled || !token?.token) return null;
    const usable = (value) => value?.token && Number(value.exp) > Date.now() ? value : null;
    const prior = stored[RECOVERY_STATE_KEY];
    if (prior?.tokenExp === token.exp && prior.retryAt > Date.now()) return usable(token);
    const state = { tokenExp: token.exp, retryAt: Date.now() + SESSION_RETRY_MS, status: 'waiting-sdk' };
    // Persist the attempt before opening a page, including across worker restarts.
    await chrome.storage.local.set({ [RECOVERY_STATE_KEY]: state });
    const owner = await ensureSessionOwner();
    let result = { status: 'page-unavailable' };
    if (owner) {
      for (let attempt = 0; attempt < 8; attempt++) {
        result = await sdkAccess(owner.id);
        if (result.status === 'ready') { result = await sdkAccess(owner.id, true); break; }
        if (!['not-ready', 'sdk-missing'].includes(result.status)) break;
        if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (result.status === 'renewed') {
        await runFomoScript({ target: { tabId: owner.id }, files: ['fomo-auth.js'] });
        await chrome.tabs.sendMessage(owner.id, { type: 'fomo-sync-now' }).catch(() => {});
      }
    }
    let latest = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
    if (result.status === 'renewed') {
      for (let attempt = 0; attempt < 5 && (!usable(latest) || Number(latest.exp) < result.exp); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        latest = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
      }
    }
    const recovered = result.status === 'renewed' && usable(latest) && Number(latest.exp) >= result.exp;
    await chrome.storage.local.set({ [RECOVERY_STATE_KEY]: {
      ...state, tokenExp: latest?.exp ?? token.exp,
      status: recovered ? 'ready' : result.status,
      retryAt: recovered ? Math.max(Date.now() + 30_000, Math.min(state.retryAt, latest.exp - 30_000)) : state.retryAt,
    } });
    return usable(latest);
  })().catch(() => null);
  try { return await refreshInFlight; }
  finally { refreshInFlight = null; }
}

async function scheduleSessionExpiry() {
  const { fomoToken, fdEnabled } = await chrome.storage.local.get(['fomoToken', 'fdEnabled']);
  const exp = Number(fomoToken?.exp) || 0;
  if (fdEnabled === false || exp <= Date.now()) { await chrome.alarms.clear(EXPIRY_ALARM); return; }
  const when = Math.max(Date.now() + 30_000, exp - 30_000);
  const prior = await chrome.alarms.get(EXPIRY_ALARM);
  if (!prior || Math.abs(prior.scheduledTime - when) > 2000) await chrome.alarms.create(EXPIRY_ALARM, { when });
}

async function keepSessionAlive(force = false) {
  if (!force && Date.now() - keepAliveAt < 60_000) return;
  keepAliveAt = Date.now();
  const { fdEnabled, fomoToken } = await chrome.storage.local.get(['fdEnabled', 'fomoToken']);
  if (fdEnabled === false || !fomoToken?.token) return;
  const left = (Number(fomoToken.exp) || jwtExpiry(fomoToken.token)) - Date.now();
  if (left > REFRESH_AHEAD_MS) return;
  await refreshSession();
}

function bodyIsUnauthorized(body) {
  const status = Number(body?.statusCode);
  const message = `${body?.error || ''} ${body?.message || ''}`;
  return status === 401 || status === 403 || /\bunauthori[sz]ed\b|\bunauthenticated\b/i.test(message);
}

function loadFomoRateLimit() {
  if (!fomoRateLimitReady) {
    fomoRateLimitReady = chrome.storage.local.get(FOMO_RATE_LIMIT_KEY).then((stored) => {
      const state = stored[FOMO_RATE_LIMIT_KEY];
      const until = Number(state?.until);
      const level = Number(state?.level);
      fomoRateLimit = {
        until: Number.isFinite(until) ? Math.max(0, until) : 0,
        level: Number.isFinite(level) ? Math.max(0, Math.min(4, Math.trunc(level))) : 0,
      };
    }).catch(() => {});
  }
  return fomoRateLimitReady;
}

function checkFomoRateLimit() {
  if (Date.now() < fomoRateLimit.until) {
    const error = new Error('FOMO 请求暂时受限');
    error.reason = 'rate-limited';
    error.retryAt = fomoRateLimit.until;
    throw error;
  }
}

function retryAfterMs(response, now) {
  const value = String(response.headers.get('Retry-After') || '').trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) ? delay : 0;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

// All official FOMO API calls, including PnL and auth retries, share one queue.
// Consume the body before releasing the slot; a slow response cannot overlap
// the next request. Cooldown survives service-worker and browser restarts.
async function queuedFomoFetch(path, token, method = 'GET') {
  await loadFomoRateLimit();
  checkFomoRateLimit();
  const task = fomoRequestTail.then(async () => {
    checkFomoRateLimit();
    const wait = Math.max(0, fomoNextRequestAt - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    checkFomoRateLimit();
    const headers = { Accept: 'application/json', 'X-Supported-Chains': SUPPORTED_CHAINS };
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch(`${FOMO_API}${path}`, {
        method, headers, credentials: 'include', cache: 'no-store', signal: controller.signal,
      });
      if (response.status === 429) {
        const now = Date.now();
        const previousLevel = now - fomoRateLimit.until > FOMO_BACKOFF_MAX_MS ? 0 : fomoRateLimit.level;
        const level = Math.min(4, previousLevel + 1);
        const fallback = Math.min(FOMO_BACKOFF_MAX_MS, FOMO_BACKOFF_BASE_MS * 2 ** (level - 1));
        // A longer explicit server delay must never be shortened to our fallback cap.
        fomoRateLimit = { until: now + Math.max(fallback, retryAfterMs(response, now)), level };
        await chrome.storage.local.set({ [FOMO_RATE_LIMIT_KEY]: fomoRateLimit }).catch(() => {});
        await response.body?.cancel().catch(() => {});
        checkFomoRateLimit();
      }
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* Cloudflare may return HTML. */ }
      if (response.ok && !bodyIsUnauthorized(body) && body?.success !== false
        && (!body?.statusCode || Number(body.statusCode) === 200) && fomoRateLimit.level) {
        fomoRateLimit = { until: 0, level: 0 };
        await chrome.storage.local.set({ [FOMO_RATE_LIMIT_KEY]: fomoRateLimit }).catch(() => {});
      }
      return { response, body, text };
    } finally {
      clearTimeout(timeout);
      fomoNextRequestAt = Date.now() + FOMO_REQUEST_GAP_MS;
    }
  });
  fomoRequestTail = task.catch(() => {});
  return task;
}

function requestFailure(error, cached) {
  if (error?.reason === 'rate-limited') {
    const cooldown = { retryAt: error.retryAt, retryAfterMs: Math.max(0, error.retryAt - Date.now()) };
    if (cached) return { ...cached.data, stale: true, reason: 'rate-limited', ...cooldown };
    return { ok: false, reason: 'rate-limited', status: 429, ...cooldown };
  }
  return { ok: false, reason: 'network', message: String(error?.message || '').slice(0, 100) };
}

function shareRequest(pending, key, run) {
  if (!pending.has(key)) {
    const task = Promise.resolve().then(run).finally(() => pending.delete(key));
    pending.set(key, task);
  }
  return pending.get(key);
}

async function authenticatedFetch(path, method = 'GET') {
  await loadFomoRateLimit();
  checkFomoRateLimit();
  let stored = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
  if (stored?.token && Number(stored.exp) - Date.now() < 10_000) {
    stored = (await refreshSession())
      || (await chrome.storage.local.get('fomoToken')).fomoToken
      || null;
  }

  let result = await queuedFomoFetch(path, stored?.token, method);
  const isUnauthorized = ({ response, body }) => response.status === 401 || bodyIsUnauthorized(body);
  if (isUnauthorized(result) && stored?.token) {
    const renewed = await refreshSession();
    if (renewed?.token && renewed.token !== stored.token) {
      stored = renewed;
      result = await queuedFomoFetch(path, renewed.token, method);
    }
  }
  return { ...result, stored, unauthorized: isUnauthorized(result) };
}

function requestPath({ tokenAddress, networkId, kind }) {
  const token = encodeURIComponent(String(tokenAddress || ''));
  const network = Number(networkId);
  if (kind === 'holders') {
    const tokens = encodeURIComponent(JSON.stringify([{ address: tokenAddress, networkId: network }]));
    return `/hodlers/top?tokens=${tokens}`;
  }
  if (kind === 'thesis') {
    return `/feed/token/thesis?tokenAddress=${token}&networkId=${network}&threshold=0&limit=50`;
  }
  return `/feed/token?tokenAddress=${token}&networkId=${network}&excludeThesis=true&limit=50`;
}

function fetchTokenData(payload) {
  const key = `${payload?.kind}|${payload?.networkId}|${payload?.tokenAddress}`;
  return shareRequest(tokenRequests, key, () => fetchTokenDataOnce(payload));
}

async function fetchTokenDataOnce(payload) {
  const tokenAddress = String(payload?.tokenAddress || '').trim();
  const networkId = Number(payload?.networkId);
  const kind = ['holders', 'thesis', 'swaps'].includes(payload?.kind) ? payload.kind : 'thesis';
  if (!tokenAddress || !Number.isFinite(networkId)) return { ok: false, reason: 'invalid-request' };

  const key = `${kind}|${networkId}|${tokenAddress}`;
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const { response, stored, body, text, unauthorized } = await authenticatedFetch(requestPath({ tokenAddress, networkId, kind }));
    if (unauthorized) {
      return { ok: false, reason: stored?.token ? 'expired' : 'no-token', status: response.status };
    }
    if (!response.ok) {
      const blocked = /cloudflare|cf-ray|<!doctype html/i.test(text);
      return {
        ok: false,
        reason: blocked ? 'blocked' : `http-${response.status}`,
        status: response.status,
      };
    }

    if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid-response' };
    const status = Number(body?.statusCode);
    if (body?.success === false || (Number.isFinite(status) && status !== 200)) {
      return {
        ok: false,
        reason: `api-${status || 'error'}`,
        status: status || response.status,
        message: String(body?.message || '').slice(0, 120),
      };
    }

    const object = body?.responseObject;
    let items;
    let total;
    if (kind === 'holders') {
      const box = Array.isArray(object) ? object[0] : object;
      items = box?.topHolders;
      total = Number(box?.totalHolders);
    } else {
      items = Array.isArray(object) ? object : object?.items;
    }
    if (!Array.isArray(items)) items = firstObjectArray(object) || [];
    const data = { ok: true, items, count: items.length, fetchedAt: Date.now() };
    if (Number.isFinite(total)) data.total = total;
    putBounded(responseCache, key, { at: Date.now(), data });
    return data;
  } catch (error) {
    return requestFailure(error, cached);
  }
}

function fetchUserPnl(userId) {
  return shareRequest(pnlRequests, String(userId || '').trim(), () => fetchUserPnlOnce(userId));
}

async function fetchUserPnlOnce(userId) {
  const id = String(userId || '').trim();
  if (!id) return { ok: false, reason: 'no-user' };
  const cached = pnlCache.get(id);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.data;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const path = `/v2/userTokens/aggregatedSnapshot?userId=${encodeURIComponent(id)}&timestamp=${encodeURIComponent(since)}`;
  try {
    const { response, stored, body, unauthorized } = await authenticatedFetch(path);
    if (unauthorized) return { ok: false, reason: stored?.token ? 'expired' : 'no-token' };
    if (!response.ok) return { ok: false, reason: `http-${response.status}` };
    if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid-response' };
    const status = Number(body?.statusCode);
    if (body?.success === false || (Number.isFinite(status) && status !== 200)) {
      return { ok: false, reason: `api-${status || 'error'}` };
    }
    const rows = (Array.isArray(body?.responseObject) ? body.responseObject : [])
      .filter((row) => Number.isFinite(Number(row?.pnl)))
      .sort((a, b) => Number(a.snapshotId) - Number(b.snapshotId));
    const first = rows[0];
    const last = rows.at(-1);
    const data = rows.length < 2
      ? { ok: true, pnl: null, equity: Number(first?.equity) || 0, points: rows.length }
      : { ok: true, pnl: Number(last.pnl) - Number(first.pnl), equity: Number(last.equity) || 0, points: rows.length };
    putBounded(pnlCache, id, { at: Date.now(), data }, 400);
    return data;
  } catch (error) {
    return requestFailure(error, cached);
  }
}

async function recordHeartbeat(message, sender) {
  const tabId = Number(sender?.tab?.id);
  const url = fomoTabUrl(sender?.tab || {});
  if (!Number.isInteger(tabId) || !url || (sender.frameId && sender.frameId !== 0)) return;
  const state = (await chrome.storage.session.get(KEEPER_STATE_KEY))[KEEPER_STATE_KEY];
  const keeper = Boolean(sender.tab.pinned && (state?.owned?.includes(tabId) || url.searchParams.get('fomo_dock_keeper') === '1'));
  await chrome.storage.local.set({
    fomoPage: { at: Date.now(), visible: message?.visible === true, tabId, keeper },
  });
  // Heartbeats are diagnostic only. They never open, reload, or close a page.
}

function mirrorFomoSession(message, sender) {
  if (sender?.id !== chrome.runtime.id || !fomoTabUrl(sender?.tab || {}) || (sender.frameId && sender.frameId !== 0)) {
    return Promise.resolve({ ok: false });
  }
  const token = String(message?.token || '');
  const exp = jwtExpiry(token);
  if (!token || token.length > 16_384 || !Number.isFinite(exp) || exp <= 0) return Promise.resolve({ ok: false });
  const task = sessionMirrorQueue.then(async () => {
    const { fomoToken } = await chrome.storage.local.get('fomoToken');
    if (fomoToken?.token !== token && Number(fomoToken?.exp) >= exp) return { ok: true };
    if (fomoToken?.token === token && !fomoToken.refresh) return { ok: true };
    await chrome.storage.local.set({ fomoToken: { token, exp, at: Date.now() } });
    return { ok: true };
  });
  sessionMirrorQueue = task.catch(() => {});
  return task;
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 5 });
  scheduleSessionExpiry().catch(() => {});
  const previous = String(details?.previousVersion || '0.0.0').split('.').map(Number);
  if (details?.reason === 'install' || previous[0] < 1 && previous[1] < 3) {
    chrome.storage.local.set({ fdFeedEnabled: false }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 5 });
  keepSessionAlive(true).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM || alarm.name === EXPIRY_ALARM) keepSessionAlive(true).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'fomo-trending' || message?.type === 'fomo-ranks') {
    const task = message.type === 'fomo-trending' ? fetchFomoTrending() : fetchFomoRanks();
    task.then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === '985-monitor-sync-acquire' || message?.type === '985-monitor-sync-finish') {
    const task = message.type.endsWith('acquire') ? acquireMonitorSync(message, sender) : finishMonitorSync(message, sender);
    task.then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'fomo-session-observed') {
    mirrorFomoSession(message, sender).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === '985-monitor-session-updated') {
    resetFomoFeedCache();
    refreshMonitor985Config(true)
      .then((ok) => sendResponse({ ok: Boolean(ok) }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'fomo-feed') {
    fetchFomoFeed().then(sendResponse).catch((error) => {
      sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') });
    });
    return true;
  }
  if (message?.type === 'fomo-page-heartbeat') {
    recordHeartbeat(message, sender).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'fomo-force-refresh') {
    refreshSession()
      .then(() => chrome.storage.local.get('fomoToken'))
      .then(({ fomoToken }) => sendResponse({
        ok: Boolean(fomoToken?.token && Number(fomoToken.exp) > Date.now()),
        exp: Number(fomoToken?.exp) || 0,
      }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'fomo-token-feed') {
    keepSessionAlive(false).catch(() => {});
    fetchTokenData(message.payload).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, reason: 'error', message: String(error?.message || '') });
    });
    return true;
  }
  if (message?.type === 'fomo-user-pnl') {
    fetchUserPnl(message.payload?.userId).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

chrome.alarms.get(KEEPALIVE_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 5 });
}).catch(() => {});

scheduleSessionExpiry().catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => { releaseKeeper(tabId, true).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.pinned === false || (change.url && !fomoTabUrl(tab))) {
    releaseKeeper(tabId, false, change.pinned === false && Boolean(fomoTabUrl(tab))).catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.monitor985SessionV1 || changes.fdShowKolRank || changes.fdEnabled
    || changes.monitor985SyncStateV1?.newValue?.connected === false)) {
    rankGeneration++; rankController?.abort();
  }
  if (area === 'local' && changes.monitor985SessionV1) resetFomoFeedCache();
  if (area === 'local' && (changes.fomoToken || changes.fdEnabled)) scheduleSessionExpiry().catch(() => {});
});
