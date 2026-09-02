'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
const functionStart = html.indexOf('function installGuideCopy(');
const functionEnd = html.indexOf('function initInstallGuide()', functionStart);

assert.ok(
  functionStart >= 0 && functionEnd > functionStart,
  '找不到 index.html 中的安装引导文案函数'
);

const context = vm.createContext({});
vm.runInContext(
  `${html.slice(functionStart, functionEnd)}\nthis.installGuideCopy = installGuideCopy;`,
  context
);

const installGuideCopy = context.installGuideCopy;

function assertCopy(input, expected) {
  const actual = installGuideCopy(input.userAgent, input.platform, input.maxTouchPoints || 0);
  assert.strictEqual(actual.title, expected.title);
  for (const fragment of expected.fragments) {
    assert.ok(actual.text.includes(fragment), `文案应包含“${fragment}”，实际为“${actual.text}”`);
  }
}

assertCopy(
  {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.50',
    platform: 'iPhone'
  },
  { title: '请用 Safari 打开', fragments: ['应用内浏览器', 'Safari', '添加到主屏幕'] }
);

assertCopy(
  {
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36 Instagram 350.0',
    platform: 'Linux armv8l'
  },
  { title: '请用系统浏览器打开', fragments: ['应用内浏览器', 'Chrome', 'Edge'] }
);

assertCopy(
  {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone'
  },
  { title: '添加到主屏幕', fragments: ['Safari', '分享', '添加到主屏幕'] }
);

assertCopy(
  {
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l'
  },
  { title: '添加到主屏幕', fragments: ['Chrome', '安装应用'] }
);

assertCopy(
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Version/17.6 Safari/605.1.15',
    platform: 'MacIntel'
  },
  { title: '添加到 Dock', fragments: ['Safari', '添加到 Dock'] }
);

assertCopy(
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/130.0',
    platform: 'Win32'
  },
  { title: '安装实验馆', fragments: ['若未出现“立即添加”按钮', '系统浏览器'] }
);

console.log('✓ 安装引导 6 个平台场景通过');
