'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const { asyncHandler, nowStamp, HttpError } = require('../util');

/** 商品属性：本品 own / 竞品 comp。未设置时按竞品处理（与数据库默认值一致）。 */
const KINDS = ['own', 'comp'];
const KIND_LABEL = { own: '本品', comp: '竞品' };
const MAX_CATEGORY_LENGTH = 40;

function normalizeKind(value, fallback = 'comp') {
  return KINDS.includes(value) ? value : fallback;
}

/** 品类为自由文本：留空表示未分类，这里统一去掉首尾空白 */
function normalizeCategory(value) {
  return String(value == null ? '' : value).trim().slice(0, MAX_CATEGORY_LENGTH);
}

/** 批量导入里「本品 / 竞品 / own / comp」都认 */
function parseKindText(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (text === '本品' || text === 'own') return 'own';
  if (text === '竞品' || text === 'comp') return 'comp';
  return null;
}

/** 条码样：纯数字，或字母数字连字符组合（空白分隔时用来和品类区分） */
const BARCODE_RE = /^(?:\d{6,32}|[0-9A-Za-z][0-9A-Za-z-]{5,31})$/;

/**
 * 解析批量导入的一行。
 *
 * 品类与属性都是可空字段，纯空白分隔时无法靠位置区分空位，所以：
 *   - 含制表符 / 逗号 → 严格按位置：品名, 别名, 条码, 品类, 属性；
 *   - 纯空白 → 品名 + 别名 + 条码样字段，末尾的「本品 / 竞品」视为属性，其余归入品类。
 */
function parseProductLine(line) {
  const text = String(line || '').trim();
  if (/[\t,，]/.test(text)) {
    const parts = text.split(/[\t,，]/).map((p) => p.trim());
    return {
      name: parts[0] || '',
      alias: parts[1] || '',
      barcode: parts[2] || null,
      category: normalizeCategory(parts[3]),
      kind: parseKindText(parts[4]) || 'comp',
    };
  }

  const parts = text.split(/\s+/).filter(Boolean);
  const name = parts.shift() || '';
  let alias = '';
  let barcode = null;
  let kind = 'comp';

  if (parts.length && parseKindText(parts[parts.length - 1])) {
    kind = parseKindText(parts.pop());
  }
  if (parts.length) alias = parts.shift();
  // 剩余字段里第一个条码样的当作条码，其余（可含空格）合并为品类
  const rest = [];
  for (const part of parts) {
    if (!barcode && BARCODE_RE.test(part)) barcode = part;
    else rest.push(part);
  }
  return { name, alias, barcode, category: normalizeCategory(rest.join(' ')), kind };
}

/** 商品档案：品名 / 别名（店员端只展示别名）/ 条码 / 品类 / 属性 / 状态 */
function createProductRoutes({ db, audit }) {
  const router = express.Router();
  router.use(requireAuth);

  function shape(p) {
    return {
      id: p.id,
      name: p.name,
      alias: p.alias,
      barcode: p.barcode || '',
      category: p.category || '',
      kind: normalizeKind(p.kind),
      kindLabel: KIND_LABEL[normalizeKind(p.kind)],
      status: p.status,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  }

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { q, status } = req.query;
      const where = [];
      const params = [];
      if (q) {
        where.push('(name LIKE ? OR alias LIKE ? OR barcode LIKE ?)');
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      if (status === 'active' || status === 'disabled') {
        where.push('status = ?');
        params.push(status);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM products ${clause} ORDER BY id DESC`).all(...params);
      const counts = db
        .prepare("SELECT status, count(*) AS c FROM products GROUP BY status")
        .all()
        .reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});
      // 已有品类供新增/编辑时直接选择（输入框仍可自由新建）
      const categories = db
        .prepare("SELECT DISTINCT category FROM products WHERE category <> '' ORDER BY category")
        .all()
        .map((r) => r.category);
      res.json({
        rows: rows.map(shape),
        counts: { active: counts.active || 0, disabled: counts.disabled || 0 },
        categories,
        kinds: KINDS.map((value) => ({ value, label: KIND_LABEL[value] })),
      });
    }),
  );

  router.post(
    '/',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const name = String(req.body.name || '').trim();
      const alias = String(req.body.alias || '').trim() || name;
      const barcode = String(req.body.barcode || '').trim() || null;
      const category = normalizeCategory(req.body.category);
      const kind = normalizeKind(req.body.kind);
      const status = req.body.status === 'disabled' ? 'disabled' : 'active';
      if (!name) return res.status(400).json({ error: '品名必填' });
      if (barcode && db.prepare("SELECT 1 FROM products WHERE barcode = ? AND barcode <> ''").get(barcode)) {
        return res.status(409).json({ error: '条码已存在' });
      }
      const stamp = nowStamp();
      const info = db
        .prepare(
          'INSERT INTO products (name, alias, barcode, category, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(name, alias, barcode, category, kind, status, stamp, stamp);
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(info.lastInsertRowid));
      audit.log(req, {
        action: 'product_create',
        targetType: 'product',
        targetId: product.id,
        detail: `新增商品 ${name}（别名 ${alias}${barcode ? `，条码 ${barcode}` : ''}${category ? `，品类 ${category}` : ''}，${KIND_LABEL[kind]}）`,
      });
      res.status(201).json({ ok: true, product: shape(product) });
    }),
  );

  /** 批量粘贴导入：每行「品名 [别名] [条码] [品类] [属性]」，制表符/逗号/空白分隔 */
  router.post(
    '/batch',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const lines = String(req.body.text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) return res.status(400).json({ error: '没有可导入的内容' });
      const stamp = nowStamp();
      const insert = db.prepare(
        'INSERT INTO products (name, alias, barcode, category, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const created = [];
      const skipped = [];
      db.transaction(() => {
        for (const [idx, line] of lines.entries()) {
          const parsed = parseProductLine(line);
          const name = parsed.name;
          const alias = parsed.alias || name;
          const { barcode, category, kind } = parsed;
          if (!name) {
            skipped.push({ line: idx + 1, reason: '缺少品名' });
            continue;
          }
          if (barcode && db.prepare('SELECT 1 FROM products WHERE barcode = ?').get(barcode)) {
            skipped.push({ line: idx + 1, reason: `条码 ${barcode} 已存在` });
            continue;
          }
          insert.run(name, alias, barcode, category, kind, 'active', stamp, stamp);
          created.push({ name, alias, barcode: barcode || '', category, kind });
        }
      })();
      audit.log(req, {
        action: 'product_batch_create',
        targetType: 'product',
        detail: `批量导入商品 ${created.length} 条，跳过 ${skipped.length} 条`,
      });
      res.json({ ok: true, created, skipped });
    }),
  );

  router.put(
    '/:id',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
      if (!product) throw new HttpError(404, '商品不存在');
      const name = req.body.name != null ? String(req.body.name).trim() : product.name;
      const alias = req.body.alias != null ? String(req.body.alias).trim() || name : product.alias;
      const barcode = req.body.barcode !== undefined ? String(req.body.barcode || '').trim() || null : product.barcode;
      const category =
        req.body.category !== undefined ? normalizeCategory(req.body.category) : product.category || '';
      const kind = req.body.kind !== undefined ? normalizeKind(req.body.kind, product.kind) : normalizeKind(product.kind);
      const status = req.body.status === 'disabled' ? 'disabled' : req.body.status === 'active' ? 'active' : product.status;
      if (!name) return res.status(400).json({ error: '品名必填' });
      if (barcode && barcode !== product.barcode) {
        if (db.prepare('SELECT 1 FROM products WHERE barcode = ?').get(barcode)) {
          return res.status(409).json({ error: '条码已存在' });
        }
      }
      db.prepare(
        'UPDATE products SET name = ?, alias = ?, barcode = ?, category = ?, kind = ?, status = ?, updated_at = ? WHERE id = ?',
      ).run(name, alias, barcode, category, kind, status, nowStamp(), product.id);
      const detail =
        product.status !== status
          ? `商品 ${product.name} 状态改为 ${status === 'active' ? '启用' : '禁用（不参与填报与统计）'}`
          : `修改商品 ${product.name} → ${name}（别名 ${product.alias} → ${alias}，品类 ${product.category || '未分类'} → ${
              category || '未分类'
            }，属性 ${KIND_LABEL[normalizeKind(product.kind)]} → ${KIND_LABEL[kind]}）`;
      audit.log(req, { action: 'product_update', targetType: 'product', targetId: product.id, detail });
      res.json({ ok: true, product: shape(db.prepare('SELECT * FROM products WHERE id = ?').get(product.id)) });
    }),
  );

  /** 删除商品（历史数据保留：仅解绑关联并删除档案会破坏统计，故仅允许无历史数据的商品） */
  router.delete(
    '/:id',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
      if (!product) throw new HttpError(404, '商品不存在');
      const used = db.prepare('SELECT count(*) AS c FROM sale_entries WHERE product_id = ?').get(product.id).c;
      if (used > 0) {
        return res.status(409).json({ error: '该商品已有销售记录，不能删除；请改为“禁用”' });
      }
      db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
      audit.log(req, {
        action: 'product_delete',
        targetType: 'product',
        targetId: product.id,
        detail: `删除商品 ${product.name}（别名 ${product.alias}）`,
      });
      res.json({ ok: true });
    }),
  );

  return router;
}

module.exports = { createProductRoutes };
