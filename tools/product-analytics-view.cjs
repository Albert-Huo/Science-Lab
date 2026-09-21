'use strict';

const { validateSnapshot } = require('./product-analytics-snapshot.cjs');

function productAnalyticsPresentation(value, now = Date.now(), validate = validateSnapshot) {
  const empty = (state, status) => ({ state, status, pageViews: '—', experimentOpens: '—', keyActions: '—',
    uv: '未采集', sessions: '未采集', completion: '未接入', sampled: '—', snapshot: null });
  if (!value) return empty('missing', '尚无产品统计快照');
  let clean;
  try { clean = validate(value); }
  catch { return empty('invalid', '产品统计快照无效'); }
  if (!clean.available) return empty('unavailable', '产品统计暂不可用');
  const stale = now - Date.parse(clean.capturedAt) > 15 * 60 * 1000;
  const result = empty(stale ? 'stale' : 'ready', stale ? '产品统计快照已过期' : '无身份聚合 · 数据已更新');
  const format = number => number.toLocaleString('zh-CN');
  result.pageViews = format(clean.totals.pageViews);
  result.experimentOpens = format(clean.totals.experimentOpens);
  result.keyActions = format(clean.totals.keyActions);
  result.sampled = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(clean.capturedAt));
  result.snapshot = clean;
  return result;
}

module.exports = { productAnalyticsPresentation };
