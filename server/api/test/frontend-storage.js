'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
const start = html.indexOf('const CHAT_TOTAL_MAX=200');
const end = html.indexOf("let chatPath='', chatHistory=[], chatBusy=false;", start);
assert.ok(start >= 0 && end > start, '找不到 index.html 中的 AI 存储逻辑');
const source = html.slice(start, end) + '\nthis.chatApi={loadChatStore,persistChat};';

function harness(initial) {
  const values = new Map(Object.entries(initial || {}));
  const control = { failChatWrites: false };
  const toasts = [];
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (control.failChatWrites && key === 'expfeed.chat') throw new Error('quota_exceeded');
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
  };
  const context = vm.createContext({
    localStorage,
    location: { protocol: 'https:', hostname: 'lab.example', origin: 'https://lab.example' },
    LS: { ai: 'expfeed.ai', chat: 'expfeed.chat' },
    toast(message) { toasts.push(message); },
  });
  vm.runInContext(source, context);
  return { api: context.chatApi, localStorage, control, toasts };
}

let pass = 0;
const ok = name => { console.log('  ✓', name); pass++; };

{
  const test = harness({ 'expfeed.chat': '{bad json' });
  assert.strictEqual(JSON.stringify(test.api.loadChatStore()), '{}');
  assert.strictEqual(test.localStorage.getItem('expfeed.chat'), '{}');
  ok('损坏的 AI 会话 JSON 自动重置');
}

{
  const messages = Array.from({ length: 201 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'm' + String(index + 1).padStart(3, '0'),
    ts: index + 1,
  }));
  const test = harness({ 'expfeed.chat': JSON.stringify({ experiment: messages }) });
  const clean = JSON.parse(JSON.stringify(test.api.loadChatStore()));
  assert.strictEqual(clean.experiment.length, 200);
  assert.strictEqual(clean.experiment[0].content, 'm002');
  ok('超过 200 条时淘汰最旧记录');
}

{
  const oldRaw = JSON.stringify({
    experiment: [{ role: 'user', content: 'old', ts: 1 }],
  });
  const test = harness({ 'expfeed.chat': oldRaw });
  test.control.failChatWrites = true;
  const saved = test.api.persistChat('experiment', [
    { role: 'user', content: 'new', ts: 2 },
  ]);
  assert.strictEqual(saved, false);
  assert.strictEqual(test.localStorage.getItem('expfeed.chat'), oldRaw);
  assert.deepStrictEqual(test.toasts, ['对话记录保存失败，原有记录已保留']);
  ok('写入失败时保留旧记录并提示');
}

console.log('\n前端存储测试通过：' + pass + ' 项');
