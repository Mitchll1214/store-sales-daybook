'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const { asyncHandler, isDateStr, todayStr, addDays } = require('../util');

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

  /**
   * 后台更新任务的轮询入口。
   * 任务状态存在 ipdb 实例上，因此用户切到别的页面再回来、甚至刷新浏览器，
   * 都还能接上同一次下载，不会因为离开页面就把进度丢了。
   */
  router.get(
    '/ipdb/job',
    asyncHandler(async (req, res) => {
      res.json({ job: ipdb.jobSnapshot(), status: ipdb.status() });
    }),
  );

  /** 校验上游是否需要更新（只读，不下载） */
  router.post(
    '/ipdb/check',
    asyncHandler(async (req, res) => {
      const result = await ipdb.checkUpdate();
      // 只读校验不写审计：它已并进「校验更新」按钮，每次点击都留痕只会把日志刷满。
      // 真正需要追溯的「下没下成」由 ipdb_update / ipdb_update_failed 记录。
      res.json(result);
    }),
  );

  /**
   * 启动后台更新。
   *
   * 立即返回 202 与任务快照，不在这里 await 下载完成：11 MB 的多源回退可能跑几分钟，
   * 挂在请求上会让用户必须守着页面，切换页面或网络抖动都会让前端以为失败。
   * 任务结束后（无论成败）写一条审计，用户可在操作日志里查证结果。
   */
  router.post(
    '/ipdb/update',
    asyncHandler(async (req, res) => {
      // 审计需要「谁发起的」，但任务完成时请求对象早已结束，这里先把它摘下来
      const actorReq = {
        user: req.user,
        deviceId: req.deviceId,
        headers: {
          'x-real-ip': req.headers['x-real-ip'],
          'x-forwarded-for': req.headers['x-forwarded-for'],
          'user-agent': req.headers['user-agent'],
        },
        socket: req.socket ? { remoteAddress: req.socket.remoteAddress } : {},
      };

      const { started, job } = ipdb.startUpdate();
      if (!started) {
        // 已有任务在跑：直接回当前进度，前端继续轮询即可
        return res.status(202).json({ ok: true, started: false, job, status: ipdb.status() });
      }

      // 任务结束时补写审计（成功与失败都要留痕，否则「更新过没有」无从查证）
      ipdb
        .waitForUpdate()
        .then((finished) => {
          if (finished.result) {
            const meta = finished.result.meta || {};
            audit.log(actorReq, {
              action: 'ipdb_update',
              targetType: 'ipdb',
              detail: {
                summary: '更新 IP 库成功',
                context: {
                  revision: meta.revision ? String(meta.revision).slice(0, 10) : '未知',
                  size: `${Math.round((meta.size || 0) / 1024)} KB`,
                  downloadSource: (finished.result.via && finished.result.via.label) || '未知',
                  elapsed: `${Math.round((finished.elapsedMs || 0) / 1000)} 秒`,
                },
              },
            });
          } else {
            audit.log(actorReq, {
              action: 'ipdb_update_failed',
              targetType: 'ipdb',
              detail: {
                summary: '更新 IP 库失败',
                note: finished.error || '未知错误',
              },
            });
          }
        })
        .catch((err) => {
          console.warn('[ipdb] 写入更新审计失败：', err.message);
        });

      res.status(202).json({ ok: true, started: true, job, status: ipdb.status() });
    }),
  );

  return router;
}

module.exports = { createLogRoutes };
