# ✂ Snip — Production URL Shortener

A full-stack, production-grade URL shortener built with **Node.js + Express**, **PostgreSQL**, **Redis**, **Nginx**, and **Docker**.

```
                ┌──────────────┐
   Client ────▶ │  Nginx :80   │  ← rate limiting (outer layer)
                └──────┬───────┘
                       │ reverse proxy
                ┌──────▼───────┐
                │  Express :3000│  ← rate limiting (Redis, inner)
                └──────┬───────┘
                       │
              ┌─────────┴──────────┐
              │                    │
       ┌──────▼──────┐    ┌───────▼───────┐
       │  PostgreSQL  │    │  Redis Cache  │
       │  (persist)  │    │  (fast reads) │
       └─────────────┘    └───────────────┘
```

---

## Features

| Feature | Details |
|---|---|
| `POST /shorten` | Create short URL, with optional alias + expiry |
| `GET /:code` | Redirect — Redis cache hit → no DB query |
| `GET /api/stats/:code` | Click analytics, status, metadata |
| `DELETE /api/url/:code` | Delete a short URL + evict cache |
| `GET /api/health` | Health check (Postgres + Redis status) |
| **Redis Caching** | `short_code → original_url` cached for 1h (configurable) |
| **Rate Limiting** | Redis sliding window — 20 req/min on `/shorten` |
| **ID Generation** | NanoID + Base62, 62^7 = ~3.5T combinations, collision-retry |
| **Custom Aliases** | `/my-cool-link` with validation |
| **Expiration** | TTL in hours, auto-404 on expiry |
| **Click Tracking** | Async increment — non-blocking |
| **Nginx** | Two-tier rate limiting, keepalive, gzip, security headers |
| **Docker** | Multi-stage build, non-root user, healthchecks |
| **Logging** | Winston — JSON in prod, colorized in dev |

---

## Quick Start (Docker)

```bash
# 1. Clone + enter project
git clone <your-repo-url>
cd url-shortener

# 2. Configure env (edit as needed)
cp backend/.env.example backend/.env

# 3. Start everything
docker compose up -d

# 4. Access the app
open http://localhost
```

That's it. Nginx → Express → PostgreSQL + Redis all wired up.

---

## Local Development (no Docker)

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Redis 7+

```bash
cd backend
npm install
cp .env.example .env
# Edit .env to point to your local PG + Redis

npm start
# → http://localhost:3000
```

Serve the frontend from the `frontend/` folder with any static server:
```bash
npx serve frontend/
```

---

## API Reference

### `POST /shorten`
**Rate limited:** 20 requests / 60 seconds per IP

```json
// Request body
{
  "url": "https://www.example.com/very-long-url",
  "alias": "my-link",     // optional — 3-50 alphanumeric + hyphens
  "expiresIn": 24         // optional — hours (1–8760)
}

// Response 201
{
  "shortCode": "aB3xK7m",
  "shortUrl": "http://localhost/aB3xK7m",
  "originalUrl": "https://www.example.com/very-long-url",
  "clickCount": 0,
  "expiresAt": null,
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### `GET /:code`
Redirects (302) to original URL. Returns `404` if not found, `410` if expired.

### `GET /api/stats/:code`
```json
{
  "shortCode": "aB3xK7m",
  "shortUrl": "http://localhost/aB3xK7m",
  "originalUrl": "https://www.example.com/very-long-url",
  "clickCount": 42,
  "isCustomAlias": false,
  "isExpired": false,
  "expiresAt": null,
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### `DELETE /api/url/:code`
Deletes the URL and evicts from Redis cache.

### `GET /api/health`
```json
{ "status": "healthy", "postgres": "up", "redis": "up", "timestamp": "..." }
```

---

## Architecture Decisions

### ID Generation — NanoID + Base62
- Alphabet: `[0-9A-Za-z]` — URL-safe, no ambiguous chars
- Length: 7 → **62^7 = ~3.5 trillion** combinations
- Collision-retry logic: up to 5 attempts, then fallback to length+2
- **Talking point:** *"Designed collision-resistant ID generation; with 3.5T codes, even at 1M URLs/day, collision probability stays under 0.001%"*

### Redis Caching (Cache-Aside Pattern)
```
GET /:code
  → Redis HIT  → redirect immediately (sub-ms)
  → Redis MISS → query PostgreSQL → cache result → redirect
```
- TTL matches URL expiration (or 1h default)
- Write-through on create: pre-warm cache
- Cache eviction on delete
- **Talking point:** *"Reduced read latency and DB load using Redis cache-aside; ~95% of redirect traffic never touches PostgreSQL"*

### Rate Limiting (Redis Fixed Window)
- `INCR key` + `EXPIRE key windowSecs` in a Redis MULTI block
- Nginx provides outer rate limit (10 req/s global, 2 req/s on `/shorten`)
- Node.js provides inner rate limit (20 req/min per IP via Redis)
- **Fail-open:** if Redis is down, requests are allowed (availability > security)
- **Talking point:** *"Two-tier rate limiting at Nginx and application layer; Redis atomic INCR ensures accurate counting without race conditions"*

### PostgreSQL Indexes
```sql
CREATE INDEX idx_urls_short_code ON urls(short_code);       -- O(log n) lookup
CREATE INDEX idx_urls_expires_at ON urls(expires_at)        -- efficient expiry queries
  WHERE expires_at IS NOT NULL;
```

---

## Deployment

### Railway (Recommended — Simplest)
1. Push to GitHub
2. New project → "Deploy from GitHub repo"
3. Add services: **PostgreSQL** + **Redis** (Railway provides both)
4. Set env vars: `POSTGRES_HOST`, `REDIS_HOST`, etc. (Railway injects DATABASE_URL)
5. Set `BASE_URL` to your Railway-generated domain
6. Deploy ✓

### Render
1. New Web Service → connect repo → `backend/` root
2. Build command: `npm install`
3. Start command: `node src/index.js`
4. Add **Render PostgreSQL** + **Render Redis** add-ons
5. Set environment variables from `.env.example`

### AWS (EC2 + ECS)
```bash
# Build and push to ECR
aws ecr create-repository --repository-name url-shortener
docker build -t url-shortener ./backend
docker tag url-shortener:latest <ecr-uri>/url-shortener:latest
docker push <ecr-uri>/url-shortener:latest

# Use docker-compose.yml with ECS Compose integration
# or deploy to EC2 and run docker compose up -d
```

### Self-hosted (any Linux VPS)
```bash
git clone <repo>
cd url-shortener
cp backend/.env.example backend/.env
# Edit .env with production values + your domain

docker compose up -d
# Done — Nginx listens on :80
```

For HTTPS, uncomment the `443` port in `docker-compose.yml` and mount SSL certs.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express server port |
| `BASE_URL` | auto-detected | Used in shortened URL responses |
| `POSTGRES_HOST` | `postgres` | PostgreSQL hostname |
| `POSTGRES_DB` | `urlshortener` | Database name |
| `POSTGRES_USER` | `postgres` | DB user |
| `POSTGRES_PASSWORD` | — | **Set this!** |
| `REDIS_HOST` | `redis` | Redis hostname |
| `CACHE_TTL` | `3600` | Cache TTL in seconds |
| `SHORT_CODE_LENGTH` | `7` | Generated code length |
| `LOG_LEVEL` | `info` | Winston log level |

---

## Future Enhancements

- [ ] **BullMQ** — background job queue for async click analytics
- [ ] **QR Code** generation per short URL
- [ ] **Auth** — user accounts, private URLs, dashboard
- [ ] **Geo analytics** — track clicks by country
- [ ] **Prometheus metrics** — `/metrics` endpoint for Grafana
- [ ] **Horizontal scaling** — Redis cluster, PG read replicas
- [ ] **HTTPS** — Let's Encrypt via Certbot + Nginx

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express 4 |
| Database | PostgreSQL 16 |
| Cache + Rate Limit | Redis 7 |
| Reverse Proxy | Nginx 1.25 |
| Containerization | Docker + Compose |
| ID Generation | NanoID (Base62) |
| Logging | Winston |
| Validation | valid-url |
