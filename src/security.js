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

/**
 * 常见弱口令清单：只收「一眼就能被字典命中」的那些。
 * 不追求完整（那该用 zxcvbn 之类），只求拦住 admin123 这种最典型的部署事故。
 */
const WEAK_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  '88888888',
  '66666666',
  '11111111',
  'password',
  'password1',
  'passw0rd',
  'p@ssw0rd',
  'qwertyui',
  'qwerty123',
  'abc12345',
  'abcd1234',
  'a1234567',
  'admin',
  'admin123',
  'admin888',
  'adminadmin',
  'administrator',
  'root1234',
  'letmein1',
  'welcome1',
  'iloveyou',
  'changeme',
  'store123',
  'daybook123',
]);

/**
 * 判断密码强度是否不可接受，返回原因（字符串），acceptable 时返回 null。
 *
 * 只在「用户自己设密码」与「环境变量配的管理员密码」两处使用：
 * 后者不阻止启动（托管密码由运维负责，强行拒绝会让服务起不来），
 * 但会在日志里大声提醒，避免 admin123 这种默认值悄悄留在线上。
 */
function passwordWeakness(password) {
  const value = String(password || '');
  if (!value) return '密码不能为空';
  if (value.length < 8) return '密码至少 8 位';
  const lower = value.toLowerCase();
  if (WEAK_PASSWORDS.has(lower)) return '这是常见弱口令，容易被字典猜中';
  if (/^\d+$/.test(value)) return '不能是纯数字';
  if (/^(.)\1+$/.test(value)) return '不能是同一个字符重复';
  if (isSequential(lower)) return '不能是连续字符';
  return null;
}

/** 整串是否「逐位递增或递减」（abcdefgh、87654321 这类） */
function isSequential(value) {
  if (value.length < 4) return false;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < value.length; i += 1) {
    const delta = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (delta !== 1) ascending = false;
    if (delta !== -1) descending = false;
    if (!ascending && !descending) return false;
  }
  return ascending || descending;
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

module.exports = { hashPassword, verifyPassword, randomToken, sha256, passwordWeakness, LoginLimiter };
