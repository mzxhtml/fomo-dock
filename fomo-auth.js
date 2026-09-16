(() => {
  'use strict';
  if (location.origin !== 'https://fomo.family') return;
  try { window.__fomoDockAuthCleanup?.(); } catch { /* Previous extension context. */ }

  let stopped = false;
  let syncing = false;
  let lastSent = '';
  let mirrorTimer;
  let heartbeatTimer;

  function cleanup() {
    stopped = true;
    window.clearInterval(mirrorTimer);
    window.clearInterval(heartbeatTimer);
    window.removeEventListener('focus', onVisible);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisible);
    try { chrome.runtime.onMessage.removeListener(onSync); } catch { /* Invalidated context. */ }
  }

  function contextAlive() {
    try {
      if (!stopped && chrome.runtime.id) return true;
    } catch { /* Invalidated context. */ }
    cleanup();
    return false;
  }

  function unwrap(raw) {
    if (!raw) return '';
    try { const value = JSON.parse(raw); if (typeof value === 'string') return value; } catch { /* Plain text. */ }
    return String(raw).trim();
  }

  function expiry(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return Number(JSON.parse(atob(part)).exp) * 1000 || 0;
    } catch { return 0; }
  }

  function readToken() {
    try {
      return Object.keys(window.localStorage)
        .filter((key) => /^privy:(.+:)?token$/.test(key))
        .map((key) => unwrap(window.localStorage.getItem(key)))
        .filter((token) => expiry(token) > 0)
        .sort((a, b) => expiry(b) - expiry(a))[0] || '';
    } catch { return ''; }
  }

  async function send(message) {
    if (!contextAlive()) return null;
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) {
      if (/context invalidated/i.test(String(error?.message || '')) || !contextAlive()) cleanup();
      return null;
    }
  }

  async function syncSession() {
    if (!contextAlive() || syncing) return;
    const token = readToken();
    // Empty page storage can mean hydration or navigation, not a logout.
    if (!token || token === lastSent) return;
    syncing = true;
    try {
      const response = await send({ type: 'fomo-session-observed', token });
      if (!stopped && response?.ok) lastSent = token;
    } finally { syncing = false; }
  }

  function heartbeat() {
    return send({ type: 'fomo-page-heartbeat', visible: document.visibilityState === 'visible' });
  }

  function onVisible() { void syncSession(); void heartbeat(); }
  function onPageHide(event) { if (!event.persisted) cleanup(); }
  function onSync(message, sender, reply) {
    if (message?.type !== 'fomo-sync-now' || sender.id !== chrome.runtime.id || stopped) return false;
    Promise.all([syncSession(), heartbeat()]).then(() => reply({ ok: !stopped })).catch(() => reply({ ok: false }));
    return true;
  }

  window.__fomoDockAuthCleanup = cleanup;
  if (!contextAlive()) return;
  try { chrome.runtime.onMessage.addListener(onSync); } catch { cleanup(); return; }
  mirrorTimer = window.setInterval(() => void syncSession(), 5000);
  heartbeatTimer = window.setInterval(() => void heartbeat(), 15_000);
  window.addEventListener('focus', onVisible);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisible);
  onVisible();
})();
