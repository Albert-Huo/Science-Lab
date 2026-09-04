import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_COUNT = 70;
const ASSET = 'experiment-scroll-receiver.v1.js';
const TARGET_PATTERN = /^初中物理实验(?:\d+|\d+-\d+)\.html$/;
const { values } = parseArgs({ options: { 'content-root': { type: 'string' }, 'base-ref': { type: 'string' } } });
assert.ok(values['content-root'], '--content-root is required');
if (values['base-ref']) assert.match(values['base-ref'], /^[0-9a-f]{40}$/);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentRoot = path.resolve(values['content-root']);
const receiver = readFileSync(path.join(appRoot, 'experiment-scroll-receiver.js'), 'utf8');
const tag = `<script src="../${ASSET}" data-science-lab-scroll></script>\n`;
const legacyBlock = `<script data-science-lab-scroll>\n${receiver}</script>\n`;
const files = readdirSync(path.join(contentRoot, 'physics-middle'))
  .filter(file => TARGET_PATTERN.test(file))
  .sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }));

assert.equal(files.length, EXPECTED_COUNT, 'physics-middle experiment count');
assert.equal(
  readFileSync(path.join(contentRoot, ASSET), 'utf8'),
  receiver,
  `${ASSET}: canonical receiver mismatch`
);

function stripReceiver(html) {
  if (html.includes(tag)) return html.replace(tag, '');
  if (html.includes(legacyBlock)) return html.replace(legacyBlock, '');
  return html;
}

for (const file of files) {
  const relative = `physics-middle/${file}`;
  const html = readFileSync(path.join(contentRoot, relative), 'utf8');
  const markerCount = (html.match(/data-science-lab-scroll/g) || []).length;
  const externalCount = html.split(tag).length - 1;
  assert.equal(markerCount, 1, `${relative}: receiver marker must occur once`);
  assert.equal(externalCount, 1, `${relative}: versioned receiver tag must occur once`);
  assert.equal(html.split(`${tag}</body>`).length - 1, 1, `${relative}: receiver tag must precede closing body`);
  assert.ok(!html.includes(legacyBlock), `${relative}: inline receiver must be removed`);
  if (values['base-ref']) {
    const baseline = execFileSync('git', ['show', `${values['base-ref']}:${relative}`], {
      cwd: contentRoot,
      encoding: 'utf8'
    });
    assert.equal(stripReceiver(html), stripReceiver(baseline), `${relative}: unexpected experiment source change`);
  }
}

console.log(`Verified ${files.length} middle-school experiments and the versioned receiver release boundary.`);
