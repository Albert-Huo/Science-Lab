const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');

const expectedMetadata = [
  '<meta name="description" content="滑动探索丰富的沉浸式科学实验">',
  '<meta property="og:type" content="website">',
  '<meta property="og:site_name" content="实验馆">',
  '<meta property="og:title" content="实验馆 · 沉浸式实验流">',
  '<meta property="og:description" content="滑动探索丰富的沉浸式科学实验">',
  '<meta property="og:url" content="https://lab.xingnian.net.cn/">',
  '<meta property="og:image" content="https://lab.xingnian.net.cn/assets/icons/icon-512.png">',
  '<meta property="og:image:type" content="image/png">',
  '<meta property="og:image:width" content="512">',
  '<meta property="og:image:height" content="512">'
];

for (const metadata of expectedMetadata) {
  assert.ok(html.includes(metadata), `首页缺少分享元数据：${metadata}`);
}

console.log('frontend share metadata tests passed');
