/* 实验馆 AI 代理 — Cloudflare Worker
 *
 * 用途：隐藏 DeepSeek API Key，并解决浏览器直连可能遇到的 CORS 限制。
 *
 * 部署步骤：
 * 1. https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. 粘贴本文件内容，Deploy
 * 3. Worker 设置 → Variables → 添加 Secret: DEEPSEEK_API_KEY = 你的 key
 * 4. 在 App 的 AI 设置里把"接口地址"改为 https://<worker名>.<账号>.workers.dev/chat
 *    API Key 字段留空即可（key 在服务端）
 *
 * 安全：ALLOW_ORIGINS 列出允许调用的站点，避免代理被他人盗用。
 */
const ALLOW_ORIGINS = [
  'https://albert-huo.github.io',
  'https://html.xingnian.net.cn',
  'http://127.0.0.1:8788',
  'http://localhost:8788',
];
const UPSTREAM = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';

function corsHeaders(origin) {
  const allowed = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405, headers: corsHeaders(origin) });
    }
    let body;
    try { body = await request.json(); }
    catch { return new Response('bad json', { status: 400, headers: corsHeaders(origin) }); }

    const upstreamBody = {
      model: body.model || DEFAULT_MODEL,
      stream: body.stream !== false,
      messages: Array.isArray(body.messages) ? body.messages.slice(-20) : [],
    };

    const res = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.DEEPSEEK_API_KEY,
      },
      body: JSON.stringify(upstreamBody),
    });

    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'text/event-stream',
        ...corsHeaders(origin),
      },
    });
  },
};
