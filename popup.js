'use strict';

const DEFAULTS = {
  fdEnabled: true,
  fdAutoOpen: false,
  fdShowPnl: true,
  fdRefreshSeconds: 30,
};

const elements = {
  enabled: document.querySelector('#enabled'),
  autoOpen: document.querySelector('#auto-open'),
  showPnl: document.querySelector('#show-pnl'),
  refresh: document.querySelector('#refresh-seconds'),
  statusDot: document.querySelector('#status-dot'),
  statusTitle: document.querySelector('#status-title'),
  statusNote: document.querySelector('#status-note'),
  openFomo: document.querySelector('#open-fomo'),
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

async function init() {
  const stored = await chrome.storage.local.get({ ...DEFAULTS, fomoToken: null });
  elements.enabled.checked = stored.fdEnabled;
  elements.autoOpen.checked = stored.fdAutoOpen;
  elements.showPnl.checked = stored.fdShowPnl;
  elements.refresh.value = String(stored.fdRefreshSeconds);
  elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
  renderSession(stored.fomoToken);
}

elements.enabled.addEventListener('change', () => {
  chrome.storage.local.set({ fdEnabled: elements.enabled.checked });
});

elements.autoOpen.addEventListener('change', () => {
  chrome.storage.local.set({ fdAutoOpen: elements.autoOpen.checked });
});

elements.showPnl.addEventListener('change', () => {
  chrome.storage.local.set({ fdShowPnl: elements.showPnl.checked });
});


elements.refresh.addEventListener('change', () => {
  chrome.storage.local.set({ fdRefreshSeconds: Number(elements.refresh.value) });
});

elements.openFomo.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://fomo.family/' });
});


elements.resetLayout.addEventListener('click', async () => {
  await chrome.storage.local.set({ fdPanelPos: {}, fdPanelOpen: {} });
  elements.resetLayout.textContent = '已重置';
  window.setTimeout(() => { elements.resetLayout.textContent = '重置浮窗位置'; }, 1200);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.fomoToken) renderSession(changes.fomoToken.newValue);
});

init().catch(() => {
  elements.statusTitle.textContent = '读取配置失败';
  elements.statusNote.textContent = '请重新打开插件面板。';
});
