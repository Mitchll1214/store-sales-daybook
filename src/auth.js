'use strict';

const { clientIp, computeFingerprint, uaSkeleton, deviceLabel, networkType } = require('./net');
const { randomToken, verifyPassword } = require('./security');
const { nowStamp, stampOf, HttpError, dateStrOf, localNow, storeAlias } = require('./util');
const { passwordManagedExternally } = require('./db');

const COOKIE_NAME = 'ssd_sid';
const SESSION_DAYS = Number.parseInt(process.env.SESSION_DAYS ?? '14', 10) || 14;
const TOUCH_INTERVAL_MS = 60 * 1000;
const ROLE_LABEL = { admin: '总部管理员', region_admin: '区域管理员', clerk: '店员' };

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

function addDaysStamp(days) {
  const d = localNow();
  d.setUTCDate(d.getUTCDate() + days);
  return stampOf(d);
}

/**
 * 设备档案：本设备上的每次操作都记录同一个设备指纹。
 * fingerprint 是轻量浏览器指纹（少量公开环境字段 → FNV-1a 双通道 16 位短码），
 * device_id 优先用前端 localStorage 里持久化的 id，没有时才用指纹兜底——
 * 二者都落库，便于按设备追溯。
 */
function captureDevice(req) {
  const header = req.headers['x-device-id'];
  const raw = typeof header === 'string' ? header.trim().slice(0, 128) : '';
  const ua = String(req.headers['user-agent'] || '');
  let client = null;
  const metaHeader = req.headers['x-device-meta'];
  if (typeof metaHeader === 'string' && metaHeader.length <= 2048) {
    try {
      client = JSON.parse(Buffer.from(metaHeader, 'base64').toString('utf8'));
      if (client && typeof client !== 'object') client = null;
    } catch {
      client = null;
    }
  }
  // 已经是 16 位十六进制短码，不再做二次哈希：日志里展示什么、库里存什么保持一致
  const fingerprint = computeFingerprint({ userAgent: ua, client });
  const deviceId = raw || `fp_${fingerprint}`;
  req.deviceId = deviceId;
  req.deviceFingerprint = fingerprint;
  req.deviceMeta = client;
  req.networkType = networkType(ua);
  return { deviceId, fingerprint, ua };
}

class Auth {
  constructor(db) {
    this.db = db;
    this.touchCache = new Map();
  }

  /** 注册/刷新设备档案，返回设备指纹 */
  touchDevice(req) {
    const device = captureDevice(req);
    const stamp = nowStamp();
    const uaSample = String(req.headers['user-agent'] || '').slice(0, 300);
    this.db
      .prepare(
        `INSERT INTO device_profiles (device_id, fingerprint, ua_hash, ua_sample, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           ua_hash = excluded.ua_hash,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(device.deviceId, device.fingerprint, uaSkeleton(uaSample).slice(0, 200), uaSample, stamp, stamp);
    return device;
  }

  /** 区域管理员一次性管辖的门店（user_stores 直连，无区域这一层） */
  loadStoreIds(userId) {
    return this.db
      .prepare(
        `SELECT s.id FROM user_stores us
         JOIN stores s ON s.id = us.store_id
         WHERE us.user_id = ? AND s.status = 'active'
         ORDER BY s.id`,
      )
      .all(userId)
      .map((r) => r.id);
  }

  /** 构造请求上下文中的用户对象 */
  buildPrincipal(user, session) {
    let store = null;
    if (session.store_id) {
      store = this.db
        .prepare('SELECT id, code, name, alias, status FROM stores WHERE id = ?')
        .get(session.store_id);
    } else if (user && user.store_id) {
      store = this.db
        .prepare('SELECT id, code, name, alias, status FROM stores WHERE id = ?')
        .get(user.store_id);
    }
    const storeIds = user && user.role === 'region_admin' ? this.loadStoreIds(user.id) : [];
    // 免登录会话没有账号，操作人姓名只能取自门店；日志里仍要能定位到哪家店，
    // 所以这里保留真实名称，只在返给店员端时换成别名（见 publicUser）。
    const autoLogin = Boolean(session.login_via === 'auto');
    return {
      id: user ? user.id : null,
      username: user ? user.username : null,
      name: user ? user.display_name : store ? `${store.name}（免登录）` : '门店访客',
      role: session.role,
      roleLabel: ROLE_LABEL[session.role] || session.role,
      storeId: store ? store.id : null,
      storeCode: store ? store.code : null,
      storeName: store ? store.name : null,
      /** 门店别名：店员端唯一可见的门店标识，后台与日志继续用真实编码 / 名称 */
      storeAlias: store ? storeAlias(store) : null,
      storeIds,
      autoLogin,
      mustChangePassword: Boolean(user && user.must_change_password),
      /** 账号是否由环境变量托管（内置超级管理员且配置了 INIT_ADMIN_PASSWORD） */
      isBuiltin: Boolean(user && user.is_builtin),
      /** 密码是否由环境变量托管：为 true 时系统内不允许修改/重置密码 */
      passwordManaged: passwordManagedExternally(user),
      sessionId: session.token,
    };
  }

  createSession(req, res, { user = null, store = null, role, via = 'password' }) {
    const token = randomToken(32);
    const stamp = nowStamp();
    this.db
      .prepare(
        `INSERT INTO sessions (token, user_id, store_id, role, ip, device_id, ua, login_via, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token,
        user ? user.id : null,
        store ? store.id : user && user.store_id ? user.store_id : null,
        role,
        clientIp(req) || null,
        req.deviceId || null,
        String(req.headers['user-agent'] || '').slice(0, 400),
        via,
        stamp,
        stamp,
        addDaysStamp(SESSION_DAYS),
      );
    setCookie(res, COOKIE_NAME, token, {
      maxAge: SESSION_DAYS * 86400 * 1000,
      secure: String(process.env.COOKIE_SECURE || '') === '1',
    });
    return token;
  }

  destroySession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  destroyUserSessions(userId, exceptToken = null) {
    if (exceptToken) {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(userId, exceptToken);
    } else {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  }

  purgeExpired() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowStamp());
  }

  /** Express 中间件：解析会话并挂载 req.user / req.session */
  middleware() {
    return (req, res, next) => {
      try {
        captureDevice(req);
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
        if (!token) return next();
        const session = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
        if (!session) return next();
        if (session.expires_at < nowStamp()) {
          this.destroySession(token);
          clearCookie(res, COOKIE_NAME);
          return next();
        }

        let user = null;
        if (session.user_id) {
          user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
          if (!user) {
            this.destroySession(token);
            clearCookie(res, COOKIE_NAME);
            return next();
          }
          if (user.status !== 'active') {
            this.destroySession(token);
            clearCookie(res, COOKIE_NAME);
            req.authError = '账号已被禁用';
            return next();
          }
        }

        req.session = session;
        req.user = this.buildPrincipal(user, session);

        const last = Date.parse(`${session.last_seen_at.replace(' ', 'T')}Z`);
        if (!Number.isFinite(last) || Date.now() - last > TOUCH_INTERVAL_MS) {
          const stamp = nowStamp();
          this.db
            .prepare('UPDATE sessions SET last_seen_at = ?, ip = ?, expires_at = ? WHERE token = ?')
            .run(stamp, clientIp(req) || null, addDaysStamp(SESSION_DAYS), token);
        }
        return next();
      } catch (err) {
        return next(err);
      }
    };
  }

  /** 账号密码登录；返回会话用户 */
  login(req, res, username, password) {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    if (!row) return { ok: false, reason: '账号或密码错误' };
    if (!verifyPassword(password, row.password_hash)) return { ok: false, reason: '账号或密码错误' };
    if (row.status !== 'active') return { ok: false, reason: '账号已被禁用，请联系管理员' };
    if (row.role === 'clerk' && !row.store_id) {
      return { ok: false, reason: '店员账号未绑定门店，请联系管理员' };
    }
    this.createSession(req, res, { user: row, role: row.role, via: 'password' });
    this.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(nowStamp(), nowStamp(), row.id);
    return { ok: true, user: row };
  }

  /** 免登录门店链接：token → 门店会话 */
  autoLogin(req, res, token) {
    const store = this.db.prepare('SELECT * FROM stores WHERE auto_login_token = ?').get(String(token || ''));
    if (!store) return { ok: false, reason: '链接无效' };
    if (!store.auto_login_enabled) return { ok: false, reason: '该门店免登录链接已停用', store };
    if (store.status !== 'active') return { ok: false, reason: '门店已停用', store };
    this.createSession(req, res, { store, role: 'clerk', via: 'auto' });
    return { ok: true, store };
  }
}

/** 角色判定工具 */
const roleOf = (user) => (user ? user.role : null);

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts(['json', 'html']) === 'html') return res.redirect('/login');
    return res.status(401).json({ error: '请先登录', code: 'UNAUTHENTICATED' });
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '请先登录', code: 'UNAUTHENTICATED' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '没有操作权限', code: 'FORBIDDEN' });
    }
    return next();
  };
}

/**
 * 计算当前用户可见门店范围。
 * admin 全部门店；region_admin（区域管理员）直接管辖的门店；clerk 仅本门店（未绑定则为空）。
 */
function visibleStoreIds(db, user) {
  if (!user) return [];
  if (user.role === 'admin') {
    return db.prepare('SELECT id FROM stores ORDER BY id').all().map((r) => r.id);
  }
  if (user.role === 'region_admin') {
    if (!user.storeIds || user.storeIds.length === 0) return [];
    const marks = user.storeIds.map(() => '?').join(',');
    return db
      .prepare(`SELECT id FROM stores WHERE id IN (${marks}) ORDER BY id`)
      .all(...user.storeIds)
      .map((r) => r.id);
  }
  return user.storeId ? [user.storeId] : [];
}

/** 校验某门店是否在当前用户可写范围内 */
function canWriteStore(db, user, storeId) {
  if (!user || !storeId) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'clerk') return user.storeId === storeId;
  if (user.role === 'region_admin') {
    // 区域管理员直接管辖的门店：user_stores 中有记录即可，无需再经区域转发
    return Boolean(user.storeIds && user.storeIds.includes(Number(storeId)));
  }
  return false;
}

function canReadStore(db, user, storeId) {
  return canWriteStore(db, user, storeId);
}

/** 登录后默认落地页 */
function homePath(user) {
  if (!user) return '/login';
  if (user.role === 'admin' || user.role === 'region_admin') return '/admin';
  return '/clerk';
}

module.exports = {
  Auth,
  COOKIE_NAME,
  ROLE_LABEL,
  roleOf,
  requireAuth,
  requireRole,
  visibleStoreIds,
  canWriteStore,
  canReadStore,
  homePath,
  parseCookies,
  captureDevice,
  deviceLabel,
  dateStrOf,
  HttpError,
};
