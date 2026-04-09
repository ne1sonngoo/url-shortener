require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const path    = require('path');

const { connectWithRetry, pool } = require('./config/db');
const { getRedisClient }         = require('./config/redis');
const routes                     = require('./routes/urls');
const logger                     = require('./utils/logger');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));
app.set('trust proxy', 1);

// ── Static frontend ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/', routes);

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    url: req.url,
    method: req.method,
  });
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message,
  });
});

// ── Bootstrap ──────────────────────────────────────────────────────────────
const start = async () => {
  logger.info('Starting URL Shortener...');

  await connectWithRetry();
  await getRedisClient();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      id            BIGSERIAL    PRIMARY KEY,
      short_code    VARCHAR(20)  NOT NULL UNIQUE,
      original_url  TEXT         NOT NULL,
      custom_alias  BOOLEAN      DEFAULT FALSE,
      click_count   BIGINT       DEFAULT 0,
      expires_at    TIMESTAMPTZ  DEFAULT NULL,
      created_at    TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_urls_short_code ON urls(short_code);
    CREATE INDEX IF NOT EXISTS idx_urls_expires_at ON urls(expires_at) WHERE expires_at IS NOT NULL;
  `);
  logger.info('Database schema ready');

  app.listen(PORT, () => logger.info(`Server listening on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Fatal startup error', { error: err.message });
  process.exit(1);
});
