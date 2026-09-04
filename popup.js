'use strict';

const DEFAULTS = {
  fdEnabled: true,
  fdShowPnl: true,
  fdRefreshSeconds: 30,
  fdFeedEnabled: false,
};

const elements = {
  enabled: document.querySelector('#enabled'),
  showPnl: document.querySelector('#show-pnl'),
  feedEnabled: document.querySelector('#feed-enabled'),
  feedNote: document.querySelector('#feed-note'),
  refresh: document.querySelector('#refresh-seconds'),
  statusDot: document.querySelector('#status-dot'),
  statusTitle: document.querySelector('#status-title'),
  statusNote: document.querySelector('#status-note'),
  openFomo: document.querySelector('#open-fomo'),
  openMonitor: document.querySelector('#open-monitor'),
  resetLayout: document.querySelector('#reset-layout'),
  version: document.querySelector('#version'),
};

function formatExpiry(expiry) {
  const left = Number(expiry) - Date.now();
  if (!Number.isFinite(left) || left <= 0) return '登录态已过期，请重新打开 FOMO';
  const minutes = Math.max(1, Math.round(left / 60_000));
  return minutes >= 60 ? `约 ${Math.round(minutes / 60)} 小时后更新` : `约 ${minutes} 分钟后更新`;
}

function renderSession(token) {
  elements.statusDot.className = 'status-dot';
  if (!token?.token) {
    elements.statusDot.classList.add('is-bad');
    elements.statusTitle.textContent = '尚未连接 FOMO';
    elements.statusNote.textContent = '打开 FOMO 登录并刷新一次即可自动同步。';
    return;
  }
  const valid = Number(token.exp) > Date.now();
  elements.statusDot.classList.add(valid ? 'is-ok' : 'is-bad');
  elements.statusTitle.textContent = valid ? 'FOMO 已连接' : 'FOMO 登录态已过期';
  elements.statusNote.textContent = formatExpiry(token.exp);
}

function renderMonitor(state) {
  const connected = state?.connected === true;
  elements.feedNote.textContent = connected
    ? `已连接 ${state.displayName || '985monitor'}；按网页关注与屏蔽配置过滤`
    : '默认关闭；开启前请先登录一次 985monitor';
  elements.openMonitor.textContent = connected ? '打开 985monitor' : '连接 985monitor';
}

async function init() {
  const stored = await chrome.storage.local.get({
    ...DEFAULTS, fomoToken: null, monitor985SyncStateV1: null,
  });
  elements.enabled.checked = stored.fdEnabled;
  elements.showPnl.checked = stored.fdShowPnl;
  elements.feedEnabled.checked = stored.fdFeedEnabled;
  elements.refresh.value = String(stored.fdRefreshSeconds);
  elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
  renderSession(stored.fomoToken);
  renderMonitor(stored.monitor985SyncStateV1);
}

elements.enabled.addEventListener('change', () => {
  chrome.storage.local.set({ fdEnabled: elements.enabled.checked });
});

elements.showPnl.addEventListener('change', () => {
  chrome.storage.local.set({ fdShowPnl: elements.showPnl.checked });
});

elements.feedEnabled.addEventListener('change', () => {
  chrome.storage.local.set({ fdFeedEnabled: elements.feedEnabled.checked });
});


elements.refresh.addEventListener('change', () => {
  chrome.storage.local.set({ fdRefreshSeconds: Number(elements.refresh.value) });
});

elements.openFomo.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://fomo.family/' });
});

elements.openMonitor.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.985monitor.xyz/' });
});


elements.resetLayout.addEventListener('click', async () => {
  await chrome.storage.local.set({ fdPanelPos: {}, fdPanelOpen: {} });
  elements.resetLayout.textContent = '已重置';
  window.setTimeout(() => { elements.resetLayout.textContent = '重置显示状态'; }, 1200);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.fomoToken) renderSession(changes.fomoToken.newValue);
  if (changes.monitor985SyncStateV1) renderMonitor(changes.monitor985SyncStateV1.newValue);
});

init().catch(() => {
  elements.statusTitle.textContent = '读取配置失败';
  elements.statusNote.textContent = '请重新打开插件面板。';
});
