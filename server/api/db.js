'use strict';
/* 数据访问层。
 * 默认使用 MySQL（mysql2）。设置 DB_DRIVER=memory 时使用内存实现，仅供本地自测，不持久化。
 */
const DRIVER = process.env.DB_DRIVER || 'mysql';

function memoryDb() {
  const users = new Map();        // email -> { id, email, pass_hash, created_at }
  const progress = new Map();     // user_id -> { history, updated_at }
  let seq = 0;
  return {
    async init() {},
    async createUser(email, passHash) {
      if (users.has(email)) { const e = new Error('duplicate'); e.code = 'ER_DUP_ENTRY'; throw e; }
      const u = { id: ++seq, email, pass_hash: passHash, created_at: new Date() };
      users.set(email, u);
      return { id: u.id, email };
    },
    async findUserByEmail(email) { return users.get(email) || null; },
    async getProgress(userId) {
      const p = progress.get(userId);
      return p ? p.history : null;
    },
    async upsertProgress(userId, history) {
      progress.set(userId, { history, updated_at: new Date() });
    },
  };
}

function mysqlDb() {
  const mysql = require('mysql2/promise');
  let pool;
  return {
    async init() {
      pool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        charset: 'utf8mb4',
      });
      await pool.query('SELECT 1');
    },
    async createUser(email, passHash) {
      const [r] = await pool.execute(
        'INSERT INTO users (email, pass_hash) VALUES (?, ?)', [email, passHash]);
      return { id: r.insertId, email };
    },
    async findUserByEmail(email) {
      const [rows] = await pool.execute(
        'SELECT id, email, pass_hash FROM users WHERE email = ? LIMIT 1', [email]);
      return rows[0] || null;
    },
    async getProgress(userId) {
      const [rows] = await pool.execute(
        'SELECT history FROM progress WHERE user_id = ? LIMIT 1', [userId]);
      if (!rows[0]) return null;
      const h = rows[0].history;
      return typeof h === 'string' ? JSON.parse(h) : h;
    },
    async upsertProgress(userId, history) {
      await pool.execute(
        'INSERT INTO progress (user_id, history) VALUES (?, CAST(? AS JSON)) ' +
        'ON DUPLICATE KEY UPDATE history = VALUES(history)',
        [userId, JSON.stringify(history)]);
    },
  };
}

module.exports = DRIVER === 'memory' ? memoryDb() : mysqlDb();
