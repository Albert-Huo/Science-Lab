'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
const RECEIVER = readFileSync(path.join(ROOT, 'experiment-scroll-receiver.js'), 'utf8');
const ASSET = 'experiment-scroll-receiver.v1.js';
const TAG = `<script src="../${ASSET}" data-science-lab-scroll></script>\n`;
const LEGACY_BLOCK = `<script data-science-lab-scroll>\n${RECEIVER}</script>\n`;
const NUMBERS = Array.from({ length: 68 }, (_, index) => index + 1)
  .filter(number => number !== 12)
  .map(String)
  .concat(['12-1', '12-2', '49-1']);

assert.equal(NUMBERS.length, 70);

function run(relative, args) {
  return execFileSync(process.execPath, [path.join(ROOT, relative), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function runGit(contentRoot, args) {
  return execFileSync('git', args, {
    cwd: contentRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function expectFailure(action, pattern) {
  let error;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'expected command to fail');
  assert.match(`${error.message}\n${error.stderr || ''}`, pattern);
}

function createFixture(t) {
  const contentRoot = mkdtempSync(path.join(os.tmpdir(), 'sl-scroll-release-'));
  t.after(() => rmSync(contentRoot, { recursive: true, force: true }));
  const experimentRoot = path.join(contentRoot, 'physics-middle');
  mkdirSync(experimentRoot);

  for (const number of NUMBERS) {
    const receiver = ['1', '35', '41'].includes(number) ? LEGACY_BLOCK : '';
    const html = `<html><body><button id="mode">模式</button>\n${receiver}</body></html>\n`;
    writeFileSync(path.join(experimentRoot, `初中物理实验${number}.html`), html);
  }

  runGit(contentRoot, ['init', '--quiet']);
  runGit(contentRoot, ['add', '.']);
  runGit(contentRoot, [
    '-c', 'user.name=Science Lab Tests',
    '-c', 'user.email=science-lab-tests@example.invalid',
    'commit', '--quiet', '-m', 'fixture baseline'
  ]);
  return { contentRoot, baseline: runGit(contentRoot, ['rev-parse', 'HEAD']) };
}

function install(contentRoot) {
  return run('tools/install-scroll-receiver.mjs', ['--content-root', contentRoot, '--apply']);
}

function check(contentRoot, baseline) {
  return run('tools/check-scroll-release.mjs', [
    '--content-root', contentRoot,
    '--base-ref', baseline
  ]);
}

test('installer migrates all 70 pages and remains idempotent', t => {
  const { contentRoot, baseline } = createFixture(t);
  const before = runGit(contentRoot, ['status', '--short']);
  const preview = run('tools/install-scroll-receiver.mjs', ['--content-root', contentRoot]);
  assert.match(preview, /70 page changes/);
  assert.equal(runGit(contentRoot, ['status', '--short']), before, 'dry run must not write files');
  assert.ok(!existsSync(path.join(contentRoot, ASSET)));

  install(contentRoot);
  assert.equal(readFileSync(path.join(contentRoot, ASSET), 'utf8'), RECEIVER);
  assert.match(check(contentRoot, baseline), /Verified 70 middle-school experiments/);

  for (const number of NUMBERS) {
    const html = readFileSync(path.join(contentRoot, `physics-middle/初中物理实验${number}.html`), 'utf8');
    assert.equal((html.match(/data-science-lab-scroll/g) || []).length, 1);
    assert.equal(html.split(TAG.trim()).length - 1, 1);
    assert.ok(!html.includes('<script data-science-lab-scroll>'));
  }

  assert.match(run('tools/install-scroll-receiver.mjs', ['--content-root', contentRoot]), /0 page changes/);
});

test('installer rejects an unknown receiver marker before writing', t => {
  const { contentRoot } = createFixture(t);
  const file = path.join(contentRoot, 'physics-middle/初中物理实验2.html');
  writeFileSync(file, readFileSync(file, 'utf8').replace(
    '</body>',
    '<script data-science-lab-scroll>unknown</script>\n</body>'
  ));
  expectFailure(() => install(contentRoot), /unknown receiver adapter/);
  assert.ok(!existsSync(path.join(contentRoot, ASSET)), 'validation must complete before any write');
});

test('checker rejects a missing receiver tag', t => {
  const { contentRoot, baseline } = createFixture(t);
  install(contentRoot);
  const file = path.join(contentRoot, 'physics-middle/初中物理实验2.html');
  writeFileSync(file, readFileSync(file, 'utf8').replace(TAG, ''));
  expectFailure(() => check(contentRoot, baseline), /receiver marker must occur once/);
});

test('checker rejects a duplicate receiver tag', t => {
  const { contentRoot, baseline } = createFixture(t);
  install(contentRoot);
  const file = path.join(contentRoot, 'physics-middle/初中物理实验2.html');
  writeFileSync(file, readFileSync(file, 'utf8').replace('</body>', `${TAG}</body>`));
  expectFailure(() => check(contentRoot, baseline), /receiver marker must occur once/);
});

test('checker rejects shared receiver drift', t => {
  const { contentRoot, baseline } = createFixture(t);
  install(contentRoot);
  writeFileSync(path.join(contentRoot, ASSET), `${RECEIVER}// drift\n`);
  expectFailure(() => check(contentRoot, baseline), /canonical receiver mismatch/);
});

test('checker rejects unrelated experiment changes', t => {
  const { contentRoot, baseline } = createFixture(t);
  install(contentRoot);
  const file = path.join(contentRoot, 'physics-middle/初中物理实验2.html');
  writeFileSync(file, readFileSync(file, 'utf8').replace(
    '<button id="mode">',
    '<p>unexpected</p><button id="mode">'
  ));
  expectFailure(() => check(contentRoot, baseline), /unexpected experiment source change/);
});
