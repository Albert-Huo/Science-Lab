'use strict';

// Shared by server rendering and the browser so an open report can become stale.
function riskPresentation(data, now = Date.now()) {
  const result = (state, title, reason, advice) => ({ state, title, reason, advice });
  const total = data?.totals;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  if (!total || !Number.isFinite(Date.parse(data.nextUpdate)) || now > Date.parse(data.nextUpdate) + 300000 ||
      Date.parse(data.generatedAt) > now + 60000 || !Number.isFinite(Date.parse(data.generatedAt)) ||
      data.partial || !Array.isArray(data.hours) || data.hours.length !== 24 ||
      data.hours.some(hour => hour.coverage !== 'recorded') ||
      !integer(total.serviceErrors) || !integer(total.requests) || !total.requests) {
    return result('unknown', '暂时无法判断', '统计过期、覆盖不完整或没有请求记录。', '先检查数据更新时间；没有记录不代表网站正常。');
  }
  const errors = total.serviceErrors;
  const badHour = hour => hour.coverage === 'recorded' && hour.serviceErrors >= 5 && hour.serviceErrors / hour.requests >= 0.05;
  const sustained = data.hours.some((hour, index) => index > 0 && badHour(hour) && badHour(data.hours[index - 1]));
  const ai = total.ai;
  const outcomes = ai?.observation;
  const failures = outcomes && outcomes.coverage !== 'unavailable'
    ? ['upstream_timeout', 'upstream_error', 'stream_incomplete', 'quota_unavailable', 'not_configured', 'internal_error'].reduce((sum, key) => sum + (outcomes.outcomes?.[key] || 0), 0) : 0;
  const failureText = outcomes && outcomes.coverage !== 'unavailable' ? `已观察到 AI 回答失败 ${failures} 次` : 'AI 回答结果未采集';
  if (errors >= 20 && errors / total.requests >= 0.05 && sustained) {
    return result('danger', '需要处理 · 曾持续出现服务错误', `本期出现 ${errors} 次非预期服务错误，相邻小时均达到告警条件。`, '优先检查网站和 AI 是否可用，再排查服务日志。该结论不代表故障仍在持续。');
  }
  if (errors >= 5 || failures >= 5) {
    return result('warning', '建议关注 · 出现服务异常', `本期非预期服务错误 ${errors} 次；${failureText}（两者可能重叠）。`, '检查失败是否集中出现；若仍无法使用，优先排查服务与模型供应商。');
  }
  if (ai?.coverage !== 'unavailable' && ai?.rateLimited >= 20 && ai.rateLimited / ai.requests >= 0.2) {
    return result('warning', '建议关注 · AI 请求多次被限流', `本期 ${ai.requests} 次 AI 请求中，${ai.rateLimited} 次被限流拒绝。`, '检查下方额度和技术详情中的限流原因；限流可能是防护起效，不等于服务器故障。');
  }
  return result('normal', '本期未见明显服务异常', `非预期服务错误 ${errors} 次；${failureText}。自动访问数量本身不代表危害。`, '暂无需因爬虫数量采取操作。此结论仅基于日志，不代表实时可用性或未被入侵。');
}

module.exports = { riskPresentation };
