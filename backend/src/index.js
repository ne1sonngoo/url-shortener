require("dotenv").config();
require("express-async-errors");

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const { connectWithRetry } = require("./config/db");
const { getRedisClient } = require("./config/redis");
const urlRoutes = require("./routes/urls");
const logger = require("./utils/logger");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security & Middleware ──────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false, // managed by Nginx
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false }));

// HTTP request logging (Apache Combined Format in prod, dev format locally)
app.use(
  morgan(process.env.NODE_ENV === "production" ? "combined" : "dev", {
    stream: { write: (msg) => logger.http(msg.trim()) },
  }),
);

// Trust Nginx proxy (for real IP extraction in rate limiter)
app.set("trust proxy", 1);

// ── Serve frontend ────────────────────────────────────
const path = require("path");
app.use(express.static(path.join(__dirname, "../frontend")));

// ── Routes ────────────────────────────────────────────
app.use("/", urlRoutes);

// ── 404 fallback ──────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ── Global error handler ──────────────────────────────
app.use((err, req, res, _next) => {
  logger.error("Unhandled error", {
    error: err.message,
    stack: process.env.NODE_ENV !== "production" ? err.stack : undefined,
    url: req.url,
    method: req.method,
  });
  res.status(err.status || 500).json({
    error:
      process.env.NODE_ENV === "production"
        ? "Internal Server Error"
        : err.message,
  });
});

// ── Bootstrap ─────────────────────────────────────────
const start = async () => {
  logger.info("🚀 Starting URL Shortener...");

  await connectWithRetry();
  await getRedisClient(); // warm up Redis connection

  // Run migrations automatically on startup
  const { pool } = require("./config/db");
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
  logger.info("✅ Database schema ready");

  app.listen(PORT, () => {
    logger.info(`✅ Server listening on port ${PORT}`);
  });
};

start().catch((err) => {
  logger.error("Fatal startup error", { error: err.message });
  process.exit(1);
});
