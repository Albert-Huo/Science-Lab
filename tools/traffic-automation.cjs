'use strict';
const CATEGORIES = ['verified', 'high', 'suspected', 'unclassified'];
const REASONS = Object.freeze({
  verified_google: 'Googlebot 声明与官方 IP 清单匹配',
  verified_bing: 'Bingbot 声明与官方 IP 清单匹配',
  ua_tool: '命令行、无头工具或验收客户端特征',
  ua_declared_bot: '自称爬虫、监控或预览程序，来源未验证',
  multi_probe: '同日至少 6 次探测，涉及至少 3 个敏感路径',
  probe_pattern: '同日出现至少 3 个敏感路径探测',
  navigation_burst: '同分钟至少 30 次页面请求，涉及至少 10 个页面',
  periodic_navigation: '同页至少 12 次规律请求，跨度至少 30 分钟',
});
const TOOL = /(?:^|[\s;(])(?:curl|wget|python(?:-requests|-urllib|-httpx)?|httpclient|go-http-client|headlesschrome|headless|selenium|playwright|scrapy|nikto|nmap|ScienceLab-Log-Check)(?:[\/\s;)]|$)/i;
const DECLARED = /(?:^|[\s;(])(?:googlebot(?:-image|-news|-video)?|bingbot|baiduspider|bytespider|petalbot|yandexbot|duckduckbot|applebot|ahrefsbot|semrushbot|mj12bot|dotbot|gptbot|claudebot|ccbot|oai-searchbot|chatgpt-user|perplexitybot|sogou(?: web spider)?|slurp|facebookexternalhit|twitterbot|telegrambot|slackbot|discordbot|uptimerobot|bot|spider|crawler|preview|monitor|uptime)(?:[\/\s;)]|$)/i;
const MAX_PROFILES = 8000;
const counts = keys => Object.fromEntries(keys.map(key => [key, 0]));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const day = time => Math.floor((time + 28800000) / 86400000);
const keyOf = record => day(record.timestamp) + '\n' + record.identity;
function probePath(uri) {
  let decoded = uri;
  try { decoded = decodeURIComponent(uri); } catch { /* Malformed URL encodings remain literal, not executable input. */ }
  return /(?:^|\/)\.(?:env(?:[./]|$)|git(?:\/|$))|\/(?:wp-admin|wp-login\.php|wordpress|phpmyadmin|actuator|cgi-bin|vendor)(?:\/|$)|\/(?:server-status|server-info)(?:\/|$)|\.php(?:\/|$)/i.test(decoded) ? decoded.toLowerCase() : null;
}
function createDetector({ botRanges, maxProfiles = MAX_PROFILES, maxMinutes = 16000, maxSamples = 128000, maxStringUnits = 2000000 } = {}) {
  const profiles = new Map();
  let minuteCount = 0, sampleCount = 0, stringUnits = 0, sealed = false;
  function charge(strings = 0, minutes = 0, samples = 0) {
    if (stringUnits + strings > maxStringUnits || minuteCount + minutes > maxMinutes || sampleCount + samples > maxSamples) throw new Error('自动访问观察预算超出限制，保留上一份报告');
    stringUnits += strings; minuteCount += minutes; sampleCount += samples;
  }
  return {
    observe(record) {
      if (sealed) throw new Error('自动访问观察已结束');
      if (record.identity.length > 2048 || record.uri.length > 4096) throw new Error('自动访问观察输入超出限制，保留上一份报告');
      const key = keyOf(record);
      if (!profiles.has(key)) {
        if (profiles.size >= maxProfiles) throw new Error('自动访问观察分组超出限制，保留上一份报告');
        charge(key.length);
        profiles.set(key, { probes: 0, paths: new Set(), minutes: new Map(), burst: false, pages: new Map() });
      }
      const profile = profiles.get(key), probe = probePath(record.uri);
      delete profile.decision;
      if (probe) {
        profile.probes++;
        if (profile.paths.size < 3 && !profile.paths.has(probe)) { charge(probe.length); profile.paths.add(probe); }
        return;
      }
      if (record.method !== 'GET' || !(['/', '/index.html'].includes(record.uri) || /\.html$/i.test(record.uri))) return;
      const minute = Math.floor(record.timestamp / 60000);
      if (!profile.burst) {
        if (!profile.minutes.has(minute)) { charge(0, 1); profile.minutes.set(minute, { count: 0, paths: new Set() }); }
        const item = profile.minutes.get(minute); item.count++;
        if (item.paths.size < 10 && !item.paths.has(record.uri)) { charge(record.uri.length); item.paths.add(record.uri); }
        if (item.count >= 30 && item.paths.size >= 10) {
          profile.burst = true;
          for (const value of profile.minutes.values()) for (const uri of value.paths) charge(-uri.length);
          charge(0, -profile.minutes.size); profile.minutes.clear();
        }
      }
      // Bounded samples: enough to detect a repeated page, never retain a full request history.
      if (!profile.pages.has(record.uri)) {
        if (profile.pages.size < 4) { charge(record.uri.length); profile.pages.set(record.uri, []); }
        else {
          const last = [...profile.pages.keys()].sort().at(-1);
          if (record.uri < last) {
            charge(record.uri.length - last.length, 0, -profile.pages.get(last).length);
            profile.pages.delete(last); profile.pages.set(record.uri, []);
          }
        }
      }
      const times = profile.pages.get(record.uri);
      if (times) {
        if (times.length < 64) charge(0, 0, 1);
        times.push(record.timestamp); times.sort((a,b) => a-b);
        if (times.length > 64) times.pop();
      }
    },
    seal() {
      sealed = true;
      for (const key of profiles.keys()) {
        const [date, ...identity] = key.split('\n');
        const decision = this.classify({ timestamp: Number(date) * 86400000 - 28800000, identity: identity.join('\n') });
        profiles.set(key, { decision });
      }
    },
    classify(record) {
      const [ip, ua] = record.identity.split('\n'), reasons = [], profile = profiles.get(keyOf(record));
      if (profile?.decision) return profile.decision;
      const verified = botRanges?.verify(ip, ua);
      if (verified) reasons.push('verified_' + verified);
      if (TOOL.test(ua)) reasons.push('ua_tool');
      else if (!verified && DECLARED.test(ua)) reasons.push('ua_declared_bot');
      if (profile?.paths.size >= 3) reasons.push(profile.probes >= 6 ? 'multi_probe' : 'probe_pattern');
      if (profile?.burst) reasons.push('navigation_burst');
      if (profile) for (const sample of profile.pages.values()) {
        if (sample.length < 12) continue;
        const times = [...sample].sort((a,b) => a-b), intervals = times.slice(1).map((t,i) => t - times[i]);
        if (times.at(-1) - times[0] < 1800000) continue;
        const sorted = [...intervals].sort((a,b) => a-b), median = sorted[Math.floor(sorted.length / 2)];
        if (median >= 10000 && intervals.filter(n => Math.abs(n - median) <= Math.max(1000, median * .05)).length / intervals.length >= .9) {
          reasons.push('periodic_navigation'); break;
        }
      }
      const decision = { category: verified ? 'verified' : reasons.some(r => ['ua_tool', 'multi_probe'].includes(r)) ? 'high' : reasons.length ? 'suspected' : 'unclassified', reasons };
      if (profile) profile.decision = decision;
      return decision;
    },
  };
}
function automationBucket() {
  return { version: 1, ...counts(CATEGORIES), entries: counts(CATEGORIES), reasons: counts(Object.keys(REASONS)), aiUnclassified: 0 };
}
function addAutomation(target, record, decision) {
  target[decision.category]++;
  if (record.entry) target.entries[decision.category]++;
  for (const reason of decision.reasons) target.reasons[reason]++;
  if (decision.anonymousAi) target.aiUnclassified++;
}
function cleanAutomation(value, requests, entryRequests) {
  if (value == null) return null;
  if (value.version !== 1) throw new Error('历史自动访问分类版本无效');
  const result = automationBucket();
  for (const category of CATEGORIES) for (const [source, target] of [[value, result], [value.entries, result.entries]]) {
    if (!integer(source?.[category])) throw new Error('历史自动访问分类计数无效');
    target[category] = source[category];
  }
  for (const key of Object.keys(REASONS)) {
    if (!integer(value.reasons?.[key]) || value.reasons[key] > requests) throw new Error('历史自动访问分类原因无效');
    result.reasons[key] = value.reasons[key];
  }
  if (!integer(value.aiUnclassified)) throw new Error('历史自动访问分类计数无效');
  result.aiUnclassified = value.aiUnclassified;
  if (CATEGORIES.reduce((sum,k) => sum + result[k], 0) !== requests || CATEGORIES.reduce((sum,k) => sum + result.entries[k], 0) !== entryRequests ||
      CATEGORIES.some(k => result.entries[k] > result[k]) || result.aiUnclassified > result.unclassified) throw new Error('历史自动访问分类分区不一致');
  return result;
}
module.exports = { CATEGORIES, REASONS, createDetector, automationBucket, addAutomation, cleanAutomation };
