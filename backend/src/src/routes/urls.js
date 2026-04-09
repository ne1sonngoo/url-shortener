const express = require('express');
const { rateLimiter } = require('../middleware/rateLimiter');
const { shorten, redirect, stats, remove, health } = require('../controllers/urlController');

const router = express.Router();

const shortenLimiter = rateLimiter({ maxRequests: 20, windowSecs: 60, keyPrefix: 'rl:shorten' });
const deleteLimiter  = rateLimiter({ maxRequests: 10, windowSecs: 60, keyPrefix: 'rl:delete' });

router.get ('/api/health',    health);
router.get ('/api/stats/:code', stats);
router.post('/shorten',       shortenLimiter, shorten);
router.delete('/api/url/:code', deleteLimiter, remove);
router.get ('/:code',         redirect);

module.exports = router;
