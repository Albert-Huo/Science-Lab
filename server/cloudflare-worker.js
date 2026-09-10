/* 已退役的 Cloudflare Worker 示例。
 * 旧版本缺少服务端实验策略和共享额度，不能再用作付费代理。
 * 当前支持入口是本站 /api/ai/chat/completions（server/api/）。
 * 如曾独立部署旧 Worker，管理员仍须手动停用旧部署并撤销对应 Secret。
 * 此文件的本地更新不会改变远端已有 Worker。
 */
export default {
  async fetch() {
    return new Response(JSON.stringify({ error: 'proxy_retired', message: '旧 AI 代理已停用，请使用实验馆内置助手。' }), {
      status: 410,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
