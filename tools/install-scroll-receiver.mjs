import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const EXPECTED_COUNT = 70;
const ASSET = 'experiment-scroll-receiver.v2.js';
const PREVIOUS_ASSETS = ['experiment-scroll-receiver.v1.js'];
const TARGET_PATTERN = /^初中物理实验(?:\d+|\d+-\d+)\.html$/;
const { values } = parseArgs({
  options: {
    'content-root': { type: 'string' },
    apply: { type: 'boolean', default: false }
  }
});

assert.ok(values['content-root'], '--content-root is required');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentRoot = path.resolve(values['content-root']);
const experimentRoot = path.join(contentRoot, 'physics-middle');
const receiver = readFileSync(path.join(appRoot, 'experiment-scroll-receiver.js'), 'utf8');
const tag = `<script src="../${ASSET}" data-science-lab-scroll></script>\n`;
const previousTags = PREVIOUS_ASSETS.map(asset => `<script src="../${asset}" data-science-lab-scroll></script>\n`);
const legacyBlock = `<script data-science-lab-scroll>\n${receiver}</script>\n`;
const files = readdirSync(experimentRoot)
  .filter(file => TARGET_PATTERN.test(file))
  .sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }));

assert.equal(
  files.length,
  EXPECTED_COUNT,
  `physics-middle experiment count: expected ${EXPECTED_COUNT}, got ${files.length}`
);

const sharedPath = path.join(contentRoot, ASSET);
const assetExists = existsSync(sharedPath);
if (assetExists) {
  assert.equal(
    readFileSync(sharedPath, 'utf8'),
    receiver,
    `${ASSET}: existing shared receiver does not match canonical receiver`
  );
}

const changes = files.map(file => {
  const relative = path.join('physics-middle', file);
  const absolute = path.join(contentRoot, relative);
  const html = readFileSync(absolute, 'utf8');
  const markerCount = (html.match(/data-science-lab-scroll/g) || []).length;

  if (markerCount > 1) {
    assert.fail(`${relative}: duplicate receiver marker`);
  }
  if (markerCount === 1) {
    if (html.includes(tag)) return null;
    for (const previousTag of previousTags) {
      if (html.includes(previousTag)) return { absolute, content: html.replace(previousTag, tag) };
    }
    if (html.includes(legacyBlock)) {
      return { absolute, content: html.replace(legacyBlock, tag) };
    }
    assert.fail(`${relative}: unknown receiver adapter`);
  }

  assert.match(html, /<\/body>/i, `${relative}: closing body tag is required`);
  return { absolute, content: html.replace(/<\/body>/i, `${tag}</body>`) };
}).filter(Boolean);

if (values.apply) {
  if (!assetExists) writeFileSync(sharedPath, receiver);
  for (const change of changes) writeFileSync(change.absolute, change.content);
}

const action = values.apply ? 'Applied' : 'Would apply';
console.log(`${action} ${changes.length} page changes and ${assetExists ? 0 : 1} asset change.`);
