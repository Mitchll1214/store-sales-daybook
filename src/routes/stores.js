'use strict';

const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { requireAuth, requireRole, visibleStoreIds } = require('../auth');
const { asyncHandler, HttpError, parseStoreLines, nowStamp, storeAlias } = require('../util');

/** 对外可访问的站点根地址：优先 PUBLIC_BASE_URL，其次按反向代理头推导 */
function baseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

/** 免登录链接只带 token：门店编码与名称不再出现在链接、二维码或聊天记录里 */
function autoLoginUrl(req, store) {
  return `${baseUrl(req)}/s/${store.auto_login_token}`;
}

function shapeStore(req, store, extra = {}) {
  const linkedCount = extra.linkedCount ?? 0;
  const activeCount = extra.activeProductCount ?? 0;
  // 免登录链接只对总部管理员与区域管理员可见，店员会话不返回 token，避免扩大链接暴露面
  const canSeeLink = req.user && (req.user.role === 'admin' || req.user.role === 'region_admin');
  return {
    id: store.id,
    code: store.code,
    name: store.name,
    alias: store.alias || '',
    /** 店员端实际会看到的门店标识（别名留空时的兜底文案） */
    displayAlias: storeAlias(store),
    status: store.status,
    autoLoginEnabled: Boolean(store.auto_login_enabled),
    autoLoginToken: canSeeLink ? store.auto_login_token : null,
    autoLoginUrl: canSeeLink ? autoLoginUrl(req, store) : null,
    productScope: linkedCount > 0 ? 'linked' : 'all',
    linkedCount,
    activeProductCount: activeCount,
    remark: store.remark || '',
    createdAt: store.created_at,
    updatedAt: store.updated_at,
  };
}

function createStoreRoutes({ db, audit }) {
  const router = express.Router();
  // 门店管理仅总部管理员与区域管理员可用；店员通过 /api/sales/home 获取自身门店信息
  router.use(requireAuth, requireRole('admin', 'region_admin'));

  function loadStore(id) {
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(Number(id));
    if (!store) throw new HttpError(404, '门店不存在');
    return store;
  }

  /** 区域管理员只能查看自己管辖的门店 */
  function assertVisible(user, store) {
    if (user.role === 'admin') return;
    if (user.role === 'region_admin') {
      if (!user.storeIds.includes(store.id)) throw new HttpError(403, '无权查看该门店');
      return;
    }
    throw new HttpError(403, '没有操作权限');
  }

  function counts(storeIds) {
    const result = { activeProductCount: 0, linked: new Map() };
    result.activeProductCount = db.prepare("SELECT count(*) AS c FROM products WHERE status = 'active'").get().c;
    if (storeIds.length === 0) return result;
    const marks = storeIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT sp.store_id AS storeId, count(*) AS c
         FROM store_products sp JOIN products p ON p.id = sp.product_id
         WHERE sp.store_id IN (${marks}) AND p.status = 'active'
         GROUP BY sp.store_id`,
      )
      .all(...storeIds);
    for (const row of rows) result.linked.set(row.storeId, row.c);
    return result;
  }

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { q, status } = req.query;
      const ids = visibleStoreIds(db, req.user);
      if (ids.length === 0) return res.json({ rows: [], total: 0 });
      const marks = ids.map(() => '?').join(',');
      const where = [`s.id IN (${marks})`];
      const params = [...ids];
      if (q) {
        where.push('(s.code LIKE ? OR s.name LIKE ? OR s.alias LIKE ?)');
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (status) {
        where.push('s.status = ?');
        params.push(status);
      }
      const rows = db
        .prepare(
          `SELECT s.* FROM stores s
           WHERE ${where.join(' AND ')}
           ORDER BY s.code`,
        )
        .all(...params);
      const c = counts(ids);
      res.json({
        rows: rows.map((s) =>
          shapeStore(req, s, {
            linkedCount: c.linked.get(s.id) || 0,
            activeProductCount: c.activeProductCount,
          }),
        ),
        total: rows.length,
      });
    }),
  );

  /** 批量新增：每行「编码 名称 [别名]」，支持制表符/逗号/空白分隔 */
  router.post(
    '/batch',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const text = req.body.text || '';
      const { rows, errors } = parseStoreLines(text);
      if (rows.length === 0) {
        return res.status(400).json({ error: '没有解析到有效门店', errors });
      }
      const stamp = nowStamp();
      const insert = db.prepare(
        `INSERT INTO stores (code, name, alias, status, auto_login_token, auto_login_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, 1, ?, ?)`,
      );
      const exists = db.prepare('SELECT id FROM stores WHERE code = ?');
      const created = [];
      const skipped = [];
      db.transaction(() => {
        for (const row of rows) {
          if (exists.get(row.code)) {
            skipped.push({ code: row.code, name: row.name, reason: '编码已存在' });
            continue;
          }
          insert.run(row.code, row.name, row.alias || null, newToken(), stamp, stamp);
          created.push({ code: row.code, name: row.name, alias: row.alias || null });
        }
      })();
      audit.log(req, {
        action: 'store_batch_create',
        targetType: 'store',
        detail: {
          summary: `批量新增门店成功 ${created.length} 家，跳过 ${skipped.length} 家`,
          note:
            skipped.length
              ? `跳过：${skipped
                  .slice(0, 10)
                  .map((s) => `${s.code} ${s.name}（${s.reason}）`)
                  .join('；')}${skipped.length > 10 ? `；等共 ${skipped.length} 家` : ''}`
              : null,
        },
      });
      res.json({ ok: true, created, skipped, errors });
    }),
  );

  router.post(
    '/',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const code = String(req.body.code || '').trim();
      const name = String(req.body.name || '').trim();
      if (!code || !name) return res.status(400).json({ error: '门店编码与名称均必填' });
      if (db.prepare('SELECT 1 FROM stores WHERE code = ?').get(code)) {
        return res.status(409).json({ error: '门店编码已存在' });
      }
      const stamp = nowStamp();
      const alias = String(req.body.alias || '').trim() || null;
      const info = db
        .prepare(
          `INSERT INTO stores (code, name, alias, status, auto_login_token, auto_login_enabled, remark, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, 1, ?, ?, ?)`,
        )
        .run(code, name, alias, newToken(), req.body.remark || null, stamp, stamp);
      const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(Number(info.lastInsertRowid));
      audit.log(req, {
        action: 'store_create',
        targetType: 'store',
        targetId: store.id,
        detail: {
          summary: `新增门店 ${store.code} ${store.name}`,
          context: { alias: store.alias || null, status: store.status, remark: store.remark || null },
          note: '免登录链接已生成',
        },
      });
      res.status(201).json({ ok: true, store: shapeStore(req, store) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const store = loadStore(req.params.id);
      assertVisible(req.user, store);
      const linked = db
        .prepare('SELECT product_id FROM store_products WHERE store_id = ?')
        .all(store.id)
        .map((r) => r.product_id);
      res.json({
        store: shapeStore(req, store, {
          linkedCount: linked.length,
          activeProductCount: db.prepare("SELECT count(*) AS c FROM products WHERE status = 'active'").get().c,
        }),
        linkedProductIds: linked,
        canEdit: req.user.role === 'admin',
      });
    }),
  );

  /** 编辑门店信息：仅总部管理员（区域管理员不可修改门店信息） */
  router.put(
    '/:id',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const store = loadStore(req.params.id);
      const code = req.body.code != null ? String(req.body.code).trim() : store.code;
      const name = req.body.name != null ? String(req.body.name).trim() : store.name;
      if (!code || !name) return res.status(400).json({ error: '门店编码与名称均必填' });
      if (code !== store.code && db.prepare('SELECT 1 FROM stores WHERE code = ?').get(code)) {
        return res.status(409).json({ error: '门店编码已存在' });
      }
      const status = req.body.status === 'disabled' ? 'disabled' : 'active';
      const remark = req.body.remark === undefined ? store.remark : req.body.remark;
      const alias =
        req.body.alias === undefined ? store.alias || null : String(req.body.alias || '').trim() || null;
      db.prepare(
        `UPDATE stores SET code = ?, name = ?, alias = ?, status = ?, remark = ?, updated_at = ? WHERE id = ?`,
      ).run(code, name, alias, status, remark || null, nowStamp(), store.id);
      audit.log(req, {
        action: 'store_update',
        targetType: 'store',
        targetId: store.id,
        detail: {
          summary: `修改门店 ${store.code} ${store.name}`,
          changes: [
            { field: 'code', from: store.code, to: code },
            { field: 'name', from: store.name, to: name },
            { field: 'alias', from: store.alias || '', to: alias || '' },
            { field: 'status', from: store.status, to: status },
            { field: 'remark', from: store.remark || '', to: remark || '' },
          ],
        },
      });
      res.json({ ok: true, store: shapeStore(req, loadStore(store.id)) });
    }),
  );

  /** 免登录链接开关 */
  router.patch(
    '/:id/auto-login',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const store = loadStore(req.params.id);
      const enabled = Boolean(req.body.enabled);
      db.prepare('UPDATE stores SET auto_login_enabled = ?, updated_at = ? WHERE id = ?').run(
        enabled ? 1 : 0,
        nowStamp(),
        store.id,
      );
      audit.log(req, {
        action: enabled ? 'store_auto_login_enable' : 'store_auto_login_disable',
        targetType: 'store',
        targetId: store.id,
        detail: {
          summary: `${enabled ? '启用' : '停用'}门店 ${store.code} ${store.name} 的免登录链接`,
          changes: [
            { field: 'auto_login_enabled', from: store.auto_login_enabled ? '开启' : '关闭', to: enabled ? '开启' : '关闭' },
          ],
          note: enabled ? '免登录链接已恢复可用' : '已持有的免登录链接同时失效',
        },
      });
      res.json({ ok: true, store: shapeStore(req, loadStore(store.id)) });
    }),
  );

  /** 更新（重置）免登录链接地址：仅总部管理员 */
  router.post(
    '/:id/rotate-token',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const store = loadStore(req.params.id);
      const token = newToken();
      db.prepare('UPDATE stores SET auto_login_token = ?, updated_at = ? WHERE id = ?').run(token, nowStamp(), store.id);
      audit.log(req, {
        action: 'store_auto_login_rotate',
        targetType: 'store',
        targetId: store.id,
        detail: {
          summary: `重置门店 ${store.code} ${store.name} 的免登录链接`,
          context: { auto_login_enabled: store.auto_login_enabled ? '开启' : '关闭' },
          note: '旧链接立即失效，需要重新分发二维码',
        },
      });
      res.json({ ok: true, store: shapeStore(req, loadStore(store.id)) });
    }),
  );

  /** 关联商品：传空数组表示「关联全部启用商品」 */
  router.put(
    '/:id/products',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const store = loadStore(req.params.id);
      const raw = Array.isArray(req.body.productIds) ? req.body.productIds : [];
      const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (ids.length > 0) {
        const marks = ids.map(() => '?').join(',');
        const found = db.prepare(`SELECT count(*) AS c FROM products WHERE id IN (${marks})`).get(...ids).c;
        if (found !== ids.length) return res.status(400).json({ error: '包含不存在的商品' });
      }
      db.transaction(() => {
        db.prepare('DELETE FROM store_products WHERE store_id = ?').run(store.id);
        const insert = db.prepare('INSERT INTO store_products (store_id, product_id) VALUES (?, ?)');
        for (const id of ids) insert.run(store.id, id);
      })();
      audit.log(req, {
        action: 'store_products_update',
        targetType: 'store',
        targetId: store.id,
        detail: ids.length
          ? { summary: `门店 ${store.code} 关联 ${ids.length} 个商品`, context: { product_ids: ids.join('、') } }
          : { summary: `门店 ${store.code} 取消商品关联`, note: '恢复为全部启用商品' },
      });
      res.json({ ok: true, linkedCount: ids.length });
    }),
  );

  /** 二维码（SVG）：内容与免登录链接一致，只有 token，不含门店编码与名称 */
  router.get(
    '/:id/qrcode',
    asyncHandler(async (req, res) => {
      const store = loadStore(req.params.id);
      assertVisible(req.user, store);
      const url = autoLoginUrl(req, store);
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 320,
        errorCorrectionLevel: 'M',
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    }),
  );

  return router;
}

module.exports = { createStoreRoutes, autoLoginUrl, baseUrl, newToken };
