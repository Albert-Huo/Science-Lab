'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const PORT = Number(process.env.PORT || 8970);
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '30d';
const ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('启动失败：请在 .env 设置足够长的 JWT_SECRET'); process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // 处于 nginx 反代之后，限流取真实 IP
app.use(express.json({ limit: '256kb' }));

// CORS：仅允许白名单来源
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);            // 同源/curl 等无 Origin
    if (ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
}));

const HISTORY_MAX = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

app.get('/health', (_req, res) => res.json({ ok: true }));

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

async function start() {
  await db.init();
  app.listen(PORT, '127.0.0.1', () => console.log('science-lab-api listening on 127.0.0.1:' + PORT));
}
if (require.main === module) start().catch(e => { console.error('启动失败：', e); process.exit(1); });

module.exports = app;
