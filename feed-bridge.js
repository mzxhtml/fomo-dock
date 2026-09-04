(() => {
  'use strict';
  if (window.__fomoDockFeedBridge) return;
  window.__fomoDockFeedBridge = true;

  const GMGN_ATTRS = [
    'data-fd-feed-track-addr', 'data-fd-feed-track-symbol', 'data-fd-feed-track-maker',
    'data-fd-feed-track-chain', 'data-fd-feed-track-side', 'data-fd-feed-track-tx',
    'data-fd-feed-track-usd', 'data-fd-feed-track-ts',
  ];
  const DEBOT_ATTRS = [
    'data-fd-debot-track-chain', 'data-fd-debot-track-token', 'data-fd-debot-track-wallet',
    'data-fd-debot-track-side', 'data-fd-debot-track-tx', 'data-fd-debot-track-usd',
    'data-fd-debot-track-mc', 'data-fd-debot-track-ts', 'data-fd-debot-track-symbol',
  ];
  let scheduled = 0;
  let delayTimer = 0;
  let lastScanAt = 0;
  let scrollingUntil = 0;

  const enabled = () => document.documentElement?.getAttribute('data-fd-feed-enabled') === '1';
  const safeString = (value, max = 128) => (typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
  const eventTimeMs = (value) => {
    const number = Number(value);
    if (number > 1.4e9 && number < 4.1e9) return Math.round(number * 1000);
    if (number > 1.4e12 && number < 4.1e12) return Math.round(number);
    return 0;
  };
  const setAttr = (element, name, value) => {
    const next = String(value ?? '');
    if (next) element.setAttribute(name, next);
    else element.removeAttribute(name);
  };

  function findInReact(element, picker, maxLevels = 16) {
    if (!(element instanceof HTMLElement)) return null;
    const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
    if (propsKey) {
      const hit = picker(element[propsKey]);
      if (hit) return hit;
    }
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? element[fiberKey] : null;
    for (let level = 0; fiber && level < maxLevels; level += 1) {
      for (const node of [fiber, fiber.alternate]) {
        if (!node) continue;
        for (const props of [node.memoizedProps, node.pendingProps]) {
          const hit = picker(props);
          if (hit) return hit;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function deepFind(value, normalize, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return null;
    seen.add(value);
    const direct = normalize(value);
    if (direct) return direct;
    let keys;
    try { keys = Object.keys(value); } catch { return null; }
    for (const key of keys.slice(0, 60)) {
      if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) continue;
      let child;
      try { child = value[key]; } catch { continue; }
      if (!child || typeof child !== 'object') continue;
      const hit = deepFind(child, normalize, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  function normalizeGmgn(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const address = value.token_address || value.base_address || value.base_token?.address;
    const maker = value.maker || value.maker_info_address || value.maker_info?.address;
    const side = safeString(value.side, 12).toLowerCase();
    const ts = eventTimeMs(value.timestamp);
    if (!safeString(address, 96) || !safeString(maker, 96)
      || (side !== 'buy' && side !== 'sell') || !ts) return null;
    const amount = Number(value.amount_usd);
    const cost = Number(value.cost_usd);
    return {
      address: safeString(address, 96),
      symbol: safeString(value.base_symbol || value.base_token?.symbol, 24),
      maker: safeString(maker, 96),
      chain: safeString(value.chain, 24).toLowerCase(),
      side,
      tx: safeString(value.transaction_hash || value.tx_hash, 180),
      usd: Number.isFinite(amount) && amount > 0 ? amount
        : Number.isFinite(cost) && cost > 0 ? cost : 0,
      ts,
    };
  }

  function gmgnRecord(element) {
    return findInReact(element, (value) => deepFind(value, normalizeGmgn));
  }

  function markGmgn(element, supplied = null) {
    const record = supplied || gmgnRecord(element);
    if (!record) return false;
    setAttr(element, GMGN_ATTRS[0], record.address);
    setAttr(element, GMGN_ATTRS[1], record.symbol);
    setAttr(element, GMGN_ATTRS[2], record.maker);
    setAttr(element, GMGN_ATTRS[3], record.chain);
    setAttr(element, GMGN_ATTRS[4], record.side);
    setAttr(element, GMGN_ATTRS[5], record.tx);
    setAttr(element, GMGN_ATTRS[6], record.usd || '');
    setAttr(element, GMGN_ATTRS[7], record.ts);
    return true;
  }

  function scanGmgn() {
    const found = new Set();
    document.querySelectorAll('[data-sentry-component="TrackerListItem"]').forEach((node) => found.add(node));
    document.querySelectorAll('[data-sentry-component="TrackingBody"] [data-sentry-component="TableItem"][href*="/token/"]')
      .forEach((row) => {
        const candidate = row.querySelector('[data-testid="follow-tracking-row-symbol"]')?.parentElement
          || row.firstElementChild;
        if (candidate instanceof HTMLElement) found.add(candidate);
      });
    document.querySelectorAll('[data-testid="follow-tracking-row-symbol"]').forEach((cell) => {
      let node = cell.closest('[data-sentry-component="TrackerListItem"]') || cell.parentElement;
      for (let level = 0; node instanceof HTMLElement && level < 6; level += 1) {
        if (node.querySelector('[data-testid="follow-tracking-row-maker"]')) {
          found.add(node); return;
        }
        node = node.parentElement;
      }
    });
    if (!found.size) {
      const scoped = document.querySelectorAll(
        '.virtual-list-container [data-index], .virtual-list-container [data-item-index], [data-index], [data-item-index]',
      );
      let examined = 0;
      for (const wrapper of scoped) {
        if (!(wrapper instanceof HTMLElement) || examined >= 240) break;
        if ((wrapper.style.position || '') !== 'absolute') continue;
        const root = wrapper.firstElementChild;
        if (!(root instanceof HTMLElement)) continue;
        examined += 1;
        const candidates = [root, root.firstElementChild,
          root.querySelector('[data-testid="follow-tracking-row-symbol"]')?.parentElement,
          root.querySelector('a[href*="/token/"]')].filter((node) => node instanceof HTMLElement);
        for (const candidate of candidates) {
          const record = gmgnRecord(candidate);
          if (!record) continue;
          found.add(root);
          markGmgn(root, record);
          break;
        }
      }
    }
    found.forEach((element) => markGmgn(element));
    if (found.size) document.dispatchEvent(new Event('fd-feed-track-ready'));
  }

  function normalizeDebot(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const chain = safeString(value.chain, 24).toLowerCase();
    const token = safeString(value.token, 96);
    const wallet = safeString(value.trader || value.wallet, 96);
    const side = safeString(value.op, 16).toLowerCase();
    const ts = eventTimeMs(value.time ?? value.unix_time);
    const usd = Number(value.volume);
    const mc = Number(value.mc);
    if (!/^[a-z0-9_-]{2,24}$/.test(chain) || !token || !wallet
      || (side !== 'buy' && side !== 'sell') || !ts || !Number.isFinite(usd)) return null;
    return {
      chain, token, wallet, side, tx: safeString(value.tx || value.tx_hash, 180),
      usd: usd > 0 ? usd : 0, mc: Number.isFinite(mc) && mc > 0 ? mc : 0, ts,
    };
  }

  function clearAttrs(element, attrs) {
    attrs.forEach((attr) => element.removeAttribute(attr));
  }

  function debotSymbol(row) {
    const link = row.querySelector('a[href*="/token/"]');
    if (!link) return '';
    const values = [...link.querySelectorAll('span, strong, p')]
      .map((node) => safeString(node.textContent, 24))
      .filter((text) => /^[\p{L}\p{N}._$-]{1,24}$/u.test(text));
    return (values.at(-1) || '').replace(/^\$/, '');
  }

  function markDebot(row) {
    const record = findInReact(row, (value) => deepFind(value, normalizeDebot));
    if (!record) { clearAttrs(row, DEBOT_ATTRS); return false; }
    const values = [record.chain, record.token, record.wallet, record.side, record.tx,
      record.usd || '', record.mc || '', record.ts, debotSymbol(row)];
    DEBOT_ATTRS.forEach((attr, index) => setAttr(row, attr, values[index]));
    return true;
  }

  function onDebotTrackPage() {
    return location.pathname === '/track' && new URLSearchParams(location.search).get('tab') === 'track';
  }

  function scanDebot() {
    if (!onDebotTrackPage()) return;
    let found = 0;
    for (const row of document.querySelectorAll('tbody tr')) {
      if (found >= 120 || !(row instanceof HTMLElement)
        || row.hasAttribute('data-fd-feed-key') || !row.querySelector('a[href*="/token/"]')) continue;
      if (markDebot(row)) found += 1;
    }
    if (found) document.dispatchEvent(new Event('fd-feed-track-ready'));
  }

  function scan() {
    scheduled = 0;
    if (!enabled() || document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now < scrollingUntil && now - lastScanAt < 150) {
      if (!delayTimer) {
        delayTimer = window.setTimeout(() => { delayTimer = 0; schedule(); }, 150);
      }
      return;
    }
    lastScanAt = now;
    if (location.hostname === 'gmgn.ai') scanGmgn();
    else if (location.hostname === 'debot.ai') scanDebot();
  }

  function schedule() {
    if (scheduled || delayTimer || !enabled() || document.visibilityState === 'hidden') return;
    scheduled = window.requestAnimationFrame(scan);
  }

  function navigate() {
    const raw = document.documentElement.getAttribute('data-fd-feed-nav') || '';
    document.documentElement.removeAttribute('data-fd-feed-nav');
    let url;
    try { url = new URL(raw, location.origin); } catch { return; }
    if (url.origin !== location.origin) return;
    if (location.hostname === 'gmgn.ai') {
      if (!/^\/(sol|bsc|eth|base|tron|blast|monad|megaeth|hyperevm|xlayer|robinhood|arc|stable|arbitrum)\/token\/[a-zA-Z0-9]{20,96}$/.test(url.pathname)) return;
      try {
        const router = window.next?.router;
        if (typeof router?.push === 'function') {
          Promise.resolve(router.push(url.pathname)).catch(() => location.assign(url.href));
          return;
        }
      } catch {}
      location.assign(url.href);
      return;
    }
    if (location.hostname === 'debot.ai'
      && /^\/token\/[a-z0-9_-]+\/[^/?#]+/i.test(url.pathname)) {
      const previous = history.state && typeof history.state === 'object' ? history.state : {};
      history.pushState({ ...previous, key: Math.random().toString(36).slice(2), idx: Number(previous.idx || 0) + 1 }, '', url.href);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }
  }

  function start() {
    const observer = new MutationObserver((records) => {
      if (records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target?.parentElement;
        if (target?.closest('[data-fd-feed-owned="1"]')) return false;
        return [...record.addedNodes, ...record.removedNodes].some((node) => {
          if (node.nodeType === Node.TEXT_NODE) return false;
          return !(node instanceof Element)
            || (!node.matches('[data-fd-feed-owned="1"]') && !node.closest('[data-fd-feed-owned="1"]'));
        });
      })) schedule();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('scroll', () => { scrollingUntil = Date.now() + 220; schedule(); }, true);
    document.addEventListener('visibilitychange', schedule);
    document.addEventListener('fd-feed-setting', schedule);
    document.addEventListener('fd-feed-navigate', navigate);
    window.addEventListener('popstate', schedule);
    window.setInterval(schedule, 1200);
    schedule();
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
