(() => {
  'use strict';

  if (window.__fomoDockEarly) return;
  window.__fomoDockEarly = true;

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

  try {
    chrome.storage.local.get('fomoToken', ({ fomoToken }) => {
      try {
        if (!fomoToken?.token || !fomoToken?.refresh) return;
        const candidates = Object.keys(window.localStorage)
          .filter((key) => /^privy:(.+:)?token$/.test(key))
          .map((tokenKey) => {
            const prefix = tokenKey.slice(0, -'token'.length);
            return {
              tokenKey,
              refreshKey: `${prefix}refresh_token`,
              exp: expiry(unwrap(window.localStorage.getItem(tokenKey))),
            };
          })
          .sort((a, b) => b.exp - a.exp);
        const tokenKey = candidates[0]?.tokenKey || 'privy:token';
        const refreshKey = candidates[0]?.refreshKey || 'privy:refresh_token';
        const pageToken = unwrap(window.localStorage.getItem(tokenKey));
        const pageExpiry = expiry(pageToken);
        const storedExpiry = Number(fomoToken.exp) || expiry(fomoToken.token);
        if (pageToken && pageExpiry >= storedExpiry) return;

        const writeLikeExisting = (key, value) => {
          const current = window.localStorage.getItem(key);
          window.localStorage.setItem(key, current == null || /^"/.test(current) ? JSON.stringify(value) : value);
        };
        writeLikeExisting(tokenKey, fomoToken.token);
        writeLikeExisting(refreshKey, fomoToken.refresh);
      } catch {
        // FOMO may change or lock its storage; normal sign-in remains available.
      }
    });
  } catch {
    // Extension context was reloaded.
  }
})();
