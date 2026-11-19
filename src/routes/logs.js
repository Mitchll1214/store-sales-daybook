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

  /**
   * 勾选删除日志（总部管理员）。
   *
   * 日志是审计证据，删除必须留痕：先取被删记录的摘要，删完后把这些摘要
   * 连同「谁删的、删了几条」一起写成一条新的 log_delete 记录。
   */
  router.post(
    '/delete',
    asyncHandler(async (req, res) => {
      const raw = req.body && req.body.ids;
      if (!Array.isArray(raw) || raw.length === 0) {
        return res.status(400).json({ error: '请先勾选要删除的操作记录' });
      }
      const result = audit.remove(raw);
      if (!result.deleted) return res.status(404).json({ error: '所选记录已不存在，请刷新后重试' });
      const sample = result.rows
        .slice(0, 10)
        .map((r) => `#${r.id} ${r.action} ${r.actor_username || r.actor_name || 'system'} ${r.created_at}`)
        .join('；');
      audit.log(req, {
        action: 'log_delete',
        targetType: 'audit_log',
        detail: {
          summary: `删除操作日志 ${result.deleted} 条`,
          context: {
            ids: result.rows.map((r) => r.id).join('、').slice(0, 400),
            actions: [...new Set(result.rows.map((r) => r.action))].join('、'),
          },
          note: `${sample}${result.rows.length > 10 ? `；等共 ${result.rows.length} 条` : ''}`,
        },
      });
      res.json({ ok: true, deleted: result.deleted });
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
          ? {
              summary: `校验 IP 库：${result.hasUpdate ? '发现新版本' : '已是最新'}`,
              context: {
                current: result.current.revision ? String(result.current.revision).slice(0, 10) : '未知',
                upstream: result.latest.revision ? String(result.latest.revision).slice(0, 10) : '未知',
              },
            }
          : {
              summary: '校验 IP 库失败',
              note: result.reason,
            },
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
          detail: {
            summary: '更新 IP 库成功',
            context: {
              revision: result.meta.revision ? String(result.meta.revision).slice(0, 10) : '未知',
              size: `${Math.round((result.meta.size || 0) / 1024)} KB`,
              downloadSource: (result.via && result.via.label) || '未知',
            },
          },
        });
        res.json({ ok: true, ...result, status: ipdb.status() });
      } catch (err) {
        audit.log(req, {
          action: 'ipdb_update_failed',
          targetType: 'ipdb',
          detail: {
            summary: '更新 IP 库失败',
            note: err.message,
          },
        });
        throw new HttpError(502, err.message);
      }
    }),
  );

  return router;
}

module.exports = { createLogRoutes };
