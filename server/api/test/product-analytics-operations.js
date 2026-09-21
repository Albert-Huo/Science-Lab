'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Nginx 产品统计入口使用匿名日志、独立限流和精确白名单', () => {
  const http = read('server/traffic/nginx-product-analytics.conf');
  const locations = read('server/traffic/nginx-locations.conf');
  assert.match(http, /limit_req_zone \$binary_remote_addr zone=science_lab_analytics:1m rate=10r\/s;/);
  const format = http.match(/log_format science_lab_product[^;]+;/s)?.[0] || '';
  for (const forbidden of ['remote_addr', 'http_user_agent', 'http_referer', 'http_cookie', 'request_uri', 'request_body']) {
    assert.equal(format.includes('$' + forbidden), false, forbidden);
  }
  for (const field of ['time', 'status', 'duration', 'requestLength', 'upstreamStatus']) assert.match(format, new RegExp('"' + field + '"'));
  assert.match(locations, /location = \/api\/analytics\/events/);
  assert.match(locations, /limit_except POST/);
  assert.match(locations, /client_max_body_size 2k;/);
  assert.match(locations, /limit_req zone=science_lab_analytics burst=30 nodelay;/);
  assert.match(locations, /access_log \/var\/log\/nginx\/science-lab-product-analytics\.log science_lab_product;/);
  assert.match(locations, /proxy_pass_request_headers off;/);
  for (const header of ['Cookie', 'User-Agent', 'Referer', 'X-Forwarded-For', 'X-Real-IP']) {
    assert.match(locations, new RegExp('proxy_set_header ' + header + ' "";'));
  }
  assert.match(locations, /proxy_pass http:\/\/127\.0\.0\.1:8970\/analytics\/events;/);
  assert.match(locations, /index\\\.html\|quota\\\.json\|analytics\\\.json/);
});

test('统计 Redis、API drop-in 与快照 timer 使用独立有界运行时', () => {
  const redis = read('server/traffic/science-lab-analytics-redis.service');
  const api = read('server/traffic/science-lab-api-analytics.conf');
  const snapshot = read('server/traffic/science-lab-product-analytics-snapshot.service');
  const timer = read('server/traffic/science-lab-product-analytics-snapshot.timer');
  assert.match(redis, /ExecStart=\/usr\/bin\/redis-server \/etc\/science-lab-analytics-redis\.conf/);
  assert.match(redis, /User=redis/);
  assert.match(redis, /ReadWritePaths=\/var\/lib\/science-lab-analytics-redis/);
  assert.match(redis, /MemoryMax=96M/);
  assert.match(redis, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/);
  assert.match(api, /Wants=science-lab-analytics-redis\.service/);
  assert.doesNotMatch(api, /Requires=science-lab-analytics-redis/);
  assert.match(api, /EnvironmentFile=\/etc\/science-lab-analytics\.env/);
  assert.match(snapshot, /EnvironmentFile=\/etc\/science-lab-analytics\.env/);
  assert.match(snapshot, /product-analytics-snapshot\.cjs --state-dir \/var\/lib\/science-lab-traffic/);
  assert.match(snapshot, /IPAddressDeny=any/);
  assert.match(snapshot, /IPAddressAllow=localhost/);
  assert.match(snapshot, /ReadWritePaths=\/var\/lib\/science-lab-traffic\/www/);
  assert.match(snapshot, /MemoryMax=96M/);
  assert.match(timer, /OnBootSec=2min/);
  assert.match(timer, /OnUnitActiveSec=5min/);
  const combined = [redis, api, snapshot, timer].join('\n');
  assert.doesNotMatch(combined, /AI_REDIS_URL|16379|science-lab-quota-redis/);
});

test('运维文档明确配置权限、端口复核、故障隔离和回滚', () => {
  const traffic = read('server/traffic/README.md');
  const deploy = read('docs/aliyun-deploy.md');
  const project = read('README.md');
  for (const text of ['/etc/science-lab-analytics.env', '/etc/science-lab-analytics-redis.conf', '127.0.0.1:16380',
    '32mb', 'noeviction', 'appendfsync everysec', 'root:root、0600', 'analytics.json']) {
    assert.ok((traffic + deploy).includes(text), text);
  }
  assert.match(traffic, /2026-09-21.*未占用/);
  assert.match(traffic, /启用前.*复核/);
  assert.match(traffic, /安全日志.*产品统计.*分离/s);
  assert.match(traffic, /回滚/);
  assert.match(project, /无身份聚合/);
  assert.match(project, /UV.*未采集/);
  assert.match(project, /第二层.*未启用/);
});
