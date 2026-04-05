// Using nanoid v3 (CommonJS compatible)
const { customAlphabet } = require('nanoid');

// Base62: [0-9A-Za-z] — URL-safe, collision-resistant
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SHORT_CODE_LENGTH = parseInt(process.env.SHORT_CODE_LENGTH || '7');

// 62^7 = ~3.5 trillion unique codes
const generateShortCode = customAlphabet(BASE62_ALPHABET, SHORT_CODE_LENGTH);

/**
 * Generate a short code with collision-retry logic.
 * @param {Function} existsFn - async fn(code) => boolean
 * @param {number} maxAttempts
 */
const generateUniqueCode = async (existsFn, maxAttempts = 5) => {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateShortCode();
    const exists = await existsFn(code);
    if (!exists) return code;
  }
  // Fallback: increase length by 2 on exhaustion (astronomically rare)
  const fallback = customAlphabet(BASE62_ALPHABET, SHORT_CODE_LENGTH + 2);
  return fallback();
};

/**
 * Validate a custom alias — alphanumeric + hyphens, 3–50 chars
 */
const isValidAlias = (alias) => /^[a-zA-Z0-9-]{3,50}$/.test(alias);

module.exports = { generateUniqueCode, isValidAlias, generateShortCode };
