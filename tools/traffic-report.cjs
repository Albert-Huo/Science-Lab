#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { isIP } = require('node:net');

const LOG_NAME = /^science-lab-access\.log(?:-\d{8}(?:\.gz)?)?$/;
const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "((?:\\.|[^"\\])*)" (\d{3}) (\d+|-) "((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)"(?: "((?:\\.|[^"\\])*)")?$/;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const AUTOMATION = /bot|spider|crawler|slurp|headless|curl|wget|python|httpclient|go-http-client|scan|facebookexternalhit|preview|monitor|uptime|ScienceLab-Log-Check\//i;

function parseTime(value) {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
  if (!m) return NaN;
  const month = MONTHS.indexOf(m[2]), day = +m[1], year = +m[3], hour = +m[4], minute = +m[5], second = +m[6];
  if (month < 0 || year < 2000 || hour > 23 || minute > 59 || second > 59 || +m[8] > 23 || +m[9] > 59) return NaN;
  const local = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(local);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return NaN;
  const offset = (+m[8] * 60 + +m[9]) * 60000 * (m[7] === '+' ? 1 : -1);
  return local - offset;
}

function sourceGroup(referrer) {
  try {
    const url = new URL(referrer);
    if (!['http:', 'https:'].includes(url.protocol)) return 'unknown';
    return url.hostname === 'lab.xingnian.net.cn' ? 'internal' : 'external';
  } catch { return 'unknown'; } // Missing or malformed Referer is expected, not a visitor identity.
}

function parseRecord(line) {
  if (!line.trim()) return null;
  const m = LINE.exec(line);
  const timestamp = m ? parseTime(m[2]) : NaN;
  if (!m || !Number.isFinite(timestamp) || !isIP(m[1])) throw new Error('无法解析访问日志');
  const [method, target] = m[3].split(' ');
  const uri = (target || '').split('?')[0];
  const automated = AUTOMATION.test(m[7]);
  const tablet = /iPad|Tablet/i.test(m[7]) || (/Android/i.test(m[7]) && !/Mobile/i.test(m[7]));
  return {
    timestamp, uri, status: +m[4], automated,
    entry: !automated && /Mozilla\//.test(m[7]) && method === 'GET' && ['/', '/index.html'].includes(uri) && [200, 304].includes(+m[4]),
    identity: m[1] + '\n' + m[7],
    device: tablet ? 'tablet' : /Mobile|Android|iPhone/i.test(m[7]) ? 'mobile' : 'desktop',
    source: sourceGroup(m[6])
  };
}

function accumulator({ generatedAt = new Date().toISOString() } = {}) {
  const totals = { requests: 0, entryRequests: 0, visitorEstimate: 0, automated: 0, invalid: 0 };
  const devices = { desktop: 0, mobile: 0, tablet: 0 };
  const sources = { internal: 0, external: 0, unknown: 0 };
  const days = new Map(), identities = new Set();
  let earliest = Infinity, latest = -Infinity;
  return {
    add(line) {
      if (!line.trim()) return;
      const m = LINE.exec(line);
      const timestamp = m ? parseTime(m[2]) : NaN;
      if (!m || !Number.isFinite(timestamp) || !isIP(m[1])) { totals.invalid++; return; }
      totals.requests++;
      earliest = Math.min(earliest, timestamp); latest = Math.max(latest, timestamp);
      const day = new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10);
      if (!days.has(day)) days.set(day, { day, requests: 0, entryRequests: 0, identities: new Set() });
      const bucket = days.get(day); bucket.requests++;
      const automated = AUTOMATION.test(m[7]);
      if (automated) totals.automated++;
      const [method, target] = m[3].split(' ');
      const uri = (target || '').split('?')[0];
      if (automated || !/Mozilla\//.test(m[7]) || method !== 'GET' || !['/', '/index.html'].includes(uri) || ![200, 304].includes(+m[4])) return;
      // These sets never enter the output: only aggregate cardinalities leave the server.
      const identity = m[1] + '\n' + m[7];
      identities.add(identity); bucket.identities.add(identity);
      totals.entryRequests++; bucket.entryRequests++;
      const tablet = /iPad|Tablet/i.test(m[7]) || (/Android/i.test(m[7]) && !/Mobile/i.test(m[7]));
      const device = tablet ? 'tablet' : /Mobile|Android|iPhone/i.test(m[7]) ? 'mobile' : 'desktop';
      devices[device]++; sources[sourceGroup(m[6])]++;
    },
    finish(files = []) {
      return {
        schema: 1, site: 'lab.xingnian.net.cn', generatedAt,
        earliest: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null,
        latest: Number.isFinite(latest) ? new Date(latest).toISOString() : null,
        totals: { ...totals, visitorEstimate: identities.size }, devices, sources, files,
        days: [...days.values()].sort((a,b) => a.day.localeCompare(b.day)).map(d => ({
          day: d.day, requests: d.requests, entryRequests: d.entryRequests, visitorEstimate: d.identities.size
        }))
      };
    }
  };
}

function summarize(lines, options) {
  const result = accumulator(options);
  for (const line of lines) result.add(line);
  return result.finish();
}

async function summarizeDirectory(directory, options) {
  const result = accumulator(options);
  const files = await visitLogDirectory(directory, line => result.add(line));
  return result.finish(files);
}

async function visitLogDirectory(directory, visit) {
  const names = fs.readdirSync(directory).filter(name => LOG_NAME.test(name)).sort();
  if (!names.length) throw new Error('未找到实验馆独立日志；不会使用旧混合日志代替。');
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error('独立日志必须是普通文件 (regular file)：' + name);
    files.push({ name, bytes: stat.size });
    if (!stat.size) continue;
    // Bound the scan to the file size observed at the start, even while Nginx appends.
    const source = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, end: stat.size - 1 });
    const input = name.endsWith('.gz') ? source.pipe(zlib.createGunzip()) : source;
    if (input !== source) source.on('error', error => input.destroy(error));
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) visit(line);
    } catch (error) {
      throw new Error('读取独立日志失败：' + name + '（' + error.code + '）', { cause: error });
    } finally { reader.close(); source.destroy(); if (input !== source) input.destroy(); }
  }
  return files;
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '—';
function displayTime(value) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(date);
}

function renderHtml(data) {
  if (data.schema !== 1 || !Array.isArray(data.days) || !data.totals || !data.devices || !data.sources || !Array.isArray(data.files)) throw new Error('统计汇总格式无效。');
  const t = data.totals, max = Math.max(1, ...data.days.map(d => Number(d.entryRequests) || 0));
  const rows = data.days.map(d => `<tr><th scope="row">${escape(d.day)}</th><td><span class="bar" style="width:${Math.min(100,Math.max(0,(Number(d.entryRequests)||0)/max*100))}%"></span><span class="value">${number(d.entryRequests)}</span></td><td>${number(d.visitorEstimate)}</td><td>${number(d.requests)}</td></tr>`).join('');
  const split = (title, values) => `<section class="panel"><h2>${title}<small>按入口请求计</small></h2><dl>${values.map(([label,count])=>`<div><dt>${label}</dt><dd>${number(count)}</dd></div>`).join('')}</dl></section>`;
  const bytes = data.files.reduce((sum,f)=>sum+(Number(f.bytes)||0),0);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>实验馆 · 私有访问简报</title>
<style>
:root{color-scheme:dark;--bg:#0b1319;--panel:#121e27;--line:#293946;--text:#e6edea;--muted:#a0b2bc;--accent:#80d4bc}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;line-height:1.6}main{max-width:1120px;margin:0 auto;padding:54px 30px}header{border-bottom:1px solid var(--line);padding-bottom:28px;margin-bottom:26px}.eyebrow{display:flex;justify-content:space-between;gap:12px;color:var(--accent);font-size:12px;letter-spacing:2px}.private{border:1px solid #396354;padding:2px 10px;border-radius:5px;letter-spacing:0}h1{font-size:38px;line-height:1.3;letter-spacing:-1px;margin:20px 0 12px;font-weight:600}.subtitle,.meta,footer{color:var(--muted);font-size:13px}.meta{margin-top:14px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}.card{border:1px solid var(--line);background:var(--panel);padding:22px;border-radius:12px}.card p{margin:0;color:var(--muted);font-size:13px}.metric{font-family:Georgia,"Times New Roman",serif;font-size:45px;line-height:1.4;font-variant-numeric:tabular-nums}.card:first-child{border-top:3px solid var(--accent)}.card small{color:var(--muted);font-size:12px}.notice{border-left:3px solid var(--accent);background:#112820;padding:14px 18px;margin:0 0 22px;border-radius:0 8px 8px 0;font-size:14px}.warning{border-color:#e4b76c;background:#332715}.panel{border:1px solid var(--line);border-radius:12px;padding:22px;background:var(--panel);margin-bottom:18px}h2{font-size:16px;margin:0 0 18px;font-weight:600}h2 small{font-weight:400;color:var(--muted);font-size:11px;margin-left:12px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:490px;font-size:13px}th,td{padding:12px 10px;text-align:right;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}th:first-child{text-align:left;font-weight:400}thead th{color:var(--muted);font-size:12px;font-weight:400}tbody tr:last-child>*{border-bottom:0}td:nth-child(2){position:relative;width:32%}.bar{display:block;position:absolute;left:0;top:20%;height:60%;background:#275443;border-radius:3px}.value{position:relative;z-index:1}.split{display:grid;grid-template-columns:1fr 1fr;gap:18px}dl{margin:0}dl div{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line)}dl div:last-child{border:0}dt{color:var(--muted);font-size:13px}dd{margin:0;font-variant-numeric:tabular-nums}.notes{font-size:13px;color:var(--muted);padding-left:20px;margin:0}.notes li{margin:9px 0}.empty{padding:22px 0;text-align:center;color:var(--muted)}footer{border-top:1px solid var(--line);padding-top:18px;font-size:12px;display:flex;justify-content:space-between;gap:18px}@media(max-width:640px){main{padding:28px 16px}h1{font-size:29px}.cards{grid-template-columns:1fr;gap:10px}.card{padding:16px 20px}.metric{font-size:38px}.split{grid-template-columns:1fr;gap:0}.panel{padding:17px}footer{display:block}.eyebrow{letter-spacing:1px}}@media print{body{background:white;color:#17252d}.card,.panel{background:white}.bar{background:#dbede5}.notice{background:#eaf5ef}main{padding:0}.private{color:#17252d}}
</style></head><body><main>
<header><div class="eyebrow"><span>SCIENCE LAB / FIELD NOTES</span><span class="private">仅供站点维护者查看</span></div><h1>实验馆 · 访问简报</h1><div class="subtitle">lab.xingnian.net.cn · 独立服务器日志 · 无新增网页追踪</div><div class="meta">生成于 ${escape(displayTime(data.generatedAt))}（北京时间）<br>日志覆盖：${escape(displayTime(data.earliest))} — ${escape(displayTime(data.latest))}</div></header>
<section class="cards"><article class="card"><p>入口请求</p><div class="metric">${number(t.entryRequests)}</div><small>浏览器特征 · GET 首页 · 200 / 304</small></article><article class="card"><p>访客估算</p><div class="metric">${number(t.visitorEstimate)}</div><small>期间 IP 与浏览器组合去重，不代表真实人数</small></article><article class="card"><p>全部请求</p><div class="metric">${number(t.requests)}</div><small>包含资源、接口、重定向和自动化访问</small></article></section>
${!t.entryRequests?'<div class="notice">暂无可计入的入口访问。独立日志刚启用或本期只有验收、自动化请求时，显示 0 是正常的；不会用旧混合日志填充数据。</div>':''}
${t.invalid?`<div class="notice warning">有 ${number(t.invalid)} 行日志无法解析，未计入指标；本报告可能不完整，请先检查日志格式。</div>`:''}
<section class="panel"><h2>每日趋势<small>北京时间 · 不足整天也会显示</small></h2>${rows?`<div class="table-wrap"><table><thead><tr><th scope="col">日期</th><th scope="col">入口请求</th><th scope="col">当日访客估算</th><th scope="col">全部请求</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="empty">等待第一条独立日志</p>'}</section>
<div class="split">${split('访问设备',[['电脑',data.devices.desktop],['手机',data.devices.mobile],['平板',data.devices.tablet]])}${split('来源概览',[['站内跳转',data.sources.internal],['外部链接',data.sources.external],['无来源信息',data.sources.unknown]])}</div>
<section class="panel"><h2>如何理解这些数字</h2><ul class="notes"><li>入口请求不是会话数或精确浏览量：缓存预取可能多计，离线或未到达服务器的访问可能漏计。</li><li>访客估算只在内存中按 IP 与浏览器标识组合去重；同一人换设备可能多计，共用网络和相同浏览器可能少计。每日估算不能相加作为期间人数。</li><li>已排除 ${number(t.automated)} 条明显机器人、命令行及验收请求；规则无法识别所有机器人，也无法排除所有站点维护者访问。</li><li>地区、停留时间、GitHub Pages 中各个实验的使用热度不在本报告内；无来源信息不等于用户直接输入网址。</li><li>本报告不含原始 IP、浏览器标识、完整来源网址或查询参数，没有脚本和外部资源。原始日志仅保留在服务器，不应公开。</li><li>仅统计仍保留的独立日志；沿用每日轮转、保留 10 份历史日志的现有策略，不是永久历史报表。</li></ul></section>
<footer><span>PRIVATE / 按需生成的本地快照，非实时看板</span><span>${number(data.files.length)} 份日志 · 磁盘约 ${(bytes/1024).toFixed(1)} KB</span></footer>
</main></body></html>`;
}

async function main(args) {
  const options = {};
  for (let i=0;i<args.length;i++) {
    const key=args[i];
    if (key==='--json') options.json=true;
    else if (['--log-dir','--remote','--node','--output'].includes(key) && args[i+1] && !args[i+1].startsWith('--')) options[key.slice(2)]=args[++i];
    else throw new Error('参数无效。使用 --log-dir 目录 --json，或 --remote 用户@主机 --node 远端Node路径 --output 本地报告.html。');
  }
  let data;
  if (options.remote) {
    if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(options.remote)) throw new Error('SSH 目标格式无效。');
    if (!/^\/[a-zA-Z0-9/._-]+$/.test(options.node || '')) throw new Error('需提供远端 Node 的绝对路径。');
    const output = execFileSync('ssh', ['-T','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=yes',options.remote, options.node+' - --log-dir /var/log/nginx --json'], {
      input:fs.readFileSync(__filename), encoding:'utf8', timeout:60000, maxBuffer:4*1024*1024, stdio:['pipe','pipe','inherit']
    });
    data=JSON.parse(output);
  } else data=await summarizeDirectory(options['log-dir'] || '/var/log/nginx');
  if (options.json) { console.log(JSON.stringify(data,null,2)); return; }
  if (!options.output || !path.isAbsolute(options.output) || !options.output.endsWith('.html')) throw new Error('需提供本地 HTML 报告的绝对路径。');
  fs.writeFileSync(options.output, renderHtml(data), { mode:0o600, flag:'wx' });
  console.log('已生成私有报告：'+options.output);
  console.log('入口请求 '+data.totals.entryRequests+'；访客估算 '+data.totals.visitorEstimate+'；解析失败 '+data.totals.invalid+'。');
}

module.exports = { summarize, summarizeDirectory, renderHtml, parseRecord, visitLogDirectory };
if (require.main === module || module.id === '[stdin]') main(process.argv.slice(2)).catch(error=>{console.error('生成私有统计失败：'+error.message);process.exitCode=1;});
