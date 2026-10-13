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
  ['physics-popular-science', '物理', '科普演示', ['演示2.html', '演示10.html', '演示1.html']],
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

test('已核对的开发备注仅改变展示名称，保留路径和教学描述', () => {
  const displayRoot = path.join(fixtureRoot, 'display-content');
  const titles = [
    ['physics-middle/初中物理实验2.html', '初中物理实验2｜探究晶体熔化和凝固的过程及特点（三模式优化版）', '初中物理实验2｜探究晶体熔化和凝固的过程及特点'],
    ['physics-high/平抛与自由落体 1.html', '平抛与自由落体演示（优化版）', '平抛与自由落体演示'],
    ['physics-high/平抛与自由落体 2-加电梯.html', '自由落体电梯演示（最终修正版）', '自由落体电梯演示'],
    ['physics-popular-science/为什么冰刀在冰上那么滑交互版.html', '冰刀为何在冰上那么滑 · 互动演示（放大镜与命中修复）', '冰刀为何在冰上那么滑 · 互动演示'],
    ['physics-popular-science/小狗听到的声交互版.html', '小狗听到的声｜交互闯关（模板同款+自动判定｜最终版）', '小狗听到的声 · 互动实验'],
    ['physics-middle/其他实验.html', '温度测量（学生必做）', '温度测量（学生必做）'],
    ['physics-high/未知演示.html', '自由落体（对比版）', '自由落体（对比版）'],
  ];
  for (const [relative, title] of titles) {
    const file = path.join(displayRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive:true });
    fs.writeFileSync(file, `<title>${title}</title>`);
  }
  execFileSync('python3', [generator, displayRoot], { encoding:'utf8' });
  const items = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
  assert.equal(items.length, titles.length);
  for (const [relative, , expected] of titles) {
    const item = items.find(entry => entry.path === relative);
    assert.ok(item, `路径仍有效：${relative}`);
    assert.equal(item.title, expected);
  }
  fs.writeFileSync(path.join(displayRoot, titles[0][0]), '<title>新教学名称（对照观察）</title>');
  execFileSync('python3', [generator, displayRoot], { encoding:'utf8' });
  const updated = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
  assert.equal(updated.find(item => item.path === titles[0][0]).title, '新教学名称（对照观察）', '来源教学名称变化时不可被旧映射覆盖');
});
