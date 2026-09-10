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
  '\nthis.storageApi={safeGet,safeSet,safeRemove};this.chatApi={loadChatStore,persistChat,toAiMessages,aiCfg,buildAiRequestBody:typeof buildAiRequestBody===\'function\'?buildAiRequestBody:null};';

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
    ScienceAiChat: require('../../../ai-chat.js'), URL,
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
    content: 'x'.repeat(1000),
  }));
  const sent = JSON.parse(JSON.stringify(test.api.toAiMessages(input)));
  assert.strictEqual(sent.length, 11);
  assert.strictEqual(sent[0].role, 'user');
  assert.strictEqual(sent[0].content.length, 1000);
  ok('发往内置 AI 的历史限制为最近 5 个完整问答轮次与当前问题');
}

{
  const test = harness();
  assert.strictEqual(test.api.aiCfg().model, 'DeepSeek');
  assert.strictEqual(typeof test.api.buildAiRequestBody, 'function');
  const messages = [{ role: 'user', content: '测试' }];
  const experimentPath = 'physics-middle/初中物理实验1.html';
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(test.api.buildAiRequestBody({ byok: false, model: 'DeepSeek' }, messages, experimentPath))),
    { stream: true, messages, context: { experimentPath } }
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(test.api.buildAiRequestBody({ byok: true, model: 'DeepSeek' }, messages, experimentPath))),
    { model: 'deepseek-v4-flash', stream: true, messages: [{ role: 'system', content: '你是中文实验学习助手。不能编造未提供的观察或读数。\n本次没有实时状态，只能依据用户描述。' }, ...messages], max_tokens: 2048, thinking: { type: 'disabled' } }
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(test.api.buildAiRequestBody({ byok: true, model: 'custom-model' }, messages, experimentPath))),
    { model: 'custom-model', stream: true, messages: [{ role: 'system', content: '你是中文实验学习助手。不能编造未提供的观察或读数。\n本次没有实时状态，只能依据用户描述。' }, ...messages] }
  );
  const compatible = test.api.buildAiRequestBody({ byok: true, endpoint: 'https://provider.example/v1/chat/completions', model: 'deepseek-v4-flash' }, messages, experimentPath);
  assert.strictEqual(compatible.thinking, undefined);
  assert.strictEqual(compatible.max_tokens, undefined);
  const liveState={version:1,experimentPath,mode:'自由模式',step:'关卡 2 / 4',readouts:[]};
  const withState=test.api.buildAiRequestBody({byok:false},messages,experimentPath,'system',liveState);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(withState.context)),{experimentPath,liveState});
  const byokState=test.api.buildAiRequestBody({byok:true,model:'DeepSeek'},messages,experimentPath,'system',liveState);
  assert.ok(byokState.messages[0].content.includes('自由模式'));
  assert.strictEqual(byokState.context,undefined);
  assert.ok(html.includes('buildAiRequestBody(cfg,messages,path,sys,liveState)'));
  ok('内置请求携带实验路径，BYOK 保持直连格式且使用当前 Flash 模型');
}

{
  const test = harness({ 'expfeed.ai': JSON.stringify({ byok: false, key: 'old-key' }) });
  assert.strictEqual(test.api.aiCfg().key, '');
  assert.strictEqual(JSON.parse(test.localStorage.getItem('expfeed.ai')).key, '');
  test.api.persistChat('experiment', [{ role: 'user', content: 'question', incomplete: true }, { role: 'assistant', content: 'partial', incomplete: true, notice: '已停止生成。' }]);
  const history = test.api.loadChatStore().experiment;
  assert.strictEqual(history[0].incomplete, true);
  assert.strictEqual(history[1].notice, '已停止生成。');
  ok('关闭 BYOK 时清除旧 Key，持久化保留未完成标记与原因');
}

{
  const test = harness({
    'expfeed.ai': JSON.stringify({
      byok: true,
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-flash',
      key: 'test-key',
    }),
  });
  assert.strictEqual(test.api.aiCfg().model, 'DeepSeek');
  ok('旧版默认模型设置迁移为稳定名称且保留 API Key');
}

assert.ok(html.includes('placeholder="DeepSeek"'), '模型输入框应展示稳定名称 DeepSeek');
assert.ok(html.includes("model:DEEPSEEK_NAME"), '前端默认模型名称必须使用稳定的 DeepSeek 常量');
const runtimeWithoutStorageHelper = html.slice(0, storageStart) + html.slice(storageEnd);
assert.ok(
  !/localStorage\.(?:getItem|setItem|removeItem)\s*\(/.test(runtimeWithoutStorageHelper),
  'localStorage 原始调用只能出现在安全存储辅助函数中'
);

console.log('\n前端存储测试通过：' + pass + ' 项');
