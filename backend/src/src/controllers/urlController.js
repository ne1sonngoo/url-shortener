const validUrl = require('valid-url');
const { isValidAlias } = require('../utils/idGen');
const {
  createShortUrl,
  resolveShortUrl,
  getUrlStats,
  deleteShortUrl,
  checkHealth,
} = require('../services/urlService');

// ── POST /shorten ──────────────────────────────────────────────────────────

const shorten = async (req, res) => {
  const { url, alias, expiresIn } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing required field: url' });
  }
  if (!validUrl.isWebUri(url)) {
    return res.status(400).json({ error: 'Invalid URL format. Must be a valid http/https URL.' });
  }
  if (url.length > 2048) {
    return res.status(400).json({ error: 'URL too long (max 2048 characters)' });
  }
  if (alias && !isValidAlias(alias)) {
    return res.status(400).json({
      error: 'Invalid alias. Use 3-50 alphanumeric characters or hyphens.',
    });
  }
  if (expiresIn) {
    const hours = parseInt(expiresIn);
    if (isNaN(hours) || hours < 1 || hours > 8760) {
      return res.status(400).json({ error: 'expiresIn must be between 1 and 8760 hours' });
    }
  }

  const record = await createShortUrl({ url, alias, expiresIn: expiresIn ? parseInt(expiresIn) : null });
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

  return res.status(201).json({
    shortCode: record.short_code,
    shortUrl: `${baseUrl}/${record.short_code}`,
    originalUrl: record.original_url,
    clickCount: record.click_count,
    expiresAt: record.expires_at,
    createdAt: record.created_at,
  });
};

// ── GET /:code ─────────────────────────────────────────────────────────────

const redirect = async (req, res) => {
  const { code } = req.params;

  if (!/^[a-zA-Z0-9-]{1,50}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid short code format' });
  }

  const { originalUrl } = await resolveShortUrl(code);
  return res.redirect(302, originalUrl);
};

// ── GET /api/stats/:code ───────────────────────────────────────────────────

const stats = async (req, res) => {
  const { code } = req.params;
  const record = await getUrlStats(code);
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
};

// ── DELETE /api/url/:code ──────────────────────────────────────────────────

const remove = async (req, res) => {
  await deleteShortUrl(req.params.code);
  return res.json({ message: 'Short URL deleted successfully' });
};

// ── GET /api/health ────────────────────────────────────────────────────────

const health = async (req, res) => {
  const { dbOk, redisOk } = await checkHealth();
  const status = dbOk && redisOk ? 200 : 503;

  return res.status(status).json({
    status: status === 200 ? 'healthy' : 'degraded',
    postgres: dbOk ? 'up' : 'down',
    redis: redisOk ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  });
};

module.exports = { shorten, redirect, stats, remove, health };
