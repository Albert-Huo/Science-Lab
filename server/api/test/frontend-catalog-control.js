'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CatalogControl = require(path.resolve(__dirname, '../../../catalog-control.js'));

const fixtures = [
  { path: 'physics-middle/a.html', title: '初中实验 A', subject: '物理', level: '初中' },
  { path: 'physics-high/off.html', title: '高中实验 B', subject: '物理', level: '高中' },
  { path: 'physics-high/keep.html', title: '高中实验 C', subject: '物理', level: '高中' }
];

{
  const result = CatalogControl.apply(fixtures, {});
  assert.deepStrictEqual(result.experiments, fixtures, '缺少配置时应保持全部实验发布');
  assert.deepStrictEqual(result.states, {
    'physics-middle/a.html': 'published',
    'physics-high/off.html': 'published',
    'physics-high/keep.html': 'published'
  });
}

{
  const result = CatalogControl.apply(fixtures, {
    categories: { 'physics-high': { state: 'hidden' } },
    experiments: { 'physics-high/keep.html': { state: 'published' } }
  });
  assert.deepStrictEqual(
    result.experiments.map((item) => item.path),
    ['physics-middle/a.html', 'physics-high/keep.html'],
    '实验级规则应覆盖目录级规则'
  );
  assert.strictEqual(result.states['physics-high/off.html'], 'hidden');
}

{
  const result = CatalogControl.apply(fixtures, {
    experiments: { 'physics-high/off.html': { state: 'disabled' } }
  });
  assert.strictEqual(result.states['physics-high/off.html'], 'disabled');
  assert.ok(!result.experiments.some((item) => item.path === 'physics-high/off.html'));
}

{
  const result = CatalogControl.apply(fixtures, {
    categories: { 'physics-high': { state: 'typo' } },
    experiments: { 'physics-middle/a.html': null }
  });
  assert.strictEqual(result.experiments.length, fixtures.length, '非法状态应安全降级为 published');
}

{
  const result = CatalogControl.apply(fixtures, null);
  assert.strictEqual(result.experiments.length, fixtures.length, '损坏或空控制对象不应关闭已有内容');
}

{
  const visible = fixtures.slice(0, 2);
  const history = [
    { path: 'physics-middle/a.html' },
    { path: 'physics-middle/a.html' },
    { path: 'physics-high/keep.html' }
  ];
  assert.deepStrictEqual(CatalogControl.stats(visible, history), {
    total: 2,
    seen: 1,
    percent: 50
  });
  assert.deepStrictEqual(CatalogControl.stats([], history), {
    total: 0,
    seen: 0,
    percent: 0
  });
}

{
  const source = [
    fixtures[0],
    fixtures[1],
    fixtures[2],
    { path: 'physics-demos/d.html', title: '科普实验 D', subject: '物理', level: '科普演示' }
  ];
  const visible = [source[0], source[3]];
  assert.strictEqual(
    CatalogControl.initialIndex(source, visible, 'physics-middle/a.html', 0),
    0,
    '仍发布的已保存路径应精确恢复'
  );
  assert.strictEqual(
    CatalogControl.initialIndex(source, visible, 'physics-high/off.html', 1),
    1,
    '已隐藏的当前实验应前进到后续最近的可用实验'
  );
  assert.strictEqual(
    CatalogControl.initialIndex(source, visible, '', 99),
    1,
    '旧序号超出范围时应回退到最后一个可用实验'
  );
  assert.strictEqual(CatalogControl.initialIndex(source, [], '', 0), -1);
}

{
  const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
  assert.ok(html.includes('<script src="catalog-control.js"></script>'), '首页应加载目录发布控制模块');
  assert.ok(
    /fetchJson\('catalog-control\.json',\{cache:'no-store'\}\)/.test(html),
    '控制文件请求应绕过 HTTP 缓存'
  );
  assert.ok(
    html.includes('CatalogControl.apply(sourceManifest,control)'),
    '首页应在启动前应用目录发布控制'
  );
  assert.ok(
    html.includes("暂无开放实验"),
    '全部关闭时应显示稳定空状态'
  );
  assert.ok(html.includes('已从目录隐藏'), '旧历史中的 hidden 实验应有明确状态');
  assert.ok(html.includes('暂不可用'), '旧历史中的 disabled 实验应有明确状态');
  assert.ok(
    html.includes('CatalogControl.stats(MANIFEST,h)'),
    '学习统计应只计算当前发布的实验'
  );
}

{
  const root = path.resolve(__dirname, '../../..');
  const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const deployGuide = fs.readFileSync(path.join(root, 'docs/aliyun-deploy.md'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.match(
    serviceWorker,
    /const VERSION = 'v\d+\.\d+\.\d+';/,
    '部署前加固上线时应使用语义版本刷新 App 壳缓存'
  );
  assert.ok(
    serviceWorker.includes('const SHELL_CACHE = CACHE_PREFIX + VERSION;'),
    'App 壳缓存名应从当前版本派生'
  );
  assert.ok(serviceWorker.includes("'./catalog-control.js'"), '发布控制模块应进入离线 App 壳');
  assert.ok(serviceWorker.includes("'./content-source.js'"), '内容源解析模块应进入离线 App 壳');
  assert.ok(serviceWorker.includes("'./catalog-control.json'"), '发布控制配置应提供离线回退');
  assert.ok(
    serviceWorker.includes("url.pathname.endsWith('/catalog-control.json')"),
    '发布控制配置应使用网络优先策略'
  );
  assert.ok(readme.includes('## 目录发布控制'), 'README 应记录目录开关操作方法');
  assert.ok(deployGuide.includes('npm ci --omit=dev'), '生产依赖必须从 lock 文件安装');
  assert.ok(deployGuide.includes('set -euo pipefail'), '静态发布必须遇错即停');
  assert.ok(deployGuide.includes('content-source.js'), '内容源模块必须进入静态发布清单');
  assert.ok(
    deployGuide.includes('SCIENCE_LAB_SHELL_FILES=('),
    '静态发布必须定义完整的物理 App 壳文件清单'
  );
  [
    'index.html',
    'catalog-control.js',
    'content-source.js',
    'catalog-control.json',
    'manifest.json',
    'manifest.webmanifest',
    'assets/icons/icon-192.png',
    'assets/icons/icon-512.png',
    'assets/icons/icon-maskable-512.png',
    'assets/icons/apple-touch-icon.png'
  ].forEach((shellFile) => {
    assert.ok(
      deployGuide.includes(`"${shellFile}"`),
      `静态发布校验清单必须包含 ${shellFile}`
    );
  });
  assert.ok(
    /for SCIENCE_LAB_SHELL_FILE in "\$\{SCIENCE_LAB_SHELL_FILES\[@\]\}"; do[\s\S]*?test -f "\$SCIENCE_LAB_RELEASE_DIR\/\$SCIENCE_LAB_SHELL_FILE"[\s\S]*?done/.test(deployGuide),
    '静态发布切换前必须逐个校验物理 App 壳文件'
  );
  assert.ok(deployGuide.includes('JSON.parse'), '静态发布切换前必须解析 JSON 文件');
  assert.ok(deployGuide.includes('try_files $uri =404;'), '缺失静态资源必须返回 404');
  assert.ok(!deployGuide.includes('try_files $uri $uri/ /index.html;'), '静态站不得把缺失 JSON 回退为首页');
  assert.ok(deployGuide.includes('/var/www/science-lab-current'), 'nginx 必须指向原子切换的 release 链接');
  assert.ok(deployGuide.includes('science-lab-next'), '发布步骤必须先创建下一版本链接再原子替换');
  assert.ok(
    deployGuide.includes('limit_req_zone $binary_remote_addr zone=science_lab_ai:10m rate=10r/m;'),
    'nginx http 上下文必须定义 AI 突发限流区'
  );
  assert.ok(
    deployGuide.includes('location = /api/ai/chat/completions {'),
    'nginx 必须为匿名 AI 接口定义精确 location'
  );
  assert.ok(
    deployGuide.includes('limit_req zone=science_lab_ai burst=3 nodelay;'),
    'nginx AI 精确 location 必须启用突发保护'
  );
  assert.ok(
    deployGuide.includes('location = /catalog-control.json {'),
    'nginx 必须为目录控制 JSON 定义精确 location'
  );
  assert.ok(
    deployGuide.includes('location = /manifest.json {'),
    'nginx 必须为清单 JSON 定义精确 location'
  );
  assert.ok(deployGuide.includes('### 仅回滚静态页面'), '静态页面回滚必须是独立操作');
  assert.ok(deployGuide.includes('### 仅回滚 Node API'), 'Node API 回滚必须是独立操作');
  assert.ok(deployGuide.includes('deepseek-v4-flash'), '真实 AI 验证必须使用当前模型');
  assert.ok(
    /install -m 644 index\.html catalog-control\.js content-source\.js catalog-control\.json manifest\.json manifest\.webmanifest sw\.js/.test(deployGuide),
    '原子发布必须复制全部 App 壳文件'
  );
  assert.ok(
    packageJson.scripts.test.includes('node test/frontend-catalog-control.js'),
    '统一测试命令应包含目录发布控制回归测试'
  );
}

console.log('✓ 目录发布控制解析、页面接入、缓存与发布契约检查通过');
