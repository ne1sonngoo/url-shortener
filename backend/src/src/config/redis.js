const { createClient } = require('redis');
const logger = require('../utils/logger');

let client = null;

const getRedisClient = async () => {
  if (client && client.isReady) return client;

  client = createClient({
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          logger.error('Redis max reconnection attempts reached');
          return new Error('Too many reconnection attempts');
        }
        return Math.min(retries * 100, 3000); // exponential backoff capped at 3s
      },
    },
    password: process.env.REDIS_PASSWORD || undefined,
  });

  client.on('error', (err) => {
    logger.error('Redis client error', { error: err.message });
  });

  client.on('connect', () => logger.info('✅ Redis connected successfully'));
  client.on('reconnecting', () => logger.warn('Redis reconnecting...'));

  await client.connect();
  return client;
};

// Cache helpers
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '3600'); // 1 hour default

const cacheGet = async (key) => {
  try {
    const redis = await getRedisClient();
    return await redis.get(key);
  } catch (err) {
    logger.warn('Redis GET failed, falling back to DB', { key, error: err.message });
    return null;
  }
};

const cacheSet = async (key, value, ttl = CACHE_TTL) => {
  try {
    const redis = await getRedisClient();
    await redis.setEx(key, ttl, value);
  } catch (err) {
    logger.warn('Redis SET failed', { key, error: err.message });
  }
};

const cacheDel = async (key) => {
  try {
    const redis = await getRedisClient();
    await redis.del(key);
  } catch (err) {
    logger.warn('Redis DEL failed', { key, error: err.message });
  }
};

// Rate limiter helpers using sliding window counter
const rateLimitIncr = async (key, windowSecs) => {
  try {
    const redis = await getRedisClient();
    const multi = redis.multi();
    multi.incr(key);
    multi.expire(key, windowSecs);
    const results = await multi.exec();
    return results[0]; // current count
  } catch (err) {
    logger.warn('Redis rate limit incr failed', { key, error: err.message });
    return 0; // fail open — allow request if Redis is down
  }
};

module.exports = { getRedisClient, cacheGet, cacheSet, cacheDel, rateLimitIncr };
