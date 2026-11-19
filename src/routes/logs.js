'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const { asyncHandler, isDateStr, todayStr, addDays, HttpError } = require('../util');

/** 操作日志（仅总部管理员）：分页查询、动作字典、IP 库状态与更新 */
function createLogRoutes({ db, audit, ipdb }) {
  const router = express.Router();
  router.use(requireAuth, requireRole('admin'));

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const to = isDateStr(String(req.query.to || '')) ? String(req.query.to) : todayStr();
      const from = isDateStr(String(req.query.from || '')) ? String(req.query.from) : addDays(to, -6);
      const data = audit.query({
        q: String(req.query.q || '').trim(),
        action: String(req.query.action || '').trim(),
        ipLocation: String(req.query.ipLocation || '').trim(),
        from,
        to,
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 30,
      });
      res.json({ ...data, from, to, actions: audit.actions() });
    }),
  );

  router.get(
    '/ipdb',
    asyncHandler(async (req, res) => {
      res.json(ipdb.status());
    }),
  );

  /** 校验上游是否需要更新（只读） */
  router.post(
    '/ipdb/check',
    asyncHandler(async (req, res) => {
      const result = await ipdb.checkUpdate();
      audit.log(req, {
        action: 'ipdb_check',
        targetType: 'ipdb',
        detail: result.reachable
          ? `校验 IP 库：${result.hasUpdate ? '发现新版本' : '已是最新'}（当前 ${result.current.revision || '未知'}，上游 ${
              result.latest.revision || '未知'
            }）`
          : `校验 IP 库失败：${result.reason}`,
      });
      res.json(result);
    }),
  );

  /** 下载并热更新 IP 库 */
  router.post(
    '/ipdb/update',
    asyncHandler(async (req, res) => {
      try {
        const result = await ipdb.update();
        audit.log(req, {
          action: 'ipdb_update',
          targetType: 'ipdb',
          detail: `更新 IP 库成功：版本 ${result.meta.revision || '未知'}，${result.meta.size} 字节`,
        });
        res.json({ ok: true, ...result, status: ipdb.status() });
      } catch (err) {
        audit.log(req, {
          action: 'ipdb_update_failed',
          targetType: 'ipdb',
          detail: `更新 IP 库失败：${err.message}`,
        });
        throw new HttpError(502, err.message);
      }
    }),
  );

  return router;
}

module.exports = { createLogRoutes };
