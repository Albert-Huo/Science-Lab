'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ContentSource = require(path.resolve(__dirname, '../../../content-source.js'));

const OFFICIAL = 'https://html.xingnian.net.cn/';
assert.strictEqual(ContentSource.resolve({ hostname: 'lab.xingnian.net.cn', requestedBase: null }), OFFICIAL);
assert.strictEqual(ContentSource.resolve({ hostname: 'html.xingnian.net.cn', requestedBase: null }), '');
assert.strictEqual(ContentSource.resolve({ hostname: 'lab.xingnian.net.cn', requestedBase: 'javascript:alert(1)//' }), OFFICIAL);
assert.strictEqual(ContentSource.resolve({ hostname: 'lab.xingnian.net.cn', requestedBase: 'https://evil.example/' }), OFFICIAL);
assert.strictEqual(ContentSource.resolve({ hostname: '127.0.0.1', requestedBase: '/HTML-/' }), '/HTML-/');
assert.strictEqual(ContentSource.resolve({ hostname: 'localhost', requestedBase: '/fixtures' }), '/fixtures/');
assert.strictEqual(ContentSource.resolve({ hostname: 'localhost', requestedBase: '//evil.example/' }), OFFICIAL);
assert.strictEqual(ContentSource.resolve({ hostname: 'localhost', requestedBase: 'data:text/html,boom' }), OFFICIAL);

const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
assert.ok(html.includes('<script src="content-source.js"></script>'));
assert.ok(html.includes('ContentSource.resolve({hostname:location.hostname,requestedBase:qs.get(\'base\')})'));
assert.ok(!html.includes("const CONTENT_BASE = qs.get('base') ??"));
console.log('✓ 内容源边界 8 个场景与首页接入检查通过');
