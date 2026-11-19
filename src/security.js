'use strict';

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/** scrypt 存储格式：scrypt$N$r$p$salt$hash（均为 base64url） */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** 登录态内存限流：同一 IP+账号连续失败过多则短暂锁定 */
class LoginLimiter {
  constructor({ maxAttempts = 6, windowMs = 10 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  key(ip, username) {
    return `${ip || '-'}|${String(username || '').toLowerCase()}`;
  }

  isBlocked(ip, username) {
    const bucket = this.buckets.get(this.key(ip, username));
    if (!bucket) return false;
    if (Date.now() - bucket.firstAt > this.windowMs) {
      this.buckets.delete(this.key(ip, username));
      return false;
    }
    return bucket.count >= this.maxAttempts;
  }

  fail(ip, username) {
    const key = this.key(ip, username);
    const bucket = this.buckets.get(key);
    if (!bucket || Date.now() - bucket.firstAt > this.windowMs) {
      this.buckets.set(key, { count: 1, firstAt: Date.now() });
      return;
    }
    bucket.count += 1;
  }

  reset(ip, username) {
    this.buckets.delete(this.key(ip, username));
  }
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256, LoginLimiter };
