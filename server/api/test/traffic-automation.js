'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { createDetector, automationBucket, addAutomation, cleanAutomation } = require('../../../tools/traffic-automation.cjs');
const { compileRanges, loadBotRanges, updateBotRanges, SOURCES } = require('../../../tools/traffic-bot-ranges.cjs');
const now = Date.parse('2026-09-14T02:00:00Z');
const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36';
const record = (uri = '/', offset = 0, userAgent = ua, ip = '203.0.113.17') => ({
  timestamp: now - 3600000 + offset, uri, method: 'GET', status: 200,
  entry: uri === '/' && userAgent === ua, identity: ip + '\n' + userAgent,
});
const snapshot = () => ({ schema: 1, capturedAt: new Date(now).toISOString(),
  providers: { google: ['192.0.2.0/24', '2001:db8::/32'], bing: ['198.51.100.0/24'] } });
const detect = records => { const detector = createDetector({ now }); records.forEach(r => detector.observe(r)); return records.map(r => detector.classify(r)); };

test('凌晨、短刷新、缺少来源和单个404不独立触发自动分类', () => {
  const records = [record('/', 0), record('/', 1000), record('/', 2000), { ...record('/missing.html', 3000), status: 404 }, record('/.env', 4000)];
  assert.ok(detect(records).every(d => d.category === 'unclassified'));
});

test('资源突发和共享出口不同UA不会被页面突发规则混合', () => {
  const assets = Array.from({ length: 100 }, (_, i) => record('/assets/' + i + '.js', i));
  const users = Array.from({ length: 40 }, (_, i) => record('/lesson' + i + '.html', i, ua + ' client/' + i));
  assert.ok(detect([...assets, ...users]).every(d => d.category === 'unclassified'));
});

test('多敏感路径成组扫描可识别伪装浏览器且原因不包含原路径', () => {
  const records = ['/wp-login.php', '/wp-admin/', '/.env', '/.git/config', '/actuator/env', '/phpmyadmin/'].map((p,i) => record(p, i * 1000));
  records.push(record('/', 7000));
  const decisions = detect(records);
  assert.ok(decisions.every(d => d.category === 'high' && d.reasons.includes('multi_probe')));
  assert.doesNotMatch(JSON.stringify(decisions), /203\.0\.113|Mozilla|wp-login|actuator/);
});

test('中等探测、导航突发和长期规律导航只列疑似，不封禁', () => {
  assert.equal(detect(['/.env', '/.git/config', '/wp-login.php'].map(p => record(p)))[0].category, 'suspected');
  const burst = Array.from({ length: 30 }, (_,i) => record('/lesson' + i + '.html', i * 1000));
  assert.ok(detect(burst).every(d => d.category === 'suspected' && d.reasons.includes('navigation_burst')));
  const periodic = Array.from({ length: 12 }, (_,i) => record('/', i * 180000));
  assert.ok(detect(periodic).every(d => d.category === 'suspected' && d.reasons.includes('periodic_navigation')));
  assert.ok(!('block' in detect(periodic)[0]));
});

test('跨北京时间自然日的弱证据不拼成强证据；输入顺序不影响结果', () => {
  const before = Date.parse('2026-09-13T23:59:00+08:00');
  const records = ['/.env', '/.git/config', '/wp-login.php', '/wp-admin/', '/actuator/env', '/phpmyadmin/'].map((p,i) => ({ ...record(p), timestamp: before + i * 60000 }));
  const a = detect(records), b = detect([...records].reverse()).reverse();
  assert.deepEqual(a, b);
  assert.equal(a[0].category, 'unclassified');
  assert.ok(a.slice(1).every(d => d.category === 'suspected'));
});

test('自称爬虫仅疑似，工具/验收为自动特征；不把正常UA中的词片段当工具', () => {
  assert.equal(detect([record('/', 0, 'Mozilla/5.0 Googlebot/2.1')])[0].category, 'suspected');
  assert.equal(detect([record('/', 0, 'curl/8.0')])[0].category, 'high');
  assert.equal(detect([record('/', 0, 'Python-urllib/3.11')])[0].category, 'high');
  assert.equal(detect([record('/', 0, 'python-httpx/0.27.0')])[0].category, 'high');
  assert.equal(detect([record('/', 0, 'ScienceLab-Log-Check/test')])[0].category, 'high');
  assert.equal(detect([record('/', 0, ua + ' Prescott/1.0')])[0].category, 'unclassified');
  assert.equal(detect([record('/', 0, 'Mozilla/5.0 (Linux; Android 10; CUBOT X30) Chrome/130.0 Mobile Safari/537.36')])[0].category, 'unclassified');
  assert.equal(detect([record('/', 0, ua + ' Abbot/1.0')])[0].category, 'unclassified');
  assert.equal(detect([record('/', 0, 'Mozilla/5.0 (compatible; Bytespider; https://example.org)')])[0].category, 'suspected');
  for (const token of ['GPTBot/1.2', 'ClaudeBot/1.0', 'CCBot/2.0', 'OAI-SearchBot/1.0', 'ChatGPT-User/1.0', 'PerplexityBot/1.0']) {
    assert.deepEqual(detect([record('/', 0, token)])[0], { category: 'suspected', reasons: ['ua_declared_bot'] });
  }
});

test('官方IP且对应爬虫声明才验证，IPv4/IPv6/边界不接受伪造来源', () => {
  const ranges = compileRanges(snapshot(), now);
  const detector = createDetector({ now, botRanges: ranges });
  assert.equal(detector.classify(record('/', 0, 'Mozilla/5.0 Googlebot/2.1', '192.0.2.255')).category, 'verified');
  assert.equal(detector.classify(record('/', 0, 'Googlebot/2.1', '2001:db8:abcd::1')).category, 'verified');
  assert.equal(detector.classify(record('/', 0, 'Googlebot/2.1', '192.0.3.0')).category, 'suspected');
  assert.equal(detector.classify(record('/', 0, 'bingbot/2.0', '198.51.100.9')).category, 'verified');
  assert.equal(detector.classify(record('/', 0, 'bingbot/2.0', '192.0.2.9')).category, 'suspected');
  assert.equal(detector.classify(record('/', 0, ua, '192.0.2.9')).category, 'unclassified');
  assert.equal(detector.classify(record('/', 0, 'Googlebot/2.1', '2001:db9::1')).category, 'suspected');
  assert.equal(detector.classify(record('/', 0, 'Googlebot/2.1', '::ffff:192.0.2.9')).category, 'suspected');
});

test('verified来源与扫描特征分别保留，不把爬虫来源当安全保证', () => {
  const detector = createDetector({ now, botRanges: compileRanges(snapshot(), now) });
  const records = ['/.env','/.git/config','/wp-login.php','/wp-admin/','/actuator/env','/phpmyadmin/'].map(p => record(p, 0, 'Googlebot/2.1', '192.0.2.9'));
  records.forEach(r => detector.observe(r));
  assert.equal(detector.classify(records[0]).category, 'verified');
  assert.ok(detector.classify(records[0]).reasons.includes('multi_probe'));
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-bot-test-'));
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
test('未配置/过期清单不能验证，损坏及过宽CIDR明确失败', () => {
  assert.equal(loadBotRanges(path.join(fixture, 'absent.json'), now).state, 'unavailable');
  assert.equal(compileRanges({ ...snapshot(), capturedAt: new Date(now - 8 * 86400000).toISOString() }, now).state, 'stale');
  assert.throws(() => compileRanges({ ...snapshot(), providers: { google: ['0.0.0.0/0'], bing: ['::/0'] } }, now), /清单/);
  assert.throws(() => compileRanges({ ...snapshot(), capturedAt: new Date(now + 600000).toISOString() }, now), /清单/);
  assert.throws(() => compileRanges({ ...snapshot(), providers: { google: ['2001:db8::/129'], bing: [] } }, now), /清单/);
});

test('官方更新只请求固定HTTPS源，成组原子写入；失败不覆盖旧清单', async () => {
  const file = path.join(fixture, 'ranges.json'), urls = [];
  const fetchFn = async (url, options) => {
    urls.push(url); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ prefixes: [{ ipv4Prefix: url === SOURCES.google ? '192.0.2.0/24' : '198.51.100.0/24' }] }));
  };
  await updateBotRanges(file, { now, fetchFn });
  assert.deepEqual(urls.sort(), Object.values(SOURCES).sort());
  assert.equal(loadBotRanges(file, now).state, 'ready');
  const previous = fs.readFileSync(file);
  await assert.rejects(updateBotRanges(file, { now, fetchFn: async () => new Response('invalid', { status: 500 }) }));
  assert.deepEqual(fs.readFileSync(file), previous);
  await assert.rejects(updateBotRanges(file, { now, fetchFn: async () => new Response(JSON.stringify({ prefixes: [{ ipv4Prefix: '0.0.0.0/0' }] })) }));
  assert.deepEqual(fs.readFileSync(file), previous);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('单供应商更新失败不拖累另一家，也不刷新失败来源的时间', async () => {
  const file = path.join(fixture, 'independent.json');
  fs.writeFileSync(file, JSON.stringify(snapshot()));
  const next = now + 86400000;
  await updateBotRanges(file, { now: next, fetchFn: async url => url !== SOURCES.bing
    ? new Response('unavailable', { status: 503 })
    : new Response(JSON.stringify({ prefixes: [{ ipv4Prefix: '198.51.100.0/24' }] })) });
  const saved = JSON.parse(fs.readFileSync(file));
  assert.equal(saved.providerCapturedAt.google, new Date(now).toISOString());
  assert.equal(saved.providerCapturedAt.bing, new Date(next).toISOString());
  const compiled = compileRanges(saved, now + 8 * 86400000);
  assert.equal(compiled.providers.google.state, 'stale');
  assert.equal(compiled.providers.bing.state, 'ready');
  assert.equal(compiled.verify('192.0.2.9', 'Googlebot/2.1'), null);
  assert.equal(compiled.verify('198.51.100.9', 'bingbot/2.0'), 'bing');
});

test('观察样本有界且按时间确定，不因轮转文件读取顺序改变规律判断', () => {
  const records = Array.from({ length: 70 }, (_,i) => record('/', i * 180000));
  for (let i = 0; i < 10; i++) records[i].timestamp += (i + 1) * 10000;
  const forward = detect(records), reverse = detect([...records].reverse()).reverse();
  assert.deepEqual(forward, reverse);
  const bounded = createDetector({ maxProfiles: 1 }); bounded.observe(record());
  assert.throws(() => bounded.observe(record('/', 0, ua, '203.0.113.18')), /分组/);
});

test('默认分组预算覆盖日志保留期累计组合且仍在固定上限失败', () => {
  const supported = createDetector();
  for (let i = 0; i < 8001; i++) supported.observe({ ...record('/asset.js'), identity: `${i}\nua` });

  const capped = createDetector();
  for (let i = 0; i < 16000; i++) capped.observe({ ...record('/asset.js'), identity: `${i}\nua` });
  assert.throws(() => capped.observe({ ...record('/asset.js'), identity: 'overflow\nua' }), /分组/);
});

test('全局分钟与样本预算受控，不让少数分组无限积累观察内存', () => {
  const minutes = createDetector({ maxMinutes: 2 });
  minutes.observe(record('/', 0)); minutes.observe(record('/', 60000));
  assert.throws(() => minutes.observe(record('/', 120000)), /观察预算/);
  const samples = createDetector({ maxSamples: 2 });
  samples.observe(record('/', 0)); samples.observe(record('/', 1000));
  assert.throws(() => samples.observe(record('/', 2000)), /观察预算/);
  const strings = createDetector({ maxStringUnits: 10 });
  assert.throws(() => strings.observe(record()), /观察预算/);
});

test('分类严格分区、未知历史不补零，白名单去标识并拒绝不一致', () => {
  const bucket = automationBucket();
  addAutomation(bucket, record(), { category: 'high', reasons: ['ua_tool'] });
  addAutomation(bucket, { entry: false }, { category: 'unclassified', reasons: [], anonymousAi: true });
  assert.equal(bucket.high, 1); assert.equal(bucket.unclassified, 1);
  assert.equal(bucket.entries.high, 1); assert.equal(bucket.aiUnclassified, 1);
  bucket.rawIp = 'secret';
  const clean = cleanAutomation(bucket, 2, 1);
  assert.doesNotMatch(JSON.stringify(clean), /secret|rawIp/);
  assert.equal(cleanAutomation(undefined, 2, 1), null);
  assert.throws(() => cleanAutomation(clean, 3, 1), /分类/);
});
