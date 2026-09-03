(() => {
  'use strict';

  if (window.__fomoDockHolderBridge) return;
  window.__fomoDockHolderBridge = true;

  const ROW_SELECTOR = '[data-testid="token-detail-holders-row"]';
  const ADDRESS_RE = /^(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
  let scheduled = 0;
  let lastScanAt = 0;

  function findHolder(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return null;
    seen.add(value);
    if (typeof value.address === 'string' && value.balance !== undefined) return value;

    let keys;
    try { keys = Object.keys(value); } catch { return null; }
    for (const key of keys.slice(0, 50)) {
      if (['_owner', 'return', 'child', 'sibling', 'alternate', 'stateNode'].includes(key)) continue;
      let child;
      try { child = value[key]; } catch { continue; }
      const hit = findHolder(child, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  function scanRow(row) {
    const fiberKey = Object.keys(row).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return;
    let fiber = row[fiberKey];
    for (let level = 0; fiber && level < 12; level += 1) {
      for (const node of [fiber, fiber.alternate]) {
        if (!node) continue;
        for (const props of [node.memoizedProps, node.pendingProps]) {
          const holder = findHolder(props);
          if (!holder) continue;
          const address = String(holder.address || '').trim();
          const balance = Number(holder.balance);
          if (ADDRESS_RE.test(address)) {
            row.setAttribute('data-fd-holder-address', address.startsWith('0x') ? address.toLowerCase() : address);
          }
          if (Number.isFinite(balance) && balance > 0) {
            row.setAttribute('data-fd-holder-balance', String(balance));
          }
          if (holder.amount_percentage !== undefined) {
            row.setAttribute('data-fd-holder-percentage', String(holder.amount_percentage));
          }
          return;
        }
      }
      fiber = fiber.return;
    }
  }

  function scan() {
    scheduled = 0;
    lastScanAt = Date.now();
    document.querySelectorAll(ROW_SELECTOR).forEach(scanRow);
  }

  function scheduleScan() {
    if (scheduled) return;
    const delay = Math.max(0, 140 - (Date.now() - lastScanAt));
    scheduled = window.setTimeout(() => window.requestAnimationFrame(scan), delay);
  }

  const observer = new MutationObserver(scheduleScan);
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('scroll', scheduleScan, { capture: true, passive: true });
    scheduleScan();
  };

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
