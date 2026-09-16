(() => {
  'use strict';
  const DEFAULTS = { fdEnabled: true, fdShowHoldingShare: true, fdShowTrending: true, fdShowKolRank: true };
  let settings = { ...DEFAULTS };
  let settingsReady = false;
  let route = null;
  let headerState = { key: '', attemptedAt: 0, supply: 0, holders: null };
  let headerPending = '';
  let cardState = { key: '', holders: null };
  let monitorState = null;
  let monitorSession = null;
  let rankSnapshot = null;
  let rankAt = 0, rankBusy = false;
  let stopped = false;
  let hotMount = null, hotActive = false, hotAt = 0, hotBusy = false, hotResponse = null;
  let hotController = null;
  const norm = (s) => /^0x/i.test(String(s)) ? String(s).toLowerCase() : String(s);
  const keyOf = (r) => r ? `${r.chain}|${norm(r.address)}` : '';
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const message = async (value) => {
    try { return await chrome.runtime.sendMessage(value); }
    catch (error) { if (/context invalidated/i.test(String(error))) cleanup(); return null; }
  };

  function holdingSummary(values, supply) {
    if (!(Number.isFinite(supply) && supply > 0) || !Array.isArray(values) || !values.length) return null;
    let amount = 0, count = 0;
    const seen = new Set();
    for (const item of values) {
      const id = item?.user?.id || item?.userId || item?.user?.userHandle;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      // Only use explicitly human-readable units, never raw on-chain balances.
      let value = Number(item?.humanAmount ?? item?.human_amount);
      if (!Number.isFinite(value) || value < 0) {
        const usd = Number(item?.value), price = Number(item?.priceUsd ?? item?.price);
        value = usd >= 0 && price > 0 ? usd / price : NaN;
      }
      if (!Number.isFinite(value) || value < 0) continue;
      amount += value; count++;
    }
    const percent = amount / supply * 100;
    if (!count || !Number.isFinite(percent) || percent > 100 || percent < 0) return null;
    // Floor rather than round up: the displayed figure remains a lower bound.
    return { text: `FOMO ≥${(Math.floor(percent * 100) / 100).toFixed(2)}%`, count, amount, percent };
  }

  async function tokenSupply(r) {
    try {
      let response;
      if (r.platform === 'debot') {
        const url = new URL('/api/dashboard/token/detail', location.origin);
        url.searchParams.set('chain', r.chain === 'sol' ? 'solana' : r.chain);
        url.searchParams.set('token', r.address);
        response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(10_000) });
      } else {
        const resources = performance.getEntriesByType('resource');
        const source = resources.map((x) => { try { return new URL(x.name); } catch { return null; } })
          .find((x) => x?.origin === location.origin && x.pathname.startsWith('/api/') && x.searchParams.has('device_id'));
        if (!source) return 0;
        const url = new URL('/api/v1/mutil_window_token_info', location.origin);
        url.search = source.search;
        response = await fetch(url, { method: 'POST', credentials: 'include', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chain: r.chain, addresses: [r.address] }) });
      }
      if (!response.ok) return 0;
      const body = await response.json();
      if (![0, 200].includes(body?.code)) return 0;
      const token = r.platform === 'debot' ? body?.data?.pair : body?.data?.[0];
      const address = token?.tokenAddress || token?.address;
      if (address && norm(address) !== norm(r.address)) return 0;
      const supply = Number(r.platform === 'debot' ? token?.totalSupply : token?.total_supply);
      return Number.isFinite(supply) && supply > 0 ? supply : 0;
    } catch { return 0; }
  }

  function headerAnchor() {
    if (route?.platform !== 'gmgn') return null;
    // Match the reference: the address wrapper in the second header row,
    // not the symbol/name in the first row.
    const symbol = document.querySelector('#token-base-symbol[data-symbol], [data-testid="token-detail-symbol"]');
    const block = symbol?.parentElement?.parentElement?.parentElement?.parentElement;
    return block?.querySelector('#token-base-address[data-addr]')?.parentElement || null;
  }
  function paintHeader() {
    paintCardStats();
    let badge = document.querySelector('#fd-holding-share');
    const anchor = headerAnchor();
    const summary = settings.fdEnabled && settings.fdShowHoldingShare && keyOf(route) === headerState.key
      ? holdingSummary(headerState.holders?.items, headerState.supply) : null;
    if (!route || !anchor || !summary) { badge?.remove(); return; }
    const target = anchor;
    if (!badge) { badge = document.createElement('span'); badge.id = 'fd-holding-share'; badge.className = 'fd-root fd-holding-share'; }
    if (badge.previousElementSibling !== target) target.after(badge);
    setText(badge, summary.text);
    badge.title = `已统计 ${summary.count} 位前排持仓者${headerState.holders.total ? ` / 共 ${headerState.holders.total} 位` : ''}。\n占比为下界，不代表全体 FOMO 持仓。\n总供应量：${headerState.supply.toLocaleString()}${headerState.holders.stale ? '\n接口限流中，暂用上次数据。' : ''}`;
  }

  function renderHoldingStats(stats, r, holders) {
    const key = keyOf(r);
    if (cardState.key !== key) cardState = { key, holders: null };
    if (holders?.ok) cardState.holders = holders;
    if (stats.dataset.fdHoldingKey !== key) {
      stats.replaceChildren();
      stats.dataset.fdHoldingKey = key;
      for (const name of ['holders', 'share']) {
        const block = document.createElement('div'); block.className = 'fd-stat';
        block.dataset.fdHoldingStat = name;
        block.append(document.createElement('span'), document.createElement('strong'), document.createElement('small'));
        stats.append(block);
      }
    }
    paintCardStats();
  }

  function paintCardStats() {
    const stats = document.querySelector('.fd-stats[data-fd-holding-key]');
    const key = keyOf(route);
    if (!stats || stats.dataset.fdHoldingKey !== key) return;
    const holders = (cardState.key === key && cardState.holders) || (headerState.key === key && headerState.holders);
    const values = Array.isArray(holders?.items) ? holders.items : [];
    const total = Number(holders?.total) > 0 ? Number(holders.total) : values.length;
    const sumUsd = values.reduce((sum, item) => sum + (Number(item?.value) || 0), 0);
    const summary = headerState.key === key ? holdingSummary(values, headerState.supply) : null;
    const showShare = settings.fdShowHoldingShare;
    const rows = [
      ['holders', 'FOMO 持有人数', holders ? total.toLocaleString('zh-CN') : '—', holders ? `已加载 ${values.length} / ${total}` : '等待持仓数据'],
      ['share', showShare ? 'FOMO 持仓占比' : 'Top 持仓合计',
        showShare ? (summary?.text.replace(/^FOMO /, '') || '—') : (holders ? money(sumUsd) : '—'),
        showShare && holders ? `合计 ${money(sumUsd)}` : ''],
    ];
    for (const [name, label, value, sub] of rows) {
      const block = stats.querySelector(`[data-fd-holding-stat="${name}"]`);
      if (!block) continue;
      setText(block.querySelector('span'), label);
      setText(block.querySelector('strong'), value);
      setText(block.querySelector('small'), sub);
      block.title = name === 'share' && showShare
        ? summary ? '仅统计已加载的前排持仓者，≥ 表示占比下界。' : '缺少可靠持仓数量或总供应量，暂不显示占比。'
        : '';
    }
  }
  function syncHeader(next) {
    route = next;
    const key = keyOf(route);
    if (headerState.key !== key) headerState = { key, attemptedAt: 0, supply: 0, holders: null };
    paintHeader();
    if (!settingsReady || !key || !settings.fdEnabled || !settings.fdShowHoldingShare || stopped
      || document.visibilityState === 'hidden' || headerPending === key || Date.now() < headerState.attemptedAt + 120_000) return;
    headerPending = key; headerState.attemptedAt = Date.now();
    const r = route;
    Promise.all([message({ type: 'fomo-token-feed', payload: { tokenAddress: r.address, networkId: r.networkId, kind: 'holders' } }),
      headerState.supply || tokenSupply(r)]).then(([holders, supply]) => {
      if (stopped || key !== keyOf(route)) return;
      if (holders?.ok) headerState.holders = holders;
      if (supply > 0) headerState.supply = supply;
      if (holders?.retryAt) headerState.attemptedAt = Math.max(headerState.attemptedAt, holders.retryAt - 120_000);
      paintHeader();
    }).finally(() => { if (headerPending === key) headerPending = ''; });
  }

  const money = (v) => Number.isFinite(v) ? '$' + Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(v) : '—';
  function tokenLink(item, platform = location.hostname === 'debot.ai' ? 'debot' : 'gmgn') {
    if (!['eth', 'bsc', 'base', 'sol', 'monad', 'robinhood', 'arc'].includes(item.chain)
      || !(item.chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/).test(item.address)) return '';
    return platform === 'debot' ? `https://debot.ai/token/${item.chain === 'sol' ? 'solana' : item.chain}/${item.address}`
      : `https://gmgn.ai/${item.chain}/token/${item.address}`;
  }
  function renderTrending(list, values) {
    list.replaceChildren();
    if (!values.length) { const empty = document.createElement('p'); empty.className = 'fd-empty'; empty.textContent = '暂无 FOMO 热门代币'; list.append(empty); }
    values.forEach((item, i) => {
      const href = tokenLink(item); if (!href) return;
      const link = document.createElement('a'); link.className = 'fd-hot-token'; link.href = href;
      const rank = document.createElement('span'); rank.className = 'fd-hot-index'; rank.textContent = String(i + 1);
      const name = document.createElement('strong'); name.textContent = item.symbol || item.address.slice(0, 8);
      const chain = document.createElement('small'); chain.textContent = item.chain.toUpperCase();
      const title = document.createElement('span'); title.className = 'fd-hot-name'; title.append(name, chain);
      if (/^https:\/\//.test(item.image || '')) {
        const image = document.createElement('img'); image.src = item.image; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), { once: true }); title.prepend(image);
      }
      const cap = document.createElement('span'); cap.textContent = money(item.marketCap); cap.title = '市值';
      const change = document.createElement('span'); change.textContent = Number.isFinite(item.change24) ? `${item.change24 >= 0 ? '+' : ''}${(item.change24 * 100).toFixed(1)}%` : '—';
      change.className = item.change24 >= 0 ? 'is-up' : 'is-down'; change.title = '24 小时涨跌';
      link.title = `${item.symbol} · ${item.chain}\n价格 ${money(item.price)} · 24h 成交额 ${money(item.volume24)}\n点击查看代币（不会提交交易）`;
      link.append(rank, title, cap, change); list.append(link);
    });
  }

  function hideHot() {
    hotActive = false;
    if (hotMount) { hotMount.body.removeAttribute('data-fd-hot-hidden'); hotMount.panel.hidden = true; hotMount.button.setAttribute('aria-pressed', 'false'); }
  }
  function removeHot() {
    hideHot(); hotController?.abort(); hotController = null;
    hotMount?.button.remove(); hotMount?.panel.remove(); hotMount = null; hotResponse = null; hotAt = 0;
  }
  async function loadHot(force = false) {
    const mount = hotMount;
    if (!mount || !hotActive || hotBusy || (!force && Date.now() - hotAt < 120_000)) return;
    hotBusy = true; hotAt = Date.now();
    setText(mount.note, '正在读取 FOMO 热门…');
    const response = await message({ type: 'fomo-trending' }); hotBusy = false;
    if (hotMount !== mount || !hotActive) { if (hotActive && hotMount !== mount) loadHot(); return; }
    if (response?.retryAt) hotAt = Math.max(hotAt, response.retryAt - 120_000);
    if (response?.ok) {
      if (hotResponse?.fetchedAt !== response.fetchedAt) renderTrending(mount.list, response.items || []);
      hotResponse = response;
      setText(mount.note, response.stale ? '接口限流中，显示上次热门数据。' : 'FOMO 全网络热门 · 市值 / 24h 涨跌');
    } else setText(mount.note, ['expired', 'no-token'].includes(response?.reason)
      ? '请先在 FOMO 官网登录，然后再次打开。' : response?.reason === 'rate-limited' ? 'FOMO 请求受限，请稍后重试。' : '暂时无法读取热门，请稍后重试。');
  }
  function syncHot() {
    if (!settings.fdEnabled || !settings.fdShowTrending || location.hostname !== 'gmgn.ai') { removeHot(); return; }
    const legacy = [...document.querySelectorAll('[data-testid="filter-tag-trending"]')].find(x => x.getBoundingClientRect().width > 0);
    const native = legacy || (location.pathname === '/trend' && [...document.querySelectorAll('[role="tab"]')]
      .find(x => /^(热门|Trending)$/i.test(x.textContent.trim()) && x.getBoundingClientRect().width > 0));
    if (hotMount && (!hotMount.button.isConnected || hotMount.native !== native)) removeHot();
    if (!native || hotMount) return;
    const tabs = legacy ? native.parentElement : native.closest('.pi-tabs-nav-list');
    let main = legacy ? native.closest('[data-sentry-component="Main"]') : null;
    const table = document.querySelector('[data-testid="trend-trending-container"]');
    if (!main && tabs && table) {
      for (let node = tabs.parentElement, i = 0; node && i < 9; node = node.parentElement, i++) {
        if (node.contains(table)) { main = node; break; }
      }
    }
    const body = main && [...main.children].find(x => !x.contains(tabs) && (legacy ? x.getBoundingClientRect().height >= 80 : x.contains(table)));
    if (!body) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'fd-root fd-hot-tab'; button.textContent = 'FOMO 热门'; button.setAttribute('aria-pressed', 'false');
    const panel = document.createElement('section'); panel.className = 'fd-root fd-hot-panel'; panel.hidden = true;
    const bar = document.createElement('div'); bar.className = 'fd-hot-bar';
    const note = document.createElement('span');
    const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '刷新'; refresh.addEventListener('click', () => loadHot(true));
    const list = document.createElement('div'); list.className = 'fd-hot-list';
    bar.append(note, refresh); panel.append(bar, list); tabs.append(button); main.append(panel);
    hotMount = { native, body, button, panel, list, note };
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (hotActive) { hideHot(); return; }
      hotActive = true; body.setAttribute('data-fd-hot-hidden', '1'); panel.hidden = false;
      button.setAttribute('aria-pressed', 'true'); loadHot();
    });
    hotController = new AbortController();
    tabs.addEventListener('click', event => { if (!button.contains(event.target)) hideHot(); }, { capture: true, signal: hotController.signal });
  }

  function ranksAllowed() {
    return settings.fdEnabled && settings.fdShowKolRank && monitorState?.connected === true && Number(monitorSession?.expiresAt) > Date.now();
  }
  function paintRanks() {
    const snapshot = rankSnapshot;
    const allowed = ranksAllowed() && snapshot?.account === norm(monitorSession?.accountId)
      && snapshot.updatedAt > Date.now() - 86_400_000 && snapshot.updatedAt <= Date.now() + 60_000;
    const ranks = new Map(allowed ? (snapshot.ranks || []).map(x => [x[0], x]) : []);
    const boards = { all: '总榜', '30d': '月榜', '7d': '周榜', '24h': '日榜' };
    document.querySelectorAll('[data-fd-rank-handle]').forEach(host => {
      const row = ranks.get(host.dataset.fdRankHandle.toLowerCase().replace(/^@+/, ''));
      let badge = host.querySelector('.fd-kol-rank');
      if (!row || !boards[row[1]] || !Number.isInteger(row[2]) || row[2] <= 0) { badge?.remove(); return; }
      if (!badge) { badge = document.createElement('span'); badge.className = 'fd-kol-rank'; host.append(badge); }
      setText(badge, `${boards[row[1]]} #${row[2]}`);
      badge.title = `FOMO KOL ${boards[row[1]]}第 ${row[2]} 名 · 来源 985monitor\n更新于 ${new Date(snapshot.updatedAt).toLocaleString()}`;
    });
  }
  function tick() {
    if (stopped) return;
    syncHot(); paintRanks();
    if (document.visibilityState === 'hidden' || !ranksAllowed() || rankBusy || Date.now() - rankAt < 300_000
      || !document.querySelector('[data-fd-rank-handle]')) return;
    rankBusy = true; rankAt = Date.now();
    message({ type: 'fomo-ranks' }).finally(() => { rankBusy = false; });
  }
  function changes(value, area) {
    if (area !== 'local') return;
    for (const key of Object.keys(DEFAULTS)) if (value[key]) settings[key] = value[key].newValue ?? DEFAULTS[key];
    if (value.monitor985SyncStateV1) monitorState = value.monitor985SyncStateV1.newValue;
    if (value.monitor985SessionV1) { monitorSession = value.monitor985SessionV1.newValue; rankAt = 0; }
    if (value.fdShowKolRank) rankAt = 0;
    if (value.fdKolRanksV1) rankSnapshot = value.fdKolRanksV1.newValue;
    syncHeader(route); tick();
  }
  function cleanup() { stopped = true; clearInterval(timer); removeHot(); document.querySelector('#fd-holding-share')?.remove(); }
  window.FomoDockExtras = { syncHeader, renderTrending, renderHoldingStats, holdingSummary, tokenLink };
  let timer;
  chrome.storage.local.get({ ...DEFAULTS, monitor985SyncStateV1: null, monitor985SessionV1: null, fdKolRanksV1: null }).then(stored => {
    settings = { ...DEFAULTS, ...stored }; monitorState = stored.monitor985SyncStateV1;
    monitorSession = stored.monitor985SessionV1; rankSnapshot = stored.fdKolRanksV1;
    settingsReady = true;
    if (!stopped) { syncHeader(route); tick(); timer = setInterval(tick, 2000); }
  }).catch(() => {});
  chrome.storage.onChanged.addListener(changes);
  window.addEventListener('pagehide', cleanup, { once: true });
})();
