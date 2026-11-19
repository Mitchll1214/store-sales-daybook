'use strict';

const { clientIp, isPrivateIp, deviceLabel, networkType } = require('./net');
const { nowStamp } = require('./util');

/**
 * 操作日志。所有写操作都经由这里落库，包含 IP、归属地、设备指纹与 UA。
 * ipdb 由 server 启动时注入（依赖注入避免循环引用）。
 */
class Audit {
  constructor(db, ipdb) {
    this.db = db;
    this.ipdb = ipdb;
  }

  locate(ip) {
    if (!this.ipdb || !ip) return null;
    if (isPrivateIp(ip)) return '内网地址';
    return this.ipdb.lookup(ip);
  }

  /**
   * @param {object} req  请求对象（可空，用于系统动作）
   * @param {object} info { action, targetType, targetId, detail, actor }
   */
  log(req, info) {
    const action = info.action;
    if (!action) throw new Error('审计日志缺少 action');
    const actor = info.actor || (req && req.user) || null;
    const ip = req ? clientIp(req) : null;
    const detail = info.detail;
    const detailText =
      detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);

    this.db
      .prepare(
        `INSERT INTO audit_logs
         (user_id, actor_name, actor_role, action, target_type, target_id, detail, ip, ip_location, device_id, ua, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actor ? actor.id ?? null : null,
        actor ? actor.name || actor.display_name || actor.username || 'system' : 'system',
        actor ? actor.role ?? null : 'system',
        action,
        info.targetType ?? null,
        info.targetId == null ? null : String(info.targetId),
        detailText,
        ip || null,
        this.locate(ip),
        (req && req.deviceId) || info.deviceId || null,
        req ? String((req.headers && req.headers['user-agent']) || '').slice(0, 400) || null : null,
        nowStamp(),
      );
  }

  /** 分页查询，支持关键字、动作、日期范围 */
  query({ q, action, from, to, page = 1, pageSize = 30, ipLocation }) {
    const where = [];
    const params = [];
    if (q) {
      where.push('(actor_name LIKE ? OR detail LIKE ? OR ip LIKE ? OR ip_location LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (action) {
      where.push('action = ?');
      params.push(action);
    }
    if (ipLocation) {
      where.push('ip_location LIKE ?');
      params.push(`%${ipLocation}%`);
    }
    if (from) {
      where.push('created_at >= ?');
      params.push(`${from} 00:00:00`);
    }
    if (to) {
      where.push('created_at <= ?');
      params.push(`${to} 23:59:59`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = Math.min(Math.max(Number(pageSize) || 30, 1), 200);
    const current = Math.max(Number(page) || 1, 1);
    const total = this.db.prepare(`SELECT count(*) AS c FROM audit_logs ${clause}`).get(...params).c;
    const rows = this.db
      .prepare(
        `SELECT id, user_id, actor_name, actor_role, action, target_type, target_id, detail,
                ip, ip_location, device_id, ua, created_at
         FROM audit_logs ${clause}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, size, (current - 1) * size);
    return {
      rows: rows.map((r) => ({
        ...r,
        device: deviceLabel(r.ua),
        network: networkType(r.ua),
      })),
      total,
      page: current,
      pageSize: size,
      pages: Math.max(Math.ceil(total / size), 1),
    };
  }

  actions() {
    return this.db
      .prepare('SELECT action, count(*) AS c FROM audit_logs GROUP BY action ORDER BY c DESC')
      .all();
  }
}

module.exports = { Audit };
