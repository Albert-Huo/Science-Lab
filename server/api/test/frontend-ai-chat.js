'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const modulePath = path.resolve(__dirname, '../../../ai-chat.js');
assert.ok(fs.existsSync(modulePath), 'AI conversation helper must exist');
const ai = require(modulePath);
const pair = (n, size = 1) => [{ role: 'user', content: String(n).repeat(size) }, { role: 'assistant', content: 'a'.repeat(size) }];
function uiHarness(fetchImpl) {
  const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
  class Element {
    constructor() { this.children = []; this.value = ''; this.textContent = ''; this.events = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
    appendChild(child) { child.parent = this; this.children.push(child); }
    get isConnected() { return this.root === true || !!(this.parent && this.parent.isConnected); }
    set innerHTML(value) { this.children.forEach(child => { child.parent = null; }); this.children = []; }
    addEventListener(name, fn) { this.events[name] = fn; }
  }
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) { const el = new Element(); el.root = true; elements.set(id, el); } return elements.get(id); }, createElement() { return new Element(); } };
  const store = new Map(), timers = new Map(); let timerId = 0;
  const context = vm.createContext({ document, console, URL, ScienceAiChat: ai, AbortController, TextDecoder,
    location: { protocol: 'https:', hostname: 'lab.example', origin: 'https://lab.example' },
    MANIFEST: [{ path: 'one.html', title: '实验一', subject: '物理', level: '初中' }, { path: 'two.html', title: '实验二', subject: '物理', level: '初中' }], cur: 0,
    LS: { ai: 'ai', chat: 'chat' }, safeGet: (key, fallback) => store.get(key) || fallback, safeSet: (key, value) => { store.set(key, value); return true; }, safeRemove: key => store.delete(key), toast() {}, fetch: fetchImpl,
    setTimeout(fn, ms) { assert.equal(ms, 120000); timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(html.slice(html.indexOf("const chatLog=document.getElementById('chatLog')"), html.indexOf('/* ---------- gestures ---------- */')) + '\nthis.ui={sendChat,renderChatForCurrent};', context);
  context.ui.renderChatForCurrent();
  return { context, document, store, timers, switchTo(index) { context.cur = index; context.ui.renderChatForCurrent(); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function testUi() {
  let streamController, captured, calls = 0;
  const test = uiHarness(async (url, options) => {
    captured = { url, options };
    calls++;
    if (calls > 1) return new Response('data: {"choices":[{"delta":{"content":"重试成功"},"finish_reason":"stop"}]}\n\ndata: [DONE]');
    return new Response(new ReadableStream({ start(controller) { streamController = controller; options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError'))); } }), { headers: { 'X-AI-Quota-Limit': '30', 'X-AI-Quota-Remaining': '29', 'X-AI-Quota-Scope': 'session_day' } });
  });
  test.document.getElementById('chatInput').value = '为什么？';
  const request = test.context.ui.sendChat(); await tick();
  assert.equal(test.document.getElementById('aiGear').disabled, true);
  assert.equal(test.document.getElementById('aiByok').disabled, true);
  assert.equal(captured.options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(captured.options.body), { stream: true, messages: [{ role: 'user', content: '为什么？' }], context: { experimentPath: 'one.html' } });
  const encoder = new TextEncoder();
  streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"部分回答"}}]}\n\n')); await tick();
  test.switchTo(1);
  assert.ok(!test.document.getElementById('chatLog').children.some(el => el.textContent.includes('部分回答')));
  test.document.getElementById('chatInput').value = '并发问题';
  await test.context.ui.sendChat();
  assert.equal(calls, 1);
  test.document.getElementById('chatStop').events.click(); await request;
  assert.equal(captured.options.signal.aborted, true);
  assert.equal(test.timers.size, 0);
  assert.equal(test.document.getElementById('chatSend').disabled, false);
  const first = JSON.parse(test.store.get('chat'))['one.html'];
  assert.equal(first[0].content, '为什么？');
  assert.equal(first[0].incomplete, true);
  assert.equal(first[1].content, '部分回答');
  assert.equal(first[1].incomplete, true);
  assert.ok(first[1].notice.includes('停止'));
  assert.ok(!test.document.getElementById('chatLog').children.some(el => el.textContent.includes('部分回答')));
  test.switchTo(0);
  const partial = test.document.getElementById('chatLog').children.find(el => el.textContent.includes('部分回答'));
  assert.ok(partial.textContent.includes('回答未完成'));
  assert.ok(partial.children.some(el => el.textContent === '重新提问'));
  partial.children.find(el => el.textContent === '重新提问').events.click(); await tick();
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(captured.options.body).messages, [{ role: 'user', content: '为什么？' }]);
  assert.equal(JSON.parse(test.store.get('chat'))['one.html'].at(-1).content, '重试成功');
  const timeout = uiHarness((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
  timeout.document.getElementById('chatInput').value = '保留我的问题';
  const pending = timeout.context.ui.sendChat();
  Array.from(timeout.timers.values())[0](); await pending;
  assert.ok(JSON.parse(timeout.store.get('chat'))['one.html'][1].notice.includes('120 秒'));
  const success = uiHarness(async () => new Response('data: {"choices":[{"delta":{"content":"完整回答"},"finish_reason":"stop"}]}\n\ndata: [DONE]'));
  success.document.getElementById('chatInput').value = '正常问题';
  await success.context.ui.sendChat();
  const complete = JSON.parse(success.store.get('chat'))['one.html'];
  assert.equal(complete[0].incomplete, false);
  assert.equal(complete[1].incomplete, false);
  assert.equal(complete[1].content, '完整回答');
  success.document.getElementById('aiQuota').textContent = '自定义服务';
  success.document.getElementById('aiByok').checked = false;
  success.document.getElementById('aiByok').events.change();
  assert.equal(success.document.getElementById('aiQuota').textContent, '');
  const boundedMemory = uiHarness(async () => new Response('data: {"choices":[{"delta":{"content":"答"},"finish_reason":"stop"}]}\n\ndata: [DONE]'));
  boundedMemory.store.set('chat', JSON.stringify({ 'two.html': Array.from({ length: 100 }, (_, n) => pair(n)).flat().map((message, n) => ({ ...message, ts: n + 1 })) }));
  boundedMemory.switchTo(1);
  boundedMemory.document.getElementById('chatInput').value = '新问题';
  await boundedMemory.context.ui.sendChat();
  assert.ok(vm.runInContext('Array.from(chatMemory.values()).reduce((sum,messages)=>sum+messages.length,0)', boundedMemory.context) <= 200);
  const longAnswer = uiHarness(async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '答'.repeat(7000) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]'));
  longAnswer.document.getElementById('chatInput').value = '长回答';
  await longAnswer.context.ui.sendChat();
  const storedLong = JSON.parse(longAnswer.store.get('chat'))['one.html'].at(-1);
  assert.equal(storedLong.content.length, 6000);
  assert.equal(storedLong.incomplete, true);
  assert.equal(vm.runInContext("chatMemory.get('one.html').at(-1).content.length", longAnswer.context), 6000);
  assert.equal(vm.runInContext("chatMemory.get('one.html').at(-1).incomplete", longAnswer.context), true);
  assert.ok(longAnswer.document.getElementById('chatLog').children.at(-1).textContent.includes('6000'));
  for (const status of [429, 503, 504]) {
    const failed = uiHarness(async () => new Response('<html>gateway error</html>', { status, headers: { 'Retry-After': '45', 'X-AI-Quota-Limit': '30', 'X-AI-Quota-Remaining': '0', 'X-AI-Quota-Scope': 'session_day' } }));
    failed.document.getElementById('chatInput').value = '失败后保留';
    await failed.context.ui.sendChat();
    const record = JSON.parse(failed.store.get('chat'))['one.html'];
    assert.equal(record[0].content, '失败后保留');
    assert.equal(record[1].incomplete, true);
    assert.ok(record[1].notice.includes('45 秒'));
    assert.ok(!record[1].notice.includes('<html>'));
    assert.ok(failed.document.getElementById('aiQuota').textContent.includes('0 / 30'));
    assert.equal(failed.document.getElementById('chatStop').hidden, true);
    assert.equal(failed.document.getElementById('chatSend').disabled, false);
  }
  console.log('AI 前端交互测试通过：请求契约、切换隔离、停止保留、超时、成功流');
}
async function main() {
  const history = Array.from({ length: 7 }, (_, n) => pair(n)).flat();
  assert.equal(ai.selectMessages([...history, { role: 'user', content: 'now' }]).length, 11);
  assert.deepEqual(ai.selectMessages([{ role: 'assistant', content: 'orphan' }, ...pair(1), { role: 'user', content: 'failed', incomplete: true }, { role: 'assistant', content: 'partial', incomplete: true }, { role: 'user', content: 'now' }]), [...pair(1), { role: 'user', content: 'now' }]);
  const bounded = ai.selectMessages([...pair(1, 4000), ...pair(2, 4000), { role: 'user', content: 'now' }]);
  assert.equal(bounded.length, 3);
  assert.ok(bounded.reduce((sum, m) => sum + m.content.length, 0) <= 12000);
  assert.throws(() => ai.selectMessages([{ role: 'user', content: 'x'.repeat(4001) }]), /4000/);
  assert.deepEqual(ai.selectMessages([...pair(1, 4001), { role: 'user', content: 'now' }]), [{ role: 'user', content: 'now' }]);
  assert.throws(() => ai.validateEndpoint('http://example.com/chat'), /HTTPS/);
  assert.throws(() => ai.validateEndpoint('https://user:password@example.com/chat'), /凭据/);
  assert.equal(ai.validateEndpoint('http://localhost:3000/chat'), 'http://localhost:3000/chat');
  assert.equal(ai.validateEndpoint('https://example.com/chat'), 'https://example.com/chat');
  const parser = ai.createSseParser();
  parser.push('data: {"choices":[{"delta":{"content":"你');
  parser.push('好"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  parser.push('data: [DONE]');
  assert.equal(parser.end(), '你好');
  const length = ai.createSseParser();
  length.push('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
  assert.throws(() => length.end(), /长度/);
  const broken = ai.createSseParser();
  broken.push('data: {"choices":[{"delta":{"content":"partial"}}]}\n');
  assert.throws(() => broken.end(), /中断/);
  assert.throws(() => ai.createSseParser().push('data: {"error":{"message":"upstream failed"}}\n\n'), /upstream failed/);
  assert.throws(() => ai.createSseParser().push('data: {broken}\n'), /格式/);
  const oversized = ai.createSseParser();
  assert.throws(() => oversized.push('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(24001) } }] }) + '\n'), /过长/);
  assert.equal(oversized.text.length, 24000);
  for (const [status, message] of [[429, '频繁'], [503, '繁忙'], [504, '超时']]) {
    const res = new Response('<html>gateway</html>', { status, headers: { 'Retry-After': '60' } });
    const error = await ai.responseError(res);
    assert.ok(error.includes(message));
    assert.ok(error.includes('60 秒'));
    assert.ok(!error.includes('<html>'));
  }
  const quota = ai.quotaText(new Headers({ 'X-AI-Quota-Limit': '30', 'X-AI-Quota-Remaining': '29', 'X-AI-Quota-Reset': String(Math.floor(Date.now() / 1000) + 3600), 'X-AI-Quota-Scope': 'session_day' }));
  assert.ok(quota.includes('29 / 30'));
  assert.ok(!quota.includes('今日'));
  assert.equal(ai.quotaText(new Headers()), '');
  console.log('AI 前端核心测试通过：历史预算、SSE、错误与限额');
  await testUi();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
