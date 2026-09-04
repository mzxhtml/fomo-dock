(() => {
  'use strict';

  if (window.__fomoDockContent) return;
  window.__fomoDockContent = true;

  const PLATFORM = location.hostname === 'debot.ai' ? 'debot'
    : location.hostname === 'gmgn.ai' ? 'gmgn' : '';
  if (!PLATFORM) return;
  const ICON_URL = chrome.runtime.getURL('icons/icon32.png');

  const DEFAULTS = {
    fdEnabled: true,
    fdFolded: false,
    fdRefreshSeconds: 30,
    fdShowPnl: true,
    fdTranslate: false,
    fdDisplayMode: 'tab',
    fdPanelOpen: {},
    fdPanelPos: {},
  };

  const NETWORK_IDS = {
    eth: 1,
    ethereum: 1,
    bsc: 56,
    bnb: 56,
    monad: 143,
    robinhood: 4663,
    base: 8453,
    sol: 1399811149,
    solana: 1399811149,
  };

  const CANONICAL_CHAIN = {
    ethereum: 'eth',
    bnb: 'bsc',
    solana: 'sol',
  };

  const FOMO_CHAIN = {
    bsc: 'bnb',
    eth: 'eth',
    base: 'base',
    sol: 'sol',
    robinhood: 'robinhood',
    monad: 'monad',
  };

  let settings = { ...DEFAULTS };
  let launcher = null;
  let panel = null;
  let gmgnButtonHost = null;
  let gmgnButton = null;
  let gmgnPreviousTabId = '';
  let debotButtonHost = null;
  let debotButton = null;
  let activeTab = 'holders';
  let loadedKey = '';
  let loading = false;
  let items = [];
  let refreshTimer = 0;
  let refreshResumeTimer = 0;
  let refreshPaused = false;
  let refreshPending = false;
  let routeTimer = 0;
  let currentRouteKey = '';
  let pnlObserver = null;
  let pnlActive = 0;
  const pnlQueue = [];
  const pnlCache = new Map();
  let translator = null;
  let translatorPromise = null;
  let translationRun = 0;
  const translationCache = new Map();
  let onchainBalances = { key: '', wallets: new Map(), signature: '' };
  function runtimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve({ ok: false, reason: 'runtime' });
          else resolve(response || { ok: false, reason: 'empty' });
        });
      } catch {
        resolve({ ok: false, reason: 'runtime' });
      }
    });
  }

  function cleanText(value, max = 1500) {
    return String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, max);
  }

  function validAddress(value) {
    return /^0x[a-fA-F0-9]{40}$/.test(value)
      || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  }

  function normalizeChain(chain) {
    const lower = cleanText(chain, 24).toLowerCase();
    return CANONICAL_CHAIN[lower] || lower;
  }

  function gmgnRoute() {
    const match = location.pathname.match(/^\/([a-z0-9_-]+)\/token\/([^/?#]+)/i);
    if (!match) return null;
    const chain = normalizeChain(match[1]);
    let address;
    try { address = decodeURIComponent(match[2]); } catch { address = match[2]; }
    if (!NETWORK_IDS[chain] || !validAddress(address)) return null;
    return { platform: PLATFORM, chain, address, networkId: NETWORK_IDS[chain] };
  }

  function debotRoute() {
    const match = location.pathname.match(/^\/token\/([a-z0-9_-]+)\/([^/?#]+)/i);
    if (!match) return null;
    const chain = normalizeChain(match[1]);
    if (!NETWORK_IDS[chain]) return null;
    let segment;
    try { segment = decodeURIComponent(match[2]); } catch { segment = match[2]; }
    const evm = segment.match(/(0x[a-fA-F0-9]{40})$/);
    const solana = segment.match(/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    const address = evm?.[1] || solana?.[1] || '';
    if (!validAddress(address)) return null;
    return { platform: PLATFORM, chain, address, networkId: NETWORK_IDS[chain] };
  }

  function tokenRoute() {
    return PLATFORM === 'debot' ? debotRoute() : gmgnRoute();
  }

  function routeKey(route = tokenRoute()) {
    return route ? `${route.platform}|${route.chain}|${route.address}` : '';
  }

  function isOpen() {
    return settings.fdPanelOpen?.[PLATFORM] === true;
  }

  function isEmbeddedMode() {
    return (PLATFORM === 'gmgn' || PLATFORM === 'debot')
      && settings.fdDisplayMode === 'tab';
  }

  function saveOpen(open) {
    settings.fdPanelOpen = { ...(settings.fdPanelOpen || {}), [PLATFORM]: open };
    chrome.storage.local.set({ fdPanelOpen: settings.fdPanelOpen }).catch(() => {});
  }

  function money(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number === 0) return '';
    const absolute = Math.abs(number);
    const compact = absolute >= 1e9 ? `${(absolute / 1e9).toFixed(1)}B`
      : absolute >= 1e6 ? `${(absolute / 1e6).toFixed(1)}M`
        : absolute >= 1e3 ? `${(absolute / 1e3).toFixed(1)}K`
          : absolute.toFixed(absolute >= 10 ? 0 : 2);
    return `${number < 0 ? '-' : ''}$${compact}`;
  }

  function price(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '';
    return number >= 1 ? `$${number.toFixed(2)}`
      : `$${number.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  }

  function relativeTime(value) {
    const timestamp = Number(new Date(value));
    if (!Number.isFinite(timestamp)) return '';
    const diff = Math.max(0, Date.now() - timestamp);
    if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}秒`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}时`;
    return `${Math.floor(diff / 86_400_000)}天`;
  }

  function deepPick(object, pattern, kind, depth = 0, seen = new Set()) {
    if (!object || typeof object !== 'object' || depth > 3 || seen.has(object)) return undefined;
    seen.add(object);
    const accept = (value) => {
      if (kind === 'number') {
        const number = Number(value);
        return Number.isFinite(number) && value !== '' && value !== true && value !== false ? number : undefined;
      }
      if (kind === 'url') {
        const text = cleanText(value, 500);
        return /^https?:\/\//i.test(text) ? text : undefined;
      }
      const text = typeof value === 'string' ? cleanText(value, 1500) : '';
      return text && !/^https?:\/\//i.test(text) ? text : undefined;
    };
    for (const [key, value] of Object.entries(object)) {
      if (!pattern.test(key)) continue;
      const found = accept(value);
      if (found !== undefined) return found;
    }
    for (const value of Object.values(object)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const found = deepPick(value, pattern, kind, depth + 1, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function userOf(item) {
    return item && typeof item.user === 'object' ? item.user : item || {};
  }

  function userName(item) {
    const user = userOf(item);
    return cleanText(user.userHandle || user.displayName
      || deepPick(item, /(username|handle|displayname|nickname)/i, 'string') || '匿名', 60);
  }

  function userHandle(item) {
    const user = userOf(item);
    const value = cleanText(user.userHandle || item?.userHandle, 100);
    if (!value) return '';
    const socialUrl = value.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i);
    return cleanText((socialUrl?.[1] || value).replace(/^@+/, ''), 60);
  }

  function twitterHandle(item) {
    const handle = userHandle(item);
    return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : '';
  }

  function userAvatar(item) {
    const user = userOf(item);
    const direct = cleanText(user.profilePictureLink || item?.profilePictureLink, 500);
    if (/^https?:\/\//i.test(direct)) return direct;
    return deepPick(item, /(profilepic|profileimage|avatar|picture|image|photo)/i, 'url') || '';
  }

  function isolateUserLink(link) {
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'touchstart']) {
      link.addEventListener(type, (event) => event.stopPropagation());
    }
    link.addEventListener('keydown', (event) => event.stopPropagation());
    return link;
  }

  function buildUserHeader(item, showTwitter = false) {
    const header = document.createElement('div');
    header.className = 'fd-item__header';
    const handle = userHandle(item);
    const profileUrl = handle
      ? `https://fomo.family/profile/${encodeURIComponent(handle)}` : '';
    const avatar = userAvatar(item);
    if (avatar) {
      const image = document.createElement('img');
      image.className = 'fd-avatar';
      image.src = avatar;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      if (profileUrl) {
        const avatarLink = isolateUserLink(document.createElement('a'));
        avatarLink.className = 'fd-avatar-link';
        avatarLink.href = profileUrl;
        avatarLink.target = '_blank';
        avatarLink.rel = 'noopener noreferrer';
        avatarLink.title = '在 FOMO 查看用户';
        avatarLink.appendChild(image);
        header.appendChild(avatarLink);
      } else {
        header.appendChild(image);
      }
    }
    const links = document.createElement('span');
    links.className = 'fd-user-links';
    const name = profileUrl
      ? isolateUserLink(document.createElement('a'))
      : document.createElement('strong');
    name.className = 'fd-item__name';
    name.textContent = userName(item);
    if (profileUrl) {
      name.href = profileUrl;
      name.target = '_blank';
      name.rel = 'noopener noreferrer';
      name.title = '在 FOMO 查看用户';
    }
    links.appendChild(name);
    const xHandle = showTwitter ? twitterHandle(item) : '';
    if (xHandle) {
      const twitter = isolateUserLink(document.createElement('a'));
      twitter.className = 'fd-twitter-link';
      twitter.href = `https://x.com/${encodeURIComponent(xHandle)}`;
      twitter.target = '_blank';
      twitter.rel = 'noopener noreferrer';
      twitter.title = `在 X 查看 @${xHandle}`;
      twitter.setAttribute('aria-label', twitter.title);
      twitter.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"/></svg>';
      links.appendChild(twitter);
    }
    header.appendChild(links);
    return header;
  }

  function holderTokenAmount(item) {
    const direct = Number(item?.humanAmount);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const found = deepPick(item, /^(human_?amount|token_?amount|amount|balance|quantity|qty|size)$/i, 'number');
    if (Number.isFinite(found) && found > 0) return found;
    const usd = Number(item?.value ?? deepPick(item, /(position|value|balance)(usd)?$/i, 'number'));
    const tokenPrice = Number(item?.priceUsd ?? item?.price
      ?? deepPick(item, /^(price|price_?usd|token_?price)$/i, 'number'));
    return usd > 0 && tokenPrice > 0 ? usd / tokenPrice : 0;
  }

  function refreshOnchainBalances() {
    if (PLATFORM !== 'gmgn') return false;
    const route = tokenRoute();
    if (!route) return false;
    const key = `${route.chain}|${route.address.toLowerCase()}`;
    const wallets = onchainBalances.key === key
      ? new Map(onchainBalances.wallets) : new Map();

    document.querySelectorAll('[data-testid="token-detail-holders-row"]').forEach((row, index) => {
      const balance = Number(row.getAttribute('data-fd-holder-balance'));
      if (!Number.isFinite(balance) || balance <= 0) return;
      const rawAddress = cleanText(row.getAttribute('data-fd-holder-address'), 64);
      const address = rawAddress.startsWith('0x') ? rawAddress.toLowerCase() : rawAddress;
      wallets.set(address || `visible-${index}-${balance}`, balance);
    });

    const signature = [...wallets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([address, balance]) => `${address}:${balance}`)
      .join('|');
    const changed = key !== onchainBalances.key || signature !== onchainBalances.signature;
    onchainBalances = { key, wallets, signature };
    return changed;
  }

  function onchainRank(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const route = tokenRoute();
    const key = route ? `${route.chain}|${route.address.toLowerCase()}` : '';
    if (!key || onchainBalances.key !== key) return null;
    const balances = [...onchainBalances.wallets.values()].sort((a, b) => b - a);
    if (!balances.length) return null;
    const firstNotAbove = balances.findIndex((balance) => balance <= amount);
    const rank = firstNotAbove < 0 ? balances.length + 1 : firstNotAbove + 1;
    const exact = amount >= balances[balances.length - 1];
    return { rank, exact, loaded: balances.length };
  }

  function buildRankBadge(amount) {
    const info = onchainRank(amount);
    if (!info) return null;
    const badge = document.createElement('span');
    badge.className = 'fd-rank-badge';
    if (info.exact) {
      badge.textContent = `链上#${info.rank}`;
      badge.classList.toggle('is-top', info.rank <= 10);
      badge.title = `按持币量估算，在 GMGN 已加载持有者中排第 ${info.rank} 名（已读取 ${info.loaded} 行）`;
    } else {
      badge.textContent = `#${info.loaded}+`;
      badge.classList.add('is-out');
      badge.title = `持币量低于 GMGN 已加载的 ${info.loaded} 行；滚动持有者列表可提高排名覆盖范围`;
    }
    return badge;
  }

  function syncRankBadges() {
    panel?.querySelectorAll('.fd-holder[data-fd-holder-amount]').forEach((row) => {
      const next = buildRankBadge(Number(row.dataset.fdHolderAmount));
      const current = row.querySelector('.fd-rank-badge');
      if (!next) {
        current?.remove();
        return;
      }
      if (current) {
        current.className = next.className;
        current.textContent = next.textContent;
        current.title = next.title;
        return;
      }
      const name = row.querySelector('.fd-item__name');
      (name?.closest('.fd-user-links') || name)?.insertAdjacentElement('afterend', next);
    });
  }

  const PNL_TIERS = [
    { icon: '💀', label: '重亏' },
    { icon: '🔴', label: '亏损' },
    { icon: '⚪', label: '持平' },
    { icon: '🟢', label: '盈利' },
    { icon: '🔥', label: '顶级' },
  ];

  function pnlTier(pnl, equity) {
    const amountTier = pnl >= 50_000 ? 4 : pnl >= 5_000 ? 3 : pnl > -5_000 ? 2 : pnl > -50_000 ? 1 : 0;
    if (!(equity > 100)) return amountTier;
    const rate = pnl / equity * 100;
    const rateTier = rate >= 30 ? 4 : rate >= 5 ? 3 : rate > -5 ? 2 : rate > -30 ? 1 : 0;
    return Math.min(amountTier, rateTier);
  }

  function paintPnl(element, response) {
    const pnl = response?.pnl == null ? NaN : Number(response.pnl);
    element.className = 'fd-pnl-badge';
    if (!response?.ok || !Number.isFinite(pnl)) {
      element.classList.add('is-none');
      element.textContent = '—';
      element.title = response?.reason === 'expired' ? 'FOMO 登录态已过期' : '暂无 7 日盈亏数据';
      return;
    }
    const equity = Number(response.equity) || 0;
    const tier = pnlTier(pnl, equity);
    const meta = PNL_TIERS[tier];
    const rate = equity > 100 ? pnl / equity * 100 : NaN;
    element.classList.add(`is-t${tier}`, pnl >= 0 ? 'is-up' : 'is-down');
    element.textContent = `${meta.icon} ${pnl >= 0 ? '+' : ''}${money(pnl) || '$0'}`;
    element.title = Number.isFinite(rate)
      ? `${meta.label} · 钱包 7 日盈亏 ${pnl >= 0 ? '+' : ''}${money(pnl)}（${rate > 0 ? '+' : ''}${rate.toFixed(1)}%）· 当前组合 ${money(equity) || '$0'}`
      : `${meta.label} · 钱包 7 日盈亏 ${pnl >= 0 ? '+' : ''}${money(pnl)}`;
  }

  function pumpPnlQueue() {
    while (pnlActive < 3 && pnlQueue.length) {
      const job = pnlQueue.shift();
      if (!job.element.isConnected) continue;
      const cached = pnlCache.get(job.userId);
      if (cached && Date.now() - cached.at < 10 * 60_000) {
        paintPnl(job.element, cached.data);
        continue;
      }
      pnlActive += 1;
      runtimeMessage({ type: 'fomo-user-pnl', payload: { userId: job.userId } })
        .then((response) => {
          pnlCache.set(job.userId, { at: Date.now(), data: response });
          while (pnlCache.size > 300) pnlCache.delete(pnlCache.keys().next().value);
          if (job.element.isConnected) paintPnl(job.element, response);
        })
        .finally(() => {
          pnlActive -= 1;
          pumpPnlQueue();
        });
    }
  }

  function observePnl(element, userId, root) {
    if (!settings.fdShowPnl || !userId) return;
    element.dataset.fdUserId = String(userId);
    if (!('IntersectionObserver' in window)) {
      pnlQueue.push({ element, userId: String(userId) });
      pumpPnlQueue();
      return;
    }
    if (!pnlObserver) {
      pnlObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          pnlQueue.push({ element: entry.target, userId: entry.target.dataset.fdUserId });
        }
        pumpPnlQueue();
      }, { root, rootMargin: '100px' });
    }
    pnlObserver.observe(element);
  }

  function hasForeignText(text) {
    return /[A-Za-zÀ-ɏ\u0370-\u052f\u0590-\u06ff\u0900-\u097f\u3040-\u30ff\uac00-\ud7af]/.test(
      String(text || '').replace(/https?:\/\/\S+/gi, '').replace(/\b0x[a-f\d]+\b/gi, ''),
    );
  }

  function paintTranslation(source, translated) {
    let node = source.nextElementSibling;
    if (!node?.classList.contains('fd-translation')) {
      node = document.createElement('p');
      node.className = 'fd-translation';
      source.after(node);
    }
    node.textContent = translated;
  }

  async function translatedText(raw) {
    if (translationCache.has(raw)) return translationCache.get(raw);
    try {
      const translated = cleanText(await translator.translate(raw), 2000);
      const result = translated && translated !== raw ? translated : '';
      translationCache.set(raw, result);
      while (translationCache.size > 500) translationCache.delete(translationCache.keys().next().value);
      return result;
    } catch {
      return '';
    }
  }

  async function translateVisible() {
    const root = panel;
    if (!root || !settings.fdTranslate || !translator) return;
    const run = ++translationRun;
    const targets = [...root.querySelectorAll('[data-fd-source]')]
      .filter((element) => !element.nextElementSibling?.classList.contains('fd-translation'))
      .map((element) => ({ element, raw: element.dataset.fdSource || element.textContent }))
      .filter(({ raw }) => hasForeignText(raw));
    if (!targets.length) return;

    const results = await Promise.all(targets.map(async ({ element, raw }) => ({
      element,
      translated: await translatedText(raw),
    })));
    if (run !== translationRun || panel !== root || !settings.fdTranslate) return;

    const list = root.querySelector('.fd-list');
    const listTop = list?.getBoundingClientRect().top || 0;
    const anchor = list
      ? [...list.querySelectorAll('.fd-item')].find((row) => row.getBoundingClientRect().bottom > listTop)
      : null;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - listTop : 0;

    window.requestAnimationFrame(() => {
      if (run !== translationRun || panel !== root || !settings.fdTranslate) return;
      for (const { element, translated } of results) {
        if (translated && element.isConnected) paintTranslation(element, translated);
      }
      if (list && anchor?.isConnected) {
        list.scrollTop += anchor.getBoundingClientRect().top - listTop - anchorOffset;
      }
    });
  }

  function startTranslator() {
    const api = globalThis.Translator;
    if (!api?.create) return null;
    if (!translatorPromise) {
      try {
        translatorPromise = api.create({ sourceLanguage: 'en', targetLanguage: 'zh' })
          .then((instance) => {
            translator = instance;
            return instance;
          })
          .catch(() => {
            // A first-time model download may require a user gesture. Leave the
            // promise retryable so clicking “译” can start it immediately.
            translatorPromise = null;
            return null;
          });
      } catch {
        translatorPromise = null;
        return null;
      }
    }
    return translatorPromise;
  }

  function translateWhenReady() {
    if (!settings.fdTranslate) return;
    if (translator) {
      translateVisible();
      return;
    }
    const pending = startTranslator();
    pending?.then((instance) => {
      if (instance && settings.fdTranslate) translateVisible();
    });
  }

  function addBodyText(row, text) {
    if (!text) return;
    const body = document.createElement('p');
    body.className = 'fd-item__text';
    body.textContent = text;
    body.dataset.fdSource = text;
    row.appendChild(body);
  }

  function renderHolders(list, values) {
    list.replaceChildren();
    pnlObserver?.disconnect();
    pnlObserver = null;
    pnlQueue.length = 0;
    if (!values.length) return renderEmpty(list, '暂无持仓者');

    for (const item of values.slice(0, 60)) {
      const row = document.createElement('article');
      row.className = 'fd-item fd-holder';
      row.dataset.fdHolderAmount = String(holderTokenAmount(item));
      const header = buildUserHeader(item, true);
      const rank = buildRankBadge(Number(row.dataset.fdHolderAmount));
      if (rank) header.appendChild(rank);
      const userId = userOf(item)?.id;
      if (settings.fdShowPnl && userId) {
        const badge = document.createElement('span');
        badge.className = 'fd-pnl-badge is-loading';
        badge.textContent = '…';
        header.appendChild(badge);
        observePnl(badge, userId, list);
      }
      row.appendChild(header);

      const metrics = document.createElement('div');
      metrics.className = 'fd-metrics';
      const value = Number(item?.value ?? deepPick(item, /(position|value|balance)(usd)?$/i, 'number'));
      const pnl = Number(item?.pnl ?? item?.realizedPnl ?? deepPick(item, /(pnl|profit)(usd)?$/i, 'number'));
      const basis = Number(item?.costBasis);
      const entry = Number(item?.averageEntryPrice ?? deepPick(item, /(entry|average).*(price)/i, 'number'));
      const rate = basis > 0 ? pnl / basis * 100 : NaN;
      const cells = [
        ['持仓', value > 0 ? money(value) : '—', ''],
        ['盈亏', Number.isFinite(pnl) && pnl !== 0
          ? `${pnl >= 0 ? '+' : ''}${money(pnl)}${Number.isFinite(rate) ? ` (${rate > 0 ? '+' : ''}${rate.toFixed(1)}%)` : ''}` : '—',
        Number.isFinite(pnl) ? (pnl >= 0 ? 'is-up' : 'is-down') : ''],
        ['均价', price(entry) || '—', ''],
      ];
      for (const [label, valueText, className] of cells) {
        const cell = document.createElement('span');
        cell.className = `fd-metric ${className}`.trim();
        cell.title = label;
        cell.textContent = valueText;
        metrics.appendChild(cell);
      }
      row.appendChild(metrics);

      const thesis = cleanText(item?.comment?.comment
        || deepPick(item, /(thesis|content|message|note|comment)/i, 'string'));
      addBodyText(row, thesis);
      list.appendChild(row);
    }
  }

  function renderItems(list, values, kind) {
    if (kind === 'holders') return renderHolders(list, values);
    list.replaceChildren();
    if (!values.length) return renderEmpty(list, kind === 'thesis' ? '还没有人发表观点' : '暂无交易');

    for (const item of values.slice(0, 50)) {
      const row = document.createElement('article');
      row.className = 'fd-item';
      const header = buildUserHeader(item);
      const trade = item?.authorTrade;
      const pnl = Number(trade
        ? (trade.closedAt ? trade.realizedPnlUsd : Number(trade.realizedPnlUsd || 0) + Number(trade.unrealizedPnlUsd || 0))
        : (item?.pnlChange ?? deepPick(item, /(pnl|profit)(usd)?$/i, 'number')));
      if (Number.isFinite(pnl) && pnl !== 0) {
        const value = document.createElement('span');
        value.className = `fd-item__pnl ${pnl >= 0 ? 'is-up' : 'is-down'}`;
        value.textContent = `${pnl >= 0 ? '+' : ''}${money(pnl)}`;
        header.appendChild(value);
      }
      const size = Number(trade?.usdValue
        ?? item?.positionUsd ?? deepPick(item, /(amount|size|value|position)(usd)?$/i, 'number'));
      if (Number.isFinite(size) && size > 0) {
        const amount = document.createElement('span');
        amount.className = 'fd-item__amount';
        amount.textContent = money(size);
        header.appendChild(amount);
      }
      const time = document.createElement('time');
      time.textContent = relativeTime(item?.createdAt || item?.timestamp || item?.createdTime || item?.time);
      header.appendChild(time);
      row.appendChild(header);
      const text = cleanText(item?.comment?.comment
        || deepPick(item, /(thesis|content|text|body|message|note)/i, 'string'));
      addBodyText(row, text);
      list.appendChild(row);
    }
  }

  function renderEmpty(list, message) {
    const empty = document.createElement('div');
    empty.className = 'fd-empty';
    empty.textContent = message;
    list.appendChild(empty);
  }

  function renderStats(response) {
    const stats = panel?.querySelector('.fd-stats');
    if (!stats) return;
    stats.replaceChildren();
    const count = activeTab === 'holders' && Number(response?.total) > 0
      ? Number(response.total) : Number(response?.count) || items.length;
    const totalValue = activeTab === 'holders'
      ? items.reduce((sum, item) => sum + (Number(item?.value) || 0), 0) : 0;
    const values = activeTab === 'holders'
      ? [['FOMO 持有人数', count.toLocaleString('zh-CN')], ['Top 持仓合计', money(totalValue) || '$0']]
      : [[activeTab === 'thesis' ? '观点' : '交易', `${count} 条`], ['更新', new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })]];
    for (const [label, value] of values) {
      const block = document.createElement('div');
      block.className = 'fd-stat';
      const labelNode = document.createElement('span');
      labelNode.textContent = label;
      const valueNode = document.createElement('strong');
      valueNode.textContent = value;
      block.append(labelNode, valueNode);
      stats.appendChild(block);
    }
  }

  function showError(list, response) {
    list.replaceChildren();
    const guide = document.createElement('div');
    guide.className = 'fd-guide';
    const reason = response?.reason || 'unknown';
    const needsLogin = reason === 'no-token' || reason === 'expired';
    const title = document.createElement('strong');
    title.textContent = needsLogin ? '需要同步 FOMO 登录态' : `加载失败（${cleanText(reason, 40)}）`;
    const note = document.createElement('p');
    if (reason === 'blocked') note.textContent = 'FOMO 风控暂时拒绝了请求，请稍后重试。';
    else if (reason === 'network') note.textContent = `网络请求失败：${cleanText(response?.message || '请检查网络', 100)}`;
    else if (needsLogin) note.textContent = '打开 FOMO，确认已经登录并刷新一次。本插件会自动读取登录态，无需复制令牌。';
    else note.textContent = cleanText(response?.message || '请稍后重试', 120);
    guide.append(title, note);
    if (needsLogin) {
      const link = document.createElement('a');
      link.href = 'https://fomo.family/';
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = '打开 FOMO 并登录 →';
      guide.appendChild(link);
    }
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试';
    retry.addEventListener('click', async () => {
      if (reason === 'expired') await runtimeMessage({ type: 'fomo-force-refresh' });
      loadedKey = '';
      loadData(true);
    });
    guide.appendChild(retry);
    list.appendChild(guide);
  }

  async function loadData(force = false, source = 'normal') {
    const route = tokenRoute();
    if (!route || !panel || loading) return;
    const backgroundRefresh = source === 'auto' || source === 'resume';
    if (source === 'auto' && refreshPaused) {
      refreshPending = true;
      syncRefreshPauseIndicator();
      return;
    }
    const key = `${activeTab}|${routeKey(route)}`;
    if (!force && loadedKey === key) return;
    loading = true;
    const list = panel.querySelector('.fd-list');
    if (!backgroundRefresh || !list.children.length) {
      list.replaceChildren();
      renderEmpty(list, '加载中…');
    }
    const response = await runtimeMessage({
      type: 'fomo-token-feed',
      payload: { tokenAddress: route.address, networkId: route.networkId, kind: activeTab },
    });
    loading = false;
    if (!panel || routeKey() !== routeKey(route)
      || `${activeTab}|${routeKey(route)}` !== key) return;
    if (source === 'auto' && refreshPaused) {
      refreshPending = true;
      syncRefreshPauseIndicator();
      return;
    }
    if (!response?.ok) return showError(list, response);
    loadedKey = key;
    items = Array.isArray(response.items) ? response.items : [];
    renderStats(response);
    renderItems(list, items, activeTab);
    translateWhenReady();
  }

  function positionPanel() {
    if (panel?.classList.contains('fd-panel--embedded')) return;
    const position = settings.fdPanelPos?.[PLATFORM];
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 160, position.x))}px`;
      panel.style.top = `${Math.max(8, Math.min(window.innerHeight - 60, position.y))}px`;
      panel.style.right = 'auto';
    }
  }

  function makeDraggable(handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a')) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originX = rect.left;
      originY = rect.top;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 160, originX + event.clientX - startX))}px`;
      panel.style.top = `${Math.max(8, Math.min(window.innerHeight - 60, originY + event.clientY - startY))}px`;
      panel.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const rect = panel.getBoundingClientRect();
      settings.fdPanelPos = {
        ...(settings.fdPanelPos || {}),
        [PLATFORM]: { x: Math.round(rect.left), y: Math.round(rect.top) },
      };
      chrome.storage.local.set({ fdPanelPos: settings.fdPanelPos }).catch(() => {});
    });
  }

  function syncFoldButton(root = panel) {
    if (!root) return;
    root.classList.toggle('is-folded', settings.fdFolded === true);
    const button = root.querySelector('.fd-fold');
    if (button) {
      button.textContent = settings.fdFolded ? '▣' : '▤';
      button.title = settings.fdFolded ? '展开' : '折叠';
    }
  }

  function syncRefreshPauseIndicator(root = panel) {
    if (!root) return;
    root.classList.toggle('is-refresh-paused', refreshPaused);
    const indicator = root.querySelector('.fd-refresh-pause');
    if (!indicator) return;
    const label = refreshPending
      ? '自动刷新已暂停，移开鼠标后立即更新'
      : '鼠标悬停中，自动刷新已暂停';
    indicator.title = label;
    indicator.setAttribute('aria-label', label);
  }

  function setRefreshPaused(paused, root = panel) {
    if (refreshResumeTimer) window.clearTimeout(refreshResumeTimer);
    refreshResumeTimer = 0;
    refreshPaused = paused;
    syncRefreshPauseIndicator(root);
    if (paused || !refreshPending) return;
    refreshResumeTimer = window.setTimeout(() => {
      refreshResumeTimer = 0;
      if (refreshPaused || !panel) return;
      refreshPending = false;
      syncRefreshPauseIndicator();
      loadData(true, 'resume');
    }, 150);
  }

  function buildPanel(embedded = false) {
    const root = document.createElement('section');
    root.className = `fd-root fd-panel fd-platform-${PLATFORM}${embedded ? ' fd-panel--embedded' : ''}`;
    root.dataset.platform = PLATFORM;

    const bar = document.createElement('header');
    bar.className = 'fd-bar';
    const brand = document.createElement('strong');
    brand.className = 'fd-brand';
    const brandIcon = document.createElement('img');
    brandIcon.src = ICON_URL;
    brandIcon.alt = '';
    brand.append(brandIcon, document.createTextNode('FOMO Dock'));
    const platform = document.createElement('span');
    platform.className = 'fd-platform';
    platform.textContent = PLATFORM === 'debot' ? 'DeBot' : 'GMGN';
    const tabs = document.createElement('nav');
    tabs.className = 'fd-tabs';
    for (const [id, label] of [['holders', '持仓'], ['thesis', '观点'], ['swaps', '交易']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.tab = id;
      button.textContent = label;
      button.classList.toggle('is-active', activeTab === id);
      button.addEventListener('click', () => {
        activeTab = id;
        root.querySelectorAll('.fd-tabs button').forEach((tab) => {
          tab.classList.toggle('is-active', tab.dataset.tab === id);
        });
        loadedKey = '';
        loadData(true);
      });
      tabs.appendChild(button);
    }

    const actions = document.createElement('div');
    actions.className = 'fd-actions';
    const refreshPause = document.createElement('span');
    refreshPause.className = 'fd-refresh-pause';
    refreshPause.setAttribute('role', 'status');
    refreshPause.setAttribute('aria-live', 'polite');
    refreshPause.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
    const translate = document.createElement('button');
    translate.type = 'button';
    translate.className = 'fd-translate';
    translate.textContent = '译';
    translate.title = globalThis.Translator ? '开启/关闭本地中文翻译' : '浏览器不支持内置翻译';
    translate.classList.toggle('is-active', settings.fdTranslate === true);
    translate.addEventListener('click', async () => {
      settings.fdTranslate = !settings.fdTranslate;
      translate.classList.toggle('is-active', settings.fdTranslate);
      // Translator.create 首次下载语言包时必须直接发生在用户点击调用栈中。
      const pendingTranslator = settings.fdTranslate ? startTranslator() : null;
      await chrome.storage.local.set({ fdTranslate: settings.fdTranslate }).catch(() => {});
      if (settings.fdTranslate) {
        await pendingTranslator;
        translateVisible();
      } else {
        translationRun += 1;
        panel?.querySelectorAll('.fd-translation').forEach((node) => node.remove());
      }
    });

    const external = document.createElement('a');
    external.className = 'fd-external';
    external.target = '_blank';
    external.rel = 'noreferrer';
    external.innerHTML = '<span>FOMO</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';
    external.title = '在 FOMO 官网打开';
    external.setAttribute('aria-label', external.title);
    const displayMode = document.createElement('button');
    displayMode.type = 'button';
    displayMode.className = 'fd-display-mode';
    displayMode.title = embedded ? '切换为浮窗' : '收回到页内';
    displayMode.setAttribute('aria-label', displayMode.title);
    displayMode.innerHTML = embedded
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="7" width="13" height="12" rx="2"/><path d="M8 7V5h12v11h-3M13 11h4v4M17 11l-5 5"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 15h16M12 7v5M9.5 9.5 12 12l2.5-2.5"/></svg>';
    displayMode.addEventListener('click', () => {
      settings.fdDisplayMode = embedded ? 'floating' : 'tab';
      chrome.storage.local.set({ fdDisplayMode: settings.fdDisplayMode }).catch(() => {});
      syncUi();
    });
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'fd-fold';
    fold.addEventListener('click', () => {
      settings.fdFolded = !settings.fdFolded;
      chrome.storage.local.set({ fdFolded: settings.fdFolded }).catch(() => {});
      syncFoldButton(root);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'fd-close';
    close.textContent = '×';
    close.title = '关闭';
    close.addEventListener('click', () => {
      saveOpen(false);
      syncUi();
    });
    actions.append(refreshPause, translate, external);
    if (PLATFORM === 'gmgn' || PLATFORM === 'debot') actions.append(displayMode);
    if (!embedded) actions.append(fold, close);
    bar.append(brand, platform, tabs, actions);

    const stats = document.createElement('div');
    stats.className = 'fd-stats';
    const list = document.createElement('div');
    list.className = 'fd-list';
    list.addEventListener('mouseenter', () => setRefreshPaused(true, root));
    list.addEventListener('mouseleave', () => setRefreshPaused(false, root));
    root.append(bar, stats, list);
    syncRefreshPauseIndicator(root);
    if (!embedded) {
      makeDraggable(bar);
      syncFoldButton(root);
    }
    return root;
  }

  function gmgnTabContext() {
    const devTab = document.querySelector('[role="tab"][id$="-tab-dev_token"]');
    if (!devTab?.parentElement) return null;
    const tabList = devTab.closest('[role="tablist"]') || devTab.parentElement;
    const devTabItem = devTab.parentElement;
    const prefix = devTab.id.replace(/-tab-dev_token$/, '');
    const nativePanels = [...document.querySelectorAll(`[id^="${prefix}-panel-"]`)]
      .filter((node) => !node.classList.contains('fd-panel--embedded'));
    const panelParent = nativePanels[0]?.parentElement
      || document.getElementById(`${prefix}-panel-fomo`)?.parentElement
      || null;
    return { devTab, devTabItem, tabList, prefix, nativePanels, panelParent };
  }

  function restoreGmgnPanels() {
    document.querySelectorAll('[data-fd-native-panel-hidden]').forEach((nativePanel) => {
      const original = nativePanel.dataset.fdNativePanelDisplay || '';
      if (original) nativePanel.style.display = original;
      else nativePanel.style.removeProperty('display');
      delete nativePanel.dataset.fdNativePanelHidden;
      delete nativePanel.dataset.fdNativePanelDisplay;
    });
  }

  function hideGmgnPanels(context) {
    context.nativePanels.forEach((nativePanel) => {
      if (!nativePanel.dataset.fdNativePanelHidden) {
        nativePanel.dataset.fdNativePanelHidden = '1';
        nativePanel.dataset.fdNativePanelDisplay = nativePanel.style.display || '';
      }
      nativePanel.style.setProperty('display', 'none', 'important');
    });
  }

  function deactivateGmgnButton({ restoreSelection = false } = {}) {
    restoreGmgnPanels();
    if (restoreSelection && gmgnPreviousTabId) {
      const previous = document.getElementById(gmgnPreviousTabId);
      if (previous?.isConnected) previous.click();
    }
    gmgnButtonHost?.remove();
    gmgnButtonHost = null;
    gmgnButton?.remove();
    gmgnButton = null;
    gmgnPreviousTabId = '';
  }

  function ensureGmgnButton(context) {
    if (!gmgnButton?.isConnected) {
      gmgnButtonHost?.remove();
      gmgnButtonHost = document.createElement('span');
      gmgnButtonHost.className = 'fd-root fd-gmgn-entry-host';

      gmgnButton = document.createElement('button');
      gmgnButton.type = 'button';
      gmgnButton.id = 'fd-gmgn-entry';
      gmgnButton.className = 'fd-root fd-gmgn-entry';
      gmgnButton.setAttribute('aria-controls', `${context.prefix}-panel-fomo`);
      gmgnButton.setAttribute('aria-pressed', 'false');
      gmgnButton.title = '打开或关闭 FOMO';
      gmgnButton.textContent = 'FOMO';

      // GMGN delegates tab interactions from the tab-list container. Keep every
      // pointer and keyboard event owned by this independent control so opening
      // FOMO cannot select, focus or otherwise activate a native GMGN tab.
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend']
        .forEach((type) => {
          gmgnButton.addEventListener(type, (event) => event.stopPropagation());
        });
      gmgnButton.addEventListener('keydown', (event) => event.stopPropagation());
      gmgnButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const selected = context.tabList.querySelector('[role="tab"][aria-selected="true"]');
        if (selected?.id) gmgnPreviousTabId = selected.id;
        saveOpen(!isOpen());
        syncUi();
      });
      gmgnButtonHost.appendChild(gmgnButton);

      // Insert after the complete native tab item. Putting the button after the
      // inner role="tab" node would leave it inside GMGN's clickable tab wrapper.
      context.devTabItem.insertAdjacentElement('afterend', gmgnButtonHost);
    }

    const { tabList } = context;
    if (tabList && tabList.dataset.fdGmgnListener !== '1') {
      tabList.dataset.fdGmgnListener = '1';
      tabList.addEventListener('click', (event) => {
        const targetTab = event.target.closest('[role="tab"]');
        if (!targetTab || !isEmbeddedMode()) return;
        saveOpen(false);
        window.setTimeout(() => {
          restoreGmgnPanels();
          teardownPanel();
          gmgnButton?.classList.remove('is-active');
          gmgnButton?.setAttribute('aria-pressed', 'false');
        });
      });
    }
  }

  function syncGmgnButton(route) {
    const context = gmgnTabContext();
    if (!context) {
      teardownPanel();
      return;
    }
    ensureGmgnButton(context);
    if (!isOpen()) {
      restoreGmgnPanels();
      if (panel?.classList.contains('fd-panel--embedded')) teardownPanel();
      gmgnButton.classList.remove('is-active');
      gmgnButton.setAttribute('aria-pressed', 'false');
      return;
    }

    const selectedNativeTab = context.tabList
      .querySelector('[role="tab"][aria-selected="true"]');
    if (gmgnPreviousTabId && selectedNativeTab?.id && selectedNativeTab.id !== gmgnPreviousTabId) {
      saveOpen(false);
      restoreGmgnPanels();
      teardownPanel();
      gmgnButton.classList.remove('is-active');
      gmgnButton.setAttribute('aria-pressed', 'false');
      gmgnPreviousTabId = selectedNativeTab.id;
      return;
    }
    if (!gmgnPreviousTabId && selectedNativeTab?.id) gmgnPreviousTabId = selectedNativeTab.id;
    gmgnButton.classList.add('is-active');
    gmgnButton.setAttribute('aria-pressed', 'true');
    hideGmgnPanels(context);

    if (!panel?.classList.contains('fd-panel--embedded') || !panel.isConnected) {
      teardownPanel();
      const latestContext = gmgnTabContext();
      if (!latestContext?.panelParent) return;
      panel = buildPanel(true);
      panel.id = `${latestContext.prefix}-panel-fomo`;
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-labelledby', gmgnButton.id);
      latestContext.panelParent.appendChild(panel);
      syncRefreshTimer();
    }
    panel.querySelector('.fd-external').href = `https://fomo.family/tokens/${FOMO_CHAIN[route.chain] || route.chain}/${encodeURIComponent(route.address)}`;
    loadData(false);
  }

  function debotTabContext() {
    const devTab = [...document.querySelectorAll('[role="tab"]')]
      .find((node) => /^\s*(?:开发者代币|Developer Tokens?)/i.test(node.textContent || ''));
    const tabList = devTab?.closest('[role="tablist"]');
    const tabsRoot = tabList?.parentElement?.parentElement;
    if (!devTab || !tabList || !tabsRoot) return null;
    const orderTab = [...tabList.querySelectorAll('[role="tab"]')]
      .find((node) => /^\s*(?:订单|Orders?)/i.test(node.textContent || ''));
    if (!orderTab) return null;

    // DeBot nests the MUI tabs in two one-child layout boxes. Their parent is
    // the complete toolbar row, whose following siblings are the native panel.
    let tabBox = tabsRoot;
    while (tabBox.parentElement?.children.length === 1) tabBox = tabBox.parentElement;
    const headerRow = tabBox.parentElement;
    const panelParent = headerRow?.parentElement;
    if (!headerRow || !panelParent || !headerRow.contains(tabsRoot)) return null;
    const nativePanels = [...panelParent.children]
      .filter((node) => node !== headerRow && !node.classList.contains('fd-panel--embedded'));
    if (!nativePanels.length) return null;
    return { orderTab, tabList, headerRow, nativePanels, panelParent };
  }

  function restoreDebotPanels() {
    document.querySelectorAll('[data-fd-debot-panel-hidden]').forEach((nativePanel) => {
      const original = nativePanel.dataset.fdDebotPanelDisplay || '';
      if (original) nativePanel.style.display = original;
      else nativePanel.style.removeProperty('display');
      delete nativePanel.dataset.fdDebotPanelHidden;
      delete nativePanel.dataset.fdDebotPanelDisplay;
    });
  }

  function hideDebotPanels(context) {
    context.nativePanels.forEach((nativePanel) => {
      if (!nativePanel.dataset.fdDebotPanelHidden) {
        nativePanel.dataset.fdDebotPanelHidden = '1';
        nativePanel.dataset.fdDebotPanelDisplay = nativePanel.style.display || '';
      }
      nativePanel.style.setProperty('display', 'none', 'important');
    });
  }

  function deactivateDebotButton() {
    restoreDebotPanels();
    debotButtonHost?.remove();
    document.querySelectorAll('.fd-debot-entry-anchor')
      .forEach((node) => node.classList.remove('fd-debot-entry-anchor'));
    debotButtonHost = null;
    debotButton?.remove();
    debotButton = null;
  }

  function positionDebotButton(context) {
    if (!debotButtonHost?.isConnected || !context?.headerRow || !context.orderTab) return;
    const headerRect = context.headerRow.getBoundingClientRect();
    const orderRect = context.orderTab.getBoundingClientRect();
    const label = context.orderTab.firstElementChild || context.orderTab;
    const labelRect = label.getBoundingClientRect();
    const labelStyle = getComputedStyle(label);
    const paddingTop = Number.parseFloat(labelStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(labelStyle.paddingBottom) || 0;
    const visualTop = labelRect.top + paddingTop;
    const visualBottom = labelRect.bottom - paddingBottom;
    const visualCenter = (visualTop + visualBottom) / 2;
    const buttonHeight = debotButtonHost.getBoundingClientRect().height || 27;
    debotButtonHost.style.left = `${orderRect.right - headerRect.left + 14}px`;
    debotButtonHost.style.top = `${visualCenter - headerRect.top - buttonHeight / 2}px`;
  }

  function ensureDebotButton(context) {
    if (!debotButton?.isConnected || debotButtonHost?.parentElement !== context.headerRow) {
      debotButtonHost?.remove();
      document.querySelectorAll('.fd-debot-entry-anchor')
        .forEach((node) => node.classList.remove('fd-debot-entry-anchor'));
      context.headerRow.classList.add('fd-debot-entry-anchor');
      debotButtonHost = document.createElement('span');
      debotButtonHost.className = 'fd-root fd-debot-entry-host';

      debotButton = document.createElement('button');
      debotButton.type = 'button';
      debotButton.id = 'fd-debot-entry';
      debotButton.className = 'fd-root fd-debot-entry';
      debotButton.setAttribute('aria-controls', 'fd-debot-panel-fomo');
      debotButton.setAttribute('aria-pressed', 'false');
      debotButton.title = '打开或关闭 FOMO';
      debotButton.textContent = 'FOMO';

      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend']
        .forEach((type) => {
          debotButton.addEventListener(type, (event) => event.stopPropagation());
        });
      debotButton.addEventListener('keydown', (event) => event.stopPropagation());
      debotButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        saveOpen(!isOpen());
        syncUi();
      });
      debotButtonHost.appendChild(debotButton);
      context.headerRow.appendChild(debotButtonHost);
    }
    positionDebotButton(context);

    if (context.tabList.dataset.fdDebotListener !== '1') {
      context.tabList.dataset.fdDebotListener = '1';
      context.tabList.addEventListener('click', (event) => {
        const targetTab = event.target.closest?.('[role="tab"]');
        if (!targetTab || PLATFORM !== 'debot' || !isEmbeddedMode()) return;
        saveOpen(false);
        window.setTimeout(() => {
          restoreDebotPanels();
          teardownPanel();
          debotButton?.classList.remove('is-active');
          debotButton?.setAttribute('aria-pressed', 'false');
        });
      });
    }
  }

  function syncDebotButton(route) {
    const context = debotTabContext();
    if (!context) {
      restoreDebotPanels();
      teardownPanel();
      return;
    }
    ensureDebotButton(context);
    if (!isOpen()) {
      restoreDebotPanels();
      if (panel?.classList.contains('fd-panel--embedded')) teardownPanel();
      debotButton.classList.remove('is-active');
      debotButton.setAttribute('aria-pressed', 'false');
      return;
    }

    debotButton.classList.add('is-active');
    debotButton.setAttribute('aria-pressed', 'true');
    hideDebotPanels(context);

    if (!panel?.classList.contains('fd-panel--embedded') || !panel.isConnected) {
      teardownPanel();
      const latestContext = debotTabContext();
      if (!latestContext?.panelParent) return;
      hideDebotPanels(latestContext);
      panel = buildPanel(true);
      panel.id = 'fd-debot-panel-fomo';
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-labelledby', debotButton.id);
      latestContext.panelParent.appendChild(panel);
      syncRefreshTimer();
    }
    panel.querySelector('.fd-external').href = `https://fomo.family/tokens/${FOMO_CHAIN[route.chain] || route.chain}/${encodeURIComponent(route.address)}`;
    loadData(false);
  }

  function teardownPanel() {
    translationRun += 1;
    pnlObserver?.disconnect();
    pnlObserver = null;
    panel?.remove();
    panel = null;
    loadedKey = '';
    items = [];
    refreshPaused = false;
    refreshPending = false;
    if (refreshResumeTimer) window.clearTimeout(refreshResumeTimer);
    refreshResumeTimer = 0;
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = 0;
  }

  function syncRefreshTimer() {
    if (refreshTimer) window.clearInterval(refreshTimer);
    const seconds = Math.max(15, Math.min(300, Number(settings.fdRefreshSeconds) || 30));
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadData(true, 'auto');
      }
    }, seconds * 1000);
  }

  function syncUi() {
    const route = tokenRoute();
    if (!settings.fdEnabled || !route) {
      launcher?.remove();
      launcher = null;
      teardownPanel();
      deactivateGmgnButton({ restoreSelection: true });
      deactivateDebotButton();
      return;
    }

    if (isEmbeddedMode()) {
      launcher?.remove();
      launcher = null;
      if (panel && !panel.classList.contains('fd-panel--embedded')) teardownPanel();
      if (PLATFORM === 'gmgn') syncGmgnButton(route);
      else syncDebotButton(route);
      return;
    }

    deactivateGmgnButton({ restoreSelection: true });
    deactivateDebotButton();
    if (panel?.classList.contains('fd-panel--embedded')) teardownPanel();

    if (!launcher) {
      launcher = document.createElement('button');
      launcher.type = 'button';
      launcher.className = `fd-root fd-launcher fd-platform-${PLATFORM}`;
      const launcherIcon = document.createElement('img');
      launcherIcon.src = ICON_URL;
      launcherIcon.alt = '';
      const launcherLabel = document.createElement('b');
      launcherLabel.textContent = 'FOMO';
      launcher.append(launcherIcon, launcherLabel);
      launcher.title = '打开 FOMO Dock';
      launcher.addEventListener('click', () => {
        saveOpen(!isOpen());
        syncUi();
      });
      document.body.appendChild(launcher);
    }
    launcher.classList.toggle('is-active', isOpen());

    if (!isOpen()) {
      teardownPanel();
      return;
    }

    if (!panel) {
      panel = buildPanel();
      document.body.appendChild(panel);
      positionPanel();
      syncRefreshTimer();
    }
    const external = panel.querySelector('.fd-external');
    external.href = `https://fomo.family/tokens/${FOMO_CHAIN[route.chain] || route.chain}/${encodeURIComponent(route.address)}`;
    loadData(false);
  }

  function checkRoute() {
    const next = routeKey();
    if (next !== currentRouteKey) {
      currentRouteKey = next;
      loadedKey = '';
      teardownPanel();
    }
    const ranksChanged = refreshOnchainBalances();
    if (ranksChanged && activeTab === 'holders' && panel && items.length) {
      syncRankBadges();
    }
    syncUi();
  }

  chrome.storage.local.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    currentRouteKey = routeKey();
    refreshOnchainBalances();
    syncUi();
    translateWhenReady();
    routeTimer = window.setInterval(checkRoute, 1000);
  }).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let refreshChanged = false;
    let translateChanged = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = change.newValue ?? DEFAULTS[key];
      if (key === 'fdRefreshSeconds') refreshChanged = true;
      if (key === 'fdTranslate') translateChanged = true;
      if (key === 'fomoToken') loadedKey = '';
    }
    syncUi();
    if (translateChanged && settings.fdTranslate) translateWhenReady();
    if (refreshChanged && panel) syncRefreshTimer();
  });

  window.addEventListener('resize', () => {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    if (rect.right > window.innerWidth || rect.bottom > window.innerHeight) positionPanel();
  }, { passive: true });

  window.addEventListener('pagehide', () => {
    if (routeTimer) window.clearInterval(routeTimer);
    if (refreshTimer) window.clearInterval(refreshTimer);
  }, { once: true });
})();
