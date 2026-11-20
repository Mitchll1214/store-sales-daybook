'use strict';

const path = require('path');
const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const { asyncHandler, HttpError } = require('../util');
const backup = require('../backup');

/**
 * 数据备份与恢复（仅总部管理员）。
 *
 * 只做四件事：列出备份、手动生成一份、下载到本机、从某份备份恢复。
 * 恢复是唯一会改动当前库的接口，因此额外加了互斥锁与审计留痕。
 */
function createBackupRoutes({ db, audit }) {
  const router = express.Router();
  router.use(requireAuth, requireRole('admin'));

  // 恢复进行中时禁止再次进入：连点两次恢复会让第二个请求在库已换掉的情况下继续操作。
  let restoring = false;

  function dbPath() {
    return db.dbPath;
  }

  /** 当前库的基本信息：让用户知道「现在用的是哪个文件、多大」 */
  function currentInfo() {
    const file = dbPath();
    const info = backup.inspect(file);
    return {
      path: file,
      dir: path.dirname(file),
      backupDir: backup.BACKUP_DIR,
      sizeLabel: backup.formatSize(info.size),
      ok: info.ok,
      error: info.error,
      version: info.version,
      tables: info.tables,
      counts: info.counts,
      restoring,
    };
  }

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({
        current: currentInfo(),
        backups: backup.listBackups(),
      });
    }),
  );

  /** 手动备份：点一下就把当前数据完整存一份快照 */
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      if (restoring) throw new HttpError(409, '正在恢复备份，请稍候再试');
      const item = backup.createBackup(db);
      audit.log(req, {
        action: 'db_backup',
        targetType: 'database',
        targetId: item.name,
        detail: {
          summary: `手动备份数据库 ${item.name}`,
          context: {
            备份文件: item.name,
            文件大小: item.sizeLabel,
            门店数: item.counts.stores,
            账号数: item.counts.users,
            销售记录: item.counts.entries,
          },
        },
      });
      res.status(201).json({ backup: item });
    }),
  );

  router.get(
    '/:name/download',
    asyncHandler(async (req, res) => {
      const file = backup.resolveBackupFile(req.params.name);
      audit.log(req, {
        action: 'db_backup_download',
        targetType: 'database',
        targetId: path.basename(file),
        detail: { summary: `下载数据库备份 ${path.basename(file)}` },
      });
      res.download(file, path.basename(file));
    }),
  );

  /** 详情：恢复前先看这份备份里到底有多少数据，避免恢复到空库还以为成功 */
  router.get(
    '/:name',
    asyncHandler(async (req, res) => {
      const file = backup.resolveBackupFile(req.params.name);
      res.json({ backup: backup.describe(file) });
    }),
  );

  router.delete(
    '/:name',
    asyncHandler(async (req, res) => {
      if (restoring) throw new HttpError(409, '正在恢复备份，请稍候再试');
      const name = backup.deleteBackup(req.params.name);
      audit.log(req, {
        action: 'db_backup_delete',
        targetType: 'database',
        targetId: name,
        detail: { summary: `删除数据库备份 ${name}` },
      });
      res.json({ ok: true, name });
    }),
  );

  /**
   * 从备份恢复。
   *
   * 必须带 confirmText=恢复 才执行：这个动作会覆盖全部当前数据，
   * 单靠一次点击太容易误触。
   */
  router.post(
    '/:name/restore',
    asyncHandler(async (req, res) => {
      if (restoring) throw new HttpError(409, '已有恢复任务在执行，请稍候');
      const confirmText = String((req.body && req.body.confirmText) || '').trim();
      if (confirmText !== '恢复') {
        throw new HttpError(400, '请输入「恢复」两个字以确认操作');
      }
      const file = backup.resolveBackupFile(req.params.name);
      const info = backup.inspect(file);
      if (!info.ok) throw new HttpError(400, `该备份不可用：${info.error}`);

      restoring = true;
      try {
        const result = backup.restoreBackup(db, dbPath(), file);
        // 恢复后库内容整体换掉，这条日志落在新库里，作为「这次恢复发生过」的凭据
        audit.log(req, {
          action: 'db_restore',
          targetType: 'database',
          targetId: path.basename(file),
          detail: {
            summary: `从备份 ${path.basename(file)} 恢复数据库`,
            context: {
              备份文件: path.basename(file),
              恢复后门店数: result.info.counts.stores,
              恢复后账号数: result.info.counts.users,
              恢复后销售记录: result.info.counts.entries,
              恢复前安全副本: result.safety.name,
            },
          },
        });
        res.json({
          ok: true,
          restored: path.basename(file),
          counts: result.info.counts,
          safety: result.safety,
          // 备份里的 accounts 与 sessions 也一起回来了，当前登录在恢复后可能失效
          relogin: true,
        });
      } finally {
        restoring = false;
      }
    }),
  );

  return router;
}

module.exports = { createBackupRoutes };
