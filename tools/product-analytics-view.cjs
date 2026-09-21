'use strict';

function validateProductAnalyticsSnapshot(value) {
  const sources = ['direct', 'internal', 'search', 'external'];
  const actions = ['catalog_open', 'profile_open', 'experiment_previous', 'experiment_next'];
  const coverage = new Set(['unavailable', 'partial', 'recorded']);
  const reasons = new Set(['redis_not_configured', 'invalid_config', 'redis_unavailable', 'redis_timeout', 'invalid_data', 'dependency_unavailable']);
  const exact = (item, keys) => item && typeof item === 'object' && !Array.isArray(item) &&
    Object.getPrototypeOf(item) === Object.prototype && Object.keys(item).sort().join('\0') === [...keys].sort().join('\0');
  const count = item => Number.isSafeInteger(item) && item >= 0;
  const iso = item => typeof item === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item) &&
    Number.isFinite(Date.parse(item)) && new Date(item).toISOString() === item;
  const invalid = () => { throw new Error('Invalid product analytics snapshot'); };
  const privacy = { mode: 'identity_free', cookie: false, fingerprint: false, crossPage: false,
    crossDay: false, uv: 'not_collected', sessions: 'not_collected', completion: 'not_connected' };
  const top = ['schema', 'capturedAt', 'collectionStart', 'available', 'reason', 'privacy', 'totals', 'hours', 'days'];
  if (!exact(value, top) || value.schema !== 1 || !iso(value.capturedAt) || typeof value.available !== 'boolean' ||
      !exact(value.privacy, Object.keys(privacy)) || JSON.stringify(value.privacy) !== JSON.stringify(privacy) ||
      !Array.isArray(value.hours) || !Array.isArray(value.days)) invalid();
  if (!value.available) {
    if (!reasons.has(value.reason) || (value.collectionStart !== null && !iso(value.collectionStart)) ||
        value.totals !== null || value.hours.length || value.days.length) invalid();
    return value;
  }
  if (value.reason !== null || !iso(value.collectionStart) || value.hours.length !== 24 || value.days.length > 400 ||
      !exact(value.totals, ['pageViews', 'experimentOpens', 'keyActions', 'sources', 'actions', 'topExperiments'])) invalid();
  for (const field of ['pageViews', 'experimentOpens', 'keyActions']) if (!count(value.totals[field])) invalid();
  if (!exact(value.totals.sources, sources) || sources.some(key => !count(value.totals.sources[key])) ||
      !exact(value.totals.actions, actions) || actions.some(key => !count(value.totals.actions[key])) ||
      !Array.isArray(value.totals.topExperiments) || value.totals.topExperiments.length > 10) invalid();
  const seen = new Set();
  for (const item of value.totals.topExperiments) {
    if (!exact(item, ['id', 'title', 'count']) || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id) ||
        seen.has(item.id) || typeof item.title !== 'string' || item.title.length < 1 || item.title.length > 300 ||
        !count(item.count) || item.count < 1) invalid();
    seen.add(item.id);
  }
  for (const item of value.hours) {
    if (!exact(item, ['start', 'end', 'coverage', 'pageViews', 'experimentOpens', 'keyActions']) || !iso(item.start) ||
        !iso(item.end) || Date.parse(item.end) - Date.parse(item.start) !== 3600000 || !coverage.has(item.coverage) ||
        !count(item.pageViews) || !count(item.experimentOpens) || !count(item.keyActions)) invalid();
  }
  for (const item of value.days) {
    if (!exact(item, ['day', 'coverage', 'pageViews', 'experimentOpens', 'keyActions']) ||
        typeof item.day !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(item.day) || !coverage.has(item.coverage) ||
        !count(item.pageViews) || !count(item.experimentOpens) || !count(item.keyActions)) invalid();
  }
  const serialized = JSON.stringify(value);
  const bytes = typeof Buffer === 'undefined' ? new TextEncoder().encode(serialized).byteLength : Buffer.byteLength(serialized);
  if (bytes > 2 * 1024 * 1024) invalid();
  return value;
}

function productAnalyticsPresentation(value, now = Date.now(), validate = validateProductAnalyticsSnapshot) {
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

module.exports = { validateProductAnalyticsSnapshot, productAnalyticsPresentation };
