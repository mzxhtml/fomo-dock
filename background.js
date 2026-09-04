'use strict';

const FOMO_API = 'https://prod-api.fomo.family';
const SUPPORTED_CHAINS = '1,56,143,4663,8453,1399811149';
const KEEPALIVE_ALARM = 'fomo-dock-keepalive';
const KEEPER_URL = 'https://fomo.family/?fomo_dock_keeper=1';
const CACHE_TTL_MS = 20_000;
const CACHE_LIMIT = 80;
const REFRESH_AHEAD_MS = 20 * 60_000;

const responseCache = new Map();
const pnlCache = new Map();
let keepAliveAt = 0;
let refreshInFlight = null;
let sessionOwnerQueue = Promise.resolve();

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
};
let monitor985ConfigInflight = null;
let fomoFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
let fomoFeedEtag = '';
let fomoFeedFailCount = 0;
let fomoFeedBackoffUntil = 0;
let fomoFeedInflight = null;

async function monitor985Session() {
  const { monitor985SessionV1: session } = await chrome.storage.local.get({ monitor985SessionV1: null });
  if (!session?.token || Number(session.expiresAt) <= Date.now()) return null;
  return session;
}

function resetFomoFeedCache() {
  fomoFeedCache = { events: [], updatedAt: 0, fetchedAt: 0 };
  fomoFeedEtag = '';
  fomoFeedFailCount = 0;
  fomoFeedBackoffUntil = 0;
}

async function markMonitor985Disconnected(reason, clearSession = false) {
  resetFomoFeedCache();
  const patch = {
    monitorFomoConfig: { connected: false, at: Date.now() },
    monitor985SyncStateV1: { connected: false, reason, checkedAt: Date.now() },
  };
  if (clearSession) patch.monitor985SessionV1 = null;
  await chrome.storage.local.set(patch);
}

async function applyMonitor985Config(config, session) {
  if (!config?.connected || !config?.account?.userId) return false;
  const at = Date.now();
  await chrome.storage.local.set({
    monitorFomoConfig: {
      ...(config.fomo || {}), wallet: config.account.userId,
      connected: true, revision: config.revision, at,
    },
    monitor985SyncStateV1: {
      connected: true,
      accountId: config.account.userId,
      displayName: String(config.account.displayName || ''),
      syncedAt: at,
      expiresAt: Number(session?.expiresAt || config.sessionExpiresAt) || 0,
    },
  });
  return true;
}

async function refreshMonitor985Config(force = false) {
  if (monitor985ConfigInflight) return monitor985ConfigInflight;
  monitor985ConfigInflight = (async () => {
    const stored = await chrome.storage.local.get({ monitor985SessionV1: null, monitor985SyncStateV1: null });
    const session = stored.monitor985SessionV1;
    if (!session?.token || Number(session.expiresAt) <= Date.now()) {
      await markMonitor985Disconnected('login-required', Boolean(session));
      return false;
    }
    if (!force && stored.monitor985SyncStateV1?.connected
      && Date.now() - Number(stored.monitor985SyncStateV1.syncedAt) < MONITOR985_CONFIG_TTL_MS) return true;
    try {
      const response = await fetch(MONITOR985_CONFIG_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}` },
        cache: 'no-store',
      });
      const body = await response.json().catch(() => null);
      if (response.status === 401) {
        await markMonitor985Disconnected('unauthorized', true);
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

async function fetchFomoFeed() {
  if (fomoFeedInflight) return fomoFeedInflight;
  const session = await monitor985Session();
  if (!session) return { ok: false, reason: 'not-connected', events: [] };
  await refreshMonitor985Config(false);
  const now = Date.now();
  if (now - fomoFeedCache.fetchedAt < FOMO_FEED_MIN_INTERVAL_MS || now < fomoFeedBackoffUntil) {
    return { ok: true, ...fomoFeedCache, stale: true };
  }
  fomoFeedInflight = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      const headers = { Authorization: `Bearer ${session.token}` };
      if (fomoFeedEtag) headers['If-None-Match'] = fomoFeedEtag;
      let response;
      try {
        response = await fetch(FOMO_FEED_URL, { headers, cache: 'no-store', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 304) {
        fomoFeedCache.fetchedAt = Date.now();
        fomoFeedFailCount = 0;
        return { ok: true, ...fomoFeedCache };
      }
      if (response.status === 401) {
        await markMonitor985Disconnected('unauthorized', true);
        return { ok: false, reason: 'not-connected', events: [] };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const events = (Array.isArray(body?.events) ? body.events : [])
        .map(slimFomoEvent).filter(Boolean).sort((a, b) => b.ts - a.ts).slice(0, FOMO_FEED_KEEP);
      fomoFeedCache = { events, updatedAt: Number(body?.updatedAt) || Date.now(), fetchedAt: Date.now() };
      fomoFeedEtag = response.headers.get('ETag') || '';
      fomoFeedFailCount = 0;
      fomoFeedBackoffUntil = 0;
      return { ok: true, ...fomoFeedCache };
    } catch (error) {
      fomoFeedFailCount += 1;
      fomoFeedBackoffUntil = Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** (fomoFeedFailCount - 1));
      if (fomoFeedCache.events.length) return { ok: true, ...fomoFeedCache, stale: true };
      return { ok: false, reason: 'fetch-failed', message: String(error?.message || '').slice(0, 120) };
    } finally {
      fomoFeedInflight = null;
    }
  })();
  return fomoFeedInflight;
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

async function fomoTabs() {
  try {
    return await chrome.tabs.query({
      url: ['https://fomo.family/*', 'https://*.fomo.family/*'],
    });
  } catch {
    return [];
  }
}

function isKeeperTab(tab) {
  return String(tab?.url || '').includes('fomo_dock_keeper=');
}

async function dedupeKeeperTabs(tabs = null) {
  const allTabs = Array.isArray(tabs) ? tabs : await fomoTabs();
  const keepers = allTabs
    .filter(isKeeperTab)
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (keepers.length < 2) return keepers[0] || null;

  // Prefer the tab the user is currently viewing; otherwise keep the oldest
  // non-discarded keeper so parallel checks always select the same owner.
  const owner = keepers.find((tab) => tab.active && !tab.discarded)
    || keepers.find((tab) => !tab.discarded)
    || keepers[0];
  const extras = keepers
    .filter((tab) => tab.id !== owner.id)
    .map((tab) => tab.id)
    .filter(Number.isInteger);
  if (extras.length) await chrome.tabs.remove(extras).catch(() => {});
  return owner;
}

async function pageIsAlive() {
  const { fomoPage } = await chrome.storage.local.get('fomoPage');
  return Boolean(fomoPage?.at && Date.now() - fomoPage.at < 45_000);
}

async function ensureSessionOwnerUnlocked(dedicated = false) {
  try {
    const tabs = await fomoTabs();
    let owner = await dedupeKeeperTabs(tabs);
    let created = false;
    if (!owner && !dedicated) {
      owner = tabs.find((tab) => !tab.discarded && tab.status === 'complete')
        || tabs.find((tab) => !tab.discarded);
    }
    if (!owner) {
      owner = await chrome.tabs.create({ url: KEEPER_URL, active: false, pinned: true });
      created = true;
    }
    const isKeeper = isKeeperTab(owner);
    const wasDiscarded = Boolean(owner.discarded);
    await chrome.tabs.update(owner.id, {
      autoDiscardable: false,
      ...(isKeeper ? { pinned: true } : {}),
    });
    if (wasDiscarded || (dedicated && isKeeper && !created)) {
      await chrome.tabs.reload(owner.id);
    }
    return owner;
  } catch {
    return null;
  }
}

function ensureSessionOwner(dedicated = false) {
  const task = sessionOwnerQueue.then(() => ensureSessionOwnerUnlocked(dedicated));
  // Keep later checks serialized even if a Chrome tabs operation fails.
  sessionOwnerQueue = task.catch(() => null);
  return task;
}

async function waitForMirroredToken(previous, timeoutMs = 35_000) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 1000));
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { fomoToken } = await chrome.storage.local.get('fomoToken');
    if (fomoToken?.token && fomoToken.token !== previous) return fomoToken;
  }
  return null;
}

async function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const { fomoToken } = await chrome.storage.local.get('fomoToken');
    if (!fomoToken?.refresh) return null;
    const owner = await ensureSessionOwner(!(await pageIsAlive()));
    if (!owner) return null;
    const mirrored = await waitForMirroredToken(fomoToken.token);
    if (mirrored) return mirrored;
    const latest = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
    return latest?.token && Number(latest.exp) > Date.now() ? latest : null;
  })().catch(() => null);
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function keepSessionAlive(force = false) {
  if (!force && Date.now() - keepAliveAt < 60_000) return;
  keepAliveAt = Date.now();
  const { fomoToken } = await chrome.storage.local.get('fomoToken');
  if (!fomoToken?.refresh) return;
  const left = (Number(fomoToken.exp) || jwtExpiry(fomoToken.token)) - Date.now();
  if (!force && left > REFRESH_AHEAD_MS) return;

  const owner = await ensureSessionOwner(false);
  if (!owner) return;
  if (await pageIsAlive()) {
    if (force) await refreshSession();
    return;
  }
  await ensureSessionOwner(true);
  if (force) await refreshSession();
}

function bodyIsUnauthorized(body) {
  const status = Number(body?.statusCode);
  return status === 401 || status === 403;
}

async function authenticatedFetch(path) {
  let stored = (await chrome.storage.local.get('fomoToken')).fomoToken || null;
  if (stored?.refresh && Number(stored.exp) - Date.now() < 10_000) {
    stored = (await refreshSession())
      || (await chrome.storage.local.get('fomoToken')).fomoToken
      || null;
  }

  const send = (token) => {
    const headers = { Accept: 'application/json', 'X-Supported-Chains': SUPPORTED_CHAINS };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${FOMO_API}${path}`, { headers, credentials: 'include' });
  };

  let response = await send(stored?.token);
  let unauthorizedBody = false;
  if (response.ok) {
    unauthorizedBody = bodyIsUnauthorized(await response.clone().json().catch(() => null));
  }
  if ((response.status === 401 || unauthorizedBody) && stored?.refresh) {
    const renewed = await refreshSession();
    if (renewed?.token && renewed.token !== stored.token) {
      stored = renewed;
      response = await send(renewed.token);
    }
  }
  return { response, stored };
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

async function fetchTokenData(payload) {
  const tokenAddress = String(payload?.tokenAddress || '').trim();
  const networkId = Number(payload?.networkId);
  const kind = ['holders', 'thesis', 'swaps'].includes(payload?.kind) ? payload.kind : 'thesis';
  if (!tokenAddress || !Number.isFinite(networkId)) return { ok: false, reason: 'invalid-request' };

  const key = `${kind}|${networkId}|${tokenAddress}`;
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const { response, stored } = await authenticatedFetch(requestPath({ tokenAddress, networkId, kind }));
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const blocked = /cloudflare|cf-ray|<!doctype html/i.test(text);
      return {
        ok: false,
        reason: blocked ? 'blocked' : response.status === 401 ? (stored?.token ? 'expired' : 'no-token') : `http-${response.status}`,
        status: response.status,
      };
    }

    const body = await response.json().catch(() => null);
    const status = Number(body?.statusCode);
    if (body?.success === false || (Number.isFinite(status) && status !== 200)) {
      const unauthorized = status === 401 || status === 403;
      return {
        ok: false,
        reason: unauthorized ? (stored?.token ? 'expired' : 'no-token') : `api-${status || 'error'}`,
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
    return { ok: false, reason: 'network', message: String(error?.message || '').slice(0, 100) };
  }
}

async function fetchUserPnl(userId) {
  const id = String(userId || '').trim();
  if (!id) return { ok: false, reason: 'no-user' };
  const cached = pnlCache.get(id);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.data;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const path = `/v2/userTokens/aggregatedSnapshot?userId=${encodeURIComponent(id)}&timestamp=${encodeURIComponent(since)}`;
  try {
    const { response } = await authenticatedFetch(path);
    if (!response.ok) return { ok: false, reason: response.status === 401 ? 'expired' : `http-${response.status}` };
    const body = await response.json().catch(() => null);
    const status = Number(body?.statusCode);
    if (body?.success === false || (Number.isFinite(status) && status !== 200)) {
      return { ok: false, reason: status === 401 ? 'expired' : `api-${status || 'error'}` };
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
    return { ok: false, reason: 'network', message: String(error?.message || '').slice(0, 100) };
  }
}

async function recordHeartbeat(message, sender) {
  const tabId = Number(sender?.tab?.id);
  let url;
  try {
    url = new URL(String(sender?.tab?.url || ''));
  } catch {
    return;
  }
  if (!Number.isInteger(tabId) || !(url.hostname === 'fomo.family' || url.hostname.endsWith('.fomo.family'))) return;
  const keeper = message?.keeper === true || url.searchParams.has('fomo_dock_keeper');
  await chrome.storage.local.set({
    fomoPage: { at: Date.now(), visible: message?.visible === true, tabId, keeper },
  });
  if (keeper) {
    await ensureSessionOwner(false);
  } else {
    const extras = (await fomoTabs())
      .filter((tab) => tab.id !== tabId && isKeeperTab(tab))
      .map((tab) => tab.id)
      .filter(Number.isInteger);
    if (extras.length) await chrome.tabs.remove(extras).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 5 });
  dedupeKeeperTabs().catch(() => {});
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
  if (alarm.name === KEEPALIVE_ALARM) keepSessionAlive(false).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    keepSessionAlive(true)
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

// A service worker can start after Chrome has restored several stale pinned
// keepers. Remove duplicates immediately without creating a new page.
dedupeKeeperTabs().catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.monitor985SessionV1) resetFomoFeedCache();
});
