'use strict';

const express = require('express');
const { requireAuth, requireRole, visibleStoreIds } = require('../auth');
const {
  asyncHandler,
  HttpError,
  isDateStr,
  todayStr,
  addDays,
  toCsv,
  PERIODS,
  PERIOD_LABEL,
  nowStamp,
} = require('../util');
const {
  dayOverview,
  recentDays,
  storeOverview,
  detailByDate,
  detailRows,
  managerDay,
} = require('../report');

/** 报表：7 日看板、单日总览、门店完成率、按日期折叠明细、CSV 导出 */
function createReportRoutes({ db, audit }) {
  const router = express.Router();
  router.use(requireAuth, requireRole('admin', 'region_admin'));

  function parseRange(req, defaultDays = 7) {
    const to = isDateStr(String(req.query.to || '')) ? String(req.query.to) : todayStr();
    const from = isDateStr(String(req.query.from || '')) ? String(req.query.from) : addDays(to, -(defaultDays - 1));
    if (from > to) throw new HttpError(400, '开始日期不能晚于结束日期');
    return { from, to };
  }

  function filters(req) {
    return {
      storeId: req.query.storeId ? Number(req.query.storeId) : null,
    };
  }

  /** 查询范围内的门店列表，供筛选器使用 */
  router.get(
    '/options',
    asyncHandler(async (req, res) => {
      const ids = visibleStoreIds(db, req.user);
      if (ids.length === 0) return res.json({ stores: [] });
      const marks = ids.map(() => '?').join(',');
      const stores = db
        .prepare(
          `SELECT s.id, s.code, s.name
           FROM stores s
           WHERE s.id IN (${marks}) AND s.status = 'active'
           ORDER BY s.code`,
        )
        .all(...ids);
      res.json({ stores });
    }),
  );

  /** 首页 7 日看板：日期-门店编码-完成率 */
  router.get(
    '/recent',
    asyncHandler(async (req, res) => {
      const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
      const ids = visibleStoreIds(db, req.user);
      const { storeId } = filters(req);
      const scope = storeId ? ids.filter((id) => id === storeId) : ids;
      const data = recentDays(db, {
        storeIds: scope,
        days,
        endDate: isDateStr(String(req.query.end || '')) ? String(req.query.end) : undefined,
      });
      res.json(data);
    }),
  );

  /** 单日总览：总数 + 每个门店 */
  router.get(
    '/day',
    asyncHandler(async (req, res) => {
      const date = isDateStr(String(req.query.date || '')) ? String(req.query.date) : todayStr();
      const ids = visibleStoreIds(db, req.user);
      const { storeId } = filters(req);
      const scope = storeId ? ids.filter((id) => id === storeId) : ids;
      res.json({ ...dayOverview(db, { date, storeIds: scope }), canExport: true });
    }),
  );

  /** 概览柱形图：按区域管理员分组的当日商品 × 本品/竞品销售数量 */
  router.get(
    '/manager-day',
    asyncHandler(async (req, res) => {
      const date = isDateStr(String(req.query.date || '')) ? String(req.query.date) : todayStr();
      const ids = visibleStoreIds(db, req.user);
      res.json(managerDay(db, { date, storeIds: ids }));
    }),
  );

  /** 区间门店完成率（管理员报表顶部的门店卡片） */
  router.get(
    '/stores',
    asyncHandler(async (req, res) => {
      const { from, to } = parseRange(req);
      const ids = visibleStoreIds(db, req.user);
      res.json(storeOverview(db, { storeIds: ids, from, to }));
    }),
  );

  /** 明细：按日期折叠 */
  router.get(
    '/detail',
    asyncHandler(async (req, res) => {
      const { from, to } = parseRange(req, 7);
      const ids = visibleStoreIds(db, req.user);
      const { storeId } = filters(req);
      res.json(
        detailByDate(db, {
          storeIds: ids,
          from,
          to,
          storeId,
          page: Number(req.query.page) || 1,
          pageSize: Number(req.query.pageSize) || 5,
        }),
      );
    }),
  );

  /**
   * 明细单条修正（总部管理员 / 区域管理员，限所辖门店）。
   *
   * 店员提交后明细即锁定，遇到填错只能由管理员改。规则：
   * - 只改数量，且必须落在原条目上（不接受新增/删除，避免绕过填报流程）；
   * - 带 expectedQty 乐观锁：两人同时改同一条时，后提交者会收到 409 而不是静默覆盖；
   * - 前后值写进操作日志（changes），条目本身只留最后一次修正的时间与操作人；
   * - 同事务内重算该时段提交汇总，否则明细变了、总数还停在提交那一刻。
   */
  router.put(
    '/detail/entry',
    asyncHandler(async (req, res) => {
      const entryId = Number(req.body && req.body.entryId);
      if (!Number.isInteger(entryId) || entryId <= 0) {
        throw new HttpError(400, '缺少要修正的明细条目');
      }
      const qty = Number(req.body && req.body.qty);
      const MAX_QTY = 1_000_000;
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || Math.abs(qty) > MAX_QTY) {
        throw new HttpError(400, `数量需为整数，绝对值不超过 ${MAX_QTY}`);
      }

      const entry = db
        .prepare(
          `SELECT e.id, e.store_id, e.biz_date, e.period, e.product_id, e.qty,
                  s.code AS storeCode, s.name AS storeName,
                  p.name AS productName, p.alias
           FROM sale_entries e
           JOIN stores s ON s.id = e.store_id
           JOIN products p ON p.id = e.product_id
           WHERE e.id = ?`,
        )
        .get(entryId);
      if (!entry) throw new HttpError(404, '该条明细不存在，可能已被删除，请刷新后重试');

      // 权限：区域管理员只能改自己所辖门店的条目
      const ids = visibleStoreIds(db, req.user);
      if (!ids.includes(entry.store_id)) throw new HttpError(403, '无权修正该门店的数据');

      if (entry.qty === qty) {
        return res.json({ ok: true, unchanged: true, qty });
      }
      // 乐观锁：客户端带着「我看到的值」来改，值已经变了就说明有人先改过
      const expected = req.body && req.body.expectedQty;
      if (expected != null && Number(expected) !== entry.qty) {
        throw new HttpError(409, `该条目已被他人改为 ${entry.qty}，请刷新后重新修正`, 'STALE');
      }

      const stamp = nowStamp();
      const operator = req.user.name || req.user.username || '管理员';

      db.transaction(() => {
        db.prepare(
          `UPDATE sale_entries
              SET qty = ?, updated_by = ?, updated_at = ?, corrected_at = ?, corrected_by_name = ?
            WHERE id = ?`,
        ).run(qty, req.user.id ?? null, stamp, stamp, operator, entryId);

        // 提交汇总里存的是提交那一刻的合计，修正后必须跟着重算；
        // 否则报表按 submission 取的合计会与明细对不上。
        const agg = db
          .prepare(
            `SELECT count(*) AS itemCount, COALESCE(sum(e.qty), 0) AS totalQty
             FROM sale_entries e
             JOIN products p ON p.id = e.product_id
             WHERE e.store_id = ? AND e.biz_date = ? AND e.period = ? AND p.status = 'active'`,
          )
          .get(entry.store_id, entry.biz_date, entry.period);
        db.prepare(
          `UPDATE sale_submissions SET item_count = ?, total_qty = ?
            WHERE store_id = ? AND biz_date = ? AND period = ?`,
        ).run(agg.itemCount, agg.totalQty, entry.store_id, entry.biz_date, entry.period);
      })();

      audit.log(req, {
        action: 'sales_correct',
        targetType: 'sale_entry',
        targetId: entryId,
        detail: {
          summary: `修正 ${entry.biz_date} ${PERIOD_LABEL[entry.period]}销售明细`,
          changes: [{ field: 'qty', from: entry.qty, to: qty }],
          context: {
            storeId: `${entry.storeCode} ${entry.storeName}`,
            product: entry.alias && entry.alias !== entry.productName
              ? `${entry.productName}（${entry.alias}）`
              : entry.productName,
            period: PERIOD_LABEL[entry.period] || entry.period,
            biz_date: entry.biz_date,
          },
        },
      });

      res.json({
        ok: true,
        entryId,
        qty,
        qtyBefore: entry.qty,
        correctedAt: stamp,
        correctedBy: operator,
      });
    }),
  );

  /** 导出：CSV（Excel 直接打开），文件名带日期区间与筛选条件 */
  router.get(
    '/export',
    asyncHandler(async (req, res) => {
      const { from, to } = parseRange(req, 7);
      const ids = visibleStoreIds(db, req.user);
      const { storeId } = filters(req);
      const period = req.query.period && PERIOD_LABEL[req.query.period] ? req.query.period : null;
      const rows = detailRows(db, { storeIds: ids, from, to, storeId, period });
      if (rows.length === 0) {
        return res.status(404).json({ error: '所选范围内没有销售明细可导出' });
      }
      const header = ['日期', '时段', '门店编码', '门店名称', '品名', '别名', '条码', '数量', '提交时间', '提交人'];
      const body = rows.map((r) => [
        r.date,
        r.periodLabel,
        r.storeCode,
        r.storeName,
        r.productName,
        r.alias,
        r.barcode,
        r.qty,
        r.submittedAt,
        r.submitter,
      ]);
      const totalQty = rows.reduce((s, r) => s + r.qty, 0);
      body.push([], ['合计', '', '', '', '', '', '', totalQty, '', '']);
      const csv = toCsv([header, ...body]);
      const filename = `销售明细_${from}_${to}${period ? `_${PERIOD_LABEL[period]}` : ''}.csv`;

      audit.log(req, {
        action: 'report_export',
        targetType: 'report',
        detail: {
          summary: `导出销售明细 ${from} ~ ${to}${period ? `（${PERIOD_LABEL[period]}）` : ''}`,
          context: { rows: rows.length, period: period || '全部时段' },
        },
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="sales_${from}_${to}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(csv);
    }),
  );

  return router;
}

module.exports = { createReportRoutes };
