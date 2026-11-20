'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../auth');
const {
  asyncHandler,
  HttpError,
  PERIODS,
  PERIOD_LABEL,
  UPLOAD_DIR,
  canEditPeriod,
  isDateStr,
  todayStr,
  localHour,
  periodState,
  nowStamp,
  storeAlias,
} = require('../util');
const { productsForStore, submissionIndex, clerkHome } = require('../report');

const MAX_QTY = 1_000_000;

/** 店员会话必须有门店上下文 */
function requireStoreContext(req) {
  if (!req.user || !req.user.storeId) {
    throw new HttpError(403, '当前账号未绑定门店，无法填报');
  }
  return req.user.storeId;
}

/** 填报只收集数量：本系统不统计销售金额。负数代表退货件数，允许提交 */
function shapeEntryInput(raw) {
  const qty = Number(raw.qty ?? 0);
  if (!Number.isFinite(qty) || !Number.isInteger(qty) || Math.abs(qty) > MAX_QTY) {
    throw new HttpError(400, `数量需为整数，绝对值不超过 ${MAX_QTY}`);
  }
  return { qty };
}

/**
 * 销售填报：引导式逐条录入 + 时段提交 + 凭证图片。
 * 已提交的时段对店员完全锁定，且店员端永远不回传商品真实品名/条码与历史数量。
 */
function createSalesRoutes({ db, audit }) {
  const router = express.Router();
  router.use(requireAuth);

  const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 8) || '.jpg';
      cb(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  });
  const upload = multer({
    storage: imageStorage,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!ok.includes(file.mimetype)) return cb(new HttpError(400, '仅支持 JPG/PNG/WebP/GIF 图片'));
      return cb(null, true);
    },
  });

  function loadSubmission(storeId, date, period) {
    return db
      .prepare('SELECT * FROM sale_submissions WHERE store_id = ? AND biz_date = ? AND period = ?')
      .get(storeId, date, period);
  }

  function ensureEditable(storeId, date, period) {
    if (!PERIODS.includes(period)) throw new HttpError(400, '时段不合法');
    if (!isDateStr(date)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
    if (!canEditPeriod(date, period)) {
      const today = todayStr();
      const msg =
        date > today
          ? '该日期尚未到来，无法填报'
          : date === today
            ? '该时段已过填报截止时间'
            : '只能补交昨日数据，且需在当天 12:00 前完成';
      throw new HttpError(409, msg, 'PERIOD_CLOSED');
    }
    const sub = loadSubmission(storeId, date, period);
    if (sub) throw new HttpError(409, `${date} ${PERIOD_LABEL[period]}已提交，不能重复填写`, 'ALREADY_SUBMITTED');
  }

  /** 商品队列 + 已确认进度（不含任何已登记数量/金额） */
  function buildWizard(storeId, date, period) {
    const products = productsForStore(db, storeId);
    const filledIds = new Set(
      db
        .prepare(
          `SELECT product_id FROM sale_entries
           WHERE store_id = ? AND biz_date = ? AND period = ?`,
        )
        .all(storeId, date, period)
        .map((r) => r.product_id),
    );
    const queue = products.map((p) => ({ id: p.id, alias: p.alias }));
    const next = queue.find((p) => !filledIds.has(p.id)) || null;
    return {
      products: queue,
      progress: { total: queue.length, done: queue.filter((p) => filledIds.has(p.id)).length },
      nextProduct: next,
      readyToSubmit: queue.length > 0 && queue.every((p) => filledIds.has(p.id)),
    };
  }

  function listImages(storeId, date, period) {
    return db
      .prepare(
        `SELECT id, original_name AS name, mime, size, uploaded_at AS uploadedAt
         FROM sale_images WHERE store_id = ? AND biz_date = ? AND period = ?
         ORDER BY id`,
      )
      .all(storeId, date, period)
      .map((r) => ({ ...r, url: `/api/sales/images/${r.id}/file` }));
  }

  function storeContext(user) {
    const store = db
      .prepare(
        `SELECT s.id, s.code, s.name, s.alias, s.status
         FROM stores s WHERE s.id = ?`,
      )
      .get(user.storeId);
    if (!store) throw new HttpError(404, '门店不存在');
    return store;
  }

  /**
   * 店员端可见的门店信息：只有别名。
   * 真实编码与名称属于后台与日志口径，不回传给店员页面（含 /home、/session 的响应）。
   */
  function clerkStoreView(store) {
    return { id: store.id, alias: storeAlias(store) };
  }

  /** 店员首页：今天与昨天的上午/下午完成情况 */
  router.get(
    '/home',
    asyncHandler(async (req, res) => {
      const storeId = requireStoreContext(req);
      const store = storeContext(req.user);
      const home = clerkHome(db, storeId);
      res.json({
        store: clerkStoreView(store),
        ...home,
        autoLogin: req.user.autoLogin,
        // 免登录会话没有账号，操作人姓名是「真实店名（免登录）」；店员端只显示别名。
        hello: req.user.autoLogin ? `${storeAlias(store)}（免登录）` : req.user.name,
      });
    }),
  );

  /** 填报上下文：默认定位到当前可填时段 */
  router.get(
    '/session',
    asyncHandler(async (req, res) => {
      const storeId = requireStoreContext(req);
      const store = storeContext(req.user);
      const date = req.query.date || todayStr();
      const period = req.query.period || (localHour() < 12 ? 'am' : 'pm');
      if (!isDateStr(date) || !PERIODS.includes(period)) {
        return res.status(400).json({ error: '日期或时段不合法' });
      }
      const submission = loadSubmission(storeId, date, period);
      const editable = !submission && canEditPeriod(date, period);
      const products = productsForStore(db, storeId);
      const wizard = submission
        ? { products: [], progress: { total: products.length, done: products.length }, nextProduct: null, readyToSubmit: false }
        : buildWizard(storeId, date, period);
      res.json({
        store: clerkStoreView(store),
        date,
        period,
        periodLabel: PERIOD_LABEL[period],
        editable,
        submitted: Boolean(submission),
        submittedAt: submission ? submission.submitted_at : null,
        state: periodState(date, period, Boolean(submission)),
        productCount: products.length,
        productAliases: editable ? wizard.products : undefined,
        progress: wizard.progress,
        nextProduct: wizard.nextProduct,
        readyToSubmit: wizard.readyToSubmit,
        images: listImages(storeId, date, period),
      });
    }),
  );

  /** 保存单个商品（引导式的“确认”按钮）；返回下一个待填商品 */
  router.put(
    '/entry',
    asyncHandler(async (req, res) => {
      const storeId = requireStoreContext(req);
      const date = String(req.body.date || '');
      const period = String(req.body.period || '');
      const productId = Number(req.body.productId);
      ensureEditable(storeId, date, period);

      const allowed = productsForStore(db, storeId).map((p) => p.id);
      if (!allowed.includes(productId)) {
        throw new HttpError(400, '该商品不在本门店可填报范围内');
      }
      const { qty } = shapeEntryInput(req.body);

      db.prepare(
        `INSERT INTO sale_entries (store_id, biz_date, period, product_id, qty, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(store_id, biz_date, period, product_id)
         DO UPDATE SET qty = excluded.qty,
                       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).run(storeId, date, period, productId, qty, req.user.id, nowStamp());

      const wizard = buildWizard(storeId, date, period);
      res.json({
        ok: true,
        progress: wizard.progress,
        nextProduct: wizard.nextProduct,
        readyToSubmit: wizard.readyToSubmit,
      });
    }),
  );

  /** 一键按「本时段无销售」填满 0，用于快速提交 */
  router.post(
    '/fill-zero',
    asyncHandler(async (req, res) => {
      const storeId = requireStoreContext(req);
      const date = String(req.body.date || '');
      const period = String(req.body.period || '');
      ensureEditable(storeId, date, period);
      const products = productsForStore(db, storeId);
      if (products.length === 0) throw new HttpError(400, '门店暂无可填报商品');
      const stamp = nowStamp();
      const upsert = db.prepare(
        `INSERT INTO sale_entries (store_id, biz_date, period, product_id, qty, updated_by, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(store_id, biz_date, period, product_id)
         DO UPDATE SET qty = 0, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      );
      db.transaction(() => {
        for (const p of products) upsert.run(storeId, date, period, p.id, req.user.id, stamp);
      })();
      audit.log(req, {
        action: 'sales_fill_zero',
        targetType: 'store',
        targetId: storeId,
        detail: {
          summary: `${date} ${PERIOD_LABEL[period]} 批量记为 0`,
          context: { item_count: products.length },
          note: '尚未提交，仍需点击提交才会进入统计',
        },
      });
      const wizard = buildWizard(storeId, date, period);
      res.json({ ok: true, progress: wizard.progress, nextProduct: wizard.nextProduct, readyToSubmit: wizard.readyToSubmit });
    }),
  );

  /** 提交整份时段数据 */
  router.post(
    '/submit',
    asyncHandler(async (req, res) => {
      const storeId = requireStoreContext(req);
      const date = String(req.body.date || '');
      const period = String(req.body.period || '');
      ensureEditable(storeId, date, period);

      const products = productsForStore(db, storeId);
      if (products.length === 0) throw new HttpError(400, '门店暂无可填报商品，请联系管理员');
      const entries = db
        .prepare(
          `SELECT e.product_id, e.qty
           FROM sale_entries e
           JOIN products p ON p.id = e.product_id
           WHERE e.store_id = ? AND e.biz_date = ? AND e.period = ? AND p.status = 'active'`,
        )
        .all(storeId, date, period);
      const covered = new Set(entries.map((e) => e.product_id));
      const missing = products.filter((p) => !covered.has(p.id));
      if (missing.length > 0) {
        throw new HttpError(
          409,
          `还有 ${missing.length} 个商品未确认，请继续完成填报`,
          'INCOMPLETE',
        );
      }

      const totalQty = entries.reduce((s, e) => s + e.qty, 0);
      const stamp = nowStamp();
      try {
        db.transaction(() => {
          db.prepare(
            `INSERT INTO sale_submissions
             (store_id, biz_date, period, item_count, total_qty, submitted_by, submitter_name, submitted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(storeId, date, period, products.length, totalQty, req.user.id, req.user.name, stamp);
          audit.log(req, {
            action: 'sales_submit',
            targetType: 'store',
            targetId: storeId,
            detail: {
              summary: `提交 ${date} ${PERIOD_LABEL[period]} 销售数据`,
              context: {
                item_count: products.length,
                total_qty: totalQty,
                submitter: req.user.name,
              },
            },
          });
        })();
      } catch (err) {
        if (/UNIQUE constraint failed/.test(err.message)) {
          throw new HttpError(409, '该时段已提交，请勿重复提交', 'ALREADY_SUBMITTED');
        }
        throw err;
      }
      res.json({
        ok: true,
        date,
        period,
        periodLabel: PERIOD_LABEL[period],
        submittedAt: stamp,
        itemCount: products.length,
        totalQty,
      });
    }),
  );

  /** 上传凭证图片（提交前） */
  router.post(
    '/images',
    asyncHandler(async (req, res) => {
      const storeId = requireStoreContext(req);
      await new Promise((resolve, reject) => {
        upload.single('file')(req, res, (err) => (err ? reject(err) : resolve()));
      });
      if (!req.file) throw new HttpError(400, '请选择要上传的图片');
      const date = String(req.body.date || '');
      const period = String(req.body.period || '');
      try {
        ensureEditable(storeId, date, period);
      } catch (err) {
        fs.unlink(req.file.path, () => {});
        throw err;
      }
      const info = db
        .prepare(
          `INSERT INTO sale_images (store_id, biz_date, period, stored_name, original_name, mime, size, uploaded_by, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          storeId,
          date,
          period,
          req.file.filename,
          String(req.file.originalname || '').slice(0, 200),
          req.file.mimetype,
          req.file.size,
          req.user.id,
          nowStamp(),
        );
      audit.log(req, {
        action: 'image_upload',
        targetType: 'image',
        targetId: info.lastInsertRowid,
        detail: {
          summary: `${date} ${PERIOD_LABEL[period]} 上传凭证图片`,
          context: {
            file: req.file.originalname || req.file.filename,
            size: `${Math.round((req.file.size || 0) / 1024)} KB`,
            mime: req.file.mimetype,
          },
        },
      });
      res.status(201).json({
        ok: true,
        images: listImages(storeId, date, period),
      });
    }),
  );

  /** 读取图片（含权限校验） */
  router.get(
    '/images/:id/file',
    asyncHandler(async (req, res) => {
      const image = db.prepare('SELECT * FROM sale_images WHERE id = ?').get(Number(req.params.id));
      if (!image) throw new HttpError(404, '图片不存在');
      if (req.user.role === 'clerk' || req.user.autoLogin) {
        if (image.store_id !== req.user.storeId) throw new HttpError(403, '无权查看该图片');
      } else if (req.user.role === 'region_admin') {
        if (!req.user.storeIds.includes(image.store_id)) throw new HttpError(403, '无权查看该图片');
      }
      const file = path.join(UPLOAD_DIR, image.stored_name);
      if (!fs.existsSync(file)) throw new HttpError(404, '图片文件已丢失');
      res.set('Cache-Control', 'private, max-age=300');
      res.type(image.mime || 'application/octet-stream');
      res.sendFile(file);
    }),
  );

  /** 删除图片（提交前；删除动作完整记录日志） */
  router.delete(
    '/images/:id',
    asyncHandler(async (req, res) => {
      const image = db.prepare('SELECT * FROM sale_images WHERE id = ?').get(Number(req.params.id));
      if (!image) throw new HttpError(404, '图片不存在');
      const isOwner = image.store_id === req.user.storeId;
      const isAdmin = req.user.role === 'admin';
      if (!isOwner && !isAdmin) throw new HttpError(403, '无权删除该图片');
      if (!isAdmin) {
        const sub = loadSubmission(image.store_id, image.biz_date, image.period);
        if (sub) throw new HttpError(409, '该时段已提交，不能删除凭证图片');
      }
      db.prepare('DELETE FROM sale_images WHERE id = ?').run(image.id);
      fs.unlink(path.join(UPLOAD_DIR, image.stored_name), () => {});
      audit.log(req, {
        action: 'image_delete',
        targetType: 'image',
        targetId: image.id,
        detail: {
          summary: `删除 ${image.biz_date} ${PERIOD_LABEL[image.period] || image.period} 的凭证图片`,
          context: {
            store_id: `#${image.store_id}`,
            file: image.original_name || image.stored_name,
            size: `${Math.round((image.size || 0) / 1024)} KB`,
          },
          note: isAdmin && !isOwner ? '由总部管理员跨门店删除' : null,
        },
      });
      res.json({ ok: true });
    }),
  );

  /** 管理员查看某门店某天的凭证图片列表 */
  router.get(
    '/images',
    asyncHandler(async (req, res) => {
      if (req.user.role === 'clerk' || req.user.autoLogin) throw new HttpError(403, '没有操作权限');
      const storeId = Number(req.query.storeId);
      if (!storeId) throw new HttpError(400, '缺少门店参数');
      if (req.user.role === 'region_admin' && !req.user.storeIds.includes(storeId)) {
        throw new HttpError(403, '无权查看该门店');
      }
      const date = String(req.query.date || todayStr());
      const rows = db
        .prepare(
          `SELECT id, period, original_name AS name, mime, size, uploaded_at AS uploadedAt
           FROM sale_images WHERE store_id = ? AND biz_date = ? ORDER BY id`,
        )
        .all(storeId, date)
        .map((r) => ({ ...r, url: `/api/sales/images/${r.id}/file` }));
      res.json({ rows });
    }),
  );

  return router;
}

module.exports = { createSalesRoutes };
