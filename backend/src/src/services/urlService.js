const { pool } = require('../config/db');
const { cacheGet, cacheSet, cacheDel } = require('../config/redis');
const { generateUniqueCode } = require('../utils/idGen');
const logger = require('../utils/logger');

const DEFAULT_CACHE_TTL = parseInt(process.env.CACHE_TTL || '3600');

// ── Create ─────────────────────────────────────────────────────────────────

const createShortUrl = async ({ url, alias, expiresIn }) => {
  let shortCode;
  let isCustom = false;

  if (alias) {
    const existing = await pool.query(
      'SELECT id FROM urls WHERE short_code = $1',
      [alias]
    );
    if (existing.rows.length > 0) {
      const err = new Error('Alias already taken. Choose a different one.');
      err.status = 409;
      throw err;
    }
    shortCode = alias;
    isCustom = true;
  } else {
    shortCode = await generateUniqueCode(async (code) => {
      const { rows } = await pool.query(
        'SELECT id FROM urls WHERE short_code = $1',
        [code]
      );
      return rows.length > 0;
    });
  }

  let expiresAt = null;
  if (expiresIn) {
    expiresAt = new Date(Date.now() + expiresIn * 3600 * 1000);
  }

  const { rows } = await pool.query(
    `INSERT INTO urls (short_code, original_url, custom_alias, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, short_code, original_url, click_count, expires_at, created_at`,
    [shortCode, url, isCustom, expiresAt]
  );
  const record = rows[0];

  const cacheTTL = expiresAt
    ? Math.floor((expiresAt - Date.now()) / 1000)
    : DEFAULT_CACHE_TTL;

  if (cacheTTL > 0) {
    await cacheSet(`url:${shortCode}`, url, cacheTTL);
  }

  logger.info('Short URL created', { shortCode, originalUrl: url, isCustom, expiresAt });
  return record;
};

// ── Resolve (redirect) ─────────────────────────────────────────────────────

const resolveShortUrl = async (code) => {
  const cacheKey = `url:${code}`;

  const cached = await cacheGet(cacheKey);
  if (cached) {
    logger.info('Cache HIT', { code });
    incrementClickCount(code);
    return { originalUrl: cached, fromCache: true };
  }

  logger.info('Cache MISS — querying DB', { code });
  const { rows } = await pool.query(
    'SELECT original_url, expires_at FROM urls WHERE short_code = $1',
    [code]
  );

  if (rows.length === 0) {
    const err = new Error('Short URL not found');
    err.status = 404;
    throw err;
  }

  const { original_url, expires_at } = rows[0];

  if (expires_at && new Date(expires_at) < new Date()) {
    const err = new Error('This short URL has expired');
    err.status = 410;
    throw err;
  }

  const remainingTTL = expires_at
    ? Math.floor((new Date(expires_at) - Date.now()) / 1000)
    : DEFAULT_CACHE_TTL;

  if (remainingTTL > 0) {
    await cacheSet(cacheKey, original_url, remainingTTL);
  }

  incrementClickCount(code);
  return { originalUrl: original_url, fromCache: false };
};

// ── Stats ──────────────────────────────────────────────────────────────────

const getUrlStats = async (code) => {
  const { rows } = await pool.query(
    `SELECT short_code, original_url, click_count, custom_alias, expires_at, created_at
     FROM urls WHERE short_code = $1`,
    [code]
  );

  if (rows.length === 0) {
    const err = new Error('Short URL not found');
    err.status = 404;
    throw err;
  }

  return rows[0];
};

// ── Delete ─────────────────────────────────────────────────────────────────

const deleteShortUrl = async (code) => {
  const { rowCount } = await pool.query(
    'DELETE FROM urls WHERE short_code = $1',
    [code]
  );

  if (rowCount === 0) {
    const err = new Error('Short URL not found');
    err.status = 404;
    throw err;
  }

  await cacheDel(`url:${code}`);
  logger.info('Short URL deleted', { code });
};

// ── Health ─────────────────────────────────────────────────────────────────

const checkHealth = async () => {
  let dbOk = false;
  let redisOk = false;

  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch (_) {}

  try {
    const { getRedisClient } = require('../config/redis');
    const r = await getRedisClient();
    await r.ping();
    redisOk = true;
  } catch (_) {}

  return { dbOk, redisOk };
};

// ── Helpers ────────────────────────────────────────────────────────────────

const incrementClickCount = (code) => {
  pool
    .query('UPDATE urls SET click_count = click_count + 1 WHERE short_code = $1', [code])
    .catch((err) => logger.warn('Click count update failed', { error: err.message }));
};

module.exports = { createShortUrl, resolveShortUrl, getUrlStats, deleteShortUrl, checkHealth };
