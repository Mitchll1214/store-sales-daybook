'use strict';

/**
 * 数据库备份与恢复。
 *
 * 设计要点：
 *  1. 备份用 `VACUUM INTO` 生成**一致性快照**，不是直接拷 app.db。
 *     库正跑在 WAL 模式下时，主库文件可能落后于 WAL，直接拷贝会得到一份
 *     「看起来正常、实际缺最新数据」的库；VACUUM INTO 由 SQLite 自己保证一致。
 *  2. 恢复前一律先给当前库留一份 pre-restore 快照，失败自动回滚，
 *     避免「点了恢复、结果两份数据都没了」。
 *  3. 恢复是热操作：替换文件后用同一 Database 对象重开连接并跑迁移，
 *     路由 / 审计 / 会话持有的引用无需重新注入。
 */

const fs = require('fs');
const path = require('path');
const { Database } = require('./sqlite');
const { DATA_DIR, nowStamp } = require('./util');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/**
 * 备份文件名前缀 → 类型。四类备份的生命周期不同：
 *  - app-        手动备份：用户主动点的，永不自动清理
 *  - auto-       定时自动备份：按份数滚动保留
 *  - pre-restore- 恢复前快照：由恢复流程生成，按份数保留
 *  - pre-upgrade- 升级前快照：结构升级前自动生成，防止升级改坏后无处可退
 */
const PREFIXES = ['app', 'auto', 'pre-restore', 'pre-upgrade'];

/**
 * 只接受本模块自己生成的文件名，挡掉 ../ 之类的路径穿越。
 *
 * 末尾的 `(-\d+)?` 必须保留：同一秒内连续备份时 uniquePath 会追加 `-2`、`-3` 等序号，
 * 不认这种名字会让那些备份「隐身」——列表看不到、下载/删除/恢复都被判非法，
 * 却照样占磁盘，长期累积可能把数据卷写满。
 */
const NAME_RE = new RegExp(
  `^(${PREFIXES.join('|')})-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}(-\\d+)?\\.db$`,
);

/** 由文件名推断类型；manual 是 app- 前缀（用户手动备份） */
function kindOf(name) {
  if (name.startsWith('pre-restore-')) return 'pre-restore';
  if (name.startsWith('pre-upgrade-')) return 'pre-upgrade';
  if (name.startsWith('auto-')) return 'auto';
  return 'manual';
}

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  return BACKUP_DIR;
}

function stampName(prefix) {
  return `${prefix}-${nowStamp().replace(/[: ]/g, '-')}.db`;
}

/** 同一秒内连续点击备份会撞名，加序号保证不覆盖 */
function uniquePath(name) {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  let candidate = path.join(BACKUP_DIR, name);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(BACKUP_DIR, `${base}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

function sqlString(value) {
  // VACUUM INTO 的目标是字面量路径，只能手工把单引号转义成两个单引号
  return `'${String(value).replace(/'/g, "''")}'`;
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 检查一个库文件是否可用，并读出关键表的行数。
 *
 * 恢复前的这一步很关键：让用户看到「这份备份里有多少门店 / 多少条销售记录」，
 * 否则很容易恢复到一份空库还以为成功了。
 */
function inspect(file) {
  const result = {
    ok: false,
    error: null,
    version: null,
    tables: 0,
    counts: { stores: 0, users: 0, entries: 0, submissions: 0 },
    size: 0,
  };
  if (!fs.existsSync(file)) {
    result.error = '文件不存在';
    return result;
  }
  result.size = fs.statSync(file).size;
  if (result.size === 0) {
    result.error = '文件为空（0 字节）';
    return result;
  }

  let db;
  try {
    db = new Database(file, { readOnly: true });
  } catch (err) {
    result.error = `无法打开：${err.message}`;
    return result;
  }
  try {
    const check = db
      .prepare('PRAGMA quick_check')
      .all()
      .map((r) => Object.values(r)[0])
      .filter((v) => String(v).toLowerCase() !== 'ok');
    if (check.length) {
      result.error = `完整性校验未通过：${check.join('；')}`;
      return result;
    }
    result.version = db.pragma('user_version', { simple: true });
    result.tables = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get().c;
    const countOf = (sql) => {
      try {
        return db.prepare(sql).get().c;
      } catch {
        // 老版本备份可能没有这张表，按 0 计，不影响恢复
        return 0;
      }
    };
    result.counts = {
      stores: countOf('SELECT count(*) AS c FROM stores'),
      users: countOf('SELECT count(*) AS c FROM users'),
      entries: countOf('SELECT count(*) AS c FROM sale_entries'),
      submissions: countOf('SELECT count(*) AS c FROM sale_submissions'),
    };
    result.ok = true;
    return result;
  } catch (err) {
    result.error = `读取失败：${err.message}`;
    return result;
  } finally {
    try {
      db.close();
    } catch {
      /* 只读探测连接关闭异常可忽略 */
    }
  }
}

/** 生成一份快照，返回备份的描述信息 */
function createBackup(db, prefix = 'app') {
  ensureDir();
  const target = uniquePath(stampName(prefix));
  db.exec(`VACUUM INTO ${sqlString(target)}`);
  const info = inspect(target);
  if (!info.ok) {
    // 刚生成的快照立即不可用，说明磁盘或内存出了问题，删掉不要留垃圾文件
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* 删不掉也不影响报错 */
    }
    throw new Error(`备份生成后校验失败：${info.error}`);
  }
  return describe(target, info);
}

function describe(file, info) {
  const name = path.basename(file);
  const stat = fs.statSync(file);
  const inspected = info || inspect(file);
  return {
    name,
    size: stat.size,
    sizeLabel: formatSize(stat.size),
    createdAt: nowStamp(),
    mtime: stat.mtime.toISOString(),
    kind: kindOf(name),
    ok: inspected.ok,
    error: inspected.error,
    counts: inspected.counts,
  };
}

/** 列出全部备份（新的在前） */
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const items = [];
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!NAME_RE.test(name)) continue;
    const file = path.join(BACKUP_DIR, name);
    let stat;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const mtime = stat.mtime;
    items.push({
      name,
      size: stat.size,
      sizeLabel: formatSize(stat.size),
      mtime: mtime.toISOString(),
      // 列表里不逐个跑 quick_check（备份多时太慢），只展示文件信息，
      // 详情与校验结果在「查看详情 / 恢复」时再算。
      kind: kindOf(name),
    });
  }
  return items.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/** 把用户传来的文件名解析成确定路径，非法名直接抛错 */
function resolveBackupFile(name) {
  const base = path.basename(String(name || ''));
  if (!NAME_RE.test(base)) throw Object.assign(new Error('备份文件名不合法'), { status: 400 });
  const file = path.join(BACKUP_DIR, base);
  if (!fs.existsSync(file)) throw Object.assign(new Error('备份不存在或已被删除'), { status: 404 });
  return file;
}

function deleteBackup(name) {
  const file = resolveBackupFile(name);
  fs.rmSync(file, { force: true });
  return path.basename(file);
}

/** 读取整数型环境变量，非法值回退到默认值 */
function readInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 按类型滚动清理旧备份，返回被删除的文件名。
 *
 * 各类型的保留份数分别可配：
 *   AUTO_BACKUP_KEEP    定时自动备份（默认 14 份）
 *   PRE_RESTORE_KEEP   恢复前快照（默认 5 份）
 *   PRE_UPGRADE_KEEP   升级前快照（默认 3 份）
 *
 * 手动备份（app-）**永不自动清理**：用户主动点的那一份往往正是他要长期留存的，
 * 系统替他决定删除是不可接受的。这也意味着磁盘占用最终要靠用户自己管理，
 * 页面上的「共 N 份」与备份目录大小就是留给他的判断依据。
 */
function pruneBackups(overrides = {}) {
  const limits = {
    auto: readInt(process.env.AUTO_BACKUP_KEEP, 14),
    'pre-restore': readInt(process.env.PRE_RESTORE_KEEP, 5),
    'pre-upgrade': readInt(process.env.PRE_UPGRADE_KEEP, 3),
    ...overrides,
  };

  const groups = new Map();
  // listBackups 已按 mtime 倒序（新的在前），因此每组的前 limit 份就是要保留的
  for (const item of listBackups()) {
    if (!groups.has(item.kind)) groups.set(item.kind, []);
    groups.get(item.kind).push(item);
  }

  const removed = [];
  for (const [kind, items] of groups) {
    const limit = limits[kind];
    // 未配置的类型（即 manual）与显式 -1 都不清理
    if (!Number.isFinite(limit) || limit < 0) continue;
    for (const item of items.slice(limit)) {
      try {
        fs.rmSync(path.join(BACKUP_DIR, item.name), { force: true });
        removed.push(item.name);
      } catch {
        /* 删不掉就留着，下次再试，绝不能因为清理失败影响备份主流程 */
      }
    }
  }
  return removed;
}

/**
 * 定时自动备份。
 *
 * 之所以必须要有它：备份如果只靠管理员手动点，一旦没人点就等于没有备份，
 * 而升级 / 误删 / 库损坏都不会提前打招呼。
 *
 * 策略：
 *  - 间隔由 AUTO_BACKUP_HOURS 控制，默认 24 小时，设为 0 可关闭；
 *  - 进程启动时先看最新一份 auto 备份有多旧，已超过间隔才立刻补一份，
 *    避免「每次 docker compose up 重建容器都白生成一份」；
 *  - 定时器 unref，不阻止进程退出（否则 docker stop 会等到优雅关闭超时）；
 *  - 任何异常只记日志，绝不让备份失败影响主服务。
 *
 * @returns {NodeJS.Timeout|null} 关闭自动备份用 clearInterval(timer)
 */
function startAutoBackup(db, options = {}) {
  const hours = readInt(
    options.hours != null ? String(options.hours) : process.env.AUTO_BACKUP_HOURS,
    24,
  );
  // 0 表示显式关闭：调用方想自己管备份时用得上
  if (hours <= 0) {
    console.log('[backup] 自动备份已关闭（AUTO_BACKUP_HOURS=0）');
    return null;
  }

  const intervalMs = hours * 3600 * 1000;

  const runOnce = (reason) => {
    try {
      const item = createBackup(db, 'auto');
      const removed = pruneBackups();
      console.log(
        `[backup] 自动备份完成（${reason}）：${item.name}（${item.sizeLabel}，` +
          `${item.counts.stores} 家门店 / ${item.counts.entries} 条销售记录）` +
          (removed.length ? `；清理 ${removed.length} 份过期备份` : ''),
      );
      return item;
    } catch (err) {
      console.error(`[backup] 自动备份失败（${reason}）：${err.message}`);
      return null;
    }
  };

  // 启动时补一份的前提：从来没有自动备份，或最新一份已经超过间隔
  const newest = listBackups().find((b) => b.kind === 'auto');
  const ageMs = newest ? Date.now() - new Date(newest.mtime).getTime() : Infinity;
  if (ageMs >= intervalMs) {
    runOnce(newest ? '距上次已超过间隔' : '尚无自动备份');
  } else {
    const leftHours = ((intervalMs - ageMs) / 3600000).toFixed(1);
    console.log(`[backup] 自动备份已启用：每 ${hours} 小时一份，最近一份 ${newest.name}，约 ${leftHours} 小时后生成下一份`);
  }

  const timer = setInterval(() => runOnce('定时'), intervalMs);
  // 不 unref 会让 docker stop 时事件循环一直有待办，优雅关闭要等满 stop_grace_period
  timer.unref();
  return timer;
}

/** 换库时必须一起清掉的伴生文件，留着会让新库被旧 WAL 污染 */
function sidecars(dbPath) {
  return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* 被占用时忽略，后续覆盖写会失败并进入回滚分支 */
  }
}

/**
 * 用一份备份文件替换当前正在使用的数据库。
 *
 * 返回 { restored, safety }，safety 是恢复前留下的当前库快照。
 * 任何一步失败都会把原库放回去并重开连接，保证服务不处于「无库」状态。
 */
function restoreBackup(db, dbPath, sourceFile) {
  // 懒加载：db.js 在启动时也会 require 本模块（用于升级前自动备份），
  // 顶层互相 require 会拿到半初始化的 exports，这里按需取即可。
  const { prepareDatabase } = require('./db');
  const info = inspect(sourceFile);
  if (!info.ok) {
    throw Object.assign(new Error(`备份不可用：${info.error}`), { status: 400 });
  }

  // 1) 先给当前库留安全副本。走 VACUUM INTO，保证拿到的是一致状态。
  ensureDir();
  const safetyPath = uniquePath(stampName('pre-restore'));
  db.exec(`VACUUM INTO ${sqlString(safetyPath)}`);

  // 2) 断开连接，替换文件
  db.checkpoint('TRUNCATE');
  db.close();
  for (const file of sidecars(dbPath)) removeQuietly(file);

  let restored = false;
  try {
    fs.copyFileSync(sourceFile, dbPath);
    removeQuietly(`${dbPath}-wal`);
    removeQuietly(`${dbPath}-shm`);
    // 3) 重开连接并跑迁移：备份可能来自旧版本，结构需要补齐
    db.reopen();
    prepareDatabase(db);
    restored = true;
  } catch (err) {
    // 回滚：把安全副本放回原处，再重新打开
    try {
      db.close();
    } catch {
      /* 已关闭或已失效 */
    }
    for (const file of sidecars(dbPath)) removeQuietly(file);
    let rollbackError = null;
    try {
      fs.copyFileSync(safetyPath, dbPath);
      removeQuietly(`${dbPath}-wal`);
      removeQuietly(`${dbPath}-shm`);
      db.reopen();
      prepareDatabase(db);
    } catch (rollbackErr) {
      rollbackError = rollbackErr.message;
    }
    const suffix = rollbackError
      ? `；回滚也失败（${rollbackError}），请用 ${path.basename(safetyPath)} 手工恢复`
      : '；已自动回滚到恢复前的数据';
    throw Object.assign(new Error(`恢复失败：${err.message}${suffix}`), { status: 500 });
  }

  return {
    restored,
    info,
    safety: {
      name: path.basename(safetyPath),
      sizeLabel: formatSize(fs.existsSync(safetyPath) ? fs.statSync(safetyPath).size : 0),
    },
  };
}

module.exports = {
  BACKUP_DIR,
  createBackup,
  listBackups,
  inspect,
  resolveBackupFile,
  deleteBackup,
  restoreBackup,
  describe,
  formatSize,
  pruneBackups,
  startAutoBackup,
};
