'use strict';

// Self-contained: embedded in the private dashboard as well as tested in Node.
function quotaPresentation(value, now = Date.now()) {
  const empty = (state, status) => ({ state, status, remaining: '—', active: '—', reset: '—', sampled: '—' });
  if (!value) return empty('missing', '尚无额度快照');
  const integer = number => Number.isSafeInteger(number) && number >= 0;
  const limit = number => integer(number) && number > 0;
  const timestamp = time => typeof time === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) && Number.isFinite(Date.parse(time));
  const reasons = ['redis_not_configured', 'invalid_config', 'redis_unavailable', 'redis_timeout', 'invalid_data', 'dependency_unavailable'];
  if (value.schema !== 1 || typeof value.available !== 'boolean' || !timestamp(value.capturedAt) || Date.parse(value.capturedAt) > now + 60000 ||
      (value.available ? value.reason !== null : !reasons.includes(value.reason)) ||
      ![value.globalLimit, value.concurrentLimit].every(number => limit(number) || (!value.available && number === null)) ||
      (value.available ? ![value.globalUsed, value.globalRemaining, value.activeRequests].every(integer) ||
        value.globalRemaining !== Math.max(0, value.globalLimit - value.globalUsed) ||
        (value.globalResetAt !== null && !timestamp(value.globalResetAt)) :
        [value.globalUsed, value.globalRemaining, value.activeRequests, value.globalResetAt].some(number => number !== null))) {
    return empty('invalid', '额度快照无效，当前状态未知');
  }
  const format = time => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(time));
  const stale = now - Date.parse(value.capturedAt) > 180000;
  const result = empty(stale ? 'stale' : value.available ? 'ready' : 'unavailable', stale ? '采样已过期 · 不代表当前状态' : value.available ? 'Redis 可用 · 独立采样' : '额度服务不可用 · 状态未知');
  result.sampled = format(value.capturedAt) + ' 北京时间';
  if (value.available) {
    result.remaining = value.globalRemaining.toLocaleString('zh-CN') + ' / ' + value.globalLimit.toLocaleString('zh-CN');
    result.active = value.activeRequests.toLocaleString('zh-CN') + ' / ' + value.concurrentLimit.toLocaleString('zh-CN');
    result.reset = value.globalResetAt ? format(value.globalResetAt) : '首个请求后开启窗口';
  }
  return result;
}
module.exports = { quotaPresentation };
