(() => {
  'use strict';

  if (window.__fomoDockContent) return;
  window.__fomoDockContent = true;

  const PLATFORM = location.hostname === 'debot.ai' ? 'debot'
    : location.hostname === 'gmgn.ai' ? 'gmgn' : '';
  if (!PLATFORM) return;

  const DEFAULTS = {
    fdEnabled: true,
    fdAutoOpen: false,
    fdFolded: false,
    fdRefreshSeconds: 30,
    fdShowPnl: true,
    fdTranslate: false,
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
  let activeTab = 'holders';
  let loadedKey = '';
  let loading = false;
  let items = [];
  let refreshTimer = 0;
  let routeTimer = 0;
  let currentRouteKey = '';
  let pnlObserver = null;
  let pnlActive = 0;
  const pnlQueue = [];
  const pnlCache = new Map();
  let translator = null;
  let translatorPromise = null;
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
    return settings.fdPanelOpen?.[PLATFORM] === true
      || (settings.fdPanelOpen?.[PLATFORM] == null && settings.fdAutoOpen === true);
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

  function userAvatar(item) {
    const user = userOf(item);
    const direct = cleanText(user.profilePictureLink || item?.profilePictureLink, 500);
    if (/^https?:\/\//i.test(direct)) return direct;
    return deepPick(item, /(profilepic|profileimage|avatar|picture|image|photo)/i, 'url') || '';
  }

  function buildUserHeader(item) {
    const header = document.createElement('div');
    header.className = 'fd-item__header';
    const avatar = userAvatar(item);
    if (avatar) {
      const image = document.createElement('img');
      image.className = 'fd-avatar';
      image.src = avatar;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      header.appendChild(image);
    }
    const name = document.createElement('strong');
    name.className = 'fd-item__name';
    name.textContent = userName(item);
    header.appendChild(name);
    return header;
  }

  function paintPnl(element, response) {
    const pnl = Number(response?.pnl);
    element.className = 'fd-pnl-badge';
    if (!response?.ok || !Number.isFinite(pnl)) {
      element.textContent = '—';
      element.title = '暂无 7 日盈亏数据';
      return;
    }
    element.classList.add(pnl >= 0 ? 'is-up' : 'is-down');
    element.textContent = `${pnl >= 0 ? '+' : ''}${money(pnl) || '$0'}`;
    element.title = `7 日盈亏 · 组合 ${money(response.equity) || '—'}`;
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
    if (!settings.fdShowPnl || !userId || !('IntersectionObserver' in window)) return;
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
    element.dataset.fdUserId = String(userId);
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

  async function translateElement(element) {
    const raw = element.dataset.fdSource || element.textContent;
    if (!settings.fdTranslate || !translator || !hasForeignText(raw)) return;
    try {
      const translated = cleanText(await translator.translate(raw), 2000);
      if (translated && translated !== raw && element.isConnected) paintTranslation(element, translated);
    } catch {
      // Keep the original text when the browser model cannot translate it.
    }
  }

  function translateVisible() {
    panel?.querySelectorAll('[data-fd-source]').forEach((element) => translateElement(element));
  }

  function startTranslatorFromGesture() {
    const api = globalThis.Translator;
    if (!api?.create) return null;
    if (!translatorPromise) {
      try {
        translatorPromise = api.create({ sourceLanguage: 'en', targetLanguage: 'zh' })
          .then((instance) => {
            translator = instance;
            return instance;
          })
          .catch(() => null);
      } catch {
        translatorPromise = Promise.resolve(null);
      }
    }
    return translatorPromise;
  }

  function addBodyText(row, text) {
    if (!text) return;
    const body = document.createElement('p');
    body.className = 'fd-item__text';
    body.textContent = text;
    body.dataset.fdSource = text;
    row.appendChild(body);
    if (settings.fdTranslate && translator) translateElement(body);
  }

  function renderHolders(list, values) {
    list.replaceChildren();
    pnlObserver?.disconnect();
    pnlObserver = null;
    if (!values.length) return renderEmpty(list, '暂无持仓者');

    for (const item of values.slice(0, 60)) {
      const row = document.createElement('article');
      row.className = 'fd-item fd-holder';
      const header = buildUserHeader(item);
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

  async function loadData(force = false) {
    const route = tokenRoute();
    if (!route || !panel || loading) return;
    const key = `${activeTab}|${routeKey(route)}`;
    if (!force && loadedKey === key) return;
    loading = true;
    const list = panel.querySelector('.fd-list');
    list.replaceChildren();
    renderEmpty(list, '加载中…');
    const response = await runtimeMessage({
      type: 'fomo-token-feed',
      payload: { tokenAddress: route.address, networkId: route.networkId, kind: activeTab },
    });
    loading = false;
    if (!panel || routeKey() !== routeKey(route)) return;
    if (!response?.ok) return showError(list, response);
    loadedKey = key;
    items = Array.isArray(response.items) ? response.items : [];
    renderStats(response);
    renderItems(list, items, activeTab);
  }

  function positionPanel() {
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

  function buildPanel() {
    const root = document.createElement('section');
    root.className = `fd-root fd-panel fd-platform-${PLATFORM}`;
    root.dataset.platform = PLATFORM;

    const bar = document.createElement('header');
    bar.className = 'fd-bar';
    const brand = document.createElement('strong');
    brand.className = 'fd-brand';
    brand.textContent = 'FOMO Dock';
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
      const pendingTranslator = settings.fdTranslate ? startTranslatorFromGesture() : null;
      await chrome.storage.local.set({ fdTranslate: settings.fdTranslate }).catch(() => {});
      if (settings.fdTranslate) {
        await pendingTranslator;
        translateVisible();
      } else {
        panel?.querySelectorAll('.fd-translation').forEach((node) => node.remove());
      }
    });

    const external = document.createElement('a');
    external.className = 'fd-external';
    external.target = '_blank';
    external.rel = 'noreferrer';
    external.textContent = '↗';
    external.title = '在 FOMO 打开';
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
    actions.append(translate, external, fold, close);
    bar.append(brand, platform, tabs, actions);

    const stats = document.createElement('div');
    stats.className = 'fd-stats';
    const list = document.createElement('div');
    list.className = 'fd-list';
    root.append(bar, stats, list);
    makeDraggable(bar);
    syncFoldButton(root);
    return root;
  }

  function teardownPanel() {
    pnlObserver?.disconnect();
    pnlObserver = null;
    panel?.remove();
    panel = null;
    loadedKey = '';
    items = [];
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = 0;
  }

  function syncRefreshTimer() {
    if (refreshTimer) window.clearInterval(refreshTimer);
    const seconds = Math.max(15, Math.min(300, Number(settings.fdRefreshSeconds) || 30));
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadedKey = '';
        loadData(true);
      }
    }, seconds * 1000);
  }

  function syncUi() {
    const route = tokenRoute();
    if (!settings.fdEnabled || !route) {
      launcher?.remove();
      launcher = null;
      teardownPanel();
      return;
    }

    if (!launcher) {
      launcher = document.createElement('button');
      launcher.type = 'button';
      launcher.className = `fd-root fd-launcher fd-platform-${PLATFORM}`;
      launcher.innerHTML = '<span>F</span><b>FOMO</b>';
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
    syncUi();
  }

  chrome.storage.local.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    currentRouteKey = routeKey();
    syncUi();
    routeTimer = window.setInterval(checkRoute, 1000);
  }).catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let refreshChanged = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = change.newValue ?? DEFAULTS[key];
      if (key === 'fdRefreshSeconds') refreshChanged = true;
      if (key === 'fomoToken') loadedKey = '';
    }
    syncUi();
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
