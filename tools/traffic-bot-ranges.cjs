#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const SOURCES = Object.freeze({
  google: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json',
  bing: 'https://www.bing.com/toolbox/bingbot.json',
});
const GOOGLE_MIRROR = 'https://developers.google.cn/static/crawling/ipranges/common-crawlers.json';
const MAX_BYTES = 512 * 1024, MAX_AGE = 7 * 86400000;

function ipValue(value) {
  const family = isIP(value);
  if (!family || value.includes('%')) throw new Error('官方爬虫清单地址无效');
  if (family === 4) return { bits: 32, value: value.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n) };
  let address = value;
  if (address.includes('.')) {
    const index = address.lastIndexOf(':');
    const v4 = ipValue(address.slice(index + 1)).value;
    address = address.slice(0, index + 1) + (v4 >> 16n).toString(16) + ':' + (v4 & 65535n).toString(16);
  }
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return { bits: 128, value: parts.reduce((n, part) => (n << 16n) | BigInt('0x' + part), 0n) };
}
function cidr(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^.+\/\d{1,3}$/.test(value)) throw new Error('官方爬虫清单 CIDR 无效');
  const [address, prefixText] = value.split('/'), ip = ipValue(address), prefix = Number(prefixText);
  if (prefix < (ip.bits === 32 ? 8 : 16) || prefix > ip.bits) throw new Error('官方爬虫清单 CIDR 范围无效');
  const shift = BigInt(ip.bits - prefix);
  return { bits: ip.bits, shift, network: ip.value >> shift };
}
function compileRanges(snapshot, now = Date.now()) {
  const captured = Date.parse(snapshot?.capturedAt);
  if (snapshot?.schema !== 1 || typeof snapshot.capturedAt !== 'string' || !Number.isFinite(captured) ||
      new Date(captured).toISOString() !== snapshot.capturedAt || captured > now + 120000 || !snapshot.providers) throw new Error('官方爬虫清单格式无效');
  const ranges = {}, providers = {};
  for (const key of Object.keys(SOURCES)) {
    const values = snapshot.providers[key];
    if (!Array.isArray(values) || values.length > 5000) throw new Error('官方爬虫清单数量无效');
    ranges[key] = values.map(cidr);
    const capturedAt = snapshot.providerCapturedAt === undefined ? snapshot.capturedAt : snapshot.providerCapturedAt[key];
    const timestamp = Date.parse(capturedAt);
    if (capturedAt === null && !values.length) providers[key] = { state: 'unavailable', capturedAt: null };
    else {
      if (!values.length || typeof capturedAt !== 'string' || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== capturedAt || timestamp > now + 120000) throw new Error('官方爬虫清单来源时间无效');
      providers[key] = { state: now - timestamp > MAX_AGE ? 'stale' : 'ready', capturedAt };
    }
  }
  const states = Object.values(providers).map(p => p.state);
  const state = states.every(s => s === states[0]) ? states[0] : 'partial';
  return {
    state, capturedAt: snapshot.capturedAt, providers,
    verify(ip, ua) {
      const provider = /(?:^|[\s;(])Googlebot\//i.test(ua) ? 'google' : /(?:^|[\s;(])bingbot\//i.test(ua) ? 'bing' : null;
      if (!provider || providers[provider].state !== 'ready') return null;
      const address = ipValue(ip);
      return ranges[provider].some(range => address.bits === range.bits && address.value >> range.shift === range.network) ? provider : null;
    },
  };
}
function loadBotRanges(file, now = Date.now()) {
  if (file === undefined) return { state: 'unavailable', capturedAt: null, verify: () => null };
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return { state: 'unavailable', capturedAt: null, verify: () => null };
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('官方爬虫清单文件无效');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return compileRanges(JSON.parse(fs.readFileSync(fd, 'utf8')), now); } finally { fs.closeSync(fd); }
}
async function updateBotRanges(file, { now = Date.now(), fetchFn = fetch } = {}) {
  if (!path.isAbsolute(file)) throw new Error('官方爬虫清单需绝对路径');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const download = async url => {
      const response = await fetchFn(url, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4500)]) });
      if (!response.ok || !response.body) throw new Error('官方爬虫清单下载失败');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error('官方爬虫清单超出大小限制');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(payload.prefixes)) throw new Error('官方爬虫清单内容无效');
      const prefixes = payload.prefixes.map(item => {
        if (!item || (!!item.ipv4Prefix === !!item.ipv6Prefix)) throw new Error('官方爬虫清单地址字段无效');
        return item.ipv4Prefix || item.ipv6Prefix;
      });
      if (!prefixes.length || prefixes.length > 5000) throw new Error('官方爬虫清单数量无效');
      prefixes.forEach(cidr);
      return prefixes;
    };
    const keys = Object.keys(SOURCES);
    const results = await Promise.allSettled(keys.map(async provider => {
      try { return await download(SOURCES[provider]); } catch (error) {
        if (provider !== 'google') throw error;
        // The same official Google document is also hosted on its China developer domain.
        return download(GOOGLE_MIRROR);
      }
    }));
    if (results.every(result => result.status === 'rejected')) throw new Error('所有官方爬虫清单下载失败');
    let previous;
    if (fs.existsSync(file)) {
      loadBotRanges(file, now); // Validate the previous private file before preserving any of it.
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    const snapshot = { schema: 1, capturedAt: new Date(now).toISOString(), providers: {}, providerCapturedAt: {} };
    keys.forEach((key,i) => {
      const result = results[i];
      snapshot.providers[key] = result.status === 'fulfilled' ? result.value : previous?.providers[key] || [];
      snapshot.providerCapturedAt[key] = result.status === 'fulfilled' ? snapshot.capturedAt :
        previous?.providerCapturedAt === undefined ? previous?.capturedAt ?? null : previous.providerCapturedAt[key];
    });
    compileRanges(snapshot, now);
    // Reuse the report's fsync + rename writer; require lazily to avoid a module cycle.
    require('./traffic-dashboard.cjs').atomicWrite(file, JSON.stringify(snapshot), 0o600);
    return snapshot;
  } finally { clearTimeout(timeout); controller.abort(); }
}
module.exports = { SOURCES, GOOGLE_MIRROR, compileRanges, loadBotRanges, updateBotRanges };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') { console.error('使用 --output 服务器私有清单绝对路径'); process.exitCode = 1; }
  else updateBotRanges(args[1]).then(snapshot => {
    const state = compileRanges(snapshot).providers;
    console.log('官方爬虫清单更新完成：' + Object.keys(state).map(key => key + '=' + state[key].state).join('，'));
    if (Object.values(snapshot.providerCapturedAt).some(time => time !== snapshot.capturedAt)) {
      console.error('部分官方来源更新失败，保留该来源旧清单和原时间'); process.exitCode = 1;
    }
  }).catch(() => {
    console.error('官方爬虫清单更新失败，保留上一份清单；超过七天不再用于验证'); process.exitCode = 1;
  });
}
