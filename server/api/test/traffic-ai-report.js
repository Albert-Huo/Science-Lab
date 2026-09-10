'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test, after } = require('node:test');
const { parseAiRecord, loadExperimentMap, visitAiLogDirectory } = require('../../../tools/traffic-ai-report.cjs');

const experimentPath = 'physics-middle/初中物理实验1.html';
const experimentHash = crypto.createHash('sha256').update(experimentPath).digest('hex');
const aiLine = (overrides = {}) => JSON.stringify({
  time: '2026-09-09T12:00:00+08:00',
  status: '200',
  duration: '3.428',
  bytes: '1532',
  experiment: experimentHash,
  messages: '5',
  inputChars: '820',
  ...overrides,
});

test('匿名 AI 日志只解析固定聚合字段', () => {
  assert.deepEqual(parseAiRecord(aiLine()), {
    timestamp: Date.parse('2026-09-09T12:00:00+08:00'),
    status: 200,
    durationMs: 3428,
    bytes: 1532,
    experimentHash,
    messageCount: 5,
    inputChars: 820,
  });
  assert.deepEqual(parseAiRecord(aiLine({ experiment: '', messages: '', inputChars: '' })), {
    timestamp: Date.parse('2026-09-09T12:00:00+08:00'),
    status: 200,
    durationMs: 3428,
    bytes: 1532,
    experimentHash: null,
    messageCount: null,
    inputChars: null,
  });
  assert.equal(parseAiRecord('  '), null);
});

test('AI 日志拒绝格式漂移、越界数值和可注入文本', () => {
  for (const line of [
    '{broken',
    aiLine({ extra: 'field' }),
    aiLine({ time: 'not-a-date' }),
    aiLine({ time: '2026-02-30T12:00:00+08:00' }),
    aiLine({ status: '99' }),
    aiLine({ status: '600' }),
    aiLine({ duration: '-1' }),
    aiLine({ duration: '86401' }),
    aiLine({ bytes: '-1' }),
    aiLine({ experiment: '用户问题不能进入日志' }),
    aiLine({ messages: '21' }),
    aiLine({ inputChars: '80001' }),
  ]) assert.throws(() => parseAiRecord(line));
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'science-lab-ai-report-'));
after(() => fs.rmSync(fixture, { recursive: true, force: true }));

test('实验清单只映射固定哈希到受限标题', () => {
  const manifest = path.join(fixture, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify([
    { path: experimentPath, title: '初中物理实验1', subject: '物理', level: '初中' },
    { path: 'chemistry-middle/初中化学实验1.html', title: '初中化学实验1', subject: '化学', level: '初中' },
  ]));
  const map = loadExperimentMap(manifest);
  assert.equal(map.get(experimentHash), '初中物理实验1');
  assert.equal(map.size, 2);
  const serialized = JSON.stringify([...map]);
  assert.ok(!serialized.includes(experimentPath));
  assert.ok(!serialized.includes('用户问题'));

  fs.writeFileSync(manifest, JSON.stringify([{ path: experimentPath, title: 'x'.repeat(301) }]));
  assert.throws(() => loadExperimentMap(manifest), /清单/);
  fs.unlinkSync(manifest);
  fs.symlinkSync(path.join(fixture, 'target.json'), manifest);
  assert.throws(() => loadExperimentMap(manifest), /普通文件/);
});

test('只读取匿名 AI 当前日志及日期轮转 gzip', async () => {
  const dir = fs.mkdtempSync(path.join(fixture, 'logs-'));
  fs.writeFileSync(path.join(dir, 'science-lab-ai-access.log'), aiLine() + '\n');
  fs.writeFileSync(path.join(dir, 'science-lab-ai-access.log-20260908.gz'), zlib.gzipSync(aiLine({ status: '429', experiment: '', messages: '', inputChars: '' }) + '\n'));
  fs.writeFileSync(path.join(dir, 'science-lab-access.log'), 'private combined log must not be read\n');
  fs.writeFileSync(path.join(dir, 'science-lab-ai-access.log.backup'), 'not a log\n');
  const records = [];
  const files = await visitAiLogDirectory(dir, line => records.push(parseAiRecord(line)));
  assert.deepEqual(files.map(file => file.name), [
    'science-lab-ai-access.log',
    'science-lab-ai-access.log-20260908.gz',
  ]);
  assert.deepEqual(records.map(record => record.status), [200, 429]);
});

test('匿名 AI 日志缺失、符号链接和损坏压缩包会明确失败', async () => {
  const empty = fs.mkdtempSync(path.join(fixture, 'empty-'));
  await assert.rejects(visitAiLogDirectory(empty, () => {}), /匿名 AI 日志/);

  const bad = fs.mkdtempSync(path.join(fixture, 'bad-'));
  const target = path.join(fixture, 'target-ai.log');
  fs.writeFileSync(target, aiLine() + '\n');
  const current = path.join(bad, 'science-lab-ai-access.log');
  fs.symlinkSync(target, current);
  await assert.rejects(visitAiLogDirectory(bad, () => {}), /普通文件|regular/);
  fs.unlinkSync(current);
  fs.writeFileSync(path.join(bad, 'science-lab-ai-access.log-20260908.gz'), 'broken gzip');
  await assert.rejects(visitAiLogDirectory(bad, () => {}), /读取独立日志失败/);
});
