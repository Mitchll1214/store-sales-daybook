'use strict';

const express = require('express');
const { requireAuth, requireRole, visibleStoreIds } = require('../auth');
const { asyncHandler, HttpError, isDateStr, todayStr, addDays, toCsv, PERIOD_LABEL } = require('../util');
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
      const header = ['日期', '时段', '门店编码', '门店名称', '品名', '别名', '条码', '数量', '金额', '提交时间', '提交人'];
      const body = rows.map((r) => [
        r.date,
        r.periodLabel,
        r.storeCode,
        r.storeName,
        r.productName,
        r.alias,
        r.barcode,
        r.qty,
        r.amount,
        r.submittedAt,
        r.submitter,
      ]);
      const totalQty = rows.reduce((s, r) => s + r.qty, 0);
      const totalAmount = Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
      body.push([], ['合计', '', '', '', '', '', '', totalQty, totalAmount, '', '']);
      const csv = toCsv([header, ...body]);
      const filename = `销售明细_${from}_${to}${period ? `_${PERIOD_LABEL[period]}` : ''}.csv`;

      audit.log(req, {
        action: 'report_export',
        targetType: 'report',
        detail: `导出销售明细 ${from} ~ ${to}${period ? `（${PERIOD_LABEL[period]}）` : ''}，共 ${rows.length} 行，金额合计 ${totalAmount}`,
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
