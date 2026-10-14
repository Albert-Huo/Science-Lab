'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const CatalogControl = require('../../../catalog-control.js');

const root = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const topics = ['测量与实验基本操作', '运动与力', '声现象', '光现象', '物态变化与热学', '压强与浮力', '功、能和机械', '电学', '磁学与电磁现象', '综合探究'];
const item = (name, extra = {}) => ({ path: `physics-middle/${name}.html`, title: name, subject: '物理', level: '初中', ...extra });

test('新目录脚本跟随当前App版本，避免已缓存旧模块缺少新能力', () => {
  const version = html.match(/experiment-scroll\.js\?app=([^"]+)/)[1];
  assert.ok(html.includes('<script src="catalog-control.js?app='+version+'"></script>'));
});

test('初中70个实验均有知识分类和原编号，开发备注不作为展示标题', () => {
  const middle = manifest.filter(entry => entry.path.startsWith('physics-middle/'));
  assert.equal(middle.length, 70);
  for (const entry of middle) {
    assert.ok(topics.includes(entry.topic), entry.path + ' 缺少已审查的知识分类');
    assert.equal(entry.topicOrder, topics.indexOf(entry.topic));
    assert.equal(entry.number, entry.path.match(/实验(\d+(?:-\d+)?)\.html$/)[1]);
    assert.ok(Array.isArray(entry.keywords) && entry.keywords.length > 0);
  }
  for (const entry of manifest) {
    assert.doesNotMatch(entry.title, /最终|修复|优化版|模板同款|帽扣|严格步骤判定|交互版|互动闯关|交互闯关|第三关|终极|逼真人物版|空间感增强/);
  }
});

test('主分类依据教学目标，跨主题通过关键词检索', () => {
  const expected = { '11':'测量与实验基本操作', '18':'运动与力', '20':'运动与力', '26':'功、能和机械', '54':'功、能和机械', '66':'电学', '68':'综合探究' };
  for (const [number, topic] of Object.entries(expected)) {
    assert.equal(manifest.find(entry => entry.path === `physics-middle/初中物理实验${number}.html`).topic, topic);
  }
  assert.equal(typeof CatalogControl.matchesSearch, 'function', '需要真实关键词检索');
  const heating = manifest.find(entry => entry.path === 'physics-middle/初中物理实验66.html');
  assert.equal(CatalogControl.matchesSearch(heating, '热学 焦耳'), true);
});

test('目录只归并已核对的同内容，源数组及所有别名入口不变', () => {
  assert.equal(typeof CatalogControl.catalogIndexes, 'function', '需要保持旧地址的目录代表映射');
  const source = [item('主课'), item('另一课'), item('旧入口', { catalogAliasOf:'physics-middle/主课.html' })];
  const original = JSON.stringify(source);
  assert.deepEqual(CatalogControl.catalogIndexes(source), [0, 1, 0]);
  assert.equal(JSON.stringify(source), original);
  assert.deepEqual(CatalogControl.apply(source, {}).experiments.map(entry => entry.path), source.map(entry => entry.path));
  assert.equal(CatalogControl.initialIndex(source, source, source[2].path, 0), 2, '旧分享/历史仍加载原别名文件');
  const sun = manifest.findIndex(entry => entry.path === 'physics-popular-science/太阳忽然消失后的地球交互版.html');
  const sunAlias = manifest.findIndex(entry => entry.path === 'physics-popular-science/太阳消失后的地球交互版.html');
  assert.ok(sun >= 0 && sunAlias >= 0);
  assert.equal(CatalogControl.catalogIndexes(manifest)[sunAlias], sun);
});

test('代表被隐藏、缺失、跨学段或循环时，不丢掉别名入口', () => {
  assert.equal(typeof CatalogControl.catalogIndexes, 'function');
  const source = [item('主课'), item('旧入口', { catalogAliasOf:'physics-middle/主课.html' })];
  const visible = CatalogControl.apply(source, { experiments:{ [source[0].path]:'hidden' } }).experiments;
  assert.deepEqual(CatalogControl.catalogIndexes(visible), [0]);
  assert.deepEqual(CatalogControl.catalogIndexes([item('缺失', { catalogAliasOf:'missing.html' })]), [0]);
  assert.deepEqual(CatalogControl.catalogIndexes([item('主课', { level:'高中' }), source[1]]), [0, 1]);
  assert.deepEqual(CatalogControl.catalogIndexes([
    item('A', { catalogAliasOf:'physics-middle/B.html' }), item('B', { catalogAliasOf:'physics-middle/A.html' })
  ]), [0, 1]);
});

test('知识分类按教材主题顺序呈现，条目保留原导航索引', () => {
  assert.equal(typeof CatalogControl.topicSections, 'function');
  const source = [item('反射', { topic:'光现象', topicOrder:3 }), item('摩擦', { topic:'运动与力', topicOrder:1 }), item('其他')];
  assert.deepEqual(CatalogControl.topicSections(source, [0, 1, 2]), [
    { title:'运动与力', indexes:[1] }, { title:'光现象', indexes:[0] }, { title:'', indexes:[2] }
  ]);
});

test('搜索支持分类、原编号、关键词、多个词及大小写', () => {
  assert.equal(typeof CatalogControl.matchesSearch, 'function');
  const lesson = item('色光的混合', { topic:'光现象', number:'43', keywords:['初中物理实验43', 'RGB', '三原色'] });
  for (const query of ['', '光现象', 'rgb', '实验43', 'RGB 三原色']) assert.equal(CatalogControl.matchesSearch(lesson, query), true, query);
  assert.equal(CatalogControl.matchesSearch(lesson, 'RGB 热学'), false);
});

test('货船故事检索实际低频声主题，不误归到浮力或淡水', () => {
  const lesson = manifest.find(entry => entry.path === 'physics-popular-science/货船神秘失踪交互版.html');
  assert.equal(CatalogControl.matchesSearch(lesson, '次声波'), true);
  assert.equal(CatalogControl.matchesSearch(lesson, '低频 共振'), true);
  assert.equal(CatalogControl.matchesSearch(lesson, '浮力'), false);
  assert.equal(CatalogControl.matchesSearch(lesson, '淡水'), false);
});

test('相近主题的关键词区分实际器材、方法和观察证据', () => {
  const lesson = path => manifest.find(entry => entry.path === path);
  const absent = [
    ['physics-popular-science/声的频谱有声交互版.html', '音叉'],
    ['physics-popular-science/三原色光交互版-模板.html', '遮光片'],
    ['physics-high/高中物理_凸透镜成像.html', '光具座'],
    ['physics-popular-science/千里江陵一日还-单程修正版.html', '逆流'],
    ['physics-popular-science/双缝干涉观测与否交互版.html', '粒子采样'],
  ];
  for (const [path, word] of absent) assert.equal(CatalogControl.matchesSearch(lesson(path), word), false, path+' 不提供 '+word);
  assert.equal(CatalogControl.matchesSearch(lesson('physics-middle/初中物理实验35.html'), '音叉'), true);
  assert.equal(CatalogControl.matchesSearch(lesson('physics-middle/初中物理实验43.html'), '遮光片'), true);
  assert.equal(CatalogControl.matchesSearch(lesson('physics-middle/初中物理实验39.html'), '光具座'), true);
  assert.equal(CatalogControl.matchesSearch(lesson('physics-popular-science/千里江陵一日还.html'), '逆流'), true);
  assert.equal(CatalogControl.matchesSearch(lesson('physics-popular-science/波粒二象性交互版.html'), '粒子采样'), true);
});

test('历史记录名称使用当前清单，已隐藏实验也不展示旧开发备注', () => {
  assert.equal(typeof CatalogControl.historyTitle, 'function');
  const source = [item('现在名称')];
  const old = { path:source[0].path, title:'旧名称（最终版）' };
  assert.equal(CatalogControl.historyTitle(old, source), '现在名称');
  assert.equal(CatalogControl.historyTitle({ path:'removed.html', title:'此前实验' }, source), '此前实验');
  const start = html.indexOf('function renderHist(){');
  const end = html.indexOf("document.getElementById('histList').addEventListener", start);
  const element = { innerHTML:'' };
  const context = vm.createContext({ document:{ getElementById:()=>element }, loadHist:()=>[old], MANIFEST:[], SOURCE_MANIFEST:source, CatalogControl,
    PUBLISHING_STATES:{ [old.path]:'hidden' }, Date, esc:value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;') });
  vm.runInContext(html.slice(start, end)+'\nrenderHist();', context);
  assert.match(element.innerHTML, /现在名称/);
  assert.doesNotMatch(element.innerHTML, /最终版/);
  assert.match(element.innerHTML, /已从目录隐藏/);
});

test('真实目录渲染将别名高亮至代表，分类搜索仍使用原导航索引', () => {
  const source = [item('形变', { topic:'运动与力', topicOrder:1, number:'19' }),
    item('反射', { topic:'光现象', topicOrder:3, number:'36', keywords:['反射角'] }),
    item('反射旧入口', { topic:'光现象', topicOrder:3, catalogAliasOf:'physics-middle/反射.html' })];
  const nodes = new Map();
  const node = id => { if(!nodes.has(id)) nodes.set(id, { innerHTML:'', handlers:{}, addEventListener(kind,fn){ this.handlers[kind]=fn; } });return nodes.get(id); };
  const context = vm.createContext({ document:{ getElementById:node, querySelectorAll:()=>[] }, MANIFEST:source, CatalogControl, cur:2, goTo:()=>{}, closePanels:()=>{},
    esc:value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;') });
  const start = html.indexOf('/* ---------- catalog ---------- */');
  const end = html.indexOf('/* ---------- panels ---------- */', start);
  vm.runInContext(html.slice(start,end)+'\nrenderChips();renderCat();', context);
  assert.match(node('catList').innerHTML, /运动与力/);
  assert.match(node('catList').innerHTML, /光现象/);
  assert.match(node('catList').innerHTML, /class="cat-item cur" data-i="1"/);
  assert.doesNotMatch(node('catList').innerHTML, /反射旧入口/);
  assert.match(node('catList').innerHTML, /class="no">36</);
  node('catInput').handlers.input({ target:{ value:'反射角' } });
  assert.match(node('catList').innerHTML, /data-i="1"/);
  assert.doesNotMatch(node('catList').innerHTML, /形变/);
});
