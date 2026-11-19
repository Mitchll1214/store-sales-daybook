'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Database } = require('./sqlite');
const { DATA_DIR, UPLOAD_DIR, nowStamp } = require('./util');
const { hashPassword, verifyPassword } = require('./security');

const SCHEMA_VERSION = 6;

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

function openDatabase() {
  ensureDirs();
  const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'app.db');
  // 启动即打印实际落点：排查「重建后数据不见了」时，第一步就是确认它读的是不是原来那个库。
  // 若这里显示的是新建文件，说明数据卷没挂上或路径被改过，而不是数据被清空。
  console.log(`[db] 数据库：${dbPath}（${fs.existsSync(dbPath) ? '已存在' : '新建'}）`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  const run = db.transaction(() => {
    db.exec(SCHEMA);
    // v2：内置（环境变量托管）管理员标记。CREATE TABLE IF NOT EXISTS 不会给旧库补列，需显式升级。
    if (current < 2) {
      const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
      if (!cols.includes('is_builtin')) {
        db.exec('ALTER TABLE users ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0');
      }
    }
    // v4：商品档案新增「品类」与「属性」（本品/竞品）。旧库需显式补列。
    if (current < 4) {
      const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
      if (!cols.includes('category')) {
        db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT ''");
      }
      if (!cols.includes('kind')) {
        db.exec("ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'comp'");
      }
    }
    // v5：审计日志新增「操作人账号」列（原来只有姓名，同名时无法区分）。
    if (current < 5) {
      const cols = db.prepare('PRAGMA table_info(audit_logs)').all().map((c) => c.name);
      if (!cols.includes('actor_username')) {
        db.exec('ALTER TABLE audit_logs ADD COLUMN actor_username TEXT');
      }
      // 老日志只存了 user_id 与姓名，按 user_id 回填账号，让操作人列统一显示「账号 + 姓名」。
      // 系统动作（actor_name='system'）不回填，避免显示成「admin / system」这种矛盾组合。
      db.exec(`UPDATE audit_logs
                  SET actor_username = (SELECT username FROM users WHERE users.id = audit_logs.user_id)
                WHERE actor_username IS NULL AND user_id IS NOT NULL AND actor_name <> 'system'`);
    }
    // v6：审计日志新增「操作人门店」两列。门店操作（免登录链接 / 绑定门店的店员）
    // 只记姓名时看不出是哪家店做的，操作记录里要能直接读到「门店编码 / 门店名称」。
    if (current < 6) {
      const cols = db.prepare('PRAGMA table_info(audit_logs)').all().map((c) => c.name);
      if (!cols.includes('actor_store_code')) {
        db.exec('ALTER TABLE audit_logs ADD COLUMN actor_store_code TEXT');
      }
      if (!cols.includes('actor_store_name')) {
        db.exec('ALTER TABLE audit_logs ADD COLUMN actor_store_name TEXT');
      }
      // 老日志里 target_type='store' 的动作，目标就是门店本身，按 target_id 回填门店编码与名称。
      db.exec(`UPDATE audit_logs
                  SET actor_store_code = (SELECT code FROM stores WHERE stores.id = audit_logs.target_id),
                      actor_store_name = (SELECT name FROM stores WHERE stores.id = audit_logs.target_id)
                WHERE actor_store_code IS NULL
                  AND target_type = 'store'
                  AND target_id GLOB '[0-9]*'`);
    }
    if (current < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  run();
  // v3 需要重建 stores 表，SQLite 不允许在事务内切换外键开关，故放在主事务之外。
  if (current < 3) upgradeToStoreScopedAdmins(db);
  if (current < 4) {
    // 旧库的 kind 列由 ALTER 补上时没有 CHECK 约束，这里用触发器兜住非法值
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

      db.exec(`CREATE TABLE stores_v3 (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        code               TEXT NOT NULL UNIQUE,
        name               TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        auto_login_token   TEXT NOT NULL UNIQUE,
        auto_login_enabled INTEGER NOT NULL DEFAULT 1,
        remark             TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      )`);
      db.exec(`INSERT INTO stores_v3
                 (id, code, name, status, auto_login_token, auto_login_enabled, remark, created_at, updated_at)
               SELECT id, code, name, status, auto_login_token, auto_login_enabled, remark, created_at, updated_at
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

module.exports = { openDatabase, getSetting, setSetting, passwordManagedExternally, SCHEMA_VERSION };
