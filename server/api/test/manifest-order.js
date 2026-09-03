'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, after } = require('node:test');
const CatalogControl = require('../../../catalog-control.js');

const repoRoot = path.resolve(__dirname, '../../..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'science-lab-manifest-order-'));
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

const contentRoot = path.join(fixtureRoot, 'content');
const toolsRoot = path.join(fixtureRoot, 'tools');
fs.mkdirSync(toolsRoot);
const generator = path.join(toolsRoot, 'build-manifest.py');
fs.copyFileSync(path.join(repoRoot, 'tools/build-manifest.py'), generator);

const expectedNumbers = ['1', '2', '9', '10', '12-1', '12-2', '12-10', '49', '49-1', '49-2', '49-10', '68', '100'];
const expectedNames = expectedNumbers.map(number => `初中物理实验${number}.html`);
const fixtures = [
  ['physics-middle', '物理', '初中', [...expectedNames].reverse().concat('说明.html')],
  ['physics-high', '物理', '高中', ['实验2.html', '实验10.html', '实验1.html']],
  ['physics-demos', '物理', '科普演示', ['演示2.html', '演示10.html', '演示1.html']],
  ['biology-high', '生物', '高中', ['实验2.html', '实验10.html', '实验1.html']]
];
const expectedItems = [];
for (const [directory, subject, level, filenames] of fixtures) {
  const target = path.join(contentRoot, directory);
  fs.mkdirSync(target, { recursive: true });
  for (const filename of filenames) {
    const title = `标题 ${filename}`;
    fs.writeFileSync(path.join(target, filename), `<title>${title}</title>`, 'utf8');
    expectedItems.push({ path: `${directory}/${filename}`, title, subject, level });
  }
  fs.writeFileSync(path.join(target, 'README.md'), 'not an experiment', 'utf8');
}
execFileSync('python3', [generator, contentRoot], { encoding: 'utf8', timeout: 10000 });
const generated = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
const middlePaths = items => items.filter(item => item.path.startsWith('physics-middle/')).map(item => item.path);

test('生成清单按主编号、子编号排序，主实验排在子实验前', () => {
  assert.deepEqual(middlePaths(generated), [...expectedNames, '说明.html'].map(name => `physics-middle/${name}`));
});

test('生成清单保留标题、路径和分类，并忽略非 HTML 文件', () => {
  const byPath = items => Object.fromEntries(items.map(item => [item.path, item]));
  assert.equal(generated.length, expectedItems.length);
  assert.deepEqual(byPath(generated), byPath(expectedItems));
});

test('其他目录保留原有文件名排序和分类顺序', () => {
  const expected = fixtures.slice(1).flatMap(([directory, , , filenames]) =>
    [...filenames].sort().map(filename => `${directory}/${filename}`));
  assert.deepEqual(generated.slice(expectedNames.length + 1).map(item => item.path), expected);
});

test('仓库清单中的编号实验按数字排序，不限制实验数量', () => {
  const numbered = middlePaths(manifest).filter(item => /初中物理实验\d+(?:-\d+)*\.html$/.test(item));
  assert.ok(numbered.length > 0, '清单应包含初中物理编号实验');
  const expected = [...numbered].sort((left, right) =>
    left.slice(0, -5).localeCompare(right.slice(0, -5), 'zh-CN', { numeric: true }));
  assert.deepEqual(numbered, expected);
});

test('发布过滤保留顺序，按路径保存的浏览位置在重排后仍指向原实验', () => {
  const hiddenPath = 'physics-middle/初中物理实验2.html';
  const control = {
    categories: { 'physics-high': { state: 'hidden' }, 'biology-high': { state: 'hidden' } },
    experiments: { [hiddenPath]: { state: 'hidden' } }
  };
  const visible = CatalogControl.apply(generated, control).experiments;
  const expectedPublishedPaths = [...expectedNames, '说明.html']
    .map(name => `physics-middle/${name}`).filter(item => item !== hiddenPath);
  assert.deepEqual(middlePaths(visible), expectedPublishedPaths);
  for (const savedPath of expectedPublishedPaths) {
    const index = CatalogControl.initialIndex(generated, visible, savedPath, 0);
    assert.equal(visible[index].path, savedPath);
  }
});
