(() => {
  'use strict';
  if (window.__fomoDockFeedContent) return;
  window.__fomoDockFeedContent = true;

  const DEFAULTS = {
    fdFeedEnabled: false,
    fdFeedChainOnly: false,
    fdFeedTypes: {
      buy: true, sell: true, swap: true, thesis: true, transferIn: true, refund: true,
    },
  };
  const TAGS = {
    buy: { label: '买入', cls: 'is-buy' }, sell: { label: '卖出', cls: 'is-sell' },
    swap: { label: '换仓', cls: 'is-swap' }, thesis: { label: '观点', cls: 'is-thesis' },
    transferIn: { label: '转入', cls: 'is-transfer' }, refund: { label: '退款/失败', cls: 'is-refund' },
  };
  const CHAIN_COLORS = {
    sol: '#7b44f2', bsc: '#eab204', base: '#3073ff', eth: '#4d84f7', robinhood: '#9fc700',
    stable: '#007b4f', arc: '#5c8de5', xlayer: '#4a4a4a', hyperevm: '#55c6ab',
    megaeth: '#2a2a2a', monad: '#6a52f1',
  };
  const POLL_MS = 18_000;
  const RENDER_CAP = 40;
  const INLINE_CAP = 8;
  const HEAD_CAP = 5;
  const seen = new Set();
  let settings = { ...DEFAULTS };
  let monitor = {
    connected: false, muted: new Set(), prefs: {}, watch: new Set(), filters: {},
    tokenFilters: new Set(), globalTradeMinUsd: 10,
  };
  let events = [];
  let lastPollAt = 0;
  let pollInflight = false;
  let renderRaf = 0;
  let observer = null;
  let loginPromptDismissed = false;

  const safeText = (value, max = 128) => String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  const normalize = (value) => {
    const text = safeText(value, 180);
    return /^0x/i.test(text) ? text.toLowerCase() : text;
  };
  const validImageUrl = (value) => {
    try {
      const url = new URL(safeText(value, 500));
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  };
  const tokenKey = (value) => {
    const text = safeText(value, 96);
    if (/^0x[a-fA-F0-9]{40}$/.test(text)) return text.toLowerCase();
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return text;
    const symbol = text.replace(/^\$+/, '').toUpperCase();
    return /^[A-Z0-9._-]{1,20}$/.test(symbol) ? symbol : '';
  };

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response || null);
        });
      } catch { resolve(null); }
    });
  }

  function loadMonitor(raw) {
    const tokenValues = Array.isArray(raw?.tokenFilters) ? raw.tokenFilters : [];
    const globalMinimum = Number(raw?.globalTradeMinUsd);
    monitor = {
      connected: raw?.connected === true,
      muted: new Set((Array.isArray(raw?.muted) ? raw.muted : [])
        .map((item) => safeText(item, 80).toLowerCase()).filter(Boolean)),
      prefs: raw?.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs) ? raw.prefs : {},
      watch: new Set((Array.isArray(raw?.watch) ? raw.watch : [])
        .map((item) => safeText(item, 80).toLowerCase()).filter(Boolean)),
      filters: raw?.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters) ? raw.filters : {},
      tokenFilters: new Set(tokenValues.map(tokenKey).filter(Boolean)),
      globalTradeMinUsd: Number.isFinite(globalMinimum) && globalMinimum >= 0 ? globalMinimum : 10,
    };
  }

  function buildLoginPrompt(variant) {
    const prompt = document.createElement('aside');
    prompt.className = `fd-feed-login fd-feed-login--${variant}`;
    prompt.dataset.fdFeedOwned = '1';
    prompt.setAttribute('role', 'status');
    const copy = document.createElement('div');
    copy.className = 'fd-feed-login__copy';
    const title = document.createElement('strong');
    title.textContent = 'FOMO 推送混排需要连接 985monitor';
    const note = document.createElement('span');
    note.textContent = '登录后会自动同步关注、屏蔽和事件偏好。';
    copy.append(title, note);
    const connect = document.createElement('button');
    connect.type = 'button';
    connect.className = 'fd-feed-login__connect';
    connect.textContent = '去登录';
    connect.addEventListener('click', () => {
      window.open('https://www.985monitor.xyz/', '_blank', 'noopener,noreferrer');
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'fd-feed-login__close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';
    close.addEventListener('click', () => {
      loginPromptDismissed = true;
      scheduleRender();
    });
    prompt.append(copy, connect, close);
    return prompt;
  }

  function currentChain() {
    if (location.hostname === 'gmgn.ai') {
      return location.pathname.match(/^\/(sol|bsc|eth|base|tron|blast|monad|megaeth|hyperevm|xlayer|robinhood|arc|stable|arbitrum)(?:\/|$)/)?.[1] || '';
    }
    const query = new URLSearchParams(location.search).get('chain');
    if (query) return safeText(query, 24).toLowerCase();
    return location.pathname.match(/^\/token\/([a-z0-9_-]+)\//i)?.[1]?.toLowerCase() || '';
  }

  function allowed(event) {
    if (!monitor.connected || !event?.key || !Number(event.ts)) return false;
    if (settings.fdFeedTypes?.[event.type] === false) return false;
    const handle = safeText(event.handle, 80).toLowerCase();
    if (!handle || !monitor.watch.has(handle) || monitor.muted.has(handle)) return false;
    if (monitor.prefs?.[handle]?.types?.[event.type] === false) return false;
    if (monitor.tokenFilters.has(tokenKey(event.symbol)) || monitor.tokenFilters.has(tokenKey(event.addr))) return false;
    const personal = Number(monitor.filters?.[handle]?.minTradeUsd ?? monitor.filters?.[handle]);
    const minimum = Math.max(monitor.globalTradeMinUsd,
      Number.isFinite(personal) && personal > 0 ? personal : 0);
    return !(minimum > 0 && Number(event.usd) > 0 && Number(event.usd) < minimum);
  }

  function eventIdentity(event) {
    const tx = normalize(event?.tx);
    if (tx) return `tx:${tx}`;
    return `${normalize(event?.addr)}:${event?.type}:${normalize(event?.handle)}`
      + `:${Math.round(Number(event?.ts) / 1000)}:${Math.round(Number(event?.usd) * 100)}`;
  }

  function isNativeDuplicate(event, row) {
    if (event.type !== 'buy' && event.type !== 'sell') return false;
    const tx = normalize(event.tx);
    if (tx && row.tx && tx === normalize(row.tx)) return true;
    if (!event.addr || normalize(event.addr) !== normalize(row.addr) || event.type !== row.side) return false;
    if (event.chain && row.chain && event.chain !== row.chain) return false;
    if (!event.ts || !row.ts || Math.abs(Number(event.ts) - Number(row.ts)) > 15_000) return false;
    const usd = Number(event.usd) || 0;
    return Boolean(usd && row.usd && Math.abs(usd - row.usd) <= Math.max(1, Math.max(usd, row.usd) * 0.05));
  }

  function visibleEvents(nativeRows = []) {
    const chain = settings.fdFeedChainOnly ? currentChain() : '';
    const identities = new Set();
    return events.filter((event) => allowed(event) && (!chain || !event.chain || event.chain === chain))
      .sort((a, b) => Number(b.ts) - Number(a.ts))
      .filter((event) => {
        const identity = eventIdentity(event);
        if (identities.has(identity) || nativeRows.some((row) => isNativeDuplicate(event, row))) return false;
        identities.add(identity);
        return true;
      }).slice(0, RENDER_CAP);
  }

  function formatUsd(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '';
    if (number >= 1e9) return `$${(number / 1e9).toFixed(number >= 1e10 ? 1 : 2)}B`;
    if (number >= 1e6) return `$${(number / 1e6).toFixed(number >= 1e7 ? 1 : 2)}M`;
    if (number >= 1e3) return `$${(number / 1e3).toFixed(number >= 1e4 ? 1 : 2)}K`;
    return `$${number.toFixed(number >= 100 ? 0 : number >= 10 ? 1 : 2)}`;
  }

  function relativeTime(timestamp) {
    const diff = Math.max(0, Date.now() - Number(timestamp));
    if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
    return `${Math.floor(diff / 86_400_000)}d`;
  }

  function profileUrl(event) {
    return event.handle ? `https://fomo.family/profile/${encodeURIComponent(event.handle)}` : '';
  }

  function tokenPath(event) {
    const chain = safeText(event.chain, 24).toLowerCase();
    const address = safeText(event.addr, 96);
    if (!chain || !address) return '';
    if (location.hostname === 'gmgn.ai') return `/${encodeURIComponent(chain)}/token/${encodeURIComponent(address)}`;
    let prefix = '';
    for (const link of document.querySelectorAll('a[href*="/token/"]')) {
      const match = (link.getAttribute('href') || '').match(/^\/token\/[a-z0-9_-]+\/([^/?#]+)/i);
      if (!match) continue;
      let segment = match[1];
      try { segment = decodeURIComponent(segment); } catch {}
      const token = segment.match(/(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/)?.[1] || '';
      const candidate = token ? segment.slice(0, -token.length) : '';
      if (/^[a-zA-Z0-9-]{1,64}_$/.test(candidate)) { prefix = candidate; break; }
    }
    return `/token/${encodeURIComponent(chain)}/${encodeURIComponent(`${prefix}${address}`)}`;
  }

  function navigate(path) {
    if (!path) return;
    document.documentElement.setAttribute('data-fd-feed-nav', path);
    document.dispatchEvent(new Event('fd-feed-navigate'));
  }

  function avatar(event, className) {
    const box = document.createElement('span');
    box.className = className;
    const url = validImageUrl(event.avatar);
    if (url) {
      const image = document.createElement('img');
      image.src = url; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove(), { once: true });
      box.appendChild(image);
    } else {
      box.textContent = safeText(event.name || event.handle, 1).toUpperCase() || '?';
    }
    const open = (click) => {
      click.preventDefault(); click.stopPropagation();
      const urlValue = profileUrl(event);
      if (urlValue) window.open(urlValue, '_blank', 'noopener,noreferrer');
    };
    box.addEventListener('click', open);
    return box;
  }

  function buildGmgnCard(event) {
    const tag = TAGS[event.type] || { label: '事件', cls: '' };
    const card = document.createElement('div');
    card.className = `fd-feed-card fd-feed-card--gmgn ${tag.cls}`;
    card.dataset.fdFeedOwned = '1';
    card.dataset.fdFeedKey = safeText(event.key, 150);
    card.dataset.fdFeedTs = String(event.ts);
    const stripe = document.createElement('span');
    stripe.className = 'fd-feed-card__stripe';
    stripe.style.backgroundColor = CHAIN_COLORS[event.chain] || '#8a93a6';
    const top = document.createElement('div');
    top.className = 'fd-feed-card__top';
    const picture = avatar(event, 'fd-feed-card__avatar');
    const name = document.createElement('strong');
    name.className = 'fd-feed-card__name';
    name.textContent = safeText(event.name || event.handle, 40) || '?';
    name.addEventListener('click', (click) => {
      click.preventDefault(); click.stopPropagation();
      const url = profileUrl(event);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    });
    const action = document.createElement('span');
    action.className = 'fd-feed-card__action'; action.textContent = tag.label;
    const source = document.createElement('span');
    source.className = 'fd-feed-card__source'; source.textContent = 'FOMO';
    const time = document.createElement('span');
    time.className = 'fd-feed-card__time'; time.textContent = relativeTime(event.ts);
    top.append(picture, name, action, source, time);
    const bottom = document.createElement('div');
    bottom.className = 'fd-feed-card__bottom';
    if (Number(event.usd) > 0) {
      const amount = document.createElement('strong');
      amount.className = 'fd-feed-card__amount'; amount.textContent = formatUsd(event.usd);
      bottom.appendChild(amount);
    }
    const logoUrl = validImageUrl(event.img);
    if (logoUrl) {
      const logo = document.createElement('img');
      logo.className = 'fd-feed-card__logo'; logo.src = logoUrl; logo.alt = ''; logo.loading = 'lazy';
      logo.addEventListener('error', () => logo.remove(), { once: true });
      bottom.appendChild(logo);
    }
    const symbol = document.createElement('strong');
    symbol.className = 'fd-feed-card__symbol'; symbol.textContent = safeText(event.symbol, 24);
    bottom.appendChild(symbol);
    if (Number(event.mc) > 0) {
      const mc = document.createElement('span');
      mc.className = 'fd-feed-card__mc'; mc.textContent = `MC:${formatUsd(event.mc)}`;
      bottom.appendChild(mc);
    }
    card.append(stripe, top, bottom);
    if ((event.type === 'thesis' || event.type === 'refund') && event.comment) {
      const comment = document.createElement('div');
      comment.className = 'fd-feed-card__comment'; comment.textContent = safeText(event.comment, 1500);
      card.appendChild(comment);
    }
    const path = tokenPath(event);
    if (path) {
      card.title = `${event.symbol || event.addr} · 点击打开代币页`;
      card.addEventListener('click', (click) => {
        click.preventDefault(); click.stopPropagation(); navigate(path);
      });
    }
    card.addEventListener('pointerdown', (pointer) => pointer.stopPropagation());
    if (!seen.has(event.key)) {
      seen.add(event.key); card.classList.add('is-new');
      while (seen.size > 600) seen.delete(seen.values().next().value);
    }
    return card;
  }

  function feedCell(className, text) {
    const cell = document.createElement('span');
    cell.className = `fd-feed-table__cell ${className}`; cell.textContent = text;
    return cell;
  }

  function buildDebotCard(event, variant = 'table') {
    const tag = TAGS[event.type] || { label: '事件', cls: '' };
    const card = document.createElement('a');
    card.className = `fd-feed-table fd-feed-table--${variant} ${tag.cls}`;
    card.dataset.fdFeedOwned = '1'; card.dataset.fdFeedKey = safeText(event.key, 150);
    card.dataset.fdFeedTs = String(event.ts); card.href = tokenPath(event);
    const stripe = document.createElement('span');
    stripe.className = 'fd-feed-table__stripe'; stripe.style.backgroundColor = CHAIN_COLORS[event.chain] || '#8a93a6';
    const who = feedCell('fd-feed-table__who', '');
    const picture = avatar(event, 'fd-feed-table__avatar');
    const name = document.createElement('strong');
    name.className = 'fd-feed-table__name'; name.textContent = safeText(event.name || event.handle, 40);
    const source = document.createElement('span');
    source.className = 'fd-feed-table__source'; source.textContent = 'FOMO';
    who.append(picture, name, source);
    const token = feedCell('fd-feed-table__token', '');
    const logoUrl = validImageUrl(event.img);
    if (logoUrl) {
      const logo = document.createElement('img');
      logo.className = 'fd-feed-table__logo'; logo.src = logoUrl; logo.alt = ''; logo.loading = 'lazy';
      logo.addEventListener('error', () => logo.remove(), { once: true }); token.appendChild(logo);
    }
    const symbol = document.createElement('strong');
    symbol.textContent = safeText(event.symbol || event.addr, 24); token.appendChild(symbol);
    const action = feedCell('fd-feed-table__action', tag.label);
    const amount = feedCell('fd-feed-table__amount', formatUsd(event.usd) || '—');
    const mc = feedCell('fd-feed-table__mc', formatUsd(event.mc) || '—');
    const time = feedCell('fd-feed-table__time', relativeTime(event.ts));
    card.append(stripe, who, token, action, amount, mc, time);
    if ((event.type === 'thesis' || event.type === 'refund') && event.comment) {
      const comment = document.createElement('div');
      comment.className = 'fd-feed-table__comment'; comment.textContent = safeText(event.comment, 1500);
      card.classList.add('has-comment'); card.appendChild(comment);
    }
    card.addEventListener('click', (click) => {
      if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
      if (click.target instanceof Element && click.target.closest('.fd-feed-table__avatar, .fd-feed-table__name')) return;
      click.preventDefault(); navigate(card.getAttribute('href'));
    });
    const openProfile = (click) => {
      click.preventDefault(); click.stopPropagation();
      const url = profileUrl(event); if (url) window.open(url, '_blank', 'noopener,noreferrer');
    };
    name.addEventListener('click', openProfile);
    if (!seen.has(event.key)) {
      seen.add(event.key); card.classList.add('is-new');
      while (seen.size > 600) seen.delete(seen.values().next().value);
    }
    return card;
  }

  function nativeTransformY(raw) {
    const text = safeText(raw, 200);
    let match = text.match(/translateY\(\s*(-?[\d.]+)px\s*\)/i);
    if (match) return Number(match[1]);
    match = text.match(/translate3d\(\s*-?[\d.]+px\s*,\s*(-?[\d.]+)px/i);
    if (match) return Number(match[1]);
    match = text.match(/matrix\(\s*([^)]+)\)/i);
    if (match) {
      const parts = match[1].split(',').map(Number);
      if (parts.length === 6 && parts.every(Number.isFinite)) return parts[5];
    }
    return Number.NaN;
  }

  function fixedRow(card) {
    let wrapper = card.parentElement;
    for (let level = 0; wrapper instanceof HTMLElement && level < 5; level += 1) {
      if ((wrapper.style.position || '') === 'absolute') {
        const top = Number.parseFloat(wrapper.style.top);
        const transform = nativeTransformY(wrapper.style.transform);
        const y = (Number.isFinite(top) ? top : 0) + (Number.isFinite(transform) ? transform : 0);
        const height = Number.parseFloat(wrapper.style.height) || wrapper.offsetHeight;
        return height > 0 && (Number.isFinite(top) || Number.isFinite(transform))
          ? { wrapper, top: y, height } : null;
      }
      wrapper = wrapper.parentElement;
    }
    return null;
  }

  function restoreShifts() {
    document.querySelectorAll('[data-fd-feed-shift="1"]').forEach((row) => {
      row.style.translate = row.dataset.fdFeedTranslate || '';
      delete row.dataset.fdFeedTranslate;
      row.removeAttribute('data-fd-feed-shift');
    });
  }

  function teardown() {
    document.querySelectorAll('[data-fd-feed-owned="1"]').forEach((node) => node.remove());
    restoreShifts();
    document.querySelectorAll('[data-fd-feed-margin-active="1"]').forEach((node) => {
      node.style.marginBottom = node.dataset.fdFeedMarginValue || '';
      delete node.dataset.fdFeedMarginValue;
      node.removeAttribute('data-fd-feed-margin-active');
    });
  }

  function placement(times, list, cap = INLINE_CAP) {
    if (!times.length) return new Map();
    const groups = new Map();
    let count = 0;
    let head = 0;
    for (const event of list) {
      let key = '';
      if (Number(event.ts) >= Number(times[0])) {
        if (head >= HEAD_CAP) continue;
        key = 'before:0'; head += 1;
      } else {
        for (let index = 0; index < times.length - 1; index += 1) {
          if (Number(times[index]) >= Number(event.ts) && Number(event.ts) >= Number(times[index + 1])) {
            key = `after:${index}`; break;
          }
        }
      }
      if (!key) continue;
      const bucket = groups.get(key) || [];
      bucket.push(event); groups.set(key, bucket);
      count += 1;
      if (count >= cap) break;
    }
    return groups;
  }

  function gmgnRows() {
    return [...document.querySelectorAll('[data-fd-feed-track-ts]')]
      .filter((node) => node instanceof HTMLElement && !node.closest('[data-fd-feed-owned="1"]'));
  }

  function gmgnNative(rows) {
    return rows.map((row) => ({
      tx: row.dataset.fdFeedTrackTx || '', addr: normalize(row.dataset.fdFeedTrackAddr),
      chain: safeText(row.dataset.fdFeedTrackChain, 24).toLowerCase(),
      side: safeText(row.dataset.fdFeedTrackSide, 16).toLowerCase(),
      ts: Number(row.dataset.fdFeedTrackTs) || 0, usd: Number(row.dataset.fdFeedTrackUsd) || 0,
    }));
  }

  function layoutGmgn() {
    const rows = gmgnRows();
    if (!rows.length) return;
    const infos = rows.map((row) => ({ row, fixed: fixedRow(row), ts: Number(row.dataset.fdFeedTrackTs) || 0 }))
      .filter((item) => item.ts > 0);
    if (!infos.length) return;
    infos.sort((a, b) => {
      if (a.fixed && b.fixed) return a.fixed.top - b.fixed.top;
      return Number(b.ts) - Number(a.ts);
    });
    const fixed = infos.every((item) => item.fixed && item.fixed.wrapper.parentElement === infos[0].fixed.wrapper.parentElement);
    if (!monitor.connected) {
      if (loginPromptDismissed) return;
      const prompt = buildLoginPrompt('gmgn');
      if (!fixed) {
        infos[0].row.before(prompt);
        return;
      }
      const spacer = infos[0].fixed.wrapper.parentElement;
      prompt.classList.add('is-absolute');
      prompt.style.top = `${infos[0].fixed.top}px`;
      spacer.appendChild(prompt);
      const height = prompt.offsetHeight + 2;
      infos.forEach((item) => {
        const wrapper = item.fixed.wrapper;
        wrapper.dataset.fdFeedTranslate = wrapper.style.translate || '';
        wrapper.dataset.fdFeedShift = '1';
        wrapper.style.translate = `0 ${height}px`;
      });
      return;
    }
    const list = visibleEvents(gmgnNative(rows));
    if (!list.length) return;
    const groups = placement(infos.map((item) => item.ts), list);
    if (!groups.size) return;
    if (!fixed) {
      const head = groups.get('before:0') || [];
      let previous = null;
      head.forEach((event) => {
        const card = buildGmgnCard(event);
        if (previous) previous.after(card); else infos[0].row.before(card);
        previous = card;
      });
      infos.forEach((item, index) => {
        let anchor = item.row;
        (groups.get(`after:${index}`) || []).forEach((event) => {
          const card = buildGmgnCard(event); anchor.after(card); anchor = card;
        });
      });
      return;
    }
    const spacer = infos[0].fixed.wrapper.parentElement;
    let inserted = 0;
    infos.forEach((item, index) => {
      for (const event of groups.get(`before:${index}`) || []) {
        const card = buildGmgnCard(event);
        card.classList.add('is-absolute');
        card.style.top = `${item.fixed.top + inserted}px`; spacer.appendChild(card);
        inserted += card.offsetHeight + 2;
      }
      const wrapper = item.fixed.wrapper;
      wrapper.dataset.fdFeedTranslate = wrapper.style.translate || '';
      wrapper.dataset.fdFeedShift = '1'; wrapper.style.translate = `0 ${inserted}px`;
      for (const event of groups.get(`after:${index}`) || []) {
        const card = buildGmgnCard(event);
        card.classList.add('is-absolute');
        card.style.top = `${item.fixed.top + item.fixed.height + inserted}px`; spacer.appendChild(card);
        inserted += card.offsetHeight + 2;
      }
    });
  }

  function debotTrackTable() {
    const marked = document.querySelector('tr[data-fd-debot-track-ts]');
    if (marked) return marked.closest('table');
    return null;
  }

  function layoutDebotTable() {
    const table = debotTrackTable();
    if (!table) return;
    const rows = [...table.querySelectorAll('tbody tr[data-fd-debot-track-ts]')];
    if (!rows.length) return;
    const nativeRows = rows.map((row) => ({
      tx: row.dataset.fdDebotTrackTx || '', addr: normalize(row.dataset.fdDebotTrackToken),
      chain: safeText(row.dataset.fdDebotTrackChain, 24).toLowerCase(),
      side: safeText(row.dataset.fdDebotTrackSide, 16).toLowerCase(),
      ts: Number(row.dataset.fdDebotTrackTs) || 0, usd: Number(row.dataset.fdDebotTrackUsd) || 0,
    }));
    const scroller = table.closest('[data-virtuoso-scroller="true"], [data-virtuoso-scroller]') || table.parentElement;
    if (!(scroller instanceof HTMLElement)) return;
    if (getComputedStyle(scroller).position === 'static') scroller.style.position = 'relative';
    const scrollerRect = scroller.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const rowInfo = rows.map((row) => ({
      row, top: row.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop,
      height: row.getBoundingClientRect().height || 46,
    }));
    const headers = [...table.querySelectorAll('thead th')];
    const columns = headers.length >= 6
      ? headers.slice(0, 6).map((cell) => `${Math.max(60, Math.round(cell.getBoundingClientRect().width))}px`).join(' ')
      : 'minmax(170px,1.45fr) minmax(150px,1.25fr) 90px 120px 120px 80px';
    if (!monitor.connected) {
      if (loginPromptDismissed) return;
      const prompt = buildLoginPrompt('debot');
      prompt.classList.add('is-absolute');
      prompt.style.top = `${rowInfo[0].top}px`;
      prompt.style.left = `${tableRect.left - scrollerRect.left + scroller.scrollLeft}px`;
      prompt.style.width = `${tableRect.width}px`;
      scroller.appendChild(prompt);
      const height = prompt.offsetHeight;
      rowInfo.forEach((info) => {
        info.row.dataset.fdFeedTranslate = info.row.style.translate || '';
        info.row.dataset.fdFeedShift = '1';
        info.row.style.translate = `0 ${height}px`;
      });
      table.dataset.fdFeedMarginValue = table.style.marginBottom || '';
      table.setAttribute('data-fd-feed-margin-active', '1');
      table.style.marginBottom = `${height}px`;
      return;
    }
    const list = visibleEvents(nativeRows);
    const groups = placement(nativeRows.map((row) => row.ts), list, 12);
    if (!groups.size) return;
    let inserted = 0;
    const appendBucket = (bucket, top) => {
      for (const event of bucket || []) {
        const card = buildDebotCard(event);
        card.classList.add('is-absolute'); card.style.top = `${top + inserted}px`;
        card.style.left = `${tableRect.left - scrollerRect.left + scroller.scrollLeft}px`;
        card.style.width = `${tableRect.width}px`; card.style.gridTemplateColumns = columns;
        scroller.appendChild(card); inserted += Math.max(46, card.scrollHeight);
      }
    };
    rowInfo.forEach((info, index) => {
      appendBucket(groups.get(`before:${index}`), info.top);
      info.row.dataset.fdFeedTranslate = info.row.style.translate || '';
      info.row.dataset.fdFeedShift = '1'; info.row.style.translate = `0 ${inserted}px`;
      appendBucket(groups.get(`after:${index}`), info.top + info.height);
    });
    table.dataset.fdFeedMarginValue = table.style.marginBottom || '';
    table.setAttribute('data-fd-feed-margin-active', '1'); table.style.marginBottom = `${inserted}px`;
  }

  function sidebarTimestamp(row, now = Date.now()) {
    const labels = [...row.querySelectorAll('[aria-label]')].map((node) => safeText(node.getAttribute('aria-label'), 24));
    const absolute = labels.find((value) => /^\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(value));
    if (absolute) {
      const match = absolute.match(/^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
      const current = new Date(now);
      let value = new Date(current.getFullYear(), Number(match[1]) - 1, Number(match[2]),
        Number(match[3]), Number(match[4]), Number(match[5])).getTime();
      if (value > now + 86_400_000) value = new Date(current.getFullYear() - 1, Number(match[1]) - 1,
        Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])).getTime();
      if (Number.isFinite(value)) return value;
    }
    const values = [...row.querySelectorAll('span, div')]
      .filter((node) => !node.children.length).map((node) => safeText(node.textContent, 12));
    const relative = values.find((value) => /^\d+(?:s|m|h|d)$/.test(value));
    const match = relative?.match(/^(\d+)(s|m|h|d)$/);
    return match ? now - Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] : 0;
  }

  function layoutDebotSidebar() {
    const root = document.querySelector('[data-edge-dock-panel="track"]');
    const scroller = root?.querySelector('[data-testid="virtuoso-scroller"]');
    const listRoot = scroller?.querySelector('[data-testid="virtuoso-item-list"]');
    if (!(scroller instanceof HTMLElement) || !(listRoot instanceof HTMLElement)) return;
    const rows = [...listRoot.querySelectorAll(':scope > [data-index][data-known-size]')]
      .filter((row) => row instanceof HTMLElement);
    if (!rows.length) return;
    const now = Date.now();
    const rowInfo = rows.map((row) => ({ row, ts: sidebarTimestamp(row, now) })).filter((item) => item.ts > 0);
    if (!rowInfo.length) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const listRect = listRoot.getBoundingClientRect();
    const rowHeight = Number(rows[0].dataset.knownSize) || rows[0].getBoundingClientRect().height || 67;
    if (!monitor.connected) {
      if (loginPromptDismissed) return;
      const prompt = buildLoginPrompt('sidebar');
      prompt.classList.add('is-absolute');
      prompt.style.top = `${rowInfo[0].row.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop}px`;
      prompt.style.left = `${listRect.left - scrollerRect.left + scroller.scrollLeft}px`;
      prompt.style.width = `${listRect.width}px`;
      scroller.appendChild(prompt);
      const height = Math.max(rowHeight, prompt.offsetHeight);
      rowInfo.forEach((info) => {
        info.row.dataset.fdFeedTranslate = info.row.style.translate || '';
        info.row.dataset.fdFeedShift = '1';
        info.row.style.translate = `0 ${height}px`;
      });
      listRoot.dataset.fdFeedMarginValue = listRoot.style.marginBottom || '';
      listRoot.setAttribute('data-fd-feed-margin-active', '1');
      listRoot.style.marginBottom = `${height}px`;
      return;
    }
    const list = visibleEvents([]);
    const groups = placement(rowInfo.map((item) => item.ts), list, 6);
    if (!groups.size) return;
    let inserted = 0;
    const appendBucket = (bucket, top) => {
      for (const event of bucket || []) {
        const card = buildDebotCard(event, 'sidebar');
        card.classList.add('is-absolute'); card.style.top = `${top + inserted}px`;
        card.style.left = `${listRect.left - scrollerRect.left + scroller.scrollLeft}px`;
        card.style.width = `${listRect.width}px`; scroller.appendChild(card);
        inserted += Math.max(rowHeight, card.scrollHeight);
      }
    };
    rowInfo.forEach((info, index) => {
      const baseTop = info.row.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop;
      appendBucket(groups.get(`before:${index}`), baseTop);
      info.row.dataset.fdFeedTranslate = info.row.style.translate || '';
      info.row.dataset.fdFeedShift = '1'; info.row.style.translate = `0 ${inserted}px`;
      appendBucket(groups.get(`after:${index}`), baseTop + rowHeight);
    });
    listRoot.dataset.fdFeedMarginValue = listRoot.style.marginBottom || '';
    listRoot.setAttribute('data-fd-feed-margin-active', '1'); listRoot.style.marginBottom = `${inserted}px`;
  }

  function render() {
    renderRaf = 0;
    teardown();
    if (!settings.fdFeedEnabled || document.visibilityState === 'hidden') return;
    if (location.hostname === 'gmgn.ai') layoutGmgn();
    else if (location.hostname === 'debot.ai') {
      layoutDebotTable();
      layoutDebotSidebar();
    }
  }

  function scheduleRender() {
    if (renderRaf) return;
    renderRaf = window.requestAnimationFrame(render);
  }

  function hasTrackingSurface() {
    if (location.hostname === 'gmgn.ai') {
      return Boolean(document.querySelector('[data-fd-feed-track-ts], [data-testid="follow-tracking-wallet-tab"], [data-testid="follow-tracking-tab"]'));
    }
    return location.pathname === '/track' || /^\/token\//.test(location.pathname);
  }

  async function poll(force = false) {
    if (!settings.fdFeedEnabled || pollInflight || !hasTrackingSurface()) return;
    if (!force && Date.now() - lastPollAt < POLL_MS) return;
    lastPollAt = Date.now(); pollInflight = true;
    try {
      const response = await runtimeMessage({ type: 'fomo-feed' });
      if (response?.ok) events = Array.isArray(response.events) ? response.events : [];
      else if (response?.reason === 'not-connected') events = [];
      scheduleRender();
    } finally { pollInflight = false; }
  }

  function publishSetting() {
    document.documentElement.setAttribute('data-fd-feed-enabled', settings.fdFeedEnabled ? '1' : '0');
    document.dispatchEvent(new Event('fd-feed-setting'));
  }

  function start() {
    chrome.storage.local.get({ ...DEFAULTS, monitorFomoConfig: null }, (stored) => {
      settings = { ...DEFAULTS, ...stored };
      loadMonitor(stored.monitorFomoConfig);
      publishSetting();
      if (settings.fdFeedEnabled) poll(true);
      scheduleRender();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.fdFeedEnabled) settings.fdFeedEnabled = changes.fdFeedEnabled.newValue === true;
      if (changes.fdFeedChainOnly) settings.fdFeedChainOnly = changes.fdFeedChainOnly.newValue === true;
      if (changes.fdFeedTypes) settings.fdFeedTypes = changes.fdFeedTypes.newValue || DEFAULTS.fdFeedTypes;
      if (changes.monitorFomoConfig) loadMonitor(changes.monitorFomoConfig.newValue);
      if (changes.fdFeedEnabled) loginPromptDismissed = false;
      publishSetting();
      if (settings.fdFeedEnabled) poll(true);
      else events = [];
      scheduleRender();
    });
    document.addEventListener('fd-feed-track-ready', scheduleRender);
    window.addEventListener('resize', scheduleRender, { passive: true });
    window.addEventListener('popstate', () => { scheduleRender(); poll(true); });
    document.addEventListener('scroll', (event) => {
      if (event.target instanceof Element && event.target.closest('[data-fd-feed-owned="1"]')) return;
      scheduleRender();
    }, true);
    observer = new MutationObserver((records) => {
      if (!settings.fdFeedEnabled) return;
      const changed = records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => {
        if (!(node instanceof Element)) return node.nodeType !== Node.TEXT_NODE;
        return !node.matches('[data-fd-feed-owned="1"]') && !node.closest('[data-fd-feed-owned="1"]');
      }));
      if (changed) scheduleRender();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(() => {
      if (document.visibilityState !== 'hidden') poll(false);
    }, 3000);
    window.setInterval(() => {
      document.querySelectorAll('[data-fd-feed-owned="1"] [class$="__time"]').forEach((time) => {
        const card = time.closest('[data-fd-feed-ts]');
        if (card) time.textContent = relativeTime(card.dataset.fdFeedTs);
      });
    }, 5000);
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
