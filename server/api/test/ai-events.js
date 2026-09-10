'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

test('anonymous event collector is available', () => {
  assert.doesNotThrow(() => require('../ai-events'), 'terminal event collector must exist');
});

test('SSE observer accepts a UTF-8 BOM', async () => {
  const { createSseObserver } = require('../ai-events');
  for (const payload of ['\ufeffdata: [DONE]\n\n']) {
    let done = 0;
    await pipeline(Readable.from([payload]), createSseObserver({ onDone: () => done++ }),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    assert.equal(done, 1);
  }
});

test('SSE observer ignores empty data events', async () => {
  const { createSseObserver } = require('../ai-events');
  let done = 0; let errors = 0;
  await pipeline(Readable.from(['data:\n\ndata:   \n\ndata: [DONE]\n\n']),
    createSseObserver({ onDone: () => done++, onError: () => errors++ }),
    new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
  assert.equal(errors, 0); assert.equal(done, 1);
});

test('SSE errors before or after content cannot be turned into completion by a later DONE', async () => {
  const { createSseObserver } = require('../ai-events');
  const content = 'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n';
  for (const failure of ['data: {"error":{"message":"private-provider-error"}}\n\n',
    'data: {bad}\n\n', 'data: ' + 'x'.repeat(70000) + '\n\n']) {
    for (const prefix of ['', content]) {
      let done = 0; let errors = 0;
      const input = Buffer.from(prefix + failure + 'data: [DONE]\n\n');
      const output = [];
      await pipeline(Readable.from([input]), createSseObserver({ onDone: () => done++, onError: () => errors++ }),
        new Writable({ write(chunk, _encoding, callback) { output.push(chunk); callback(); } }));
      assert.equal(errors, 1); assert.equal(done, 0);
      assert.deepEqual(Buffer.concat(output), input);
    }
  }
});

test('bounded SSE observer preserves bytes and recognizes only dispatched data events', async () => {
  const { createSseObserver } = require('../ai-events');
  let tokens = 0; let done = 0;
  const content = ': data: [DONE]\r\n\r\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'
    + 'data: {"choices":[{"delta":{"content":"中文"}}]}\r\n\r\n'
    + 'data: {"choices":[{"delta":{"content":"more"}}]}\n\n'
    + 'data: [DONE]\n\ndata: [DONE]\n\n';
  const bytes = Buffer.from(content);
  const chunks = Array.from(bytes, byte => Buffer.from([byte]));
  const output = [];
  await pipeline(Readable.from(chunks), createSseObserver({ onFirstToken: () => tokens++, onDone: () => done++ }),
    new Writable({ write(chunk, _encoding, callback) { output.push(chunk); callback(); } }));
  assert.deepEqual(Buffer.concat(output), bytes);
  assert.equal(tokens, 1); assert.equal(done, 1);

  for (const invalid of ['data: [DONE]', 'data: [DONE]\ndata: extra\n\n', ': [DONE]\n\n',
    'data: ' + 'x'.repeat(70000) + '\ndata: [DONE]\n\n']) {
    let completed = false;
    await pipeline(Readable.from([invalid]), createSseObserver({ onDone: () => { completed = true; } }),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    assert.equal(completed, false);
  }
});

test('event logger strips identity/content, bounds queue and reopens after rotation', async t => {
  const { createEventLogger } = require('../ai-events');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-events-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'ai-events.log');
  const warnings = [];
  const logger = createEventLogger({ path: target, maxQueue: 2, warn: message => warnings.push(message) });
  const event = { outcome: 'completed', status: 200, experiment: 'a'.repeat(64), scope: '', messages: 2,
    inputChars: 12, promptChars: 8, conversationChars: 4, durationMs: 7, firstTokenMs: 3,
    ip: 'secret-ip', apiKey: 'secret-key', content: 'secret-chat', time: 'secret-time' };
  assert.equal(logger.record(event), true);
  assert.equal(logger.record(event), true);
  assert.equal(logger.record(event), false);
  await logger.flush();
  const lines = (await fs.readFile(target, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(!lines.join('').includes('secret'));
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(parsed).sort(), ['version', 'metricVersion', 'time', 'outcome', 'scope', 'experiment',
    'status', 'messages', 'inputChars', 'promptChars', 'conversationChars', 'durationMs', 'firstTokenMs'].sort());
  assert.equal(parsed.version, 1); assert.equal(parsed.metricVersion, 2);
  assert.match(parsed.time, /^\d{4}-\d\d-\d\dT.*Z$/);
  await fs.rename(target, target + '-20260910');
  logger.record(event); await logger.flush();
  assert.equal((await fs.readFile(target, 'utf8')).trim().split('\n').length, 1);
  assert.deepEqual(warnings, ['[ai-events] queue_full']);
});

test('logger rejects symlinks and nonregular files without revealing paths or throwing', async t => {
  const { createEventLogger } = require('../ai-events');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-events-private-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'private-target');
  await fs.writeFile(target, 'untouched');
  const link = path.join(dir, 'ai-events.log');
  await fs.symlink(target, link);
  const warnings = [];
  for (const logPath of [link, dir, path.join(dir, 'missing', 'ai-events.log')]) {
    const logger = createEventLogger({ path: logPath, warn: message => warnings.push(message) });
    assert.doesNotThrow(() => logger.record({ outcome: 'internal_error', durationMs: 0 }));
    await logger.flush();
  }
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
  assert.deepEqual(warnings, Array(3).fill('[ai-events] write_unavailable'));
  const disabled = createEventLogger();
  assert.equal(disabled.record({}), false); await disabled.flush();
});
