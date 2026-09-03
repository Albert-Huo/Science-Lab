'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
const storageStart = html.indexOf('let storageWarningShown=false');
const storageEnd = html.indexOf('function fetchJson', storageStart);
assert.ok(storageStart >= 0 && storageEnd > storageStart, '找不到 index.html 中的安全存储辅助函数');
const storageSource = html.slice(storageStart, storageEnd);
const aiStart = html.indexOf('const CHAT_TOTAL_MAX=200');
const aiEnd = html.indexOf("let chatPath='', chatHistory=[], chatBusy=false;", aiStart);
assert.ok(aiStart >= 0 && aiEnd > aiStart, '找不到 index.html 中的 AI 存储逻辑');
const source = storageSource + '\n' + html.slice(aiStart, aiEnd) +
  '\nthis.storageApi={safeGet,safeSet,safeRemove};this.chatApi={loadChatStore,persistChat,toAiMessages};';

function harness(initial) {
  const values = new Map(Object.entries(initial || {}));
  const control = { failReads: false, failWrites: false, failRemoves: false, failChatWrites: false };
  const toasts = [];
  const warnings = [];
  const localStorage = {
    getItem(key) {
      if (control.failReads) throw new Error('read_blocked');
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (control.failWrites || (control.failChatWrites && key === 'expfeed.chat')) throw new Error('quota_exceeded');
      values.set(key, String(value));
    },
    removeItem(key) {
      if (control.failRemoves) throw new Error('remove_blocked');
      values.delete(key);
    },
  };
  const context = vm.createContext({
    localStorage,
    location: { protocol: 'https:', hostname: 'lab.example', origin: 'https://lab.example' },
    LS: { ai: 'expfeed.ai', chat: 'expfeed.chat' },
    console: { warn(message) { warnings.push(String(message)); } },
    toast(message) { toasts.push(message); },
  });
  vm.runInContext(source, context);
  return { api: context.chatApi, storageApi: context.storageApi, localStorage, control, toasts, warnings };
}

let pass = 0;
const ok = name => { console.log('  ✓', name); pass++; };
function assertSingleStorageWarning(warnings, operation, key, error) {
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes(operation), '警告缺少存储操作');
  assert.ok(warnings[0].includes(key), '警告缺少存储键');
  assert.ok(warnings[0].includes(error), '警告缺少底层错误');
}

{
  const test = harness({ removable: 'old' });
  test.control.failReads = true;
  assert.strictEqual(test.storageApi.safeGet('read-key', 'fallback'), 'fallback');
  assert.strictEqual(test.storageApi.safeSet('write-key', 'value'), true);
  assert.strictEqual(test.storageApi.safeRemove('removable'), true);
  test.control.failReads = false;
  assert.strictEqual(test.localStorage.getItem('write-key'), 'value');
  assert.strictEqual(test.localStorage.getItem('removable'), null);
  assertSingleStorageWarning(test.warnings, '读取', 'read-key', 'read_blocked');
  ok('读取失败不影响写入和删除');
}

{
  const test = harness({ 'read-key': 'stored', removable: 'old' });
  test.control.failWrites = true;
  assert.strictEqual(test.storageApi.safeSet('write-key', 'value'), false);
  assert.strictEqual(test.storageApi.safeGet('read-key', 'fallback'), 'stored');
  assert.strictEqual(test.storageApi.safeRemove('removable'), true);
  assert.strictEqual(test.localStorage.getItem('removable'), null);
  assertSingleStorageWarning(test.warnings, '写入', 'write-key', 'quota_exceeded');
  ok('写入失败不影响读取和删除');
}

{
  const test = harness({ 'read-key': 'stored', removable: 'old' });
  test.control.failRemoves = true;
  assert.strictEqual(test.storageApi.safeRemove('removable'), false);
  assert.strictEqual(test.storageApi.safeGet('read-key', 'fallback'), 'stored');
  assert.strictEqual(test.storageApi.safeSet('write-key', 'value'), true);
  assert.strictEqual(test.localStorage.getItem('removable'), 'old');
  assert.strictEqual(test.localStorage.getItem('write-key'), 'value');
  assertSingleStorageWarning(test.warnings, '删除', 'removable', 'remove_blocked');
  ok('删除失败不影响读取和写入');
}

{
  const test = harness();
  test.control.failReads = true;
  test.control.failWrites = true;
  test.control.failRemoves = true;
  assert.strictEqual(test.storageApi.safeGet('missing', 'fallback'), 'fallback');
  assert.strictEqual(test.storageApi.safeSet('key', 'value'), false);
  assert.strictEqual(test.storageApi.safeRemove('key'), false);
  assert.strictEqual(test.warnings.length, 1);
  assert.ok(test.warnings[0].includes('浏览器存储不可用'));
  ok('同一页面发生多种存储失败时只警告一次');
}

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

{
  const test = harness();
  const input = Array.from({ length: 13 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(5000),
  }));
  const sent = JSON.parse(JSON.stringify(test.api.toAiMessages(input)));
  assert.strictEqual(sent.length, 12);
  assert.strictEqual(sent[0].content.length, 4000);
  ok('发往内置 AI 的历史限制为最近 12 条且每条不超过 4000 字符');
}

assert.ok(html.includes("model:'deepseek-v4-flash'"), '前端默认模型必须使用 DeepSeek V4 Flash');
const runtimeWithoutStorageHelper = html.slice(0, storageStart) + html.slice(storageEnd);
assert.ok(
  !/localStorage\.(?:getItem|setItem|removeItem)\s*\(/.test(runtimeWithoutStorageHelper),
  'localStorage 原始调用只能出现在安全存储辅助函数中'
);

console.log('\n前端存储测试通过：' + pass + ' 项');
