'use strict';

/**
 * SQLite 访问薄封装，基于 Node 内置 `node:sqlite`（无原生编译依赖，Docker 构建稳定）。
 * 对外提供与 better-sqlite3 相近的接口：exec / prepare().run/get/all / transaction / pragma。
 */

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  const hint =
    process.versions.node.split('.').map(Number)[0] < 24
      ? '请使用 `node --experimental-sqlite server.js` 启动（Node 22.x 需要该参数），或升级到 Node 24+。'
      : '当前 Node 版本不包含 node:sqlite，请升级 Node.js。';
  throw new Error(`无法加载内置 SQLite 模块：${err.message}\n${hint}`);
}

/** node:sqlite 只接受 null/number/string/bigint/Buffer，统一转换 boolean 与 undefined */
function normalizeParams(params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Buffer.isBuffer(params[0]) && !Array.isArray(params[0])) {
    // 支持命名参数对象
    const out = {};
    for (const [k, v] of Object.entries(params[0])) {
      if (v === undefined) out[k] = null;
      else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
      else out[k] = v;
    }
    return [out];
  }
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

class Database {
  /**
   * @param {string} file 数据库文件路径
   * @param {{readOnly?: boolean}} [options] readOnly 用于「只读自检」：
   *   自检必须不参与写盘，否则半写状态的库可能被自检过程改坏。
   */
  constructor(file, options = {}) {
    this.file = file;
    this.readOnly = Boolean(options.readOnly);
    this.raw = this.readOnly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
    if (this.readOnly) {
      // readOnly 选项并非所有版本都生效（实测 Node 22.9 上仍允许写入），
      // 而自检绝不能改坏半写状态的库。query_only 是 SQLite 自身的闸门，
      // 作为兜底把写入彻底挡死；不受支持时忽略，不影响只读查询。
      try {
        this.raw.exec('PRAGMA query_only = ON');
      } catch {
        /* 版本不支持该 PRAGMA 时退化为仅依赖 readOnly */
      }
    }
    this.sqlCache = new Map();
    this.txDepth = 0;
  }

  exec(sql) {
    this.raw.exec(sql);
    return this;
  }

  prepare(sql) {
    let stmt = this.sqlCache.get(sql);
    if (!stmt) {
      const prepared = this.raw.prepare(sql);
      stmt = {
        run: (...params) => prepared.run(...normalizeParams(params)),
        get: (...params) => prepared.get(...normalizeParams(params)) ?? null,
        all: (...params) => prepared.all(...normalizeParams(params)),
        iterate: (...params) => prepared.iterate(...normalizeParams(params)),
      };
      this.sqlCache.set(sql, stmt);
    }
    return stmt;
  }

  /** 读取 pragma 值，simple=true 时只取第一列 */
  pragma(statement, options = {}) {
    const row = this.prepare(`PRAGMA ${statement}`).get();
    if (!row) return null;
    if (options.simple) return Object.values(row)[0];
    return row;
  }

  /**
   * 事务包装：自动 BEGIN/COMMIT/ROLLBACK，嵌套时使用 SAVEPOINT。
   * 使用方式：db.transaction(fn)(arg1, arg2)
   */
  transaction(fn) {
    return (...args) => {
      const depth = this.txDepth;
      const savepoint = `sp_${depth}`;
      if (depth === 0) this.raw.exec('BEGIN');
      else this.raw.exec(`SAVEPOINT ${savepoint}`);
      this.txDepth += 1;
      try {
        const result = fn(...args);
        this.txDepth -= 1;
        if (depth === 0) this.raw.exec('COMMIT');
        else this.raw.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        this.txDepth = depth;
        try {
          if (depth === 0) this.raw.exec('ROLLBACK');
          else this.raw.exec(`ROLLBACK TO ${savepoint}`);
        } catch {
          /* 忽略回滚异常，抛出原始错误 */
        }
        throw err;
      }
    };
  }

  /**
   * 把 WAL 日志合并进主库。
   *
   * 进程被 docker stop / 强杀时，WAL 里可能还留着尚未落盘的事务；
   * 正常关闭前主动 checkpoint 一次，能把「重启后自检判损坏」的概率压到最低。
   * 失败不抛：checkpoint 只是收尾优化，绝不能拦住关闭流程。
   */
  checkpoint(mode = 'TRUNCATE') {
    if (!this.raw) return false;
    try {
      this.raw.exec(`PRAGMA wal_checkpoint(${mode})`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 关闭当前连接并按同一文件路径重新打开。
   *
   * 恢复备份时必须在「文件替换」前后各断开一次：Windows 下库文件被连接占用时
   * 无法替换。保持 Database 对象引用不变，路由 / audit / auth 持有的引用继续有效。
   * 新连接打不开时会抛出原始错误，由调用方回滚文件后再调一次。
   */
  reopen() {
    const previous = this.raw;
    this.sqlCache.clear();
    this.txDepth = 0;
    this.raw = null;
    // 必须真正关闭再打开：先关后开看似危险，但文件替换只能在这段空窗里做，
    // 而调用方已提前生成安全副本，可以直接回滚。
    if (previous) {
      try {
        previous.close();
      } catch {
        /* 旧连接可能已失效，关闭异常不影响后续打开 */
      }
    }
    this.raw = new DatabaseSync(this.file);
    return this;
  }

  close() {
    this.sqlCache.clear();
    const raw = this.raw;
    this.raw = null;
    if (!raw) return;
    raw.close();
  }
}

module.exports = { Database };
