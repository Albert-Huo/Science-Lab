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

function fencedBlock(markdown, language, marker) {
  const pattern = new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g');
  for (const match of markdown.matchAll(pattern)) {
    if (match[1].includes(marker)) return match[1];
  }
  assert.fail(`缺少 ${language} 代码块：${marker}`);
}

function braceBlock(source, opening, message) {
  const start = source.indexOf(opening);
  assert.notStrictEqual(start, -1, message);
  const openingBrace = source.indexOf('{', start);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${message}（块未闭合）`);
}

function occurrenceCount(source, value) {
  return source.split(value).length - 1;
}

function activeConfig(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/\s*#.*$/, '').trim())
    .filter(Boolean)
    .join('\n');
}

const NEW_RELEASE_LINK =
  'sudo ln -sfn "$SCIENCE_LAB_RELEASE_DIR" /var/www/science-lab-next';
const CURRENT_RELEASE_SWITCH =
  'sudo mv -Tf /var/www/science-lab-next /var/www/science-lab-current';
const CANONICAL_AI_PROXY = 'proxy_pass http://127.0.0.1:8970/ai/chat/completions;';
const AI_RATE_ZONE = 'limit_req_zone $binary_remote_addr zone=science_lab_ai:10m rate=10r/m;';
const CANONICAL_AI_DIRECTIVES = [
  'limit_req zone=science_lab_ai burst=3 nodelay;',
  'limit_req_status 429;',
  CANONICAL_AI_PROXY,
  'proxy_http_version 1.1;',
  'proxy_set_header Connection "";',
  'proxy_set_header Host $host;',
  'proxy_set_header X-Real-IP $remote_addr;',
  'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  'proxy_set_header X-Forwarded-Proto $scheme;',
  'proxy_buffering off;',
  'proxy_cache off;',
  'proxy_read_timeout 300s;'
];

function assertAtomicReleaseSwitch(staticDeployBlock) {
  const activeLines = activeConfig(staticDeployBlock).split('\n');
  assert.strictEqual(
    activeLines.filter((line) => line === NEW_RELEASE_LINK).length,
    1,
    '静态发布必须创建唯一的新 release 符号链接'
  );
  assert.strictEqual(
    activeLines.filter((line) => line === CURRENT_RELEASE_SWITCH).length,
    1,
    '静态发布必须执行唯一的 current 原子切换'
  );
  const newReleaseLink = activeLines.indexOf(NEW_RELEASE_LINK);
  assert.strictEqual(
    activeLines[newReleaseLink + 1],
    CURRENT_RELEASE_SWITCH,
    '新 release 符号链接必须直接馈入 current 原子切换'
  );
}

function assertCanonicalAiLocation(nginxBlock) {
  const canonicalAiBlock = braceBlock(
    activeConfig(nginxBlock),
    'location = /api/ai/chat/completions {',
    'nginx 必须为匿名 AI 接口定义活动的精确 location'
  );
  CANONICAL_AI_DIRECTIVES.forEach((directive) => {
    assert.ok(canonicalAiBlock.includes(directive), `AI 精确 location 缺少活动指令 ${directive}`);
  });
  return canonicalAiBlock;
}

function assertActiveRateZonePlacement(nginxBlock) {
  const activeNginxBlock = activeConfig(nginxBlock);
  const firstServer = activeNginxBlock.match(/^server \{/m);
  assert.ok(firstServer, 'nginx 示例必须包含活动的 server 配置');
  const activeHttpContext = activeNginxBlock.slice(0, firstServer.index);
  assert.strictEqual(
    occurrenceCount(activeNginxBlock, AI_RATE_ZONE),
    1,
    'AI 限流区必须只定义一次活动指令'
  );
  assert.ok(
    activeHttpContext.includes(AI_RATE_ZONE),
    'AI 限流区必须位于活动的 http 上下文并先于 server 配置'
  );
}

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
  assert.ok(serviceWorker.includes("const SCROLL_ASSET = './experiment-scroll.js?app=' + VERSION;"), '内容滚动模块地址应随 App 版本更新');
  assert.ok(serviceWorker.includes('  SCROLL_ASSET,'), '版本化内容滚动模块应进入离线 App 壳');
  assert.ok(serviceWorker.includes("'./catalog-control.json'"), '发布控制配置应提供离线回退');
  assert.ok(
    serviceWorker.includes("url.pathname.endsWith('/catalog-control.json')"),
    '发布控制配置应使用网络优先策略'
  );
  assert.ok(readme.includes('## 目录发布控制'), 'README 应记录目录开关操作方法');
  assert.ok(deployGuide.includes('npm ci --omit=dev'), '生产依赖必须从 lock 文件安装');
  const shellFiles = [
    'index.html',
    'catalog-control.js',
    'content-source.js',
    'experiment-scroll.js',
    'catalog-control.json',
    'manifest.json',
    'manifest.webmanifest',
    'assets/icons/icon-192.png',
    'assets/icons/icon-512.png',
    'assets/icons/icon-maskable-512.png',
    'assets/icons/apple-touch-icon.png'
  ];
  const staticDeployBlock = fencedBlock(deployGuide, 'bash', '# 在仓库根目录执行');
  assert.ok(staticDeployBlock.includes('set -euo pipefail'), '静态发布必须遇错即停');
  const shellArray = staticDeployBlock.match(/SCIENCE_LAB_SHELL_FILES=\(\n([\s\S]*?)\n\)/);
  assert.ok(shellArray, '静态发布必须定义完整的物理 App 壳文件清单');
  const documentedShellFiles = Array.from(shellArray[1].matchAll(/^\s+"([^"]+)"$/gm), (match) => match[1]);
  assert.deepStrictEqual(documentedShellFiles, shellFiles, '静态发布校验清单必须精确包含十一个物理壳文件');
  assert.ok(
    /for SCIENCE_LAB_SHELL_FILE in "\$\{SCIENCE_LAB_SHELL_FILES\[@\]\}"; do[\s\S]*?test -f "\$SCIENCE_LAB_RELEASE_DIR\/\$SCIENCE_LAB_SHELL_FILE"[\s\S]*?done/.test(staticDeployBlock),
    '静态发布切换前必须逐个校验物理 App 壳文件'
  );
  assert.ok(staticDeployBlock.includes('JSON.parse'), '静态发布切换前必须解析 JSON 文件');
  const previousCapture = staticDeployBlock.indexOf('if [ -L /var/www/science-lab-current ]; then');
  const currentSwitch = staticDeployBlock.indexOf(CURRENT_RELEASE_SWITCH);
  assert.ok(previousCapture >= 0 && previousCapture < currentSwitch, '切换前必须持久保存现有静态 release');
  const previousPersistBlock = staticDeployBlock.slice(previousCapture, currentSwitch);
  assert.ok(
    previousPersistBlock.includes('readlink -f /var/www/science-lab-current') &&
      previousPersistBlock.includes('/var/www/science-lab-releases/*') &&
      previousPersistBlock.includes('test -d "$SCIENCE_LAB_PREVIOUS_RELEASE"'),
    '旧 release 必须解析并限制在 release 根目录内'
  );
  assert.ok(
    previousPersistBlock.includes('sudo ln -sfn "$SCIENCE_LAB_PREVIOUS_RELEASE" /var/www/science-lab-previous-next') &&
      previousPersistBlock.includes('sudo chown -h root:root /var/www/science-lab-previous-next') &&
      previousPersistBlock.includes('sudo mv -Tf /var/www/science-lab-previous-next /var/www/science-lab-previous'),
    '旧 release 必须通过临时符号链接原子持久化'
  );
  assert.ok(
    staticDeployBlock.includes('sudo chown -R root:root "$SCIENCE_LAB_RELEASE_DIR"') &&
      staticDeployBlock.includes('-type d -exec chmod 755') &&
      staticDeployBlock.includes('-type f -exec chmod 644'),
    '静态 release 必须统一为 root:root、目录 755、文件 644'
  );
  assert.ok(
    staticDeployBlock.includes('test -r "$SCIENCE_LAB_RELEASE_DIR/$SCIENCE_LAB_SHELL_FILE"') &&
      staticDeployBlock.includes('SCIENCE_LAB_UNREADABLE_FILE='),
    '切换前必须验证 App 壳和全部 release 文件可读'
  );
  assertAtomicReleaseSwitch(staticDeployBlock);
  const deployWithoutNewReleaseLink = staticDeployBlock.replace(NEW_RELEASE_LINK, '');
  assert.throws(
    () => assertAtomicReleaseSwitch(deployWithoutNewReleaseLink),
    /静态发布必须创建唯一的新 release 符号链接/,
    '删除新 release 符号链接命令时契约测试必须失败'
  );

  const postSwitchBlock = staticDeployBlock.slice(currentSwitch);
  assert.ok(postSwitchBlock.includes('SCIENCE_LAB_PUBLIC_URL="https://lab.xingnian.net.cn"'));
  assert.ok(
    postSwitchBlock.includes('"$SCIENCE_LAB_PUBLIC_URL/"') &&
      postSwitchBlock.includes('test "$SCIENCE_LAB_HTTP_STATUS" = "200"'),
    '切换后首页必须精确返回 HTTP 200'
  );
  assert.ok(
    /for SCIENCE_LAB_SHELL_FILE in "\$\{SCIENCE_LAB_SHELL_FILES\[@\]\}"; do[\s\S]*?"\$SCIENCE_LAB_PUBLIC_URL\/\$SCIENCE_LAB_SHELL_FILE"[\s\S]*?test "\$SCIENCE_LAB_HTTP_STATUS" = "200"[\s\S]*?done/.test(postSwitchBlock),
    '切换后十个物理 App 壳 URL 必须逐个精确返回 HTTP 200'
  );
  assert.ok(
    /for SCIENCE_LAB_JSON_FILE in "catalog-control\.json" "manifest\.json"; do[\s\S]*?Content-Type:[\s\S]*?application\/json[\s\S]*?Cache-Control:[\s\S]*?no-cache[\s\S]*?done/.test(postSwitchBlock),
    '切换后两个 JSON 必须校验类型与 no-cache'
  );
  assert.ok(
    postSwitchBlock.includes('"$SCIENCE_LAB_PUBLIC_URL/__science-lab-missing.json"') &&
      postSwitchBlock.includes('test "$SCIENCE_LAB_MISSING_JSON_STATUS" = "404"'),
    '切换后必须确认缺失 JSON 返回 404'
  );

  assert.ok(deployGuide.includes('try_files $uri =404;'), '缺失静态资源必须返回 404');
  assert.ok(!deployGuide.includes('try_files $uri $uri/ /index.html;'), '静态站不得把缺失 JSON 回退为首页');
  assert.ok(deployGuide.includes('/var/www/science-lab-current'), 'nginx 必须指向原子切换的 release 链接');
  const nginxBlock = fencedBlock(deployGuide, 'nginx', 'server_name lab.xingnian.net.cn');
  const activeNginxBlock = activeConfig(nginxBlock);
  const firstServer = nginxBlock.match(/^server \{/m);
  assert.ok(firstServer, 'nginx 示例必须包含 server 配置');
  const httpContextSnippet = nginxBlock.slice(0, firstServer.index);
  assert.ok(
    httpContextSnippet.includes('http {}') &&
      httpContextSnippet.includes('server {} 之外'),
    'nginx 注释必须说明限流区属于 http 上下文且位于 server 之外'
  );
  assertActiveRateZonePlacement(nginxBlock);
  const nginxWithZoneInsideServer = nginxBlock
    .replace(AI_RATE_ZONE, `# ${AI_RATE_ZONE}`)
    .replace(/^server \{$/m, `server {\n    ${AI_RATE_ZONE}`);
  assert.throws(
    () => assertActiveRateZonePlacement(nginxWithZoneInsideServer),
    /AI 限流区必须位于活动的 http 上下文并先于 server 配置/,
    '仅在 server 内定义活动限流区时契约测试必须失败'
  );
  assertCanonicalAiLocation(nginxBlock);
  const nginxWithCommentedCanonicalProxy = nginxBlock.replace(
    CANONICAL_AI_PROXY,
    `# ${CANONICAL_AI_PROXY}`
  );
  assert.throws(
    () => assertCanonicalAiLocation(nginxWithCommentedCanonicalProxy),
    /AI 精确 location 缺少活动指令 proxy_pass/,
    '注释 canonical proxy_pass 时契约测试必须失败'
  );
  const variantAiBlock = braceBlock(
    activeNginxBlock,
    'location ~* ^/api/ai/chat/completions/?$ {',
    'nginx 必须通过活动 guard 拒绝 AI 路径大小写和尾斜杠变体'
  );
  assert.ok(variantAiBlock.includes('return 404;'), 'AI 路径变体必须通过活动指令返回 404');
  assert.ok(
    nginxBlock.includes('nginx 精确匹配优先') && nginxBlock.includes('大小写或尾斜杠变体'),
    'nginx 示例必须解释规范路径优先且变体被拒绝'
  );
  assert.ok(
    activeNginxBlock.indexOf('location = /api/ai/chat/completions {') <
      activeNginxBlock.indexOf('location ~* ^/api/ai/chat/completions/?$ {') &&
      activeNginxBlock.indexOf('location ~* ^/api/ai/chat/completions/?$ {') <
      activeNginxBlock.indexOf('location /api/ {'),
    'AI 精确 location 和变体 guard 必须位于通用 /api/ 之前'
  );
  ['/catalog-control.json', '/manifest.json'].forEach((jsonPath) => {
    const jsonBlock = braceBlock(
      activeNginxBlock,
      `location = ${jsonPath} {`,
      `nginx 必须为 ${jsonPath} 定义活动的精确 location`
    );
    assert.ok(jsonBlock.includes('try_files $uri =404;'), `${jsonPath} 缺少活动的 try_files 404`);
    assert.ok(
      jsonBlock.includes('add_header Cache-Control "no-cache" always;'),
      `${jsonPath} 缺少活动的 no-cache 响应头`
    );
  });

  const rollbackBlock = fencedBlock(deployGuide, 'bash', 'readlink -f /var/www/science-lab-previous');
  assert.ok(rollbackBlock.includes('test -L /var/www/science-lab-previous'));
  assert.ok(
    rollbackBlock.includes("stat -c '%U:%G' /var/www/science-lab-previous"),
    '静态回滚必须验证 previous 链接由 root 所有'
  );
  assert.ok(
    rollbackBlock.includes('SCIENCE_LAB_PREVIOUS_RELEASE=$(readlink -f /var/www/science-lab-previous)'),
    '静态回滚必须重新读取持久 previous 链接'
  );
  assert.ok(
    rollbackBlock.includes('/var/www/science-lab-releases/*') &&
      rollbackBlock.includes('test -d "$SCIENCE_LAB_PREVIOUS_RELEASE"'),
    '静态回滚必须校验 previous 指向有效 release 目录'
  );
  assert.ok(
    deployGuide.includes('sudo nginx -t && sudo systemctl reload nginx'),
    'nginx 配置验证和重载必须使用管理员权限'
  );
  assert.ok(!deployGuide.includes('每日费用边界'), '每日请求上限不得描述为费用边界');
  assert.ok(deployGuide.includes('### 仅回滚静态页面'), '静态页面回滚必须是独立操作');
  assert.ok(deployGuide.includes('### 仅回滚 Node API'), 'Node API 回滚必须是独立操作');
  assert.ok(deployGuide.includes('deepseek-v4-flash'), '真实 AI 验证必须使用当前模型');
  assert.ok(
    /install -m 644 index\.html catalog-control\.js content-source\.js experiment-scroll\.js catalog-control\.json manifest\.json manifest\.webmanifest sw\.js/.test(deployGuide),
    '原子发布必须复制全部 App 壳文件'
  );
  assert.ok(
    packageJson.scripts.test.includes('node test/frontend-catalog-control.js'),
    '统一测试命令应包含目录发布控制回归测试'
  );
}

console.log('✓ 目录发布控制解析、页面接入、缓存与发布契约检查通过');
