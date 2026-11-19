'use strict';

const { clientIp, isPrivateIp, deviceLabel, networkType } = require('./net');
const { nowStamp } = require('./util');

/** 字段名 → 中文标签。日志详情里展示成「中文名：旧 → 新」，避免直接抛数据库列名。 */
const FIELD_LABEL = {
  username: '账号',
  display_name: '姓名',
  name: '名称',
  alias: '别名',
  barcode: '条码',
  category: '品类',
  kind: '属性',
  status: '状态',
  phone: '手机号',
  role: '角色',
  password: '密码',
  store_id: '绑定门店',
  storeIds: '管辖门店',
  linkedProductIds: '关联商品',
  code: '门店编码',
  remark: '备注',
  auto_login_enabled: '免登录链接',
  auto_login_token: '免登录令牌',
  qty: '数量',
  amount: '金额',
  period: '时段',
  biz_date: '业务日期',
  item_count: '商品数',
  total_qty: '总量',
  total_amount: '总金额',
  submitter: '提交人',
  rows: '导出行数',
  file: '文件名',
  size: '文件大小',
  mime: '文件类型',
  product_ids: '商品 ID',
  current: '当前版本',
  upstream: '上游版本',
  revision: '版本',
  downloadSource: '下载源',
  auto_login_enabled: '免登录链接',
};

const VALUES_LABEL = {
  ACTIVE: '启用',
  DISABLED: '禁用',
  OWN: '本品',
  COMP: '竞品',
  TRUE: '开启',
  FALSE: '关闭',
  ADMIN: '总部管理员',
  REGION_ADMIN: '区域管理员',
  CLERK: '店员',
};

/** 一次最多删除多少条日志：与分页上限一致，避免一次请求拼出超长 SQL */
const MAX_DELETE = 200;

/** 把内部值渲染成可读文本：空值、布尔、null 都要能看懂 */
function showValue(v) {
  if (v === null || v === undefined || v === '') return '空';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) return v.length ? v.join('、') : '空';
  if (typeof v === 'object') return JSON.stringify(v);
  const key = String(v).toUpperCase();
  if (VALUES_LABEL[key]) return VALUES_LABEL[key];
  return String(v);
}

function fieldLabel(key) {
  return FIELD_LABEL[key] || key;
}

/**
 * 把结构化详情展开成多行文本入库。
 *
 * 为什么存文本而不是 JSON：日志是只读证据，多行文本对人更直接，
 * 旧数据（纯字符串）也无需迁移即可继续展示。
 * 前端按换行 + 折叠渲染，因此这里负责把「变更前后」排列清楚。
 */
function buildDetail(detail) {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail;
  const lines = [];
  if (detail.summary) lines.push(String(detail.summary));
  const changes = Array.isArray(detail.changes) ? detail.changes : [];
  const effective = changes.filter((c) => c && showValue(c.from) !== showValue(c.to));
  if (effective.length) {
    lines.push(`变更明细（${effective.length} 项）：`);
    for (const c of effective) {
      lines.push(`· ${fieldLabel(c.field)}：${showValue(c.from)} → ${showValue(c.to)}`);
    }
  }
  if (detail.context && typeof detail.context === 'object') {
    const entries = Object.entries(detail.context).filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (entries.length) {
      lines.push('附注：');
      for (const [k, v] of entries) lines.push(`· ${fieldLabel(k)}：${showValue(v)}`);
    }
  }
  if (detail.note) lines.push(String(detail.note));
  return lines.length ? lines.join('\n') : null;
}

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
   *   detail 可以是字符串，也可以是 { summary, changes:[{field,from,to}], context:{}, note }
   */
  log(req, info) {
    const action = info.action;
    if (!action) throw new Error('审计日志缺少 action');
    const actor = info.actor || (req && req.user) || null;
    const ip = req ? clientIp(req) : null;

    this.db
      .prepare(
        `INSERT INTO audit_logs
         (user_id, actor_name, actor_username, actor_store_code, actor_store_name, actor_role,
          action, target_type, target_id, detail, ip, ip_location, device_id, ua, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actor ? actor.id ?? null : null,
        actor ? actor.name || actor.display_name || actor.username || 'system' : 'system',
        actor ? actor.username || null : null,
        // 门店操作（免登录或绑定门店的店员）落库门店编码与名称：
        // 店员账号可能叫「店员1」，只看姓名根本无法定位是哪家店做的操作。
        (actor && actor.storeCode) || null,
        (actor && actor.storeName) || null,
        actor ? actor.role ?? null : 'system',
        action,
        info.targetType ?? null,
        info.targetId == null ? null : String(info.targetId),
        buildDetail(info.detail),
        ip || null,
        this.locate(ip),
        (req && req.deviceId) || info.deviceId || null,
        req ? String((req.headers && req.headers['user-agent']) || '').slice(0, 400) || null : null,
        nowStamp(),
      );
  }

  /**
   * 分页查询。单个关键字在「操作人账号 / 姓名 / 详情 / IP / 归属地 / 设备指纹」里模糊匹配，
   * 这样页面上只留一个搜索框就够用。
   */
  query({ q, action, from, to, page = 1, pageSize = 30 }) {    const where = [];
    const params = [];
    if (q) {
      where.push(
        `(actor_name LIKE ?
          OR actor_username LIKE ?
          OR actor_store_code LIKE ?
          OR actor_store_name LIKE ?
          OR detail LIKE ?
          OR ip LIKE ?
          OR ip_location LIKE ?
          OR device_id LIKE ?
          OR target_id LIKE ?
          OR ua LIKE ?)`,
      );
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like, like, like, like, like);
    }
    if (action) {
      where.push('action = ?');
      params.push(action);
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
        `SELECT id, user_id, actor_name, actor_username, actor_store_code, actor_store_name, actor_role,
                action, target_type, target_id, detail,
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

  /**
   * 批量删除日志（总部管理员勾选删除）。
   *
   * 删除本身会再写一条审计，因此「谁在什么时候清掉了哪批日志」始终留痕；
   * 被删记录的动作 / 操作人 / 时间会摘进这条审计的备注里，
   * 否则删完就只剩「删了 N 条」这一句，等于自己也断了线索。
   */
  remove(ids) {
    const list = [
      ...new Set(
        (Array.isArray(ids) ? ids : [])
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ].slice(0, MAX_DELETE);
    if (!list.length) return { deleted: 0, rows: [] };
    const marks = list.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, action, actor_name, actor_username, created_at FROM audit_logs WHERE id IN (${marks})`)
      .all(...list);
    if (!rows.length) return { deleted: 0, rows: [] };
    const info = this.db
      .prepare(`DELETE FROM audit_logs WHERE id IN (${rows.map(() => '?').join(',')})`)
      .run(...rows.map((r) => r.id));
    return { deleted: info.changes || 0, rows };
  }
}

module.exports = { Audit, buildDetail, FIELD_LABEL };
