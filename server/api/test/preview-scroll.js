'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('local preview injects only pilot HTML and never serves private paths or a worker', async () => {
  const tool = path.resolve(__dirname, '../../../tools/preview-scroll.mjs');
  const { createPreview } = await import(pathToFileURL(tool).href);
  const contentRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-scroll-content-'));
  let server;
  try {
    await fs.mkdir(path.join(contentRoot, 'physics-middle'));
    for (const number of [1, 2]) await fs.writeFile(path.join(contentRoot, `physics-middle/初中物理实验${number}.html`), '<body>fixture</body>');
    await fs.writeFile(path.join(contentRoot, 'physics-middle/初中物理实验35.html'),
      '<body>fixture<script data-science-lab-scroll>const CHANNEL="science-lab.scroll.v1";</script></body>');
    await fs.symlink('/etc/hosts', path.join(contentRoot, 'outside.html'));
    server = await createPreview({ contentRoot, port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const pilot = await fetch(base + '/HTML-/physics-middle/' + encodeURIComponent('初中物理实验1.html'));
    assert.equal(pilot.headers.get('cache-control'), 'no-store');
    assert.match(await pilot.text(), /science-lab\.scroll\.v1/);
    const plain = await fetch(base + '/HTML-/physics-middle/' + encodeURIComponent('初中物理实验2.html'));
    assert.equal(await plain.text(), '<body>fixture</body>');
    const embedded = await (await fetch(base + '/HTML-/physics-middle/' + encodeURIComponent('初中物理实验35.html'))).text();
    assert.equal((embedded.match(/science-lab\.scroll\.v1/g) || []).length, 1);
    assert.ok(!embedded.includes('data-scroll-pilot'));
    const app = await (await fetch(base)).text();
    assert.ok(app.includes('experiment-scroll.js'));
    assert.ok(!app.includes("navigator.serviceWorker.register('sw.js')"));
    assert.ok(app.includes("matchMedia('(max-width:899px), (any-pointer:coarse)')"));
    const simulated = await (await fetch(base + '/index.html?preview-touch=1')).text();
    assert.ok(simulated.includes("matchMedia('(max-width:899px), (any-pointer:coarse)')"));
    assert.ok(!simulated.includes("matchMedia('(min-width:0px)')"));
    const landing = await (await fetch(base + '/scroll-preview.html')).text();
    assert.ok(landing.includes('src="/index.html?base=/HTML-/"'));
    assert.ok(!landing.includes('preview-touch=1'));
    for (const resource of ['/server/api/.env', '/.git/config', '/sw.js', '/HTML-/.git/config', '/HTML-/outside.html', '/HTML-/%2e%2e%2findex.html', '/api/ai/chat/completions']) {
      assert.equal((await fetch(base + resource)).status, 404, resource);
    }
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await fs.rm(contentRoot, { recursive: true, force: true });
  }
});
