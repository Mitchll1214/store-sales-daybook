'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Database } = require('./sqlite');
const { ROOT, DATA_DIR, UPLOAD_DIR, nowStamp } = require('./util');
const { hashPassword, verifyPassword, passwordWeakness } = require('./security');

const SCHEMA_VERSION = 7;

/** 商品属性：本品 / 竞品。未设置的一律按竞品统计（数据库默认 'comp'）。 */
const PRODUCT_KINDS = ['own', 'comp'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  /* 别名：店员端唯一可见的门店标识，真实编码与名称只在后台与日志里出现 */
  alias              TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  auto_login_token   TEXT NOT NULL UNIQUE,
  auto_login_enabled INTEGER NOT NULL DEFAULT 1,
  remark             TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('admin','region_admin','clerk')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  store_id             INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  phone                TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  is_builtin           INTEGER NOT NULL DEFAULT 0,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_store ON users(store_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

/* 区域管理员的门店范围：一个账号直接管辖多家门店（多对多），不再有「区域」这一层 */
CREATE TABLE IF NOT EXISTS user_stores (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, store_id)
);

CREATE TABLE IF NOT EXISTS products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  alias      TEXT NOT NULL,
  barcode    TEXT,
  category   TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'comp' CHECK (kind IN ('own','comp')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode
  ON products(barcode) WHERE barcode IS NOT NULL AND barcode <> '';

CREATE TABLE IF NOT EXISTS store_products (
  store_id   INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (store_id, product_id)
);

CREATE TABLE IF NOT EXISTS sale_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  biz_date   TEXT NOT NULL,
  period     TEXT NOT NULL CHECK (period IN ('am','pm')),
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL DEFAULT 0,
  amount     REAL NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  /* 管理员修正留痕：只记最后一次修正，完整的前后值在操作日志里 */
  corrected_at      TEXT,
  corrected_by_name TEXT,
  UNIQUE (store_id, biz_date, period, product_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON sale_entries(biz_date, period);
CREATE INDEX IF NOT EXISTS idx_entries_store_date ON sale_entries(store_id, biz_date);

CREATE TABLE IF NOT EXISTS sale_submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id       INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  biz_date       TEXT NOT NULL,
  period         TEXT NOT NULL CHECK (period IN ('am','pm')),
  item_count     INTEGER NOT NULL DEFAULT 0,
  total_qty      INTEGER NOT NULL DEFAULT 0,
  total_amount   REAL NOT NULL DEFAULT 0,
  submitted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitter_name TEXT NOT NULL,
  submitted_at   TEXT NOT NULL,
  UNIQUE (store_id, biz_date, period)
);
CREATE INDEX IF NOT EXISTS idx_submissions_date ON sale_submissions(biz_date, period);
CREATE INDEX IF NOT EXISTS idx_submissions_store ON sale_submissions(store_id, biz_date);

CREATE TABLE IF NOT EXISTS sale_images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  biz_date      TEXT NOT NULL,
  period        TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  original_name TEXT,
  mime          TEXT,
  size          INTEGER NOT NULL DEFAULT 0,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_slot ON sale_images(store_id, biz_date, period);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  store_id     INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  ip           TEXT,
  device_id    TEXT,
  ua           TEXT,
  login_via    TEXT NOT NULL DEFAULT 'password',
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER,
  actor_name     TEXT NOT NULL,
  actor_username TEXT,
  actor_store_code TEXT,
  actor_store_name TEXT,
  actor_role     TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  detail         TEXT,
  ip             TEXT,
  ip_location    TEXT,
  device_id      TEXT,
  ua             TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

CREATE TABLE IF NOT EXISTS device_profiles (
  device_id     TEXT PRIMARY KEY,
  fingerprint   TEXT,
  ua_hash       TEXT,
  ua_sample     TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_ua ON device_profiles(ua_hash);
CREATE INDEX IF NOT EXISTS idx_device_fingerprint ON device_profiles(fingerprint);
`;

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/** 数据库文件路径：备份、恢复、关闭流程都要用它，集中算一次 */
function resolveDbPath() {
  return process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'app.db');
}

/** 目录里是否已有「业务数据」的痕迹：库文件、上传图片、备份快照 */
function dataDirLooksUsed(dir) {
  try {
    if (fs.readdirSync(dir).some((n) => n.endsWith('.db'))) return true;
    const uploads = path.join(dir, 'uploads');
    if (fs.existsSync(uploads) && fs.readdirSync(uploads).length > 0) return true;
    const backups = path.join(dir, 'backups');
    if (fs.existsSync(backups) && fs.readdirSync(backups).some((n) => n.endsWith('.db'))) return true;
  } catch {
    /* 读不了目录就不猜，交给后续流程报错 */
  }
  return false;
}

/** 常见「本该是这里」的库位置，用于在新建空库时给出可执行的提示 */
function otherDatabaseCandidates(dbPath) {
  const candidates = [
    path.join(ROOT, 'data', 'app.db'),
    path.join(process.cwd(), 'data', 'app.db'),
  ];
  const seen = new Set([path.resolve(dbPath)]);
  const found = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
    seen.add(resolved);
    try {
      if (fs.statSync(resolved).size > 0) found.push(resolved);
    } catch {
      /* 读不到大小就忽略候选 */
    }
  }
  return found;
}

/**
 * 库文件不存在时，判断这是「首次部署」还是「路径/挂载配错了」。
 *
 * 静默建空库是这套系统最隐蔽的故障：服务正常启动、页面正常打开，
 * 只是数据全空了，而运维往往几天后才发现。因此这里在真正建库之前就把话说清楚：
 *  - 别处已有库 → 强烈警告并给出那个路径（多半是 DATA_DIR 或数据卷没挂对）；
 *  - 本目录已有上传图片 / 备份但没有 app.db → 也警告，说明库文件单独丢了；
 *  - 完全空目录 → 只提示这是首次初始化，避免虚惊。
 * 任何情况下都只打印警告，不阻止启动、不移动任何文件。
 */
function warnIfSuspiciousNewDb(dbPath) {
  const dir = path.dirname(dbPath);
  const others = otherDatabaseCandidates(dbPath);
  if (others.length) {
    console.error(
      '\n' +
        '==============================================================\n' +
        `[db] ⚠ 警告：${dbPath} 不存在，将新建一个空库；\n` +
        `     但在 ${others[0]} 发现已有数据库。\n` +
        '     这通常意味着 DATA_DIR / 数据卷挂载路径配错了，\n' +
        '     继续启动会得到一个「看起来正常、实际没有历史数据」的空系统。\n' +
        '     请先确认要用的库路径（docker compose config 看 volumes），再重启。\n' +
        '==============================================================\n',
    );
    return;
  }
  if (dataDirLooksUsed(dir)) {
    console.error(
      `[db] ⚠ 警告：数据目录 ${dir} 里已有上传图片或备份，但缺少 app.db，` +
        '服务将新建空库。若这不是预期（例如误删了库文件），请先停止服务并从备份恢复。',
    );
    return;
  }
  console.log(`[db] 首次启动：${dbPath} 尚不存在，将初始化一个空库。`);
}

function openDatabase() {
  ensureDirs();
  const dbPath = resolveDbPath();
  // 启动即打印实际落点：排查「重建后数据不见了」时，第一步就是确认它读的是不是原来那个库。
  // 若这里显示的是新建文件，说明数据卷没挂上或路径被改过，而不是数据被清空。
  const dbExists = fs.existsSync(dbPath);
  console.log(`[db] 数据库：${dbPath}（${dbExists ? '已存在' : '新建'}）`);
  if (!dbExists) warnIfSuspiciousNewDb(dbPath);

  // 启动前先自检：库文件坏了要在动任何写操作之前发现，
  // 否则会在 migrate 的第一句 UPDATE/ALTER 上抛出 errcode 11，报错位置还看不出是文件坏了。
  let damaged = detectCorruption(dbPath);
  if (damaged) {
    // 「主库没落盘 + WAL 里有完整数据」看起来和真损坏一模一样（都是 malformed），
    // 但这类完全能救回来：把 WAL 重放进主库再自检即可。
    // 必须先试这一步，否则一次 docker 强杀就会让健康数据被误判为损坏而清空。
    console.error(`[db] 数据库自检未通过：${damaged}，先尝试重放 WAL 日志…`);
    if (replayWal(dbPath)) {
      damaged = detectCorruption(dbPath);
      if (!damaged) console.error('[db] WAL 重放成功，数据库已恢复正常（数据未丢失）。');
    }
  }
  if (damaged) {
    console.error(`[db] 数据库自检未通过：${damaged}`);
    recoverDatabase(dbPath, damaged);
  }

  const db = connectAndPrepare(dbPath);
  // 备份 / 恢复模块需要知道库文件落在哪，挂到实例上比到处重复推导更可靠
  db.dbPath = dbPath;
  return db;
}

/**
 * 尝试把 -wal 里的事务重放进主库。
 *
 * 只读方式打不开或自检失败时才会走到这里：以读写方式打开并 checkpoint(TRUNCATE)，
 * 合法 WAL 会被正常重放，主库随之恢复一致。
 * 真损坏时这一步自身可能报错，直接返回 false 交给救援流程，不做任何破坏性动作。
 */
function replayWal(dbPath) {
  const walPath = `${dbPath}-wal`;
  if (!fs.existsSync(walPath) || fs.statSync(walPath).size === 0) return false;
  let db;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return true;
  } catch (err) {
    console.error(`[db] WAL 重放未成功：${err.message}`);
    return false;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* 损坏连接的关闭异常不影响后续救援 */
      }
    }
  }
}

/** 给连接套上统一 PRAGMA */
function applyPragmas(db) {
  db.pragma('journal_mode = WAL');
  // WAL + FULL：每次提交都把 WAL 刷到磁盘。NORMAL 更快，但进程被强杀时
  // 最后几个已提交事务可能丢掉，对本系统（每天只提交两轮数据）没必要用性能换这种风险。
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * 优雅关闭：先把 WAL 收进主库再断开连接。
 *
 * docker compose restart / stop 默认发 SIGTERM，若不处理，进程被直接杀掉后
 * 会留下未 checkpoint 的 -wal；下次启动就可能被自检判定为损坏。
 * 这是「每次重启都要清一次库」的根因，因此必须在进程退出前主动收尾。
 */
function closeDatabase(db, reason = '正常关闭') {
  if (!db) return;
  try {
    db.checkpoint('TRUNCATE');
  } catch {
    /* checkpoint 失败不阻塞退出 */
  }
  try {
    db.close();
    console.log(`[db] 数据库已关闭（${reason}），WAL 已合并进主库。`);
  } catch (err) {
    console.error(`[db] 关闭数据库时出错：${err.message}`);
  }
}

/**
 * 结构升级前先留一份快照。
 *
 * 为什么要做：迁移会 ALTER / 重建表，一旦新版本代码有结构缺陷（本项目就出现过
 * 重建 stores 时把 alias 列丢掉的问题），没有快照就只能对着已被改写的库发愁。
 * 升级前留一份 pre-upgrade 快照，最坏情况可以直接从备份页面恢复回去。
 *
 * 只在「确实要改结构」且「库已有内容」时生成：
 *  - 日常重启结构已是最新，不该每次 docker compose up 都多一份备份；
 *  - 全新空库没有可保护的数据。
 * 任何失败都只记日志：备份失败绝不能拦住服务启动。
 */
function preUpgradeSnapshot(db, dbPath) {
  try {
    if (!fs.existsSync(dbPath)) return null;
    // 全新库（还没有任何业务表）没有可保护的数据，不该占一份备份
    if (!tableExists(db, 'stores') || !tableExists(db, 'users')) return null;
    if (!needsUpgrade(db)) return null;
    // 懒加载：backup.js 依赖 sqlite / util，这里按需取可避免两个模块顶层互引
    const backup = require('./backup');
    const item = backup.createBackup(db, 'pre-upgrade');
    backup.pruneBackups();
    console.log(
      `[db] 检测到结构需要升级，已先生成快照 ${item.name}（${item.sizeLabel}，` +
        `${item.counts.stores} 家门店 / ${item.counts.entries} 条销售记录）；` +
        '若升级后数据异常，可在「系统设置 → 数据备份」里恢复这一份。',
    );
    return item;
  } catch (err) {
    console.error(`[db] 升级前快照生成失败（继续启动，不影响升级）：${err.message}`);
    return null;
  }
}

/**
 * 打开连接并跑迁移 / 初始化账号。
 *
 * 迁移过程中也可能才暴露出损坏（自检偶尔能过、真正写页时才失败），
 * 因此这里兜底：一旦是损坏类错误，就救援一次后重试。用 recovered 标志防止无限重试。
 */
function connectAndPrepare(dbPath, recovered = false) {
  const db = applyPragmas(new Database(dbPath));
  try {
    // 先留快照再迁移：顺序反了就失去「升级前」这个时间点
    preUpgradeSnapshot(db, dbPath);
    migrate(db);
    seed(db);
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      /* 连接已不可用，忽略关闭异常 */
    }
    if (recovered || !isCorruptionError(err)) throw err;
    console.error(`[db] 初始化时发现数据库损坏：${err.message}`);
    recoverDatabase(dbPath, err.message);
    return connectAndPrepare(dbPath, true);
  }
}

/**
 * 判断错误是不是「文件坏了」，而不是普通的约束 / 语法错误。
 * SQLITE_CORRUPT(11) 与 SQLITE_NOTADB(26) 是明确的文件级损坏。
 */
function isCorruptionError(err) {
  if (!err) return false;
  if (err.errcode === 11 || err.errcode === 26) return true;
  return /malformed|corrupt|not a database|disk image/i.test(String(err.message || ''));
}

/**
 * 只读探测库文件是否可读，不修改任何东西。
 * 返回 null 表示健康；返回字符串表示发现的问题。
 */
function detectCorruption(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  // 0 字节文件是「新建库」的正常形态，不是损坏
  if (fs.statSync(dbPath).size === 0) return null;

  let db;
  try {
    // 只读打开：自检绝对不能参与写盘。用读写方式打开时，SQLite 会尝试恢复/改写
    // 头部与 WAL，一旦库本来就处于半写状态，自检反而可能把还能救的现场改坏。
    db = new Database(dbPath, { readOnly: true });
  } catch (err) {
    return isCorruptionError(err) ? err.message : null;
  }
  try {
    // quick_check 会真正走一遍 B-tree，比 integrity_check 快，足够发现坏页 / 坏索引
    const rows = db.prepare('PRAGMA quick_check').all();
    const bad = rows
      .map((r) => Object.values(r)[0])
      .filter((v) => String(v).toLowerCase() !== 'ok');
    if (bad.length) return bad.join('；');
    // 能列出表才说明 sqlite_master 也是好的（文件被截断时往往卡在这里）
    db.prepare('SELECT count(*) AS c FROM sqlite_master').get();
    return null;
  } catch (err) {
    return isCorruptionError(err) ? err.message : `自检失败：${err.message}`;
  } finally {
    try {
      db.close();
    } catch {
      /* 损坏连接关闭可能异常，忽略 */
    }
  }
}

/** 关键表：救不回来就意味着「业务数据已不可用」，按约定以全新空库启动 */
const CRITICAL_TABLES = ['users', 'stores'];

/**
 * 救援一份损坏的数据库文件。
 *
 * 1. 先把现场整体移进 corrupt-<时间戳>/ 备份目录（含 -wal / -shm / -journal），绝不删除；
 * 2. 从备份里的坏库逐表 SELECT 抢救到新库，坏掉的表跳过并记录；
 * 3. 关键表（users / stores）救不回来时弃用抢救结果，交给上层建全新空库。
 *
 * 之所以不用 VACUUM INTO：实测在真损坏时它直接报 errcode 11，
 * 逐表 SELECT 反而能把还没坏的表救出来。
 */
function recoverDatabase(dbPath, reason) {
  const dir = path.dirname(dbPath);
  const stamp = nowStamp().replace(/[: ]/g, '-');
  const backupDir = path.join(dir, `corrupt-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  // 备份现场：主库与 WAL/SHM 一起移走，少一件都可能让事后手工抢救失真。
  // 优先 rename（原子、快），但被占用时（WAL 未释放 / 另一进程还在读）会 EBUSY，
  // 此时退回逐字节拷贝：备份慢一点没关系，绝不能因为备份失败把启动彻底拦住。
  const moved = [];
  const failedMoves = [];
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    const from = dbPath + ext;
    if (!fs.existsSync(from)) continue;
    const to = path.join(backupDir, path.basename(dbPath) + ext);
    try {
      fs.renameSync(from, to);
      moved.push(path.basename(dbPath) + ext);
    } catch (err) {
      try {
        fs.copyFileSync(from, to);
        // 拷贝成功后尽力清掉原文件；清不掉也无妨，后续会以全新空库覆盖
        try {
          fs.rmSync(from, { force: true });
        } catch {
          /* 文件仍被占用，留给后续处理 */
        }
        moved.push(`${path.basename(dbPath) + ext}（拷贝）`);
      } catch (copyErr) {
        failedMoves.push(`${path.basename(dbPath) + ext}: ${copyErr.message}`);
      }
    }
  }
  if (moved.length) {
    console.error(`[db] 损坏现场已备份到 ${backupDir}（${moved.join('、')}）`);
  }
  if (failedMoves.length) {
    console.error(`[db] 以下文件未能备份：${failedMoves.join('；')}`);
  }
  console.error(`[db] 损坏原因：${reason}`);

  const broken = path.join(backupDir, path.basename(dbPath));
  const report = rescueToNewFile(broken, dbPath);
  const failedTables = new Set(report.failed.map((f) => f.table));
  const missingCritical = CRITICAL_TABLES.filter((t) => failedTables.has(t) || !(t in report.copied));

  if (report.fatal || missingCritical.length) {
    // 弃用半成品抢救库，让上层重新建空库（避免留下一份结构残缺的库，后续报错更难查）。
    // 逐个安全丢弃：文件可能仍被 WAL 占用，删不掉就改名，绝不能因此把启动拦住。
    for (const ext of ['', '-wal', '-shm', '-journal']) {
      discardFile(dbPath + ext, stamp);
    }
    console.error(
      `[db] 关键数据未能抢救（${report.fatal || missingCritical.join('、')}），将以全新空库启动。`,
    );
    console.error(`[db] 原库完整保留在 ${backupDir}，需要时可手工导出：sqlite3 "${broken}" .dump > dump.sql`);
    return;
  }

  const saved = Object.entries(report.copied)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t} ${n} 行`)
    .join('、');
  console.error(`[db] 已从损坏库抢救出数据：${saved || '（无数据）'}`);
  if (report.failed.length) {
    console.error(`[db] 未能抢救的表：${report.failed.map((f) => f.table).join('、')}（数据丢失）`);
  }
  console.error(`[db] 原库完整保留在 ${backupDir}`);
}

/**
 * 安全删除文件：删不掉（被占用 / 权限）时退而重命名，
 * 绝不让「清理旧文件」这一步把救援流程整个打断。
 */
function discardFile(file, stamp) {
  if (!fs.existsSync(file)) return true;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    try {
      fs.renameSync(file, `${file}.discard-${stamp}`);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 把还能读的表逐行拷进一个新库文件。
 * 坏表（读不出或建表语句缺失）记入 failed 后跳过，不影响其他表。
 */
function rescueToNewFile(brokenPath, targetPath) {
  const report = { copied: {}, failed: [], fatal: null };

  let src;
  try {
    src = new Database(brokenPath);
  } catch (err) {
    report.fatal = `无法打开损坏库：${err.message}`;
    return report;
  }

  let defs;
  try {
    defs = src
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
  } catch (err) {
    report.fatal = `无法读取表结构：${err.message}`;
    try {
      src.close();
    } catch {
      /* 忽略 */
    }
    return report;
  }

  let dst;
  try {
    dst = new Database(targetPath);
  } catch (err) {
    report.fatal = `无法创建新库：${err.message}`;
    try {
      src.close();
    } catch {
      /* 忽略 */
    }
    return report;
  }

  try {
    dst.exec('PRAGMA foreign_keys = OFF');
    for (const def of defs) {
      if (!def.sql) {
        report.failed.push({ table: def.name, error: '缺少建表语句' });
        continue;
      }
      try {
        const rows = src.prepare(`SELECT * FROM "${def.name}"`).all();
        dst.exec(def.sql);
        if (rows.length) {
          const cols = Object.keys(rows[0]);
          const stmt = dst.prepare(
            `INSERT INTO "${def.name}" (${cols.map((c) => `"${c}"`).join(',')}) ` +
              `VALUES (${cols.map(() => '?').join(',')})`,
          );
          // 逐表一个事务：大批量插入快得多，失败也能整表回滚
          dst.transaction(() => {
            for (const row of rows) stmt.run(...cols.map((c) => row[c]));
          })();
        }
        report.copied[def.name] = rows.length;
      } catch (err) {
        report.failed.push({ table: def.name, error: err.message });
      }
    }
  } finally {
    try {
      dst.close();
    } catch {
      /* 忽略 */
    }
    try {
      src.close();
    } catch {
      /* 忽略 */
    }
  }

  return report;
}

/**
 * 幂等补列：只看真实表结构缺不缺这一列，不看 user_version。
 *
 * 为什么不能只信 user_version：它可能已经是新版本号，但列并没有真正写进库
 * （升级中途被打断、或用中间版本启动过一次），此时按版本号短路会永久跳过补列，
 * 表现就是查询时报 `no such column`。按结构判断则每次启动都能自愈。
 */
function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/**
 * 「老库缺、当前代码要用」的列清单。集中定义的好处：
 *  1. ensureAllColumns 按它补列；
 *  2. needsUpgrade 用同一份清单判断「这次启动是否真的要改结构」，
 *     从而决定要不要先留一份升级前快照——两处不会各自漂移。
 * 定义必须与 SCHEMA 里的建表语句保持一致。
 */
const COLUMN_SPECS = [
  ['users', 'is_builtin', 'INTEGER NOT NULL DEFAULT 0'],
  ['products', 'category', "TEXT NOT NULL DEFAULT ''"],
  ['products', 'kind', "TEXT NOT NULL DEFAULT 'comp'"],
  ['audit_logs', 'actor_username', 'TEXT'],
  ['audit_logs', 'actor_store_code', 'TEXT'],
  ['audit_logs', 'actor_store_name', 'TEXT'],
  // 门店别名：店员端只认这一个字段。老库补列后**不**用真实名称回填——
  // 别名存在的意义就是不让店员看到真实店名，回填等于脱敏失效，留空时前端用中性兜底文案。
  ['stores', 'alias', 'TEXT'],
  // 明细条目被管理员修正后留下的标记：只存最后一次，完整前后值在操作日志里
  ['sale_entries', 'corrected_at', 'TEXT'],
  ['sale_entries', 'corrected_by_name', 'TEXT'],
];

/**
 * 补齐所有「老库缺、当前代码要用」的列。整体幂等，可重复调用。
 *
 * 之所以单独抽成一个函数而不是写在 migrate 的固定位置：v3 升级会整表重建 stores，
 * 任何在重建之前补上的列都会被丢掉，必须在重建之后再补一次。
 */
function ensureAllColumns(db) {
  // 按「实际结构缺不缺」执行，重复启动不会重复加列，
  // 也不会因为版本号错位而漏加。
  for (const [table, column, definition] of COLUMN_SPECS) {
    ensureColumn(db, table, column, definition);
  }
}

/**
 * 判断「本次启动会不会真的改动库结构」。
 *
 * 只有真要改结构时才值得在动手前留一份 pre-upgrade 快照：
 * 日常重启（结构已是最新）不该每次都多生成一份备份。
 * 只读探测，不写任何东西。
 */
function needsUpgrade(db) {
  const version = Number(db.pragma('user_version', { simple: true })) || 0;
  if (version < SCHEMA_VERSION) return true;
  // 版本号可能已经是最新、但列没真正加上（升级中途被打断），按实际结构再判一次
  for (const [table, column] of COLUMN_SPECS) {
    if (!tableExists(db, table)) return true;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) return true;
  }
  // v3 的遗留表：存在就说明还没完成「区域」这一层的下线
  if (tableExists(db, 'regions') || tableExists(db, 'user_regions')) return true;
  const storeCols = db.prepare('PRAGMA table_info(stores)').all().map((c) => c.name);
  return storeCols.includes('region_id');
}

function migrate(db) {
  const run = db.transaction(() => {
    db.exec(SCHEMA);
    ensureAllColumns(db);

    // 回填同样幂等：只动还没填过的行，重复执行不会覆盖已有数据。

    // 老日志只存了 user_id 与姓名，按 user_id 回填账号，让操作人列统一显示「账号 + 姓名」。
    // 系统动作（actor_name='system'）不回填，避免显示成「admin / system」这种矛盾组合。
    db.exec(`UPDATE audit_logs
                SET actor_username = (SELECT username FROM users WHERE users.id = audit_logs.user_id)
              WHERE actor_username IS NULL AND user_id IS NOT NULL AND actor_name <> 'system'`);

    // 老日志里 target_type='store' 的动作，目标就是门店本身，按 target_id 回填门店编码与名称。
    db.exec(`UPDATE audit_logs
                SET actor_store_code = (SELECT code FROM stores WHERE stores.id = audit_logs.target_id),
                    actor_store_name = (SELECT name FROM stores WHERE stores.id = audit_logs.target_id)
              WHERE actor_store_code IS NULL
                AND target_type = 'store'
                AND target_id GLOB '[0-9]*'`);

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  run();

  // v3 需要重建 stores 表，SQLite 不允许在事务内切换外键开关，故放在主事务之外。
  // 函数内部会先判断是否真的需要重建，已经是新结构时直接返回，因此可以无条件调用。
  upgradeToStoreScopedAdmins(db);

  // 重建会整表替换 stores，任何在主事务里补过的列都会随之消失。
  // 这里无条件再补一次（幂等），保证重建之后结构仍是当前版本。
  ensureAllColumns(db);

  // 旧库的 kind 列由 ALTER 补上时没有 CHECK 约束，这里用触发器兜住非法值。
  // 触发器与索引都是 IF NOT EXISTS，无条件执行即可（不能跟着 user_version 短路，
  // 否则「列刚补上但版本号已是最新」的库会缺这两道约束）。
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_products_kind_ins
           BEFORE INSERT ON products
           WHEN NEW.kind NOT IN ('own','comp')
           BEGIN SELECT RAISE(ABORT, '商品属性只能是 own 或 comp'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_products_kind_upd
           BEFORE UPDATE OF kind ON products
           WHEN NEW.kind NOT IN ('own','comp')
           BEGIN SELECT RAISE(ABORT, '商品属性只能是 own 或 comp'); END`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)');
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * v3：取消「区域」这一层。
 *
 * 区域管理员直接管辖门店（user_stores 多对多），不再经由区域间接授权；
 * 旧库里的「账号-区域」+「门店-区域」两段关系在这里展开成「账号-门店」直连，
 * 然后删掉 regions / user_regions，并重建 stores 去掉 region_id 外键列。
 */
function upgradeToStoreScopedAdmins(db) {
  const storeCols = db.prepare('PRAGMA table_info(stores)').all().map((c) => c.name);
  const hasRegionColumn = storeCols.includes('region_id');
  const hasLegacyTables = tableExists(db, 'regions') || tableExists(db, 'user_regions');
  if (!hasRegionColumn && !hasLegacyTables) return;

  const restoreForeignKeys = db.pragma('foreign_keys', { simple: true }) === 1;
  if (restoreForeignKeys) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      if (hasRegionColumn && tableExists(db, 'user_regions')) {
        db.exec(`INSERT OR IGNORE INTO user_stores (user_id, store_id)
                 SELECT ur.user_id, s.id FROM user_regions ur
                 JOIN stores s ON s.region_id = ur.region_id`);
      }
      db.exec('DROP TABLE IF EXISTS user_regions');
      db.exec('DROP TABLE IF EXISTS regions');
      if (!hasRegionColumn) return;

      // 这里的建表语句必须与 SCHEMA 里的 stores **完全一致**：
      // 重建会丢掉所有未列出的列（历史上 alias 就是这样在升级首轮被丢掉的，
      // 表现为门店登录直接报 no such column: alias）。新增列时两处要同步改。
      db.exec(`CREATE TABLE stores_v3 (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        code               TEXT NOT NULL UNIQUE,
        name               TEXT NOT NULL,
        /* 别名：店员端唯一可见的门店标识，真实编码与名称只在后台与日志里出现 */
        alias              TEXT,
        status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        auto_login_token   TEXT NOT NULL UNIQUE,
        auto_login_enabled INTEGER NOT NULL DEFAULT 1,
        remark             TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      )`);
      // alias 用 SELECT * 取不到（可能还不存在），单独判断后再带上，避免旧库报 no such column
      const legacyCols = db.prepare('PRAGMA table_info(stores)').all().map((c) => c.name);
      const aliasExpr = legacyCols.includes('alias') ? 'alias' : 'NULL';
      db.exec(`INSERT INTO stores_v3
                 (id, code, name, alias, status, auto_login_token, auto_login_enabled, remark, created_at, updated_at)
               SELECT id, code, name, ${aliasExpr}, status, auto_login_token, auto_login_enabled, remark, created_at, updated_at
               FROM stores`);
      db.exec('DROP TABLE stores');
      db.exec('ALTER TABLE stores_v3 RENAME TO stores');
    })();
  } finally {
    if (restoreForeignKeys) db.pragma('foreign_keys = ON');
  }
}

function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value == null ? null : String(value), nowStamp());
}

/**
 * 内置超级管理员（由环境变量托管）。
 *
 * 规则：
 *   - 配置了 INIT_ADMIN_PASSWORD 时，该账号的密码**以环境变量为唯一来源**：
 *     每次启动校验并同步，系统内任何入口（改密页、后台重置、CLI）都不允许修改；
 *   - 未配置 INIT_ADMIN_PASSWORD 时，密码随机生成并写入 data/initial-admin-password.txt，
 *     此时该账号与系统内创建的账号一样，允许自行修改密码。
 */
function seed(db) {
  const stamp = nowStamp();
  const username = process.env.INIT_ADMIN_USERNAME || 'admin';
  const envPassword = process.env.INIT_ADMIN_PASSWORD || '';
  const managed = Boolean(envPassword);

  // 托管密码由运维配置，这里不阻止启动（强行拒绝会让服务起不来），但必须大声提醒：
  // admin123 这类默认值一旦跟着 .env 上线，等于后台门没锁。
  if (managed) {
    const weakness = passwordWeakness(envPassword);
    if (weakness) {
      console.error(
        '\n' +
          '==============================================================\n' +
          `[seed] ⚠ 警告：INIT_ADMIN_PASSWORD 强度不足（${weakness}）。\n` +
          '     这个密码可以登录总部管理员，请尽快改成 12 位以上、\n' +
          '     不含常见词与连续/重复字符的随机密码后重启。\n' +
          '==============================================================\n',
      );
    }
  }

  let admin = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (admin && admin.role !== 'admin') {
    throw new Error(
      `INIT_ADMIN_USERNAME 指定的账号「${username}」已被非管理员角色占用，` +
        '请更换 INIT_ADMIN_USERNAME，或先在后台处理该账号后重启。',
    );
  }
  if (!admin) {
    // 环境变量改了名字时，接管原有的内置账号，避免出现两个超级管理员
    admin = db.prepare('SELECT * FROM users WHERE is_builtin = 1 ORDER BY id LIMIT 1').get();
  }
  if (admin && !admin.is_builtin) {
    db.prepare('UPDATE users SET is_builtin = 1 WHERE id = ?').run(admin.id);
    admin = { ...admin, is_builtin: 1 };
  }

  if (!admin) {
    let password = envPassword;
    let generated = false;
    if (!password) {
      password = crypto.randomBytes(6).toString('base64url');
      generated = true;
    }
    db.prepare(
      `INSERT INTO users (username, display_name, password_hash, role, status, must_change_password, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 'active', ?, 1, ?, ?)`,
    ).run(username, '总部管理员', hashPassword(password), managed ? 0 : 1, stamp, stamp);
    db.prepare(
      `INSERT INTO audit_logs (actor_name, actor_role, action, target_type, detail, created_at)
       VALUES ('system', 'system', 'init_admin', 'user', ?, ?)`,
    ).run(`初始化总部管理员账号 ${username}${managed ? '（密码由环境变量 INIT_ADMIN_PASSWORD 托管）' : ''}`, stamp);

    const banner = [
      '========================================================',
      '  店销日集 初始化完成',
      `  总部管理员账号：${username}`,
      managed
        ? '  登录密码：由环境变量 INIT_ADMIN_PASSWORD 提供（系统内不可修改）'
        : `  初始密码：${password}  （仅本次显示，请登录后修改）`,
      '========================================================',
    ].join('\n');
    console.log(banner);
    if (generated) {
      fs.writeFileSync(path.join(DATA_DIR, 'initial-admin-password.txt'), banner, 'utf8');
    }
  } else if (managed && syncBuiltinPassword(db, admin, envPassword, stamp)) {
    console.log(`[seed] 已按环境变量 INIT_ADMIN_PASSWORD 同步内置管理员 ${admin.username} 的密码。`);
  }
  if (!getSetting(db, 'app_initialized')) setSetting(db, 'app_initialized', stamp);
}

/**
 * 该账号的密码是否由环境变量托管（托管 = 系统内不允许修改）。
 *
 * 只有「内置管理员」且「环境变量 INIT_ADMIN_PASSWORD 已配置」且「账号名与
 * INIT_ADMIN_USERNAME 一致」三者同时成立时才锁定；
 * 其余账号（含系统内创建的所有账号、以及未配置环境变量密码时的内置账号）均可自行修改。
 */
function passwordManagedExternally(user) {
  if (!user || !user.is_builtin) return false;
  if (!process.env.INIT_ADMIN_PASSWORD) return false;
  return user.username === (process.env.INIT_ADMIN_USERNAME || 'admin');
}

/**
 * 把内置管理员密码对齐到环境变量。
 * 密码不一致就改写（这正是「改了环境变量却登不进去」的修复点），
 * 同时清理初始化标记与禁用状态，保证超级管理员始终可登录。
 *
 * @returns {boolean} 是否发生了变更
 */
function syncBuiltinPassword(db, user, password, stamp) {
  const same = verifyPassword(password, user.password_hash);
  const needsReset = user.status !== 'active' || Boolean(user.must_change_password);
  if (same && !needsReset) return false;
  db.prepare(
    `UPDATE users SET password_hash = ?, status = 'active', must_change_password = 0, updated_at = ? WHERE id = ?`,
  ).run(same ? user.password_hash : hashPassword(password), stamp, user.id);
  if (!same) {
    db.prepare(
      `INSERT INTO audit_logs (user_id, actor_name, actor_role, action, target_type, target_id, detail, created_at)
       VALUES (?, 'system', 'system', 'init_admin_password_sync', 'user', ?, ?, ?)`,
    ).run(user.id, String(user.id), '按环境变量 INIT_ADMIN_PASSWORD 同步内置管理员密码', stamp);
  }
  return true;
}

/**
 * 对「已经打开的连接」执行统一 PRAGMA + 迁移 + 初始化。
 *
 * 恢复备份后新库是别人写的文件，结构和版本都可能落后，必须再走一遍
 * 迁移与初始化才能直接使用；抽出这个函数让两条入口复用同一套逻辑。
 */
function prepareDatabase(db) {
  applyPragmas(db);
  migrate(db);
  seed(db);
  return db;
}

module.exports = {
  openDatabase,
  closeDatabase,
  resolveDbPath,
  prepareDatabase,
  detectCorruption,
  getSetting,
  setSetting,
  passwordManagedExternally,
  SCHEMA_VERSION,
};
