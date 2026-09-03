(() => {
  'use strict';

  if (window.__fomoDockAuth) return;
  window.__fomoDockAuth = true;

  const unwrap = (raw) => {
    if (!raw) return '';
    let value = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') value = parsed;
    } catch {
      // Keep plain text values as-is.
    }
    value = String(value || '').trim();
    return value.length > 20 ? value : '';
  };

  const expiry = (token) => {
    try {
      const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return Number(JSON.parse(atob(part)).exp) * 1000 || 0;
    } catch {
      return 0;
    }
  };

  function readSession() {
    const sessions = [];
    try {
      for (const tokenKey of Object.keys(window.localStorage).filter((key) => /^privy:(.+:)?token$/.test(key))) {
        const prefix = tokenKey.slice(0, -'token'.length);
        const token = unwrap(window.localStorage.getItem(tokenKey));
        if (!token) continue;
        sessions.push({
          token,
          refresh: unwrap(window.localStorage.getItem(`${prefix}refresh_token`)),
          exp: expiry(token),
        });
      }
    } catch {
      return null;
    }
    sessions.sort((a, b) => b.exp - a.exp);
    return sessions[0] || null;
  }

  let lastSent = '';
  function syncSession() {
    const session = readSession();
    if (!session?.token) return;
    const stamp = `${session.token}|${session.refresh}`;
    if (stamp === lastSent) return;
    try {
      chrome.storage.local.get('fomoToken', ({ fomoToken }) => {
        if (fomoToken?.token === session.token && (fomoToken.refresh || '') === (session.refresh || '')) {
          lastSent = stamp;
          return;
        }
        if (fomoToken?.token && fomoToken.token !== session.token
          && Number(fomoToken.exp) >= Number(session.exp)) return;
        lastSent = stamp;
        chrome.storage.local.set({
          fomoToken: { ...session, at: Date.now() },
        }).catch(() => {});
      });
    } catch {
      // Extension context was reloaded.
    }
  }

  function heartbeat() {
    try {
      chrome.runtime.sendMessage({
        type: 'fomo-page-heartbeat',
        visible: document.visibilityState === 'visible',
        keeper: new URLSearchParams(location.search).has('fomo_dock_keeper'),
      }, () => void chrome.runtime.lastError);
    } catch {
      // Extension context was reloaded.
    }
  }

  syncSession();
  heartbeat();
  window.setInterval(syncSession, 5000);
  window.setInterval(heartbeat, 15_000);
  window.addEventListener('focus', syncSession);
  document.addEventListener('visibilitychange', () => {
    syncSession();
    heartbeat();
  });
})();
