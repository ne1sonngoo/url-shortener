# Snip — URL Shortener

A URL shortener built with Node.js, PostgreSQL, Redis, Nginx, and Docker. Shortens links, tracks clicks, supports custom aliases and expiration dates. Redis handles caching and rate limiting so the database isn't hammered on every redirect.

---

## Stack

- **Node.js + Express** — API server
- **PostgreSQL** — stores all URLs persistently
- **Redis** — caches redirects, enforces rate limits
- **Nginx** — reverse proxy, sits in front of Express
- **Docker** — runs everything together

---

## Getting Started

The only thing you need installed is Docker Desktop.

```bash
git clone <your-repo>
cd url-shortener

cp backend/.env.example backend/.env
```

Open `backend/.env` and make sure these are set:

```env
POSTGRES_HOST=postgres
REDIS_HOST=redis
BASE_URL=http://localhost
```

Then start everything:

```bash
docker compose up -d --build
```

Open `http://localhost` in your browser. That's it — Postgres, Redis, Nginx, and the backend all start automatically. The database tables get created on first boot.

---

## API

### `POST /shorten`

Creates a short URL.

```json
// request
{
  "url": "https://your-long-url.com/goes/here",
  "alias": "my-link",     // optional
  "expiresIn": 24         // optional, hours
}

// response
{
  "shortCode": "aB3xK7m",
  "shortUrl": "http://localhost/aB3xK7m",
  "originalUrl": "https://your-long-url.com/goes/here",
  "clickCount": 0,
  "expiresAt": null,
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### `GET /:code`

Redirects to the original URL. Hits Redis first — if the code is cached, Postgres never gets touched. Click count increments in the background so the redirect isn't slowed down.

### `GET /api/stats/:code`

Returns click count, status, and metadata for a short URL.

### `DELETE /api/url/:code`

Deletes the short URL and removes it from the Redis cache.

### `GET /api/health`

Health check — returns status of Postgres and Redis.

```json
{ "status": "healthy", "postgres": "up", "redis": "up" }
```

---

## How it works

**Redirects** — when someone visits a short URL, Express checks Redis first. If it's there, it redirects immediately without touching Postgres. If not, it queries Postgres, caches the result, then redirects. At steady state, almost every redirect is served from Redis.

```
GET /aB3xK7m
    │
    ├── Redis HIT  → redirect (sub-ms, no DB query)
    │
    └── Redis MISS → query Postgres → cache it → redirect
```

**Rate limiting** — two layers. Nginx limits requests per second at the network level. Express has a Redis-backed limiter on top of that — 20 requests per minute per IP on `/shorten`. Uses Redis `INCR` + `EXPIRE` in a single atomic block so there are no race conditions. If Redis goes down, the limiter fails open (requests go through rather than everything breaking).

**ID generation** — uses NanoID with a base62 alphabet `[0-9A-Za-z]`. 7 characters gives 62^7 ≈ 3.5 trillion possible codes. On the rare chance of a collision it retries up to 5 times, then falls back to a 9-character code.

**Expiration** — if a URL has an expiry, the Redis TTL is set to match it exactly so stale entries self-evict. Expired URLs return a 410 Gone.

---

## Environment Variables

| Variable            | Default        | Notes                                      |
| ------------------- | -------------- | ------------------------------------------ |
| `BASE_URL`          | auto           | Set to your domain in production           |
| `POSTGRES_HOST`     | `postgres`     | Use `localhost` if running outside Docker  |
| `POSTGRES_DB`       | `urlshortener` |                                            |
| `POSTGRES_USER`     | `postgres`     |                                            |
| `POSTGRES_PASSWORD` | —              | Change this                                |
| `REDIS_HOST`        | `redis`        | Use `localhost` if running outside Docker  |
| `CACHE_TTL`         | `3600`         | Seconds, default 1 hour                    |
| `SHORT_CODE_LENGTH` | `7`            | Longer = more codes, less collision chance |
| `LOG_LEVEL`         | `info`         |                                            |

---

## Common Issues

**`POSTGRES_HOST` / `REDIS_HOST`** — if you're running the backend with `npm start` locally (outside Docker), set these to `localhost`. If running inside Docker (via `docker compose up`), keep them as `postgres` and `redis` — those are the Docker service names and resolve automatically inside the container network.

**`BASE_URL`** — affects what URL gets returned when you shorten something. If it's wrong you'll get `localhost:3000/...` instead of `localhost/...` and the link won't work. Always set this to whatever domain you're actually serving from.

**Docker Desktop not running** — the `pipe/dockerDesktopLinuxEngine` error just means Docker Desktop isn't open. Start it and wait for the whale icon in the system tray before running any `docker` commands.

---

## Deployment

**Railway** — easiest option. Push to GitHub, create a new project, add Postgres and Redis from the Railway dashboard, set your env vars, and deploy. Railway injects `DATABASE_URL` automatically.

**Render** — similar to Railway. Create a web service pointing to the repo, add Postgres and Redis add-ons, set env vars.

**Any VPS** — clone the repo, install Docker, run `docker compose up -d --build`. Point your domain at the server and update `BASE_URL`. For HTTPS, uncomment the 443 port in `docker-compose.yml` and add SSL certs.

---

## Project Structure

```
url-shortener/
├── docker-compose.yml
├── nginx/
│   └── nginx.conf
├── frontend/
│   └── index.html
└── backend/
    ├── Dockerfile
    ├── .env.example
    └── src/
        ├── index.js
        ├── config/
        │   ├── db.js          postgres pool + retry logic
        │   ├── redis.js       cache helpers + rate limit counters
        │   └── migrate.js     standalone migration script
        ├── middleware/
        │   └── rateLimiter.js redis-backed rate limiting
        ├── routes/
        │   └── urls.js        all endpoints
        └── utils/
            ├── idGen.js       nanoid + collision retry
            └── logger.js      winston
```
