'use strict';
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const modulePath = '../../../tools/traffic-ai-outcomes.cjs';
const event = (values = {}) => JSON.stringify({ version: 1, metricVersion: 2,
  time: '2026-09-07T01:00:00.000Z', outcome: 'completed', scope: '', experiment: '',
  status: 200, messages: 2, inputChars: 50, promptChars: 20, conversationChars: 30,
  durationMs: 1200, firstTokenMs: 40, ...values });

test('终态解析器存在且接受固定匿名字段和空指标', () => {
  assert.ok(fs.existsSync(path.resolve(__dirname, modulePath)), 'terminal parser must exist');
  const { parseAiEvent } = require(modulePath);
  assert.equal(parseAiEvent(event()).timestamp, Date.parse('2026-09-07T01:00:00.000Z'));
  assert.equal(parseAiEvent(event({ outcome: 'client_aborted', status: null })).status, null);
  assert.equal(parseAiEvent(event({ messages: null, inputChars: null, promptChars: null,
    conversationChars: null, firstTokenMs: null })).firstTokenMs, null);
  assert.equal(parseAiEvent(' '), null);
  for (const values of [{ version: 2 }, { metricVersion: 1 }, { time: '2026-02-30T01:00:00.000Z' },
    { outcome: 'secret' }, { scope: 'ip:123' }, { experiment: 'prompt text' }, { durationMs: -1 },
    { firstTokenMs: '40' }, { messages: -1 }, { promptChars: 1.5 }, { status: 600 }, { apiKey: 'secret' }]) {
    assert.throws(() => parseAiEvent(event(values)));
  }
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'science-lab-outcomes-'));
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
test('终态日志只读取专用文件与轮转，缺失或损坏失败', async () => {
  assert.ok(fs.existsSync(path.resolve(__dirname, modulePath)), 'terminal parser must exist');
  const { visitAiEventLogDirectory, parseAiEvent } = require(modulePath);
  await assert.rejects(visitAiEventLogDirectory(fixture, () => {}));
  fs.writeFileSync(path.join(fixture, 'ai-events.log'), event() + '\n');
  fs.writeFileSync(path.join(fixture, 'ai-events.log-20260906.gz'), zlib.gzipSync(event({ outcome: 'client_aborted' }) + '\n'));
  fs.writeFileSync(path.join(fixture, 'other.log'), 'private');
  const outcomes = [];
  await visitAiEventLogDirectory(fixture, line => outcomes.push(parseAiEvent(line).outcome));
  assert.deepEqual(outcomes, ['completed', 'client_aborted']);
  fs.writeFileSync(path.join(fixture, 'ai-events.log-20260905.gz'), 'broken');
  await assert.rejects(visitAiEventLogDirectory(fixture, () => {}));
});
