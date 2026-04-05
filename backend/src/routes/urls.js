const express = require('express');
const validUrl = require('valid-url');
const { pool } = require('../config/db');
const { cacheGet, cacheSet, cacheDel } = require('../config/redis');
const { generateUniqueCode, isValidAlias } = require('../utils/idGen');
const { rateLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

// ─────────────────────────────────────────────────────
// POST /shorten  →  Create a short URL
// Rate limited: 20 requests / minute per IP
// ─────────────────────────────────────────────────────
router.post(
  '/shorten',
  rateLimiter({ maxRequests: 20, windowSecs: 60, keyPrefix: 'rl:shorten' }),
  async (req, res) => {
    const { url, alias, expiresIn } = req.body;

    // 1. Validate URL
    if (!url) {
      return res.status(400).json({ error: 'Missing required field: url' });
    }
    if (!validUrl.isWebUri(url)) {
      return res.status(400).json({ error: 'Invalid URL format. Must be a valid http/https URL.' });
    }
    if (url.length > 2048) {
      return res.status(400).json({ error: 'URL too long (max 2048 characters)' });
    }

    // 2. Validate custom alias (optional)
    let shortCode;
    let isCustom = false;

    if (alias) {
      if (!isValidAlias(alias)) {
        return res.status(400).json({
          error: 'Invalid alias. Use 3–50 alphanumeric characters or hyphens.',
        });
      }
      // Check alias availability
      const existing = await pool.query(
        'SELECT id FROM urls WHERE short_code = $1',
        [alias]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Alias already taken. Choose a different one.' });
      }
      shortCode = alias;
      isCustom = true;
    } else {
      // Auto-generate collision-resistant code
      shortCode = await generateUniqueCode(async (code) => {
        const { rows } = await pool.query(
          'SELECT id FROM urls WHERE short_code = $1',
          [code]
        );
        return rows.length > 0;
      });
    }

    // 3. Compute expiration
    let expiresAt = null;
    if (expiresIn) {
      const hours = parseInt(expiresIn);
      if (isNaN(hours) || hours < 1 || hours > 8760) {
        return res.status(400).json({ error: 'expiresIn must be between 1 and 8760 hours' });
      }
      expiresAt = new Date(Date.now() + hours * 3600 * 1000);
    }

    // 4. Persist to PostgreSQL
    const { rows } = await pool.query(
      `INSERT INTO urls (short_code, original_url, custom_alias, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, short_code, original_url, click_count, expires_at, created_at`,
      [shortCode, url, isCustom, expiresAt]
    );
    const record = rows[0];

    // 5. Pre-warm Redis cache
    const cacheTTL = expiresAt
      ? Math.floor((expiresAt - Date.now()) / 1000)
      : parseInt(process.env.CACHE_TTL || '3600');

    if (cacheTTL > 0) {
      await cacheSet(`url:${shortCode}`, url, cacheTTL);
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    logger.info('Short URL created', {
      shortCode,
      originalUrl: url,
      isCustom,
      expiresAt,
    });

    return res.status(201).json({
      shortCode: record.short_code,
      shortUrl: `${baseUrl}/${record.short_code}`,
      originalUrl: record.original_url,
      clickCount: record.click_count,
      expiresAt: record.expires_at,
      createdAt: record.created_at,
    });
  }
);

// ─────────────────────────────────────────────────────
// GET /:code  →  Redirect to original URL
// Redis cache hit → no DB query (low latency)
// ─────────────────────────────────────────────────────
router.get('/:code', async (req, res) => {
  const { code } = req.params;

  // Sanitize code
  if (!/^[a-zA-Z0-9-]{1,50}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid short code format' });
  }

  const cacheKey = `url:${code}`;

  // 1. Cache lookup (fast path)
  const cached = await cacheGet(cacheKey);
  if (cached) {
    logger.info('Cache HIT — redirecting', { code });
    // Async click count update (fire-and-forget, non-blocking)
    pool
      .query('UPDATE urls SET click_count = click_count + 1 WHERE short_code = $1', [code])
      .catch((err) => logger.warn('Click count update failed', { error: err.message }));

    return res.redirect(302, cached);
  }

  // 2. DB lookup (cache miss)
  logger.info('Cache MISS — querying DB', { code });
  const { rows } = await pool.query(
    `SELECT original_url, expires_at, click_count
     FROM urls WHERE short_code = $1`,
    [code]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Short URL not found' });
  }

  const { original_url, expires_at } = rows[0];

  // 3. Expiration check
  if (expires_at && new Date(expires_at) < new Date()) {
    return res.status(410).json({ error: 'This short URL has expired' });
  }

  // 4. Re-populate cache + async click count
  const remainingTTL = expires_at
    ? Math.floor((new Date(expires_at) - Date.now()) / 1000)
    : parseInt(process.env.CACHE_TTL || '3600');

  if (remainingTTL > 0) {
    await cacheSet(cacheKey, original_url, remainingTTL);
  }

  pool
    .query('UPDATE urls SET click_count = click_count + 1 WHERE short_code = $1', [code])
    .catch((err) => logger.warn('Click count update failed', { error: err.message }));

  return res.redirect(302, original_url);
});

// ─────────────────────────────────────────────────────
// GET /api/stats/:code  →  Analytics for a short URL
// ─────────────────────────────────────────────────────
router.get('/api/stats/:code', async (req, res) => {
  const { code } = req.params;

  const { rows } = await pool.query(
    `SELECT short_code, original_url, click_count, custom_alias, expires_at, created_at
     FROM urls WHERE short_code = $1`,
    [code]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Short URL not found' });
  }

  const record = rows[0];
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const isExpired = record.expires_at && new Date(record.expires_at) < new Date();

  return res.json({
    shortCode: record.short_code,
    shortUrl: `${baseUrl}/${record.short_code}`,
    originalUrl: record.original_url,
    clickCount: parseInt(record.click_count),
    isCustomAlias: record.custom_alias,
    isExpired,
    expiresAt: record.expires_at,
    createdAt: record.created_at,
  });
});

// ─────────────────────────────────────────────────────
// DELETE /api/url/:code  →  Delete a short URL
// ─────────────────────────────────────────────────────
router.delete(
  '/api/url/:code',
  rateLimiter({ maxRequests: 10, windowSecs: 60, keyPrefix: 'rl:delete' }),
  async (req, res) => {
    const { code } = req.params;

    const { rowCount } = await pool.query(
      'DELETE FROM urls WHERE short_code = $1',
      [code]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Short URL not found' });
    }

    // Evict from cache
    await cacheDel(`url:${code}`);

    logger.info('Short URL deleted', { code });
    return res.json({ message: 'Short URL deleted successfully' });
  }
);

// ─────────────────────────────────────────────────────
// GET /api/health  →  Health check
// ─────────────────────────────────────────────────────
router.get('/api/health', async (req, res) => {
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

  const status = dbOk && redisOk ? 200 : 503;
  return res.status(status).json({
    status: status === 200 ? 'healthy' : 'degraded',
    postgres: dbOk ? 'up' : 'down',
    redis: redisOk ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
