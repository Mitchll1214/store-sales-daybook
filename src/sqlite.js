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
  constructor(file) {
    this.raw = new DatabaseSync(file);
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

  close() {
    this.sqlCache.clear();
    this.raw.close();
  }
}

module.exports = { Database };
