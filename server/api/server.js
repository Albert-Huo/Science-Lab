'use strict';
require('dotenv').config();

const APP_MODE = process.env.APP_MODE || 'full';
if (!['full', 'ai-only'].includes(APP_MODE)) {
  console.error('启动失败：APP_MODE 必须为 full 或 ai-only'); process.exit(1);
}
const AI_ONLY = APP_MODE === 'ai-only';

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createHash } = require('node:crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { createAiPolicy } = require('./ai-policy');
const { createQuota } = require('./ai-quota');
const { createEventLogger, createSseObserver } = require('./ai-events');
const db = AI_ONLY ? null : require('./db');

const PORT = Number(process.env.PORT || 8970);
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '30d';
const ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const AI_RATE_LIMIT_MINUTE_MAX = positiveInt(process.env.AI_RATE_LIMIT_MINUTE_MAX, 10);
const AI_RATE_LIMIT_DAY_MAX = positiveInt(process.env.AI_RATE_LIMIT_DAY_MAX, 20);
const AI_UPSTREAM_TIMEOUT_MS = positiveInt(process.env.AI_UPSTREAM_TIMEOUT_MS, 120000);
const quota = createQuota({
  minuteMax: AI_RATE_LIMIT_MINUTE_MAX,
  ipDayMax: AI_RATE_LIMIT_DAY_MAX,
  sessionDayMax: positiveInt(process.env.AI_SESSION_DAY_MAX, 20),
  globalDayMax: positiveInt(process.env.AI_GLOBAL_DAY_MAX, 500),
  concurrentMax: positiveInt(process.env.AI_GLOBAL_CONCURRENT_MAX, 10),
  timeoutMs: AI_UPSTREAM_TIMEOUT_MS,
  secret: process.env.AI_SESSION_SECRET,
  redisUrl: process.env.AI_REDIS_URL,
  production: process.env.NODE_ENV === 'production',
});

if (!AI_ONLY && (!JWT_SECRET || JWT_SECRET.length < 16)) {
  console.error('启动失败：请在 .env 设置足够长的 JWT_SECRET'); process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // 处于 nginx 反代之后，限流取真实 IP
const aiEvents = createEventLogger({ path: process.env.AI_EVENT_LOG_PATH });
// Install before body parsing so malformed/oversized requests also have a terminal event.
app.use((req, res, next) => {
  if (req.method !== 'POST' || !/^\/ai\/chat\/completions\/?$/i.test(req.path)) return next();
  const started = performance.now();
  let recorded = false;
  const event = { scope: '', firstTokenMs: null };
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  res.locals.aiEvent = {
    event,
    firstToken() { if (event.firstTokenMs === null) event.firstTokenMs = elapsed(); },
    finish(outcome) {
      if (recorded) return;
      recorded = true;
      aiEvents.record({ ...event, outcome, status: res.headersSent ? res.statusCode : null, durationMs: elapsed() });
    },
  };
  // Defer close fallback until the stream pipeline can classify upstream failures.
  res.once('close', () => setImmediate(() => res.locals.aiEvent.finish(
    res.writableFinished ? 'internal_error' : 'client_aborted')));
  next();
});
if (AI_ONLY) {
  // 在 CORS 预检和 JSON 解析前禁用，确保旧接口的所有方法统一返回 503。
  app.use(['/auth', '/progress'], (_req, res) => res.status(503).json({ error: 'sync_disabled' }));
}
app.use(express.json({ limit: '256kb' }));

// CORS：仅允许白名单来源
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);            // 同源/curl 等无 Origin
    if (ORIGINS.includes(origin)) return cb(null, true);
    const error = new Error('Origin not allowed');
    error.code = 'origin_not_allowed';
    return cb(error);
  },
  exposedHeaders: ['Retry-After', 'X-AI-Quota-Limit', 'X-AI-Quota-Remaining', 'X-AI-Quota-Reset', 'X-AI-Quota-Scope'],
}));

const HISTORY_MAX = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const configuredAiModel = String(process.env.DEEPSEEK_MODEL || '').trim();
const DEFAULT_AI_MODEL = configuredAiModel || 'deepseek-v4-flash';
const sanitizeAiBody = createAiPolicy(require('./ai-context.json'), DEFAULT_AI_MODEL);

function sign(user) { return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES }); }

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return res.status(401).json({ error: 'unauthorized' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'invalid_token' }); }
}

// 校验并规整历史数组
function sanitizeHistory(arr) {
  if (!Array.isArray(arr)) return null;
  const seen = new Set(); const out = [];
  for (const x of arr) {
    if (!x || typeof x.path !== 'string') continue;
    if (seen.has(x.path)) continue;
    seen.add(x.path);
    out.push({
      path: String(x.path).slice(0, 300),
      title: typeof x.title === 'string' ? x.title.slice(0, 300) : '',
      ts: Number.isFinite(x.ts) ? x.ts : 0,
    });
    if (out.length >= HISTORY_MAX) break;
  }
  return out;
}

function mergeHistory(a, b) {
  const m = new Map();
  for (const x of [...(a || []), ...(b || [])]) {
    if (!x || !x.path) continue;
    const cur = m.get(x.path);
    if (!cur || (x.ts || 0) > (cur.ts || 0)) m.set(x.path, x);
  }
  return [...m.values()].sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, HISTORY_MAX);
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const aiMinuteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: AI_RATE_LIMIT_MINUTE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', scope: 'ip_minute', message: '请求较频繁，请稍后再试。' },
  handler(req, res, _next, options) {
    res.set('X-AI-Quota-Scope', 'ip_minute');
    res.status(429).json(options.message);
    res.locals.aiEvent.event.scope = 'ip_minute';
    res.locals.aiEvent.finish('rate_limited');
  },
});

function setAiMetricHeaders(res, messages, context) {
  const rawPath = context && typeof context.experimentPath === 'string' ? context.experimentPath : '';
  const experiment = rawPath && rawPath.length <= 300
    ? createHash('sha256').update(rawPath).digest('hex')
    : '';
  res.set({
    'X-Science-Lab-AI-Experiment': experiment,
    'X-Science-Lab-AI-Messages': String(messages.length),
    'X-Science-Lab-AI-Input-Chars': String(messages.reduce((sum, item) => sum + item.content.length, 0)),
  });
  Object.assign(res.locals.aiEvent.event, { experiment, messages: messages.length,
    inputChars: messages.reduce((sum, item) => sum + item.content.length, 0),
    promptChars: messages.filter(item => item.role === 'system').reduce((sum, item) => sum + item.content.length, 0),
    conversationChars: messages.filter(item => item.role !== 'system').reduce((sum, item) => sum + item.content.length, 0) });
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// Express 4 does not automatically forward rejected async handlers to error middleware.
app.post('/ai/chat/completions', aiMinuteLimiter, (req, res, next) => handleAiChat(req, res).catch(next));
async function handleAiChat(req, res) {
  const terminal = res.locals.aiEvent;
  res.set('Cache-Control', 'no-store');
  const parsed = sanitizeAiBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    terminal.finish('invalid_request'); return;
  }
  setAiMetricHeaders(res, parsed.value.messages, { experimentPath: parsed.experimentPath });

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'ai_unavailable', message: 'AI 助手暂未配置，请稍后再试' });
    terminal.finish('not_configured'); return;
  }

  const release = await quota.reserve(req, res);
  if (!release) {
    if (res.statusCode === 429) terminal.event.scope = res.getHeader('X-AI-Quota-Scope') || '';
    terminal.finish(res.destroyed ? 'client_aborted' : res.statusCode === 429 ? 'rate_limited' : 'quota_unavailable');
    return;
  }
  if (res.destroyed) { terminal.finish('client_aborted'); await release(); return; }

  const controller = new AbortController();
  let abortKind = '';
  let upstreamFailed = false;
  const timeout = setTimeout(() => {
    if (abortKind) return;
    abortKind = 'timeout';
    controller.abort();
  }, AI_UPSTREAM_TIMEOUT_MS);
  const abortOnClientClose = () => {
    if (!res.writableEnded && !abortKind && !upstreamFailed) {
      abortKind = 'client';
      controller.abort();
    }
  };
  res.once('close', abortOnClientClose);

  try {
    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(parsed.value),
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body || !(upstream.headers.get('content-type') || '').includes('text/event-stream')) {
      console.error('DeepSeek 请求失败，状态码：' + upstream.status);
      if (upstream.body) {
        try { await upstream.body.cancel(); }
        catch { console.error('DeepSeek 错误响应体清理失败'); }
      }
      res.status(502).json({ error: 'ai_upstream_error' });
      terminal.finish('upstream_error'); return;
    }

    res.status(200);
    res.set({
      'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const source = Readable.fromWeb(upstream.body);
    source.once('error', () => { upstreamFailed = true; });
    await pipeline(source, createSseObserver({ onFirstToken: () => terminal.firstToken(),
      onDone: () => terminal.finish('completed'), onError: () => terminal.finish('upstream_error') }), res);
    terminal.finish('stream_incomplete');
  } catch {
    if (abortKind === 'client') { terminal.finish('client_aborted'); return; }
    if (abortKind === 'timeout') {
      console.error('DeepSeek 代理失败：upstream_timeout');
      if (!res.headersSent) res.status(504).json({ error: 'ai_upstream_timeout' });
      if (!res.writableEnded) res.end();
      terminal.finish('upstream_timeout');
      return;
    }
    console.error('DeepSeek 代理失败：upstream_unavailable');
    if (!res.headersSent) res.status(502).json({ error: 'ai_upstream_unavailable' });
    if (!res.writableEnded) res.end();
    terminal.finish('upstream_error');
  } finally {
    clearTimeout(timeout);
    res.removeListener('close', abortOnClientClose);
    await release();
  }
}

app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
    if (password.length < 6) return res.status(400).json({ error: 'weak_password' });
    const hash = await bcrypt.hash(password, 10);
    let user;
    try { user = await db.createUser(email, hash); }
    catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'email_taken' });
      throw e;
    }
    res.json({ token: sign(user), email: user.email });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await db.findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'bad_credentials' });
    const ok = await bcrypt.compare(password, user.pass_hash);
    if (!ok) return res.status(401).json({ error: 'bad_credentials' });
    res.json({ token: sign(user), email: user.email });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 拉取进度
app.get('/progress', auth, async (req, res) => {
  try {
    const history = (await db.getProgress(req.user.uid)) || [];
    res.json({ history });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 上传并合并进度，返回合并后的权威结果
app.put('/progress', auth, async (req, res) => {
  try {
    const incoming = sanitizeHistory(req.body.history);
    if (incoming === null) return res.status(400).json({ error: 'invalid_history' });
    const existing = (await db.getProgress(req.user.uid)) || [];
    const merged = mergeHistory(existing, incoming);
    await db.upsertProgress(req.user.uid, merged);
    res.json({ history: merged });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.use((error, _req, res, _next) => {
  const finish = outcome => res.locals.aiEvent?.finish(outcome);
  if (error.type === 'request.aborted') { finish('client_aborted'); return; }
  if (res.headersSent) { res.end(); finish('internal_error'); return; }
  if (error.code === 'origin_not_allowed') {
    res.status(403).json({ error: 'origin_not_allowed' }); finish('invalid_request'); return;
  }
  if (error.type === 'entity.too.large') {
    res.status(413).json({ error: 'request_too_large' }); finish('invalid_request'); return;
  }
  if (error.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json' }); finish('invalid_request'); return;
  }
  console.error('API 请求失败：internal_error');
  res.status(500).json({ error: 'server_error' }); finish('internal_error');
});

async function start() {
  if (!AI_ONLY) await db.init();
  await quota.connect();
  app.listen(PORT, '127.0.0.1', () => console.log('science-lab-api listening on 127.0.0.1:' + PORT));
}
if (require.main === module) start().catch(e => { console.error('启动失败：', e); process.exit(1); });

module.exports = app;
