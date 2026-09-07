(() => {
  const labels = { entryRequests: '入口请求', visitorEstimate: '访客估算', requests: '全部请求' };
  let metric = 'entryRequests', selected = null, checking = false;
  const format = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  const hours = [...document.querySelectorAll('[data-hour]')];
  function detail(index) {
    const hour = trafficData.hours[index];
    document.querySelector('#chart-detail').textContent = format(hour.start) + ' — ' + format(hour.end).slice(-5) + ' · ' +
      (hour.coverage === 'unavailable' ? '尚未开始采集' : labels[metric] + ' ' + hour[metric].toLocaleString('zh-CN') + (hour.coverage === 'partial' ? '（部分采集）' : ''));
  }
  function paint() {
    const max = Math.max(1, ...trafficData.hours.map(hour => hour[metric]));
    hours.forEach((element, index) => {
      const hour = trafficData.hours[index];
      element.querySelector('.fill').style.height = hour[metric] / max * 100 + '%';
      element.setAttribute('aria-label', format(hour.start) + '，' + (hour.coverage === 'unavailable' ? '未采集' : labels[metric] + ' ' + hour[metric]));
    });
    document.querySelector('#metric-label').textContent = labels[metric];
    document.querySelector('#chart-scale').textContent = '最高 ' + Math.max(...trafficData.hours.map(hour => hour[metric])).toLocaleString('zh-CN');
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
    const late = Date.now() > Date.parse(trafficData.nextUpdate) + 5 * 60000;
    warning.hidden = !late && !networkProblem;
    warning.textContent = late ? '更新延迟：正在显示上一份可用数据，请以页面统计区间为准。' : networkProblem;
    freshness.textContent = late ? '更新延迟' : networkProblem ? '暂未连接到服务器' : '已生成本期数据';
    document.querySelector('.status-dot').classList.toggle('delayed', late || !!networkProblem);
  }
  async function checkUpdate() {
    updateStatus();
    if (checking || document.hidden || location.protocol !== 'https:') return;
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
  setInterval(checkUpdate, 60000);
  updateStatus();
})();
