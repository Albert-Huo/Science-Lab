'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
const panels = html.slice(html.indexOf('/* ---------- panels ---------- */', html.indexOf('function boot(')), html.indexOf('/* tabs */'));
assert.ok(panels.includes('setPresentationMode'), '需要可退出、保留实验状态的专注展示');
function exercise(collapsed, desktop = true) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(id === 'root' && collapsed ? ['catalog-collapsed'] : []);
      elements.set(id, {classes, attrs: {}, events: {}, textContent: '', classList: {
        contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
        toggle(name, on) { if (on === undefined) on = !classes.has(name); on ? classes.add(name) : classes.delete(name); return on; }
      }, setAttribute(name, value) {this.attrs[name] = value;},
      addEventListener(name, handler) {this.events[name] = handler;}, contains() {return false;}, focus() {this.focused = true;}});
    }
    return elements.get(id);
  }
  const saved = [];
  const media = {matches: desktop, addEventListener(name, fn) {this.change = fn;}};
  const document = {documentElement: element('root'), activeElement: element('btnPresentation'), getElementById: element,
    querySelectorAll: selector => selector === '.panel' ? [element('panelCat'), element('panelUser')] : []};
  const context = vm.createContext({document, matchMedia: () => media, safeSet: (...args) => saved.push(args), LS: {catalog: 'catalog'}, updateScrollBand() {}, productAnalytics: {keyAction() {}}});
  vm.runInContext(panels, context);
  element('btnPresentation').events.click();
  assert.equal(element('root').classes.has('presentation-mode'), true);
  assert.equal(element('root').classes.has('catalog-collapsed'), true);
  assert.equal(element('btnPresentation').attrs['aria-pressed'], 'true');
  assert.equal(element('btnPresentation').textContent, '退出展示');
  assert.deepEqual(saved, [], '临时展示不能改写目录偏好');
  element('btnPresentation').events.click();
  assert.equal(element('root').classes.has('presentation-mode'), false);
  assert.equal(element('root').classes.has('catalog-collapsed'), collapsed);
  assert.equal(element('btnPresentation').attrs['aria-pressed'], 'false');
  assert.deepEqual(saved, []);
  element('btnPresentation').events.click(); media.matches = false; media.change();
  assert.equal(element('root').classes.has('presentation-mode'), false, '转入窄屏时恢复手机导航');
  assert.equal(element('root').classes.has('catalog-collapsed'), collapsed);
}
exercise(false); exercise(true);
const navStart = html.indexOf('let wheelLock=0;');
const navEnd = html.indexOf('/* ---------- hint & toast ---------- */', navStart);
const handlers = {}, moves = [];
let focused = true;
vm.runInNewContext(html.slice(navStart, navEnd), {
  window: {addEventListener: (name, handler) => {handlers[name] = handler;}},
  document: {querySelector: selector => selector === '.presentation-mode' && focused ? {} : null, activeElement: {tagName: 'BUTTON'}},
  next: () => moves.push('next'), prev: () => moves.push('prev'), closePanels() {}, setPresentationMode: on => {focused = on;}
});
handlers.wheel({deltaY: 200}); handlers.keydown({key: 'PageDown'});
assert.deepEqual(moves, [], '展示期间外层滚轮、方向键不能误换实验');
handlers.keydown({key: 'Escape'}); assert.equal(focused, false);
const catalogue = html.slice(html.indexOf('<aside class="panel" id="panelCat">'), html.indexOf('<aside class="panel" id="panelUser">'));
assert.ok(catalogue.includes('id="btnPrev"') && catalogue.includes('id="btnNext"'), '实验切换入口应移入目录，避开画布');
assert.doesNotMatch(html, /右下角箭头/);
console.log('✓ 专注展示保留目录偏好、退出和窄屏恢复、阻止误翻页、导航入口避开画布');
