(() => {
  'use strict';
  if (!/(^|\.)985monitor\.xyz$/.test(location.hostname) || window.__fomoDockMonitorAuth) return;
  window.__fomoDockMonitorAuth = true;

  const readJson = (key, fallback) => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) || fallback);
      return parsed == null ? JSON.parse(fallback) : parsed;
    } catch { return JSON.parse(fallback); }
  };
  const accountKey = (value) => (/^0x/i.test(String(value || ''))
    ? String(value || '').toLowerCase() : String(value || ''));
  const pageAuth = () => ({
    wallet: String(window.localStorage.getItem('xMonitorWalletAddress') || '').trim(),
    token: String(window.localStorage.getItem('xMonitorWalletToken') || '').trim(),
  });
  const pagePrefs = () => {
    let muted = readJson('xMonitorFomoMutedV1', '[]');
    let prefs = readJson('xMonitorFomoPrefsV1', '{}');
    if (!Array.isArray(muted)) muted = [];
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
    return { fomo: { muted, prefs } };
  };
  const pageHeaders = ({ wallet, token }) => ({
    'Content-Type': 'application/json', 'X-User-Id': wallet,
    'X-User-Token': token, 'X-Wallet-Address': wallet,
  });
  let inflight = null;
  let lastPrefsStamp = '';
  let lastFullSyncAt = 0;

  async function applyConfig(config, session) {
    if (!config?.connected || !config?.account?.userId) return;
    const at = Date.now();
    await chrome.storage.local.set({
      monitorFomoConfig: {
        ...(config.fomo || {}), wallet: config.account.userId,
        connected: true, revision: config.revision, at,
      },
      monitor985SyncStateV1: {
        connected: true, accountId: config.account.userId,
        displayName: String(config.account.displayName || ''), syncedAt: at,
        expiresAt: Number(session?.expiresAt || config.sessionExpiresAt) || 0,
      },
    });
  }

  async function sync(force = false) {
    if (inflight) return inflight;
    inflight = (async () => {
      const auth = pageAuth();
      const stored = await chrome.storage.local.get({
        monitor985SessionV1: null, monitor985ClientIdV1: '', monitor985SyncStateV1: null,
      });
      let clientId = String(stored.monitor985ClientIdV1 || '').trim();
      if (!clientId) {
        clientId = typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID() : `chrome-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await chrome.storage.local.set({ monitor985ClientIdV1: clientId });
      }
      const session = stored.monitor985SessionV1;
      const sameAccount = accountKey(session?.accountId) === accountKey(auth.wallet);
      const sessionFresh = sameAccount && session?.token
        && Number(session.expiresAt) > Date.now() + 24 * 60 * 60_000;
      if (!auth.wallet || !auth.token) {
        if (!sessionFresh) {
          await chrome.storage.local.set({
            monitor985SyncStateV1: { connected: false, reason: 'login-required', checkedAt: Date.now() },
          });
        }
        return;
      }
      const prefs = pagePrefs();
      const prefsStamp = JSON.stringify(prefs);
      const needsRebind = !sessionFresh || stored.monitor985SyncStateV1?.reason === 'unauthorized';
      const periodic = Date.now() - lastFullSyncAt >= 3 * 60_000;
      if (!force && !needsRebind && prefsStamp === lastPrefsStamp && !periodic) return;
      const endpoint = needsRebind ? '/api/extension/session' : '/api/extension/prefs';
      const response = await fetch(endpoint, {
        method: 'POST', headers: pageHeaders(auth), cache: 'no-store',
        body: JSON.stringify(needsRebind ? { clientId, prefs } : { prefs }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true || !body?.config) {
        if (response.status === 401) {
          await chrome.storage.local.set({
            monitor985SyncStateV1: { connected: false, reason: 'login-required', checkedAt: Date.now() },
          });
        }
        return;
      }
      let activeSession = session;
      if (body.session?.token) {
        activeSession = {
          token: body.session.token, clientId: body.session.clientId || clientId,
          expiresAt: Number(body.session.expiresAt) || 0, accountId: body.config.account.userId,
        };
        await chrome.storage.local.set({ monitor985SessionV1: activeSession });
      }
      await applyConfig(body.config, activeSession);
      lastPrefsStamp = prefsStamp;
      lastFullSyncAt = Date.now();
      chrome.runtime.sendMessage({ type: '985-monitor-session-updated' }, () => void chrome.runtime.lastError);
    })().catch(() => {}).finally(() => { inflight = null; });
    return inflight;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== '985-monitor-sync-now') return false;
    sync(false);
    sendResponse({ ok: true });
    return false;
  });
  sync(true);
  window.setInterval(() => sync(false), 15_000);
  window.addEventListener('focus', () => sync(true));
  window.addEventListener('storage', () => sync(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync(false);
  });
})();
