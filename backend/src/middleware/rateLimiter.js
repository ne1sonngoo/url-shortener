const { rateLimitIncr } = require('../config/redis');
const logger = require('../utils/logger');

/**
 * Redis-backed rate limiter middleware (fixed window counter).
 *
 * @param {object} options
 * @param {number} options.maxRequests   - Max requests per window
 * @param {number} options.windowSecs    - Window size in seconds
 * @param {string} options.keyPrefix     - Redis key prefix (e.g. 'rl:shorten')
 */
const rateLimiter = ({ maxRequests = 10, windowSecs = 60, keyPrefix = 'rl' } = {}) => {
  return async (req, res, next) => {
    // Use X-Forwarded-For (Nginx) or fallback to socket IP
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown';

    const key = `${keyPrefix}:${ip}`;

    try {
      const count = await rateLimitIncr(key, windowSecs);

      // Attach rate limit headers (industry standard)
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - count));
      res.setHeader('X-RateLimit-Window', `${windowSecs}s`);

      if (count > maxRequests) {
        logger.warn('Rate limit exceeded', { ip, key, count, maxRequests });
        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit: ${maxRequests} requests per ${windowSecs}s`,
          retryAfter: windowSecs,
        });
      }

      next();
    } catch (err) {
      // Fail open — never block users because Redis is down
      logger.error('Rate limiter error, failing open', { error: err.message });
      next();
    }
  };
};

module.exports = { rateLimiter };
