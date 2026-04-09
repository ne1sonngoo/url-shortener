require('dotenv').config();
const { pool, connectWithRetry } = require('./db');
const logger = require('../utils/logger');

const migrate = async () => {
  await connectWithRetry();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      id            BIGSERIAL PRIMARY KEY,
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

  logger.info('✅ Database migration complete');
  await pool.end();
};

migrate().catch((err) => {
  logger.error('Migration failed', { error: err.message });
  process.exit(1);
});
