'use strict';

const express = require('express');
const { asyncHandler } = require('../util');
const { requireAuth, homePath, COOKIE_NAME } = require('../auth');
const { hashPassword, verifyPassword, passwordWeakness } = require('../security');
const { clientIp } = require('../net');
const { passwordManagedExternally } = require('../db');

/**
 * 认证路由：登录 / 登出 / 当前用户 / 修改密码。
 * 登录失败按 IP+账号限流，所有关键动作写审计日志。
 */
function createAuthRoutes({ db, auth, audit, limiter }) {
  const router = express.Router();

  /** 登录页需要的公开信息（是否已初始化等） */
  router.get(
    '/bootstrap',
    asyncHandler(async (req, res) => {
      const storeCount = db.prepare('SELECT count(*) AS c FROM stores').get().c;
      const v = db.prepare("SELECT value FROM settings WHERE key = 'brand_name'").get();
      res.json({
        brandName: (v && v.value) || '店销日集',
        initialized: storeCount > 0,
        today: require('../util').todayStr(),
      });
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      if (!username || !password) {
        return res.status(400).json({ error: '请输入账号和密码' });
      }
      const ip = clientIp(req);
      if (limiter.isBlocked(ip, username)) {
        audit.log(req, {
          action: 'login_blocked',
          targetType: 'user',
          targetId: username,
          detail: {
            summary: `账号 ${username} 连续登录失败次数过多`,
            note: '已在当前 IP 上临时限制登录，10 分钟后自动解除',
          },
        });
        return res.status(429).json({ error: '登录失败次数过多，请 10 分钟后再试' });
      }
      const result = auth.login(req, res, username, password);
      if (!result.ok) {
        limiter.fail(ip, username);
        audit.log(req, {
          action: 'login_failed',
          targetType: 'user',
          targetId: username,
          detail: { summary: `账号 ${username} 登录失败`, note: result.reason },
        });
        return res.status(401).json({ error: result.reason });
      }
      limiter.reset(ip, username);
      audit.log(req, {
        action: 'login',
        targetType: 'user',
        targetId: result.user.id,
        detail: {
          summary: `账号 ${result.user.username}（${result.user.display_name}）登录成功`,
          context: { role: result.user.role },
        },
        actor: { id: result.user.id, name: result.user.display_name, role: result.user.role },
      });
      const user = req.user;
      res.json({
        ok: true,
        redirect: homePath({ role: result.user.role }),
        mustChangePassword: Boolean(result.user.must_change_password),
        passwordManaged: passwordManagedExternally(result.user),
        user: { role: result.user.role, name: result.user.display_name || user?.name },
      });
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      if (req.user) {
        audit.log(req, {
          action: 'logout',
          detail: { summary: '主动退出登录', context: { role: req.user.role } },
        });

      }
      if (req.session) auth.destroySession(req.session.token);
      res.append(
        'Set-Cookie',
        `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      );
      res.json({ ok: true, redirect: '/login' });
    }),
  );

  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: '请先登录', code: 'UNAUTHENTICATED' });
      res.json({ user: publicUser(req.user) });
    }),
  );

  router.post(
    '/password',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { oldPassword, newPassword } = req.body || {};
      if (!req.user.id) return res.status(403).json({ error: '免登录会话不能修改密码' });
      if (req.user.passwordManaged) {
        return res.status(403).json({
          error: '该账号的密码由环境变量 INIT_ADMIN_PASSWORD 托管，系统内不可修改',
          code: 'BUILTIN_PASSWORD_MANAGED',
        });
      }
      const weak = passwordWeakness(newPassword);
      if (weak) {
        return res.status(400).json({ error: weak });
      }
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (!row || !verifyPassword(oldPassword, row.password_hash)) {
        return res.status(400).json({ error: '原密码不正确' });
      }
      if (verifyPassword(newPassword, row.password_hash)) {
        return res.status(400).json({ error: '新密码不能与原密码相同' });
      }
      db.prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
      ).run(hashPassword(newPassword), require('../util').nowStamp(), row.id);
      auth.destroyUserSessions(row.id, req.session.token);
      audit.log(req, {
        action: 'password_change',
        targetType: 'user',
        targetId: row.id,
        detail: {
          summary: `账号 ${row.username}（${row.display_name}）修改了登录密码`,
          context: { role: row.role },
          note: '其他设备的登录状态已强制下线',
        },
      });
      res.json({ ok: true });
    }),
  );

  return router;
}

function publicUser(user) {
  // 店员端（含免登录会话）只认门店别名：真实编码与名称属于后台与日志口径，
  // 不下发到店员页面。后台账号（总部 / 区域管理员）保持原样。
  const clerkView = user.role === 'clerk' || user.autoLogin;
  return {
    id: user.id,
    // 免登录会话没有账号，name 里带的是「真实店名（免登录）」，店员端换成别名
    name: user.autoLogin === true && !user.username ? `${user.storeAlias || '本门店'}（免登录）` : user.name,
    username: user.username,
    role: user.role,
    roleLabel: user.roleLabel,
    storeId: user.storeId,
    storeCode: clerkView ? null : user.storeCode,
    storeName: clerkView ? null : user.storeName,
    /** 门店别名：店员端展示的唯一门店标识 */
    storeAlias: user.storeAlias || null,
    /** 区域管理员直接管辖的门店 */
    storeIds: user.storeIds || [],
    autoLogin: user.autoLogin,
    mustChangePassword: user.mustChangePassword,
    isBuiltin: Boolean(user.isBuiltin),
    /** 密码由环境变量托管时为 true：前端应隐藏「改密码」入口 */
    passwordManaged: Boolean(user.passwordManaged),
    home: homePath(user),
  };
}

module.exports = { createAuthRoutes, publicUser };
