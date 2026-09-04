import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_FILES = new Set([
  'index.html', 'catalog-control.js', 'content-source.js', 'experiment-scroll.js',
  'experiment-scroll-receiver.js', 'scroll-preview.html', 'manifest.json', 'catalog-control.json', 'manifest.webmanifest',
  'assets/icons/icon-192.png', 'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png', 'assets/icons/apple-touch-icon.png'
]);
const PILOTS = new Set([1, 35, 41].map(n => `physics-middle/初中物理实验${n}.html`));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4'
};

/** Local-only pilot. Source HTML files are read, never modified. No API proxy. */
export async function createPreview({ contentRoot, port = 18890 }) {
  const root = await realpath(contentRoot);
  const receiver = await readFile(path.join(APP_ROOT, 'experiment-scroll-receiver.js'), 'utf8');
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const fail = status => { response.writeHead(status); response.end(http.STATUS_CODES[status]); };
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD'); fail(405); return;
    }
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.'))) {
        fail(404); return;
      }
      const content = pathname.startsWith('/HTML-/');
      const relative = content ? pathname.slice('/HTML-/'.length) : pathname.slice(1) || 'index.html';
      const extension = path.extname(relative).toLowerCase();
      if (!MIME[extension] || (!content && !APP_FILES.has(relative))) { fail(404); return; }
      const allowedRoot = content ? root : APP_ROOT;
      const file = await realpath(path.resolve(allowedRoot, relative));
      if (!file.startsWith(allowedRoot + path.sep) || !(await stat(file)).isFile()) { fail(404); return; }
      let body = await readFile(file);
      if (content && PILOTS.has(relative)) {
        const html = body.toString('utf8');
        if (!/<\/body\s*>/i.test(html)) throw new Error('pilot_body_missing');
        body = Buffer.from(html.replace(/<\/body\s*>/i, () => `<script data-scroll-pilot>\n${receiver}\n</script>\n</body>`));
      } else if (!content && relative === 'index.html') {
        // The preview uses a dedicated origin and does not register a caching worker.
        const html = body.toString('utf8');
        const registration = "navigator.serviceWorker.register('sw.js')";
        if (!html.includes(registration)) throw new Error('preview_worker_guard_changed');
        let preview = html.replace(registration, 'Promise.resolve()');
        if (url.searchParams.get('preview-touch') === '1') {
          // Desktop review only: use the same band with a mouse inside the phone-sized wrapper.
          preview = preview.replace('@media (pointer:coarse)', '@media (min-width:0px)')
            .replace("matchMedia('(pointer:coarse)')", "matchMedia('(min-width:0px)')");
        }
        body = Buffer.from(preview);
      }
      response.writeHead(200, { 'Content-Type': MIME[extension], 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) || error instanceof URIError) fail(404);
      else { console.error('Preview response failed:', error.code || error.message); fail(500); }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'content-root': { type: 'string' }, port: { type: 'string', default: '18890' } } });
  const port = Number(values.port);
  if (!values['content-root'] || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Usage: node tools/preview-scroll.mjs --content-root <public-html-directory> [--port 18890]');
  }
  const server = await createPreview({ contentRoot: values['content-root'], port });
  console.log(`Local scroll pilot: http://127.0.0.1:${server.address().port}/?base=/HTML-/`);
  console.log(`Desktop-friendly preview: http://127.0.0.1:${server.address().port}/scroll-preview.html`);
  console.log('Adapted previews: physics-middle experiments 1, 35, 41. No API or deployment.');
}
