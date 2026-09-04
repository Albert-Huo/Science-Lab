import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: { 'content-root': { type: 'string' }, 'base-ref': { type: 'string' } } });
assert.ok(values['content-root'], '--content-root is required');
if (values['base-ref']) assert.match(values['base-ref'], /^[0-9a-f]{40}$/);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiver = readFileSync(path.join(appRoot, 'experiment-scroll-receiver.js'), 'utf8');
const block = `<script data-science-lab-scroll>\n${receiver}</script>\n`;
for (const number of [1, 35, 41]) {
  const relative = `physics-middle/初中物理实验${number}.html`;
  const html = readFileSync(path.join(values['content-root'], relative), 'utf8');
  assert.equal(html.split(block).length, 2, `${relative}: exact receiver must occur once`);
  assert.equal((html.match(/data-science-lab-scroll/g) || []).length, 1, `${relative}: duplicate marker`);
  if (values['base-ref']) {
    const baseline = execFileSync('git', ['show', `${values['base-ref']}:${relative}`], { cwd: values['content-root'], encoding: 'utf8' });
    assert.equal(html.replace(block, ''), baseline, `${relative}: unexpected experiment source change`);
  }
  console.log(`Verified receiver and release boundary: ${relative}`);
}
