const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const source = readFileSync(resolve(__dirname, '../extras.js'), 'utf8');
const context = vm.createContext({ window: {}, console });
vm.runInContext(source.replace('  let timer;', '  return;\n  let timer;'), context);
const { holdingSummary, tokenLink } = context.window.FomoDockExtras;

test('holding percentage is a floored lower bound, deduped and never inferred from raw balance', () => {
  const summary = holdingSummary([{ userId: 'a', humanAmount: 123.456 }, { userId: 'a', humanAmount: 123.456 }, { userId: 'b', value: 10, priceUsd: 2 }, { balance: 1000000000000000000 }], 1000);
  assert.equal(summary.text, 'FOMO ≥12.84%');
  assert.equal(summary.count, 2);
  assert.equal(holdingSummary([{ humanAmount: 101 }], 100), null);
  assert.equal(holdingSummary([{ humanAmount: 1 }], 0), null);
  assert.equal(holdingSummary([{ balance: 1 }], 100), null);
  assert.equal(holdingSummary([], 100), null);
});

test('hot token links are network-aware and reject malformed routes', () => {
  const address = '0x' + 'a'.repeat(40);
  assert.equal(tokenLink({ chain: 'arc', address }, 'gmgn'), `https://gmgn.ai/arc/token/${address}`);
  assert.equal(tokenLink({ chain: 'arc', address }, 'debot'), `https://debot.ai/token/arc/${address}`);
  assert.equal(tokenLink({ chain: 'bsc', address: 'javascript:alert(1)' }, 'gmgn'), '');
  assert.equal(tokenLink({ chain: 'unknown', address }, 'gmgn'), '');
});

test('header waits for saved settings and does not request data when its switch is off', async () => {
  let resolveSettings;
  const requests = [];
  const sandbox = vm.createContext({
    window: { addEventListener() {} }, console,
    document: { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [] },
    location: { hostname: 'debot.ai' },
    chrome: {
      storage: {
        local: { get: () => new Promise(resolve => { resolveSettings = resolve; }) },
        onChanged: { addListener() {} },
      },
      runtime: { sendMessage: async message => { requests.push(message); return { ok: false }; } },
    },
    setInterval: () => 1, clearInterval() {},
    fetch: () => { throw new Error('Unexpected supply request while disabled'); },
  });
  vm.runInContext(source, sandbox);
  const route = { platform: 'debot', chain: 'bsc', networkId: 56, address: '0x' + 'a'.repeat(40) };
  sandbox.window.FomoDockExtras.syncHeader(route);
  assert.equal(requests.length, 0);
  resolveSettings({ fdShowHoldingShare: false });
  await new Promise(resolve => setImmediate(resolve));
  sandbox.window.FomoDockExtras.syncHeader(route);
  assert.equal(requests.length, 0);
});

function statsHarness() {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    querySelector(selector) {
      const name = selector.match(/^\[data-fd-holding-stat="(.*)"\]$/)?.[1];
      return this.children.find(x => name ? x.dataset.fdHoldingStat === name : x.tag === selector) || null;
    }
  }
  const stats = new Element('div');
  const addressWrapper = new Element('div');
  const address = { parentElement: addressWrapper };
  const block = { querySelector: selector => selector === '#token-base-address[data-addr]' ? address : null };
  const symbol = { parentElement: { parentElement: { parentElement: { parentElement: block } } } };
  const document = {
    createElement: tag => new Element(tag),
    querySelector: selector => selector.startsWith('#token-base-symbol') ? symbol
      : selector === '.fd-stats[data-fd-holding-key]' && stats.dataset.fdHoldingKey ? stats : null,
  };
  const sandbox = vm.createContext({ window: {}, document, console });
  vm.runInContext(source.replace('  let timer;', `
    window.setStatsState = (r, holders, supply) => { route = r; headerState = { key: keyOf(r), holders, supply }; };
    window.getHeaderAnchor = headerAnchor;
    return;
    let timer;`), sandbox);
  return { stats, addressWrapper, ...sandbox.window };
}

test('header badge is anchored after the GMGN address wrapper, never the token name or DeBot h1', () => {
  const h = statsHarness();
  h.setStatsState({ platform: 'gmgn', chain: 'bsc', address: 'abc' }, null, 0);
  assert.equal(h.getHeaderAnchor(), h.addressWrapper);
  h.setStatsState({ platform: 'debot', chain: 'bsc', address: 'abc' }, null, 0);
  assert.equal(h.getHeaderAnchor(), null);
});

test('FOMO cards retain holder count, share and amount across tabs without rebuilding or leaking another token', () => {
  const h = statsHarness();
  const route = { platform: 'debot', chain: 'bsc', address: 'abc' };
  const holders = { ok: true, total: 100, items: [{ userId: 'a', humanAmount: 100, value: 500 }] };
  h.setStatsState(route, holders, 1000);
  h.FomoDockExtras.renderHoldingStats(h.stats, route, holders);
  assert.equal(h.stats.children.length, 2);
  const [count, share] = h.stats.children;
  assert.equal(count.querySelector('strong').textContent, '100');
  assert.equal(count.querySelector('small').textContent, '已加载 1 / 100');
  assert.equal(share.querySelector('span').textContent, 'FOMO 持仓占比');
  assert.equal(share.querySelector('strong').textContent, '≥10.00%');
  assert.equal(share.querySelector('small').textContent, '合计 $500');
  // Changing to opinions has no new holders response and keeps both cards.
  h.FomoDockExtras.renderHoldingStats(h.stats, route, null);
  assert.equal(h.stats.children[1], share);
  assert.equal(share.querySelector('strong').textContent, '≥10.00%');
  h.setStatsState(route, holders, 0);
  h.FomoDockExtras.renderHoldingStats(h.stats, route, null);
  assert.equal(share.querySelector('strong').textContent, '—');
  const next = { ...route, address: 'def' };
  h.setStatsState(next, null, 0);
  h.FomoDockExtras.renderHoldingStats(h.stats, next, null);
  assert.equal(h.stats.children[0].querySelector('strong').textContent, '—');
  assert.equal(h.stats.children[1].querySelector('strong').textContent, '—');
});
