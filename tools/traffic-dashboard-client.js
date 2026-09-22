(() => {
  const labels = { entryRequests: '原始入口', visitorEstimate: '入口组合估算', requests: '全部请求',
    'automation.entries.unclassified': '未标记入口', 'automation.high': '高置信自动请求', 'automation.suspected': '疑似自动请求',
    'ai.requests': 'AI 请求', 'ai.httpSuccesses': 'AI HTTP 2xx' };
  let metric = 'automation.entries.unclassified', selected = null, checking = false;
  const canRefresh = location.protocol === 'https:' || ['127.0.0.1','localhost'].includes(location.hostname);
  const format = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  const valueOf = (hour, key) => key.split('.').reduce((value, part) => value?.[part], hour) ?? 0;
  const coverageOf = (hour, key) => key.startsWith('ai.') ? hour.ai.coverage : key.startsWith('automation.') && !hour.automation ? 'unavailable' : hour.coverage;
  const hours = [...document.querySelectorAll('[data-hour]')];
  function detail(index) {
    const hour = trafficData.hours[index], coverage = coverageOf(hour, metric);
    document.querySelector('#chart-detail').textContent = format(hour.start) + ' — ' + format(hour.end).slice(-5) + ' · ' +
      (coverage === 'unavailable' ? '尚未开始采集' : labels[metric] + ' ' + valueOf(hour, metric).toLocaleString('zh-CN') + (coverage === 'partial' ? '（部分采集）' : ''));
  }
  function paint() {
    const values = trafficData.hours.map(hour => valueOf(hour, metric));
    const max = Math.max(1, ...values);
    hours.forEach((element, index) => {
      const hour = trafficData.hours[index], coverage = coverageOf(hour, metric), value = values[index];
      element.querySelector('.fill').style.height = value / max * 100 + '%';
      element.classList.toggle('unavailable', coverage === 'unavailable');
      element.setAttribute('aria-label', format(hour.start) + '，' + (coverage === 'unavailable' ? '未采集' : labels[metric] + ' ' + value));
    });
    document.querySelector('#metric-label').textContent = labels[metric];
    document.querySelector('#chart-scale').textContent = '最高 ' + Math.max(...values).toLocaleString('zh-CN');
    document.querySelector('#metric-note').textContent = metric === 'visitorEstimate' ? '小时组合估算不可相加为全天人数' : metric === 'automation.entries.unclassified' ? '未标记不等于真人访问' : metric.startsWith('automation.') ? '按同日组合观察标记，不等于恶意或入侵成功' : metric.startsWith('ai.') ? 'AI 指标只包含内置模式' : '时间区间含开始、不含结束';
    document.querySelector('.trend-panel').dataset.mode = ['automation.high', 'automation.suspected'].includes(metric) ? 'automation' : 'traffic';
    if (selected !== null) detail(selected);
  }
  for (const button of document.querySelectorAll('[data-metric]')) button.addEventListener('click', () => {
    metric = button.dataset.metric;
    document.querySelectorAll('[data-metric]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    paint();
  });
  hours.forEach((button, index) => {
    const select = () => { selected = index; hours.forEach(other => other.classList.toggle('selected', other === button)); detail(index); };
    button.addEventListener('pointerenter', select); button.addEventListener('focus', select); button.addEventListener('click', select);
  });
  function download(scope) {
    const url = URL.createObjectURL(new Blob([toCsv(trafficData, scope)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'science-lab-' + scope + '-' + new Date(Date.parse(trafficData.windowEnd) + 8 * 3600000).toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.csv';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.querySelector('#download-current').addEventListener('click', () => download('current'));
  document.querySelector('#download-history').addEventListener('click', () => download('history'));
  const warning = document.querySelector('#update-warning'), freshness = document.querySelector('#freshness');
  let networkProblem = '';
  function updateStatus() {
    const risk = riskPresentation(trafficData);
    document.querySelector('#risk-panel').dataset.state = networkProblem ? 'unknown' : risk.state;
    document.querySelector('#risk-title').textContent = networkProblem ? '连接异常 · 当前状态未知' : risk.title;
    document.querySelector('#risk-reason').textContent = networkProblem || risk.reason;
    document.querySelector('#risk-advice').textContent = networkProblem ? '检查连接或稍后刷新；以下保留的是上次统计。' : risk.advice;
    const late = Date.now() > Date.parse(trafficData.nextUpdate) + 5 * 60000;
    warning.hidden = !late && !networkProblem;
    warning.textContent = late ? '更新延迟：正在显示上一份可用数据，请以页面统计区间为准。' : networkProblem;
    freshness.textContent = late ? '更新延迟' : networkProblem ? '暂未连接到服务器' : '已生成本期数据';
    document.querySelector('.status-dot').classList.toggle('delayed', late || !!networkProblem);
  }
  async function checkUpdate() {
    updateStatus();
    if (checking || document.hidden || !canRefresh) return;
    checking = true;
    const button = document.querySelector('#check-update'); button.disabled = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(location.href, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? '访问授权已过期，请刷新后重新登录。' : '暂时无法检查更新，仍可查看和下载当前数据。');
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const generatedAt = page.querySelector('meta[name="report-generated-at"]')?.content;
      if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) throw new Error('暂时无法读取新数据，已保留当前页面。');
      networkProblem = '';
      if (Date.parse(generatedAt) > Date.parse(trafficData.generatedAt)) location.reload();
    } catch (error) {
      networkProblem = error.name === 'AbortError' || error instanceof TypeError ? '连接暂时不可用，仍可查看和下载当前数据。' : error.message;
    } finally {
      clearTimeout(timeout); checking = false; button.disabled = false; updateStatus();
    }
  }
  document.querySelector('#check-update').addEventListener('click', checkUpdate);
  let quotaChecking = false, quotaSnapshot = null, quotaProblem = '';
  function paintQuota() {
    const presentation = quotaPresentation(quotaSnapshot);
    const status = document.querySelector('#quota-status');
    status.textContent = quotaProblem ? quotaProblem + (quotaSnapshot ? ' · 以下为上次采样' : '') : presentation.status;
    status.dataset.state = quotaProblem ? 'unavailable' : presentation.state;
    if (!quotaProblem && presentation.state === 'ready') {
      if (quotaSnapshot.globalRemaining === 0) {
        status.textContent = 'AI 额度已用完 · 等待额度重置'; status.dataset.state = 'warning';
      } else if (quotaSnapshot.activeRequests >= quotaSnapshot.concurrentLimit) {
        status.textContent = 'AI 当前繁忙 · 新请求可能被限流，请稍后重试'; status.dataset.state = 'warning';
      } else if (quotaSnapshot.globalRemaining / quotaSnapshot.globalLimit <= 0.2) {
        status.textContent = 'AI 剩余额度不超过 20% · 建议关注用量'; status.dataset.state = 'warning';
      } else {
        status.textContent = 'AI 额度充足 · 并发未满（不代表模型服务可用）';
      }
    }
    document.querySelector('.quota-panel').dataset.stale = String(!!quotaProblem || presentation.state === 'stale');
    for (const key of ['remaining', 'active', 'reset', 'sampled']) document.querySelector('#quota-' + key).textContent = presentation[key];
  }
  async function checkQuota() {
    paintQuota();
    if (quotaChecking || document.hidden || !canRefresh) return;
    quotaChecking = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(new URL('quota.json', location.href), { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error('quota_unavailable');
      const body = await response.text();
      if (body.length > 4096) throw new Error('quota_invalid');
      const snapshot = JSON.parse(body);
      if (quotaPresentation(snapshot).state === 'invalid') throw new Error('quota_invalid');
      quotaSnapshot = snapshot; quotaProblem = '';
    } catch {
      // Do not show upstream bodies/errors: they can contain infrastructure details.
      quotaProblem = '无法读取新额度快照，当前状态未知';
    } finally {
      clearTimeout(timeout); quotaChecking = false; paintQuota();
    }
  }
  let analyticsChecking = false, analyticsSnapshot = null, analyticsProblem = '', productMetric = 'pageViews';
  const productLabels = { pageViews: '页面浏览 PV', experimentOpens: '实验打开次数', keyActions: '关键操作' };
  const productSources = { direct: '直接访问', internal: '站内跳转', search: '搜索来源', external: '外部链接' };
  const productActions = { catalog_open: '打开目录', profile_open: '打开“我的”', experiment_previous: '上一实验', experiment_next: '下一实验' };
  function paintDefinitionList(target, labels, values) {
    target.replaceChildren(...Object.entries(labels).map(([key, label]) => {
      const row = document.createElement('div'), term = document.createElement('dt'), number = document.createElement('dd');
      term.textContent = label; number.textContent = values[key].toLocaleString('zh-CN'); row.append(term, number); return row;
    }));
  }
  function paintProductTrend(snapshot) {
    const target = document.querySelector('#product-bars');
    const max = Math.max(1, ...snapshot.hours.map(hour => hour[productMetric]));
    target.replaceChildren(...snapshot.hours.map(hour => {
      const bar = document.createElement('span');
      bar.className = 'product-bar' + (hour.coverage === 'unavailable' ? ' unavailable' : '');
      if (hour.coverage !== 'unavailable') bar.style.height = Math.max(2, hour[productMetric] / max * 100) + '%';
      const period = format(hour.start) + ' — ' + format(hour.end).slice(-5);
      const detail = hour.coverage === 'unavailable' ? '未采集' : productLabels[productMetric] + ' ' + hour[productMetric].toLocaleString('zh-CN') + (hour.coverage === 'partial' ? '，部分采集' : '');
      bar.title = period + ' · ' + detail; bar.setAttribute('aria-label', bar.title); return bar;
    }));
    document.querySelector('#product-trend-note').textContent = productLabels[productMetric] + ' · 最高 ' +
      Math.max(...snapshot.hours.map(hour => hour[productMetric])).toLocaleString('zh-CN') + ' · 无身份聚合，不按访客串联行为';
  }
  function paintExperiments(items) {
    const target = document.querySelector('#product-experiments');
    if (!items.length) {
      const empty = document.createElement('li'); empty.className = 'product-empty'; empty.textContent = '当前窗口暂无实验打开记录';
      target.replaceChildren(empty); return;
    }
    target.replaceChildren(...items.map((item, index) => {
      const row = document.createElement('li'), name = document.createElement('span'), rank = document.createElement('i'), number = document.createElement('b');
      rank.textContent = String(index + 1); name.append(rank, document.createTextNode(item.title)); number.textContent = item.count.toLocaleString('zh-CN');
      row.append(name, number); return row;
    }));
  }
  function paintAnalytics() {
    const presentation = productAnalyticsPresentation(analyticsSnapshot);
    const panel = document.querySelector('.product-panel'), status = document.querySelector('#analytics-status');
    panel.dataset.state = analyticsProblem ? 'unavailable' : presentation.state;
    status.dataset.state = panel.dataset.state;
    status.textContent = analyticsProblem ? analyticsProblem + (analyticsSnapshot ? ' · 以下为上次快照' : '') : presentation.status;
    for (const key of ['pageViews', 'experimentOpens', 'keyActions', 'uv', 'sessions', 'completion', 'sampled']) {
      document.querySelector('#analytics-' + key).textContent = presentation[key];
    }
    const button = document.querySelector('#download-product');
    button.disabled = !presentation.snapshot;
    if (!presentation.snapshot) return;
    paintProductTrend(presentation.snapshot);
    paintDefinitionList(document.querySelector('#product-sources'), productSources, presentation.snapshot.totals.sources);
    paintDefinitionList(document.querySelector('#product-actions'), productActions, presentation.snapshot.totals.actions);
    paintExperiments(presentation.snapshot.totals.topExperiments);
  }
  async function checkAnalytics() {
    paintAnalytics();
    if (analyticsChecking || document.hidden || !canRefresh) return;
    analyticsChecking = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(new URL('analytics.json', location.href), { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error('analytics_unavailable');
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > 2 * 1024 * 1024) throw new Error('analytics_invalid');
      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024) throw new Error('analytics_invalid');
      const snapshot = JSON.parse(body);
      if (productAnalyticsPresentation(snapshot).state === 'invalid') throw new Error('analytics_invalid');
      analyticsSnapshot = snapshot; analyticsProblem = '';
    } catch {
      analyticsProblem = '无法读取新产品统计，当前状态未知';
    } finally {
      clearTimeout(timeout); analyticsChecking = false; paintAnalytics();
    }
  }
  for (const button of document.querySelectorAll('[data-product-metric]')) button.addEventListener('click', () => {
    productMetric = button.dataset.productMetric;
    document.querySelectorAll('[data-product-metric]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    if (analyticsSnapshot) paintProductTrend(analyticsSnapshot);
  });
  document.querySelector('#download-product').addEventListener('click', () => {
    if (!analyticsSnapshot) return;
    const url = URL.createObjectURL(new Blob([productAnalyticsToCsv(analyticsSnapshot)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = 'science-lab-product-' + analyticsSnapshot.capturedAt.slice(0, 16).replace(/[:T]/g, '-') + '.csv';
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.querySelector('#check-update').addEventListener('click', checkQuota);
  document.querySelector('#check-update').addEventListener('click', checkAnalytics);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkUpdate(); checkQuota(); checkAnalytics(); } });
  setInterval(checkUpdate, 60000);
  setInterval(checkQuota, 60000);
  setInterval(checkAnalytics, 300000);
  checkQuota();
  checkAnalytics();
  updateStatus();
})();
