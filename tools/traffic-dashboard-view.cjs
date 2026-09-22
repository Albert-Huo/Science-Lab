'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { quotaPresentation } = require('./traffic-quota-view.cjs');
const { riskPresentation } = require('./traffic-risk-view.cjs');
const { validateProductAnalyticsSnapshot, productAnalyticsPresentation } = require('./product-analytics-view.cjs');
const { CATEGORIES, REASONS, cleanAutomation } = require('./traffic-automation.cjs');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const count = value => Number(value).toLocaleString('zh-CN');
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const average = (total, samples) => samples ? Math.round(total / samples) : null;
const duration = value => value === null ? '—' : value >= 1000 ? (value / 1000).toFixed(1) + ' 秒' : value + ' 毫秒';
const bytes = value => value === null ? '—' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B';

// The exact same serializer is embedded in the page; downloads always represent the visible snapshot.
function toCsv(data, scope = 'current') {
  const cell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  const mean = (total, samples) => samples ? Math.round(total / samples) : '';
  const outcomeLabels = { completed: 'AI服务端完成', client_aborted: 'AI客户端中断', upstream_timeout: 'AI上游超时', upstream_error: 'AI上游错误', stream_incomplete: 'AI流未完整结束', invalid_request: 'AI结果_无效请求', rate_limited: 'AI结果_限流', quota_unavailable: 'AI额度服务不可用', not_configured: 'AI模型未配置', internal_error: 'AI内部错误' };
  const scopeLabels = { ip_minute: 'IP分钟', ip_day: 'IP日', session_day: '会话日', global_day: '全站日', concurrency: '并发' };
  const reasonLabels = { ...scopeLabels, nginx: 'Nginx入口', unknown: '原因未知' };
  const automationReasons = { verified_google: 'Google官方来源', verified_bing: 'Bing官方来源', ua_tool: '工具客户端', ua_declared_bot: '自称爬虫未验证', multi_probe: '成组敏感探测', probe_pattern: '多敏感路径', navigation_burst: '页面突发', periodic_navigation: '规律导航' };
  const categories = ['verified', 'high', 'suspected', 'unclassified'];
  const coverageText = value => value === 'unavailable' ? '未采集' : value === 'partial' ? '部分时段已采集' : '按日志统计';
  const headers = ['记录类型', '区间开始_北京时间', '区间结束_北京时间', '生成时间_北京时间', '采集状态', '入口请求', '访客估算_不可跨行相加', '全部请求', '已识别自动请求', '4xx请求', '5xx请求', '电脑入口', '手机入口', '平板入口', '站内来源', '外部来源', '无来源信息', 'AI采集状态', 'AI请求', 'AI_HTTP_2xx', 'AI无效请求_400', 'AI限流_429', 'AI_5xx', 'AI其他状态', 'AI_2xx平均耗时毫秒', 'AI平均上下文消息数', 'AI平均输入字符数_历史混合口径', 'AI平均响应字节数',
    ...Object.values(reasonLabels).map(label => 'AI限流_' + label), '预期停用接口_503', '其他服务端_5xx',
    'AI结果采集状态', 'AI结果口径版本', 'AI已观察结果', ...Object.values(outcomeLabels),
    ...Object.values(scopeLabels).map(label => 'AI结果限流_' + label), 'AI平均首内容耗时毫秒', 'AI平均规则资料字符数_v2', 'AI平均对话字符数_v2',
    '自动分类状态', '自动分类版本', '已验证爬虫请求', '高置信自动特征请求', '疑似自动访问请求', '未命中自动规则请求',
    '已验证爬虫入口', '高置信自动特征入口', '疑似自动入口', '未标记入口', '匿名AI未判定请求', ...Object.values(automationReasons).map(label => '自动原因_' + label)];
  const format = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19) + '+08:00';
  const row = (kind, start, end, item, coverage) => {
    const metrics = coverage === 'unavailable' ? Array(12).fill('') : [item.entryRequests, item.visitorEstimate, item.requests, item.automated, item.clientErrors, item.serverErrors,
      item.devices.desktop, item.devices.mobile, item.devices.tablet, item.sources.internal, item.sources.external, item.sources.unknown];
    const ai = item.ai;
    const aiMetrics = ai.coverage === 'unavailable' ? Array(10).fill('') : [ai.requests, ai.httpSuccesses, ai.invalidRequests, ai.rateLimited, ai.serverErrors, ai.otherStatuses,
      mean(ai.durationMsTotal, ai.durationSamples), mean(ai.messageCountTotal, ai.messageSamples),
      mean(ai.inputCharsTotal, ai.inputSamples), mean(ai.responseBytes, ai.httpSuccesses)];
    const reasons = Object.keys(reasonLabels).map(key => ai.coverage === 'unavailable' ? '' : ai.limitReasons?.[key] ?? (key === 'unknown' ? ai.rateLimited : 0));
    const observation = ai.observation;
    const observed = observation && observation.coverage !== 'unavailable';
    const results = observed ? [observation.metricVersion, observation.requests,
      ...Object.keys(outcomeLabels).map(key => observation.outcomes[key] ?? 0),
      ...Object.keys(scopeLabels).map(key => observation.scopes[key] ?? 0),
      mean(observation.firstTokenMsTotal, observation.firstTokenSamples), mean(observation.promptCharsTotal, observation.inputSamples), mean(observation.conversationCharsTotal, observation.inputSamples)] : Array(20).fill('');
    const automation = coverage === 'unavailable' ? null : item.automation;
    const automationMetrics = automation ? [automation.version, ...categories.map(key => automation[key]),
      ...categories.map(key => automation.entries[key]), automation.aiUnclassified, ...Object.keys(automationReasons).map(key => automation.reasons[key])] : Array(18).fill('');
    return [kind, format(start), format(end), format(data.generatedAt), coverageText(coverage), ...metrics,
      coverageText(ai.coverage), ...aiMetrics, ...reasons, item.expectedUnavailable ?? '', item.serviceErrors ?? '',
      coverageText(observation?.coverage || 'unavailable'), ...results,
      coverage === 'unavailable' ? '未采集' : automation ? '按规则回算' : '未知（旧数据）', ...automationMetrics];
  };
  const rows = scope === 'history'
    ? data.history.map(day => row('每日汇总', day.start, day.end, day, day.partial ? 'partial' : 'recorded'))
    : [row('24小时汇总', data.windowStart, data.windowEnd, data.totals, data.partial ? 'partial' : 'recorded'),
      ...data.hours.map(hour => row('小时明细', hour.start, hour.end, hour, hour.coverage))];
  return '\ufeff' + [headers, ...rows].map(values => values.map(cell).join(',')).join('\r\n') + '\r\n';
}

function productAnalyticsToCsv(value, scope = 'current') {
  const data = validateProductAnalyticsSnapshot(value);
  if (!data.available) throw new Error('Product analytics unavailable');
  const cell = item => '"' + String(item ?? '').replace(/"/g, '""') + '"';
  const coverage = item => item === 'recorded' ? '已采集' : item === 'partial' ? '部分采集' : '未采集';
  const headers = ['记录类型', '时间', '采集状态', '页面浏览_PV', '实验打开次数', '关键操作次数', '分类', '名称', '次数'];
  let rows;
  if (scope === 'history') {
    rows = data.days.map(day => ['每日汇总', day.day, coverage(day.coverage), day.pageViews, day.experimentOpens, day.keyActions, '', '', '']);
  } else if (scope === 'current') {
    rows = [
      ['24小时汇总', data.capturedAt, '已采集', data.totals.pageViews, data.totals.experimentOpens, data.totals.keyActions, '', '', ''],
      ...data.hours.map(hour => ['小时明细', hour.start, coverage(hour.coverage), hour.pageViews, hour.experimentOpens, hour.keyActions, '', '', '']),
      ...Object.entries(data.totals.sources).map(([name, number]) => ['来源汇总', data.capturedAt, '已采集', '', '', '', '来源', name, number]),
      ...Object.entries(data.totals.actions).map(([name, number]) => ['操作汇总', data.capturedAt, '已采集', '', '', '', '操作', name, number]),
      ...data.totals.topExperiments.map(item => ['实验排行', data.capturedAt, '已采集', '', '', '', '实验', item.title, item.count]),
    ];
  } else {
    throw new Error('Invalid product analytics CSV scope');
  }
  return '\ufeff' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

function renderDashboard(data) {
  const validExperiment = item => item && typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 300 &&
    Number.isSafeInteger(item.requests) && item.requests > 0;
  const validAi = value => value && ['unavailable', 'partial', 'recorded'].includes(value.coverage) &&
    ['requests', 'httpSuccesses', 'invalidRequests', 'rateLimited', 'serverErrors', 'otherStatuses', 'durationMsTotal',
      'durationSamples', 'responseBytes', 'messageCountTotal', 'messageSamples', 'inputCharsTotal', 'inputSamples']
      .every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);
  if (data.schema !== 3 || data.hours.length !== 24 || !Array.isArray(data.history) || !validAi(data.totals?.ai) ||
      data.hours.some(hour => !validAi(hour.ai)) || data.history.some(day => !validAi(day.ai)) ||
      !Array.isArray(data.totals.ai.experiments) || data.totals.ai.experiments.length > 8 ||
      data.totals.ai.experiments.some(item => !validExperiment(item))) {
    throw new Error('看板数据无效');
  }
  for (const item of [data.totals, ...data.hours, ...data.history]) cleanAutomation(item.automation, item.requests, item.entryRequests);
  const css = ['traffic-dashboard.css', 'traffic-dashboard-product.css', 'traffic-dashboard-ai.css', 'traffic-dashboard-automation.css', 'traffic-dashboard-risk.css']
    .map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
  const client = fs.readFileSync(path.join(__dirname, 'traffic-dashboard-client.js'), 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const script = `'use strict';\nconst trafficData = ${json};\nconst riskPresentation = ${riskPresentation.toString()};\nconst toCsv = ${toCsv.toString()};\nconst validateProductAnalyticsSnapshot = ${validateProductAnalyticsSnapshot.toString()};\nconst productAnalyticsPresentation = ${productAnalyticsPresentation.toString()};\nconst productAnalyticsToCsv = ${productAnalyticsToCsv.toString()};\nconst quotaPresentation = ${quotaPresentation.toString()};\n${client}`;
  const hash = crypto.createHash('sha256').update(script).digest('base64');
  const csp = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`;
  const max = Math.max(1, ...data.hours.map(hour => hour.automation?.entries.unclassified ?? 0));
  const bars = data.hours.map((hour, i) => {
    const label = time(hour.start).slice(-5);
    const unavailable = hour.coverage === 'unavailable';
    const value = hour.automation?.entries.unclassified ?? 0;
    return `<button class="hour ${unavailable ? 'unavailable' : ''}" type="button" data-hour="${i}" aria-label="${escape(time(hour.start))}，${unavailable ? '未采集' : '未标记入口 ' + value}"><span class="column"><span class="fill" style="height:${value / max * 100}%"></span></span><span class="hour-label">${i % 3 === 0 || i === 23 ? escape(label) : ''}</span></button>`;
  }).join('');
  const metric = (label, value, hint, className = '') => `<article class="metric ${className}"><span class="metric-label">${label}</span><strong>${count(value)}</strong><p>${hint}</p></article>`;
  const distribution = (label, value, total, symbol) => `<div class="distribution"><div class="distribution-line"><span><i aria-hidden="true">${symbol}</i>${label}</span><span><b>${count(value)}</b><small>${total ? Math.round(value / total * 100) + '%' : '—'}</small></span></div><div class="track"><span style="width:${total ? value / total * 100 : 0}%"></span></div></div>`;
  const total = data.totals;
  const risk = riskPresentation(data);
  const riskPanel = `<section id="risk-panel" class="panel risk-panel" data-state="${risk.state}" aria-labelledby="risk-title"><span class="risk-label">最近 24 小时 · 日志观察</span><h2 id="risk-title">${escape(risk.title)}</h2><p id="risk-reason">${escape(risk.reason)}</p><p class="risk-advice"><b>建议</b><span id="risk-advice">${escape(risk.advice)}</span></p><p class="risk-note">统计截至 ${escape(time(data.windowEnd))}，每 2 小时更新。未接入实时可用性与服务器负载监测。</p><details class="risk-rules"><summary>什么情况下需要关注？</summary><p>绿色：已记录请求，未达到异常阈值。黄色：24 小时非预期服务错误或 AI 回答失败至少 5 次；或 AI 限流至少 20 次且占 AI 请求 20%。红色：非预期服务错误至少 20 次且占全部请求 5%，同时相邻两个小时各至少 5 次且占该小时请求 5%。灰色：数据过期、不完整或没有请求，暂时无法判断。</p><p>预期停用接口的 503 不算故障。爬虫、扫描特征、单个 404 不单独升级风险；这些规则是排查提示，不是入侵判定。</p></details></section>`;
  const ai = total.ai;
  const automation = total.automation;
  const classificationLabels = { verified: '已验证爬虫', high: '高置信自动特征', suspected: '疑似自动访问', unclassified: '未命中规则' };
  const classificationHints = { verified: 'Google / Bing 声明 + 官方来源', high: '工具特征或成组扫描证据', suspected: '存在自动特征，证据尚不足', unclassified: '身份未知，不等于真人' };
  const feed = data.botVerification;
  const feedText = feed?.state === 'ready' ? '官方清单有效 · 每日更新' : feed?.state === 'partial' ? '官方清单部分可用 · 仅验证有效来源' : feed?.state === 'stale' ? '官方清单已过期 · 暂停来源验证' : '官方清单不可用 · 无法验证爬虫来源';
  const providerText = Object.entries({ google: 'Google', bing: 'Bing' }).map(([key,label]) => {
    const provider = feed?.providers?.[key];
    return label + '：' + (provider?.state === 'ready' ? '有效' : provider?.state === 'stale' ? '过期' : '不可用') + (provider?.capturedAt ? '（' + time(provider.capturedAt) + ' 更新）' : '');
  }).join(' · ');
  const markedEntries = automation ? total.entryRequests - automation.entries.unclassified : null;
  const reasonRows = automation ? Object.entries(REASONS).filter(([key]) => automation.reasons[key] > 0)
    .sort(([a],[b]) => automation.reasons[b] - automation.reasons[a])
    .map(([key,label]) => `<div><dt>${escape(label)}<small>${key}</small></dt><dd>${count(automation.reasons[key])}<small>次请求</small></dd></div>`).join('') : '';
  const automationPanel = `<section class="panel automation-panel" aria-labelledby="automation-title"><div class="panel-heading"><div><span class="automation-eyebrow">TRAFFIC / CLASSIFICATION</span><h2 id="automation-title">访问分类</h2><p>规则 v1 · 只影响统计，不封禁访问 · 原始计数不变</p></div><span class="verification-status" data-state="${escape(feed?.state || 'unavailable')}">${escape(feedText)}</span></div>
<div class="entry-assessment"><div><span>未标记入口</span><strong>${automation ? count(automation.entries.unclassified) : '—'}</strong><small>候选入口，不等于真人访问</small></div><p>原始浏览器特征入口 <b>${count(total.entryRequests)}</b> 次，其中 <b>${markedEntries === null ? '未知' : count(markedEntries)}</b> 次带有自动访问标记。<br>刷新、预取或伪装浏览器仍可能计入；不把剩余请求当成真实人数。</p></div>
<div class="classification-strip" aria-hidden="true">${CATEGORIES.map(key => `<span class="classification-${key}" style="flex-grow:${automation?.[key] || 0}"></span>`).join('')}</div>
<div class="classification-grid">${CATEGORIES.map(key => `<article class="classification-item classification-${key}"><span><i aria-hidden="true"></i>${classificationLabels[key]}</span><strong>${automation ? count(automation[key]) : '—'}<small>次请求</small></strong><p>${classificationHints[key]}</p><small>${automation && total.requests ? (automation[key] / total.requests * 100).toFixed(1) + '%' : '—'} · 全部请求占比</small></article>`).join('')}</div>
<p class="classification-note">${escape(providerText)}</p>
<p class="classification-note">四类请求互斥，合计为全部请求。${automation?.aiUnclassified ? '其中 ' + count(automation.aiUnclassified) + ' 次匿名 AI 请求缺少身份信息，归入未命中规则。' : '匿名 AI 日志不用于判断真人。'}验证来源不代表行为安全，仍单独保留扫描标记。</p>
<details class="automation-details"><summary>查看判定原因与规则</summary><div class="automation-reasons"><h3>本期命中的判定原因</h3>${reasonRows ? '<dl>' + reasonRows + '</dl>' : '<p>本期暂无命中的判定原因，或分类尚未启用。</p>'}<p>原因数量代表带该标记的请求，可重叠，不能相加。行为证据来自截至统计窗口结束的北京时间同日 IP 与浏览器组合；标记关联到该组合的请求，不是探测路径条数。</p></div><div class="automation-rules"><h3>保守判定，不等于身份确认</h3><p>自称爬虫而来源未验证，仅列疑似；成组敏感路径探测或工具客户端特征列为高置信。页面突发、长期规律导航仅列疑似，不触发封禁。</p><p>凌晨访问、无来源信息、单个 404、几次刷新和静态资源突发，不单独参与判定。共享出口和相同浏览器仍可能混合多位用户，应结合原因复核。</p><p>Google / Bing 官方清单每天独立更新，报表任务只读本地文件；超过 7 天停止来源验证。其他爬虫未接入官方验证，不能仅凭名称认定正规来源。</p><p>行为观察使用有界样本，无法识别所有自动程序。不采集鼠标轨迹或浏览器指纹；IP、UA、原始路径和完整来源不进入网页、CSV 或历史汇总。旧历史缺少分类时保留未知，不补零。</p><dl>${Object.entries(REASONS).map(([key,label]) => `<div><dt>${key}</dt><dd>${escape(label)}</dd></div>`).join('')}</dl></div></details></section>`;
  const aiMetric = (label, value, hint) => `<article class="ai-metric"><span>${label}</span><strong>${value}</strong><small>${hint}</small></article>`;
  const observation = ai.observation;
  const observed = observation && observation.coverage !== 'unavailable';
  const outcomeLabels = { completed: '服务端完成', client_aborted: '客户端中断', upstream_timeout: '上游超时', upstream_error: '上游错误', stream_incomplete: '流未完整结束', invalid_request: '无效请求', rate_limited: '限流拒绝', quota_unavailable: '额度服务不可用', not_configured: '模型未配置', internal_error: '内部错误' };
  const reasonLabels = { ip_minute: 'IP 分钟额度', ip_day: 'IP 日额度', session_day: '会话日额度', global_day: '全站日额度', concurrency: '并发已满', nginx: 'Nginx 入口限流', unknown: '原因未知（旧日志）' };
  const diagnosticRows = (labels, values, known) => `<dl class="diagnostic-list">${Object.entries(labels).map(([key, label]) => `<div><dt>${label}</dt><dd>${known ? count(values?.[key] ?? 0) : '—'}</dd></div>`).join('')}</dl>`;
  const resultDetails = `<details class="ai-diagnostics"><summary>查看完成结果与限流原因</summary><div class="ai-diagnostic-grid"><div><h3>服务端最终结果 <small>${observed ? observation.coverage === 'partial' ? '部分时段已采集' : '已采集' : '未采集'}</small></h3>${diagnosticRows(outcomeLabels, observation?.outcomes, observed)}<p>结果按结束时间统计；旧数据或未观察到的结果为未知，不从 HTTP 200 推断成功。${observed ? '本期观察到 ' + count(observation.requests) + ' 个结果。' : ''}</p></div><div><h3>HTTP 429 原因</h3>${diagnosticRows(reasonLabels, ai.limitReasons || { unknown: ai.rateLimited }, ai.coverage !== 'unavailable')}<p>Nginx 拒绝不会到达 Node，因此不会出现在服务端最终结果中。</p></div></div></details>`;
  const quotaPanel = `<section class="panel quota-panel" aria-labelledby="quota-title"><div class="panel-heading"><div><h2 id="quota-title">额度与服务状态</h2><p>独立分钟采样 · 不属于下方历史统计窗口</p></div><span id="quota-status" class="quota-status" role="status">等待读取额度快照</span></div><div class="quota-grid"><div><span>全站窗口剩余额度 / 上限</span><strong id="quota-remaining">—</strong></div><div><span>当前有效并发 / 上限</span><strong id="quota-active">—</strong></div><div><span>全站窗口到期 · 北京时间</span><strong id="quota-reset">—</strong></div></div><p class="panel-note">采样于 <span id="quota-sampled">—</span>。超过 3 分钟标记过期；全站日额度是首次请求起的 24 小时窗口，不是自然日，也不代表模型账单。</p></section>`;
  const productPanel = `<section class="panel product-panel" aria-labelledby="product-title" data-state="loading"><div class="product-heading"><div><span class="product-eyebrow">PRODUCT / IDENTITY-FREE</span><h2 id="product-title">网站使用概览</h2><p>浏览器只发送固定事件，服务器直接累加匿名总数</p></div><div class="product-controls"><span id="analytics-status" class="product-status" role="status">正在读取产品统计</span><button id="download-product" class="secondary product-download" type="button" disabled>下载产品统计 <small>CSV</small></button></div></div>
<div class="product-metrics"><article><span>页面浏览 PV</span><strong id="analytics-pageViews">—</strong><small>首页载入次数</small></article><article><span>实验打开次数</span><strong id="analytics-experimentOpens">—</strong><small>当前实验实际展示</small></article><article><span>关键操作</span><strong id="analytics-keyActions">—</strong><small>固定按钮点击总数</small></article><article class="not-collected"><span>UV</span><strong id="analytics-uv">未采集</strong><small>不生成访客标识</small></article></div>
<div class="product-grid"><div class="product-trend"><div class="product-subheading"><h3>小时趋势</h3><div class="product-segmented" role="group" aria-label="产品统计趋势"><button type="button" data-product-metric="pageViews" aria-pressed="true">PV</button><button type="button" data-product-metric="experimentOpens" aria-pressed="false">实验打开</button><button type="button" data-product-metric="keyActions" aria-pressed="false">关键操作</button></div></div><div id="product-bars" class="product-bars" aria-label="产品统计小时趋势"><span class="product-empty">等待快照</span></div><p id="product-trend-note">无身份聚合，不按访客串联页面行为</p></div>
<div class="product-breakdown"><h3>访问来源</h3><dl id="product-sources"><div><dt>直接访问</dt><dd>—</dd></div><div><dt>站内跳转</dt><dd>—</dd></div><div><dt>搜索来源</dt><dd>—</dd></div><div><dt>外部链接</dt><dd>—</dd></div></dl><h3>固定操作</h3><dl id="product-actions"><div><dt>打开目录</dt><dd>—</dd></div><div><dt>打开“我的”</dt><dd>—</dd></div><div><dt>上一实验</dt><dd>—</dd></div><div><dt>下一实验</dt><dd>—</dd></div></dl></div>
<div class="product-ranking"><h3>热门实验 <small>前 10 · 按打开次数</small></h3><ol id="product-experiments"><li class="product-empty">等待快照</li></ol></div></div>
<div class="privacy-state"><div><span>会话</span><strong id="analytics-sessions">未采集</strong></div><div><span>实验完成事件</span><strong id="analytics-completion">未接入</strong></div><p><b>无身份聚合</b> · 不设置统计 Cookie，不保存 IP、完整 UA、完整来源或查询参数，不使用指纹或派生标识，也不形成跨页面／跨天轨迹。安全运行日志与本区统计严格分离。</p><span>快照 <b id="analytics-sampled">—</b></span></div></section>`;
  const experimentRows = ai.experiments.length ? ai.experiments.map((item, index) => `<li><span><i>${index + 1}</i>${escape(item.title)}</span><b>${count(item.requests)}</b></li>`).join('') : '<li class="ai-empty">当前窗口暂无可排行的 HTTP 2xx 请求</li>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><meta name="report-generated-at" content="${escape(data.generatedAt)}"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><title>访问观察台 · 星年实验馆</title><style>${css}</style></head><body>
<div class="ambient" aria-hidden="true"></div><main>
<header class="masthead"><div class="brand"><span class="brand-mark" aria-hidden="true">✳</span><span>星年<span class="brand-divider"> / </span>实验馆<small>TRAFFIC OBSERVATORY</small></span></div><span class="private-badge"><span aria-hidden="true">◈</span> 私有统计</span></header>
<section class="intro"><div><div class="eyebrow">持续观察 · 每 2 小时更新</div><h1>过去 <em>24</em> 小时</h1><p class="period">${escape(time(data.windowStart))}<span>→</span>${escape(time(data.windowEnd))}<small>北京时间</small></p></div><div class="intro-actions"><button id="download-current" class="primary" type="button"><span aria-hidden="true">↓</span> 下载当前数据 <small>CSV</small></button><div class="status-line"><span class="status-dot"></span><span id="freshness" role="status">已生成本期数据</span><button id="check-update" type="button" title="检查服务器是否已生成新一期数据">检查更新</button></div></div></section>
<div class="update-strip"><span>生成于 <b>${escape(time(data.generatedAt))}</b></span><span>下次更新 <b>${escape(time(data.nextUpdate))}</b></span><span>每次向前滚动 2 小时</span></div>
<div id="update-warning" class="notice warning" role="status" hidden></div>
${data.partial ? `<div class="notice"><span class="notice-symbol">i</span><span>统计自 ${escape(time(data.collectionStart))} 开始，当前窗口尚未覆盖完整 24 小时。图中斜纹表示未采集时段，不计作零访问。</span></div>` : ''}
${productPanel}
<div class="section-heading"><span>SECURITY / OPERATIONS</span><h2>网站运行与风险</h2><p>先看是否需要处理；安全流量与产品统计分开，不用于反推 UV 或访问路径。</p></div>
${riskPanel}
${quotaPanel}
<details class="technical-details"><summary>技术详情 <span>请求量、爬虫分类、错误与历史趋势</span></summary>
<section class="metrics" aria-label="24小时概览">${metric('浏览器特征入口', total.entryRequests, '原始入口口径 · 不等于真人访问', 'lead')}${metric('入口组合估算', total.visitorEstimate, '原始 IP + UA 去重 · 不代表真实人数')}${metric('全部请求', total.requests, '包含页面、资源、接口及自动请求')}</section>
${automationPanel}
<p class="traffic-health">HTTP 5xx 原始总数 <b>${count(total.serverErrors)}</b><span>预期停用接口 503 <b>${total.expectedUnavailable == null ? '未知（旧数据）' : count(total.expectedUnavailable)}</b></span><span>其他服务端 5xx <b>${total.serviceErrors == null ? '未知（旧数据）' : count(total.serviceErrors)}</b></span></p>
<section class="panel ai-panel" aria-labelledby="ai-title"><div class="ai-heading"><div><span class="ai-eyebrow">AI / BUILT-IN</span><h2 id="ai-title">AI 交互 <small>仅内置模式</small></h2><p>匿名请求元数据 · BYOK 不在统计范围</p></div><span class="ai-coverage">${ai.coverage === 'recorded' ? '24 小时已采集' : ai.coverage === 'partial' ? '部分时段已采集' : '尚未开始采集'}</span></div>
<div class="ai-metrics">${aiMetric('AI 请求', ai.coverage === 'unavailable' ? '—' : count(ai.requests), 'HTTP 日志 · 含入口拒绝')}${aiMetric('服务端完成', observed ? count(observation.outcomes.completed) : '—', observed ? '已观察到有效 [DONE]' : '旧数据完成结果未知')}${aiMetric('限流 429', ai.coverage === 'unavailable' ? '—' : count(ai.rateLimited), 'Nginx 与 Node 合计')}${aiMetric('首内容平均耗时', observed ? duration(average(observation.firstTokenMsTotal, observation.firstTokenSamples)) : '—', '首个非空正文片段 · 非响应头')}</div>
<p class="ai-sample-note">HTTP 2xx 共 ${count(ai.httpSuccesses)} 次，只表示流式接口已建立，不等于回答完成。${ai.requests < 20 ? '当前样本较少，不宜据此判断整体可靠性。' : '完成结果只覆盖已启用结果采集的时段。'}</p>
<div class="ai-grid"><div class="ai-status"><h3>响应状态</h3>${distribution('HTTP 2xx', ai.httpSuccesses, ai.requests, '✓')}${distribution('无效请求 400', ai.invalidRequests, ai.requests, '!')}${distribution('限流 429', ai.rateLimited, ai.requests, '⌁')}${distribution('服务端 5xx', ai.serverErrors, ai.requests, '×')}${distribution('其他状态', ai.otherStatuses, ai.requests, '·')}</div><div class="ai-context"><h3>对话负载</h3><dl><div><dt>平均上下文消息</dt><dd>${average(ai.messageCountTotal, ai.messageSamples) ?? '—'}</dd></div><div><dt>平均输入字符</dt><dd>${average(ai.inputCharsTotal, ai.inputSamples) ?? '—'}</dd></div><div><dt>平均响应流量</dt><dd>${bytes(average(ai.responseBytes, ai.httpSuccesses))}</dd></div></dl><p>统计实际转发的上下文长度与响应字节，不是 token 数。</p></div><div class="ai-experiments"><h3>热门实验 <small>前 8 · 按 HTTP 2xx</small></h3><ol>${experimentRows}</ol></div></div>
<p class="ai-sample-note">输入字符包含服务端规则、实验资料与对话历史，不是本次提问长度，也不是 token 数。HTTP 日志保留历史混合口径；v2 结果日志单独拆分规则／资料和对话，不与旧样本直接比较。${observed ? 'v2 平均规则／资料 ' + (average(observation.promptCharsTotal, observation.inputSamples) ?? '—') + ' 字符，平均对话 ' + (average(observation.conversationCharsTotal, observation.inputSamples) ?? '—') + ' 字符。' : ''}HTTP 2xx 平均耗时 ${duration(average(ai.durationMsTotal, ai.durationSamples))}（含传输）。</p>
${resultDetails}
<p class="ai-privacy">不保存问题或回答正文，不记录 API Key、IP、浏览器标识或用户身份。</p></section>
<section class="panel trend-panel"><div class="panel-heading"><div><h2>小时趋势</h2><p>对照原始流量、候选入口与自动访问</p></div><div class="segmented" role="group" aria-label="趋势指标"><button type="button" data-metric="automation.entries.unclassified" aria-pressed="true">未标记入口</button><button type="button" data-metric="entryRequests" aria-pressed="false">原始入口</button><button type="button" data-metric="visitorEstimate" aria-pressed="false">组合估算</button><button type="button" data-metric="requests" aria-pressed="false">全部请求</button><button type="button" data-metric="automation.high" aria-pressed="false">高置信自动</button><button type="button" data-metric="automation.suspected" aria-pressed="false">疑似自动</button><button type="button" data-metric="ai.requests" aria-pressed="false">AI 请求</button><button type="button" data-metric="ai.httpSuccesses" aria-pressed="false">AI 2xx</button></div></div>
<div class="chart-topline"><span id="chart-detail" aria-live="polite">轻触柱形或用键盘选择，查看该小时数据</span><span id="chart-scale">最高 ${count(Math.max(0, ...data.hours.map(hour => hour.automation?.entries.unclassified ?? 0)))}</span></div><div class="chart"><div class="chart-guides" aria-hidden="true"></div><div class="bars">${bars}</div></div><div class="chart-footnote"><span><i class="legend"></i> <span id="metric-label">未标记入口</span></span><span id="metric-note">未标记不等于真人访问</span></div>
<details class="hour-details"><summary>查看 24 小时明细</summary><div class="table-scroll"><table><thead><tr><th>时段</th><th>原始入口</th><th>组合估算</th><th>全部请求</th><th>未标记入口</th><th class="classified-heading">已验证爬虫</th><th class="classified-heading">高置信自动</th><th class="classified-heading">疑似自动</th><th>未命中规则</th><th>AI 请求</th><th>AI 2xx</th></tr></thead><tbody>${data.hours.map(hour => `<tr><th>${escape(time(hour.start))} — ${escape(time(hour.end).slice(-5))}${hour.coverage !== 'recorded' ? '<small>' + (hour.coverage === 'unavailable' ? '未采集' : '部分采集') + '</small>' : ''}</th>${['entryRequests', 'visitorEstimate', 'requests'].map(key => `<td>${hour.coverage === 'unavailable' ? '—' : count(hour[key])}</td>`).join('')}<td>${hour.coverage === 'unavailable' || !hour.automation ? '—' : count(hour.automation.entries.unclassified)}</td>${CATEGORIES.map(key => `<td>${hour.coverage === 'unavailable' || !hour.automation ? '—' : count(hour.automation[key])}</td>`).join('')}${['requests', 'httpSuccesses'].map(key => `<td>${hour.ai.coverage === 'unavailable' ? '—' : count(hour.ai[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details></section>
<div class="breakdowns"><section class="panel"><div class="panel-heading"><h2>访问设备</h2><span class="caption">按入口请求</span></div>${distribution('电脑', total.devices.desktop, total.entryRequests, '▱')}${distribution('手机', total.devices.mobile, total.entryRequests, '▯')}${distribution('平板', total.devices.tablet, total.entryRequests, '▭')}<p class="panel-note">根据浏览器信息粗略识别，可能存在误判。</p></section><section class="panel"><div class="panel-heading"><h2>来源概览</h2><span class="caption">按入口请求</span></div>${distribution('站内跳转', total.sources.internal, total.entryRequests, '↻')}${distribution('外部链接', total.sources.external, total.entryRequests, '↗')}${distribution('无来源信息', total.sources.unknown, total.entryRequests, '–')}<p class="panel-note">无来源信息不一定是直接访问，也可能由隐私设置造成。</p></section></div>
<section class="archive"><div><span class="archive-label">留一份观察记录</span><h2>历史每日汇总</h2><p>已归档 ${count(data.history.length)} 天 · 最多保留 400 天 · 每天结束后归档</p></div><button id="download-history" class="secondary" type="button" ${data.history.length ? '' : 'disabled'}>${data.history.length ? '下载历史 CSV' : '等待首日归档'} <span aria-hidden="true">↓</span></button></section>
<details class="methodology"><summary>统计口径与数据说明</summary><div><p>浏览器特征入口沿用原入口请求口径：GET 首页、状态 200 / 304，且未命中旧 UA 自动特征规则，不是身份认证。未标记入口是其中未命中新版自动规则的子集，仍不等于真人。预取可能多计，缓存或离线访问可能漏计。</p><p>入口组合估算沿用原访客估算，在内存中按 IP 与浏览器标识去重，包含可能被新版标记的入口。共享网络与设备变化会影响估算；小时或每日组合数不能相加作为更长期间人数。设备和来源仍按原始入口统计，未静默过滤。</p><p>原 UA 规则命中 ${count(total.automated)} 条请求，仅作历史兼容指标，不等于已验证机器人。新分类单独展示并保留原因；${count(total.clientErrors)} 条 4xx、${count(total.serverErrors)} 条 5xx 响应。统计页自身请求不计入访问日志。</p><p>AI 统计只包含本站内置模式，BYOK 不在统计范围。HTTP 2xx 表示流式接口已建立，不保证浏览器最终收到 [DONE]；请求耗时包含响应传输，响应字节不是 token 数。</p><p>AI 专用日志不含 IP、浏览器、来源或请求正文；实验只以定长哈希记录并在当前 24 小时内映射。每日历史不保存实验排行，也不保存问题或回答正文。</p><p>时间区间含开始、不含结束。页面展示最近一个双数整点之前的 24 小时，每 2 小时生成；更新失败时继续展示旧快照并提示延迟。无日志记录无法区分无人访问、离线缓存或服务器中断。</p><p>CSV 与当前屏幕来自同一份快照，仅含汇总数字，使用 UTF-8 编码，可用 Excel 打开。原始 IP、浏览器标识及完整来源网址不进入网页或下载文件。历史 CSV 中首个采集日会标记为部分采集；旧历史无分类证据时显示未知，不补零。</p><p>原始日志沿用每日轮转、保留 10 份历史文件。每日汇总保留 400 天；保留日志内的完整日可按本版规则回算，未来规则版本变化应单独比较。服务器长时间停机、超过原始日志保留期的缺失数据无法补算。本版不包含地区或停留时间。</p></div></details>
</details>
<noscript><div class="notice">浏览器禁用了脚本，以上结论仅代表报告生成时；请手动刷新查看新一期报告，额度与下载功能需要启用 JavaScript。</div></noscript>
<footer><span>SCIENCE LAB <span class="footer-dot">·</span> 让每一次探索被看见</span><span>lab.xingnian.net.cn <span class="footer-dot">·</span> 仅维护者可见</span></footer>
</main><script>${script}</script></body></html>`;
}
module.exports = { renderDashboard, toCsv, productAnalyticsToCsv };
