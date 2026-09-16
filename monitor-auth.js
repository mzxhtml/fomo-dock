(() => {
  'use strict';
  if (!/(^|\.)985monitor\.xyz$/.test(location.hostname)) return;
  try { window.__fomoDockMonitorCleanup?.(); } catch { /* Old extension context. */ }
  let stopped = false;
  let inflight = null;
  let timer;
  let controller;

  function cleanup() {
    stopped = true;
    controller?.abort();
    window.clearInterval(timer);
    window.removeEventListener('focus', onChange);
    window.removeEventListener('storage', onChange);
    document.removeEventListener('visibilitychange', onChange);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
  }
  function alive() {
    try { if (!stopped && chrome.runtime.id) return true; } catch {}
    cleanup();
    return false;
  }
  async function message(value) {
    if (!alive()) return null;
    try { return await chrome.runtime.sendMessage(value); }
    catch (error) {
      if (/context invalidated/i.test(String(error?.message || ''))) cleanup();
      return null;
    }
  }
  function readJson(key, fallback) {
    try { return JSON.parse(window.localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function pageAuth() {
    try {
      return { wallet: String(window.localStorage.getItem('xMonitorWalletAddress') || '').trim(),
        token: String(window.localStorage.getItem('xMonitorWalletToken') || '').trim() };
    } catch { return { wallet: '', token: '' }; }
  }
  function pagePrefs() {
    const muted = readJson('xMonitorFomoMutedV1', []);
    const prefs = readJson('xMonitorFomoPrefsV1', {});
    return { fomo: { muted: Array.isArray(muted) ? muted : [],
      prefs: prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {} } };
  }
  function retryDelay(response) {
    if (response.status !== 429) return 30_000;
    const raw = response.headers.get('Retry-After') || '';
    const delay = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
    return Math.max(60_000, Number.isFinite(delay) ? delay : 0);
  }
  function sync() {
    if (!alive() || inflight) return inflight;
    inflight = (async () => {
      const auth = pageAuth();
      // A signed-out/background tab must not erase another tab's valid session.
      if (!auth.wallet || !auth.token) return;
      const prefs = pagePrefs();
      const permit = await message({ type: '985-monitor-sync-acquire',
        account: auth.wallet, visible: document.visibilityState === 'visible', prefsStamp: JSON.stringify(prefs) });
      if (!permit?.ok || !permit.lease) return;
      let outcome = { status: 0, retryAfterMs: 30_000 };
      let timeout;
      try {
        if (!alive()) return;
        const current = pageAuth();
        if (current.wallet !== auth.wallet || current.token !== auth.token) {
          outcome = { cancelled: true };
          return;
        }
        controller = new AbortController();
        timeout = window.setTimeout(() => controller.abort(), 20_000);
        const response = await fetch(permit.needsRebind ? '/api/extension/session' : '/api/extension/prefs', {
          method: 'POST', cache: 'no-store', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-User-Id': auth.wallet,
            'X-User-Token': auth.token, 'X-Wallet-Address': auth.wallet },
          body: JSON.stringify(permit.needsRebind ? { clientId: permit.clientId, prefs } : { prefs }),
        });
        const body = await response.json().catch(() => null);
        const after = pageAuth();
        outcome = after.wallet === auth.wallet && after.token === auth.token
          ? { status: response.status, body, retryAfterMs: retryDelay(response) } : { cancelled: true };
      } catch { /* Shared cooldown is released in finally. */ }
      finally {
        window.clearTimeout(timeout);
        controller = null;
        await message({ type: '985-monitor-sync-finish', lease: permit.lease, ...outcome });
      }
    })().catch(() => {}).finally(() => { inflight = null; });
    return inflight;
  }
  function onChange() { if (document.visibilityState === 'visible') void sync(); }
  function onMessage(value, sender, reply) {
    if (value?.type !== '985-monitor-sync-now' || sender.id !== chrome.runtime.id) return false;
    sync();
    reply({ ok: true });
    return false;
  }
  window.__fomoDockMonitorCleanup = cleanup;
  if (!alive()) return;
  try { chrome.runtime.onMessage.addListener(onMessage); } catch { cleanup(); return; }
  timer = window.setInterval(sync, 15_000);
  window.addEventListener('focus', onChange);
  window.addEventListener('storage', onChange);
  document.addEventListener('visibilitychange', onChange);
  sync();
})();
