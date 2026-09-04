'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../../..');
const CHANNEL = 'science-lab.scroll.v1';
const hostHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
test('host waits for the iframe load before connecting the scroll receiver', () => {
  assert.match(hostHtml, /f\.dataset\.scrollLoaded='1'/);
  assert.match(hostHtml, /frame&&frame\.dataset\.scrollLoaded==='1'\?frame:null/);
});

function load(file) {
  assert.ok(fs.existsSync(path.join(ROOT, file)), `Missing scroll implementation: ${file}`);
  return require(path.join(ROOT, file));
}
function windowStub(origin = 'https://lab.xingnian.net.cn') {
  const listeners = new Map();
  let sequence = 0;
  const win = {
    location: new URL(origin), crypto: { randomUUID: () => `session-${++sequence}` },
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    emit: (type, event) => listeners.get(type)?.forEach(fn => fn(event)),
    requestAnimationFrame: fn => { win.pending = fn; return 1; },
    cancelAnimationFrame: () => { win.pending = null; },
    flush: () => { const fn = win.pending; win.pending = null; fn?.(); }
  };
  return win;
}
function childFixture() {
  const win = windowStub('https://html.xingnian.net.cn');
  const replies = [];
  win.parent = { postMessage: (data, origin) => replies.push({ data, origin }) };
  const root = { scrollTop: 0, scrollHeight: 1500, clientHeight: 500 };
  win.document = { scrollingElement: root, body: root, querySelectorAll: () => [] };
  const receiver = load('experiment-scroll-receiver.js').createReceiver(win);
  const send = (type, fields = {}, origin = 'https://lab.xingnian.net.cn', source = win.parent) => {
    win.emit('message', { origin, source, data: { channel: CHANNEL, session: 'test-session', type, ...fields } });
    win.flush();
  };
  return { win, root, replies, receiver, send };
}

test('host trusts only current iframe, exact origin/session and valid state', () => {
  const win = windowStub();
  const messages = [], states = [];
  const frame = { src: 'https://html.xingnian.net.cn/physics-middle/test.html', contentWindow: { postMessage: (data, origin) => messages.push({ data, origin }) } };
  const client = load('experiment-scroll.js').createClient(win, state => states.push(state));
  client.activate(frame);
  const session = messages[0].data.session;
  assert.equal(messages[0].origin, 'https://html.xingnian.net.cn');
  const state = { channel: CHANNEL, type: 'state', session, top: 0, max: 1000, viewport: 500, blocked: false };
  for (const event of [
    { origin: 'https://evil.example', source: frame.contentWindow, data: state },
    { origin: 'https://html.xingnian.net.cn', source: {}, data: state },
    { origin: 'https://html.xingnian.net.cn', source: frame.contentWindow, data: { ...state, session: 'stale' } },
    { origin: 'https://html.xingnian.net.cn', source: frame.contentWindow, data: { ...state, top: NaN } }
  ]) win.emit('message', event);
  assert.equal(client.getState(), null);
  win.emit('message', { origin: 'https://html.xingnian.net.cn', source: frame.contentWindow, data: state });
  assert.equal(client.getState().max, 1000);
  assert.equal(client.scroll(120), true);
  assert.equal(messages.at(-1).data.delta, 120);
  assert.equal(client.scroll(Infinity), false);
  client.activate(null);
  assert.equal(messages.at(-1).data.type, 'disconnect');
  assert.equal(client.getState(), null);
  assert.equal(client.scroll(100), false);
  client.destroy();
});

test('receiver clamps scrolling to this document and rejects malformed requests', () => {
  const f = childFixture();
  f.send('scroll', { delta: 200 });
  assert.equal(f.root.scrollTop, 0);
  f.send('connect');
  assert.equal(f.replies.at(-1).data.max, 1000);
  assert.equal(f.replies.at(-1).origin, 'https://lab.xingnian.net.cn');
  f.send('scroll', { delta: 300 });
  assert.equal(f.root.scrollTop, 300);
  for (const delta of [NaN, Infinity, '200', 999999]) f.send('scroll', { delta });
  f.send('scroll', { delta: 200 }, 'https://evil.example');
  f.send('scroll', { delta: 200 }, 'https://lab.xingnian.net.cn', {});
  f.send('scroll', { delta: 200, session: 'stale' });
  assert.equal(f.root.scrollTop, 300);
  f.send('scroll', { delta: 4096 });
  assert.equal(f.root.scrollTop, 1000);
  f.send('scroll', { delta: -4096 });
  assert.equal(f.root.scrollTop, 0);
  f.send('disconnect');
  f.send('scroll', { delta: 100 });
  assert.equal(f.root.scrollTop, 0);
  f.receiver.destroy();
});

test('receiver supports explicit inner scroller and reports no overflow', () => {
  const f = childFixture();
  f.receiver.destroy();
  const inner = { scrollTop: 0, scrollHeight: 900, clientHeight: 300 };
  const receiver = load('experiment-scroll-receiver.js').createReceiver(f.win, { getTarget: () => inner });
  f.send('connect');
  f.send('scroll', { delta: 120 });
  assert.equal(inner.scrollTop, 120);
  assert.equal(f.root.scrollTop, 0);
  inner.scrollHeight = 300; inner.scrollTop = 0;
  f.win.emit('resize', {}); f.win.flush();
  assert.equal(f.replies.at(-1).data.max, 0);
  receiver.destroy();
});

test('loopback parent is allowed only for loopback content; standalone is inert', () => {
  const api = load('experiment-scroll-receiver.js');
  assert.equal(api.allowedParent('http://127.0.0.1:18890', 'http://localhost:18891'), true);
  assert.equal(api.allowedParent('http://127.0.0.1:18890', 'https://html.xingnian.net.cn'), false);
  assert.equal(api.allowedParent('https://lab.xingnian.net.cn.evil.example', 'https://html.xingnian.net.cn'), false);
  const win = windowStub(); win.parent = win;
  assert.doesNotThrow(() => api.createReceiver(win).destroy());
});

test('boundary jumps use one validated command and respect blocked content', () => {
  const f = childFixture();
  f.send('connect');
  f.send('jump', { edge: 'bottom' });
  assert.equal(f.root.scrollTop, 1000);
  f.send('jump', { edge: 'invalid' });
  assert.equal(f.root.scrollTop, 1000);
  f.win.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  f.win.document.querySelectorAll = () => [{ getBoundingClientRect: () => ({ height: 200 }) }];
  f.send('jump', { edge: 'top' });
  assert.equal(f.root.scrollTop, 1000);
  f.win.document.querySelectorAll = () => [];
  f.send('jump', { edge: 'top' });
  assert.equal(f.root.scrollTop, 0);
  f.receiver.destroy();
});

test('actual pilot modal-mask is observed and blocks background scrolling', () => {
  const f = childFixture();
  let shown = false, changed;
  const observed = [];
  const mask = { getBoundingClientRect: () => ({ height: shown ? 500 : 0 }) };
  f.win.document.querySelectorAll = selector => selector.includes('.modal-mask') ? [mask] : [];
  f.win.getComputedStyle = () => ({ display: shown ? 'flex' : 'none', visibility: 'visible', opacity: '1' });
  f.win.MutationObserver = class {
    constructor(callback) { changed = callback; }
    observe(element) { observed.push(element); }
    disconnect() {}
  };
  f.send('connect');
  assert.ok(observed.includes(mask));
  assert.equal(f.replies.at(-1).data.blocked, false);
  shown = true; changed(); f.win.flush();
  assert.equal(f.replies.at(-1).data.blocked, true);
  f.send('scroll', { delta: 100 });
  assert.equal(f.root.scrollTop, 0);
  shown = false; changed(); f.win.flush();
  assert.equal(f.replies.at(-1).data.blocked, false);
  f.receiver.destroy();
});

function bandFixture() {
  const events = windowStub(), captured = new Set(), deltas = [], jumps = [];
  let enabled = true, catalog = 0;
  const element = {
    ...events, classList: { add() {}, remove() {} },
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id),
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 150 }) })
  };
  const band = load('experiment-scroll.js').bindBand(element, {
    enabled: () => enabled, scroll: delta => deltas.push(delta), jump: edge => jumps.push(edge),
    state: () => ({ top: 20, max: 10000, viewport: 500 }), openCatalog: () => catalog++
  });
  const send = (type, x, y, extra = {}) => element.emit(type, {
    pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y,
    preventDefault() {}, stopPropagation() {}, ...extra
  });
  return { band, send, deltas, jumps, captured, disable: () => { enabled = false; }, catalog: () => catalog };
}

test('vertical band gestures scroll incrementally and cancellation releases capture', () => {
  const f = bandFixture();
  f.send('pointerdown', 380, 400);
  f.send('pointermove', 380, 350);
  f.send('pointermove', 375, 300);
  assert.deepEqual(f.deltas, [50, 50]);
  f.send('pointermove', 380, 100, { pointerId: 2 });
  f.send('pointercancel', 380, 300);
  f.send('pointermove', 380, 200);
  assert.deepEqual(f.deltas, [50, 50]);
  assert.equal(f.captured.size, 0);
  assert.equal(f.catalog(), 0);
  f.send('pointerdown', 380, 400);
  f.send('lostpointercapture', 380, 400);
  f.send('pointermove', 380, 200);
  assert.deepEqual(f.deltas, [50, 50]);
  f.band.destroy();
});

test('horizontal handle drags do not scroll or open the catalog', () => {
  const f = bandFixture();
  f.send('pointerdown', 380, 400);
  f.send('pointermove', 280, 395);
  f.send('pointerup', 280, 390);
  assert.equal(f.catalog(), 0);
  assert.deepEqual(f.deltas, []);
  f.band.destroy();
});

test('handle taps do not jump the content', () => {
  const f = bandFixture();
  f.send('pointerdown', 380, 200);
  f.send('pointerup', 380, 200);
  assert.deepEqual(f.deltas, []);
  f.band.destroy();
});

test('handle preserves keyboard scrolling and cancels when disabled', () => {
  const f = bandFixture();
  f.send('keydown', 0, 0, { key: 'End' });
  f.send('keydown', 0, 0, { key: 'Home' });
  assert.deepEqual(f.jumps, ['bottom', 'top']);
  f.send('pointerdown', 380, 400);
  f.disable();
  f.send('pointermove', 380, 300);
  f.send('pointerup', 380, 200);
  f.send('keydown', 0, 0, { key: 'ArrowDown' });
  assert.deepEqual(f.deltas, []);
  assert.equal(f.captured.size, 0);
  f.band.destroy();
});

test('handle wheel scroll stays bounded and cannot bubble to experiment navigation', () => {
  const f = bandFixture();
  let prevented = 0, stopped = 0;
  const wheel = { deltaY: 80, deltaMode: 0, preventDefault: () => prevented++, stopPropagation: () => stopped++ };
  f.send('wheel', 380, 400, wheel);
  f.send('wheel', 380, 400, { ...wheel, deltaY: 1e6 });
  assert.deepEqual(f.deltas, [80, 4096]);
  assert.equal(prevented, 2);
  assert.equal(stopped, 2);
  f.send('wheel', 380, 400, { ...wheel, ctrlKey: true });
  assert.equal(prevented, 2);
  assert.equal(stopped, 3);
  assert.deepEqual(f.deltas, [80, 4096]);
  f.disable();
  f.send('wheel', 380, 400, wheel);
  assert.deepEqual(f.deltas, [80, 4096]);
  f.band.destroy();
});

test('page uses one short handle and disables both old edge gestures on touch', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('<script src="experiment-scroll.js"></script>'));
  assert.ok(html.includes('if(scrollTouch.matches) return;'));
  assert.ok(html.includes('#edgeL{display:none;}'));
  assert.ok(html.includes('class="scroll-grip"'));
  assert.ok(!html.includes('scroll-track'));
  assert.ok(!html.includes('scroll-thumb'));
  assert.ok(html.includes('scrollBand.cancel();'));
  assert.ok(html.includes("scrollClient.activate(scrollTouch.matches&&frame&&frame.dataset.scrollLoaded==='1'?frame:null)"));
  assert.ok(html.includes('aria-orientation="vertical"'));
});

test('short viewports reduce handle height and disable targets smaller than 44px', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('--scroll-h:min(112px,max(0px,calc(100%'));
  assert.ok(html.includes('height:var(--scroll-h)'));
  assert.ok(html.includes('scrollEdge.clientHeight>=44'));
});
