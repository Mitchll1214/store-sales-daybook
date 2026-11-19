'use strict';

const express = require('express');
const { requireAuth, requireRole, ROLE_LABEL } = require('../auth');
const { asyncHandler, nowStamp, HttpError } = require('../util');
const { hashPassword } = require('../security');
const { passwordManagedExternally } = require('../db');

/** 用户管理：总部管理员创建/维护账号；区域管理员直接管辖若干门店，无「区域」这一层 */
function createUserRoutes({ db, audit }) {
  const router = express.Router();
  router.use(requireAuth);

  function shape(row) {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      roleLabel: ROLE_LABEL[row.role] || row.role,
      status: row.status,
      storeId: row.store_id,
      storeCode: row.store_code || null,
      storeName: row.store_name || null,
      phone: row.phone || '',
      mustChangePassword: Boolean(row.must_change_password),
      /** 内置超级管理员账号（由环境变量 INIT_ADMIN_USERNAME 创建） */
      isBuiltin: Boolean(row.is_builtin),
      /** 密码由环境变量托管：为 true 时不允许重置密码，也不允许禁用 */
      passwordManaged: passwordManagedExternally(row),
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      /** 区域管理员直接管辖的门店 */
      storeIds: row.store_ids ? String(row.store_ids).split(',').filter(Boolean).map(Number) : [],
      storeCodes: row.store_codes ? String(row.store_codes).split('\u0001').filter(Boolean) : [],
      storeNames: row.store_names ? String(row.store_names).split('\u0001').filter(Boolean) : [],
    };
  }

  const SELECT_BASE = `
    SELECT u.*, s.code AS store_code, s.name AS store_name,
      (SELECT group_concat(us.store_id) FROM user_stores us WHERE us.user_id = u.id) AS store_ids,
      (SELECT group_concat(st.code, char(1)) FROM user_stores us JOIN stores st ON st.id = us.store_id WHERE us.user_id = u.id) AS store_codes,
      (SELECT group_concat(st.name, char(1)) FROM user_stores us JOIN stores st ON st.id = us.store_id WHERE us.user_id = u.id) AS store_names
    FROM users u
    LEFT JOIN stores s ON s.id = u.store_id`;

  function syncUserStores(userId, storeIds) {
    db.prepare('DELETE FROM user_stores WHERE user_id = ?').run(userId);
    if (!storeIds || storeIds.length === 0) return;
    const insert = db.prepare('INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)');
    for (const storeId of storeIds) insert.run(userId, storeId);
  }

  function validateStores(storeIds) {
    if (!storeIds || storeIds.length === 0) return [];
    const marks = storeIds.map(() => '?').join(',');
    const found = db.prepare(`SELECT id FROM stores WHERE id IN (${marks})`).all(...storeIds).map((r) => r.id);
    if (found.length !== storeIds.length) throw new HttpError(400, '包含不存在的门店');
    return found;
  }

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { q, role, status } = req.query;
      const where = [];
      const params = [];

      if (req.user.role === 'region_admin') {
        if (req.user.storeIds.length === 0) return res.json({ rows: [], counts: {} });
        const marks = req.user.storeIds.map(() => '?').join(',');
        where.push(`(u.role = 'clerk' AND u.store_id IN (${marks}))`);
        params.push(...req.user.storeIds);
      } else if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '没有操作权限' });
      }

      if (q) {
        where.push('(u.username LIKE ? OR u.display_name LIKE ? OR s.name LIKE ? OR s.code LIKE ?)');
        params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (role) {
        where.push('u.role = ?');
        params.push(role);
      }
      if (status) {
        where.push('u.status = ?');
        params.push(status);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db.prepare(`${SELECT_BASE} ${clause} ORDER BY u.role, u.id`).all(...params);
      const counts = db
        .prepare('SELECT role, count(*) AS c FROM users GROUP BY role')
        .all()
        .reduce((acc, r) => ({ ...acc, [r.role]: r.c }), {});
      res.json({ rows: rows.map(shape), counts, roleLabels: ROLE_LABEL });
    }),
  );

  /** 下拉选项：门店列表（仅总部管理员创建用户时使用） */
  router.get(
    '/options',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const stores = db.prepare('SELECT id, code, name, status FROM stores ORDER BY code').all();
      res.json({ stores });
    }),
  );

  router.post(
    '/',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const username = String(req.body.username || '').trim();
      const displayName = String(req.body.displayName || '').trim();
      const role = req.body.role;
      const password = String(req.body.password || '');
      const storeId = req.body.storeId ? Number(req.body.storeId) : null;
      const storeIds = validateStores((req.body.storeIds || []).map(Number).filter(Boolean));

      if (!username || !displayName) return res.status(400).json({ error: '账号与姓名必填' });
      if (!/^[A-Za-z0-9_.@-]{3,32}$/.test(username)) {
        return res.status(400).json({ error: '账号需为 3-32 位字母、数字或 _ . @ -' });
      }
      if (!['admin', 'region_admin', 'clerk'].includes(role)) return res.status(400).json({ error: '角色不合法' });
      if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        return res.status(409).json({ error: '账号已存在' });
      }
      if (role === 'clerk' && !storeId) return res.status(400).json({ error: '店员必须绑定门店' });
      if (role === 'region_admin' && storeIds.length === 0) {
        return res.status(400).json({ error: '区域管理员至少管辖一家门店' });
      }
      if (storeId) {
        const store = db.prepare('SELECT id FROM stores WHERE id = ?').get(storeId);
        if (!store) return res.status(400).json({ error: '门店不存在' });
      }

      const stamp = nowStamp();
      const info = db
        .prepare(
          `INSERT INTO users (username, display_name, password_hash, role, status, store_id, phone, must_change_password, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, 1, ?, ?)`,
        )
        .run(username, displayName, hashPassword(password), role, role === 'clerk' ? storeId : null, req.body.phone || null, stamp, stamp);
      const userId = Number(info.lastInsertRowid);
      if (role === 'region_admin') syncUserStores(userId, storeIds);

      audit.log(req, {
        action: 'user_create',
        targetType: 'user',
        targetId: userId,
        detail: {
          summary: `创建${ROLE_LABEL[role]}账号 ${username}（${displayName}）`,
          context: {
            role,
            display_name: displayName,
            phone: req.body.phone || null,
            store_id: role === 'clerk' && storeId ? `#${storeId}` : null,
            storeIds: role === 'region_admin' && storeIds.length ? storeIds.join('、') : null,
          },
          note: '首次登录需修改初始密码',
        },
      });
      const row = db.prepare(`${SELECT_BASE} WHERE u.id = ?`).get(userId);
      res.status(201).json({ ok: true, user: shape(row) });
    }),
  );

  router.put(
    '/:id',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
      if (!user) throw new HttpError(404, '用户不存在');
      const displayName = req.body.displayName != null ? String(req.body.displayName).trim() : user.display_name;
      const phone = req.body.phone !== undefined ? String(req.body.phone || '').trim() : user.phone;
      const status = req.body.status === 'disabled' ? 'disabled' : req.body.status === 'active' ? 'active' : user.status;
      const storeId =
        user.role === 'clerk'
          ? req.body.storeId != null
            ? Number(req.body.storeId) || null
            : user.store_id
          : null;
      if (!displayName) return res.status(400).json({ error: '姓名必填' });
      if (user.role === 'clerk' && !storeId) return res.status(400).json({ error: '店员必须绑定门店' });
      if (status === 'disabled' && passwordManagedExternally(user)) {
        return res.status(400).json({ error: '该账号由环境变量托管，不可在系统内禁用' });
      }
      if (status === 'disabled' && user.role === 'admin') {
        const admins = db.prepare("SELECT count(*) AS c FROM users WHERE role = 'admin' AND status = 'active'").get().c;
        if (admins <= 1 && user.status === 'active') {
          return res.status(400).json({ error: '至少保留一个启用状态的总部管理员' });
        }
      }
      db.prepare('UPDATE users SET display_name = ?, phone = ?, status = ?, store_id = ?, updated_at = ? WHERE id = ?').run(
        displayName,
        phone || null,
        status,
        storeId,
        nowStamp(),
        user.id,
      );
      if (user.role === 'region_admin' && Array.isArray(req.body.storeIds)) {
        const storeIds = validateStores(req.body.storeIds.map(Number).filter(Boolean));
        if (storeIds.length === 0) return res.status(400).json({ error: '区域管理员至少管辖一家门店' });
        syncUserStores(user.id, storeIds);
      }
      if (status === 'disabled') {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      }
      audit.log(req, {
        action: 'user_update',
        targetType: 'user',
        targetId: user.id,
        detail: {
          summary: `修改账号 ${user.username}`,
          changes: [
            { field: 'display_name', from: user.display_name, to: displayName },
            { field: 'phone', from: user.phone || '', to: phone || '' },
            { field: 'status', from: user.status, to: status },
            { field: 'store_id', from: user.store_id || '', to: storeId || '' },
          ],
          context: { role: user.role },
          note: status === 'disabled' ? '该账号在线会话已全部失效' : null,
        },
      });
      res.json({ ok: true, user: shape(db.prepare(`${SELECT_BASE} WHERE u.id = ?`).get(user.id)) });
    }),
  );

  /** 管理员重置他人密码：目标账号下次登录需修改密码 */
  router.post(
    '/:id/reset-password',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
      if (!user) throw new HttpError(404, '用户不存在');
      if (passwordManagedExternally(user)) {
        throw new HttpError(403, '该账号的密码由环境变量 INIT_ADMIN_PASSWORD 托管，系统内不可重置');
      }
      const password = String(req.body.password || '');
      if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
      db.prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?',
      ).run(hashPassword(password), nowStamp(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      audit.log(req, {
        action: 'user_reset_password',
        targetType: 'user',
        targetId: user.id,
        detail: {
          summary: `重置账号 ${user.username}（${user.display_name}）的登录密码`,
          context: { role: user.role, status: user.status },
          note: '该账号所有登录状态已失效，下次登录需修改密码',
        },
      });
      res.json({ ok: true });
    }),
  );

  router.delete(
    '/:id',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
      if (!user) throw new HttpError(404, '用户不存在');
      if (user.id === req.user.id) return res.status(400).json({ error: '不能删除当前登录账号' });
      if (user.is_builtin) return res.status(400).json({ error: '内置超级管理员账号不可删除' });
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      audit.log(req, {
        action: 'user_delete',
        targetType: 'user',
        targetId: user.id,
        detail: `删除${ROLE_LABEL[user.role] || ''}账号 ${user.username}（${user.display_name}）`,
      });
      res.json({ ok: true });
    }),
  );

  return router;
}

module.exports = { createUserRoutes };
