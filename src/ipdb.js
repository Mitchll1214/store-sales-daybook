'use strict';

/**
 * ip2region 归属地解析 + IP 库在线校验/更新。
 * 数据文件优先级：DATA_DIR/ipdb/ip2region_v4.xdb（可在线更新）→ vendor/（镜像构建时下载）→ npm 包内置 xdb。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./util');

const IPDB_DIR = path.join(DATA_DIR, 'ipdb');
const LOCAL_XDB = path.join(IPDB_DIR, 'ip2region_v4.xdb');
const META_FILE = path.join(IPDB_DIR, 'meta.json');
const BUNDLED_DIR = path.join(__dirname, '..', 'node_modules', 'ip2region', 'data');
/** 镜像构建时预下载的 xdb（scripts/fetch-ipdb.js → vendor/），随镜像分发、不受数据卷挂载影响 */
const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
const IMAGE_XDB = process.env.IPDB_IMAGE_FILE
  ? path.resolve(process.env.IPDB_IMAGE_FILE)
  : path.join(VENDOR_DIR, 'ip2region_v4.xdb');
/** 镜像预置 xdb 的下载信息（由 scripts/fetch-ipdb.js 在构建时写入，与被覆盖的 xdb 同目录） */
const IMAGE_META_FILE = path.join(path.dirname(IMAGE_XDB), 'meta.json');
const UPSTREAM_REPO = 'lionsoul2014/ip2region';
const UPSTREAM_PATH = 'data/ip2region_v4.xdb';
const UPSTREAM_RAW = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/master/${UPSTREAM_PATH}`;
const CACHE_LIMIT = 5000;

const FIELD_LIST = ['country_name', 'region_name', 'city_name', 'isp', 'country_code'];

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/** 把 ip2region 记录压缩成一行可读位置，过滤 Reserved/0 等占位值 */
function formatRegion(result) {
  if (!result) return null;
  const raw = (result.extensions && result.extensions.raw) || {};
  const parts = [raw.country_name, raw.region_name, raw.city_name, raw.isp]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter((v) => v && v !== '0' && !/^reserved$/i.test(v));
  const seen = new Set();
  const unique = parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  if (unique.length === 0) return null;
  if (unique.length === 1 && /^(中国|China)$/i.test(unique[0])) return unique[0];
  return unique.join(' ');
}

class IpDatabase {
  constructor() {
    this.reader = null;
    this.meta = null;
    this.cache = new Map();
    this.source = 'none';
    this.error = null;
  }

  async init() {
    fs.mkdirSync(IPDB_DIR, { recursive: true });
    const candidates = [];
    if (fs.existsSync(LOCAL_XDB)) candidates.push({ file: LOCAL_XDB, source: 'updated' });
    if (fs.existsSync(IMAGE_XDB)) candidates.push({ file: IMAGE_XDB, source: 'image' });
    const bundled = path.join(BUNDLED_DIR, 'ip2region_v4.xdb');
    if (fs.existsSync(bundled)) candidates.push({ file: bundled, source: 'bundled' });

    for (const candidate of candidates) {
      try {
        await this.load(candidate.file);
        this.source = candidate.source;
        this.meta = this.buildMeta(candidate.file, candidate.source);
        if (candidate.source === 'updated') writeJson(META_FILE, this.meta);
        console.log(`[ipdb] 已加载 ${candidate.source} 数据：${candidate.file}`);
        return this.source;
      } catch (err) {
        this.error = err.message;
        console.warn(`[ipdb] 加载失败 ${candidate.file}：${err.message}`);
      }
    }
    console.warn('[ipdb] 未找到可用的 ip2region xdb，操作日志将只记录 IP 地址。');
    return 'none';
  }

  buildMeta(file, source) {
    const stat = fs.statSync(file);
    const manifest = readJsonSafe(path.join(BUNDLED_DIR, 'manifest.json'), {}) || {};
    const upstream = manifest.upstream || {};
    const fileEntry = (manifest.files || []).find((f) => f.family === 4) || {};
    const stored = readJsonSafe(META_FILE, {}) || {};
    const imageMeta = readJsonSafe(IMAGE_META_FILE, {}) || {};
    if (source === 'image') {
      return {
        source,
        file,
        size: stat.size,
        sha256: sha256File(file),
        revision: imageMeta.revision || null,
        retrievedAt: imageMeta.retrievedAt || null,
        builtAt: imageMeta.builtAt || null,
        origin: imageMeta.origin || 'docker-build',
        loadedAt: new Date().toISOString(),
      };
    }
    return {
      source,
      file,
      size: stat.size,
      sha256: sha256File(file),
      revision: source === 'updated' ? stored.revision || null : upstream.revision || null,
      retrievedAt: source === 'updated' ? stored.retrievedAt || null : upstream.retrievedAt || null,
      builtAt: source === 'updated' ? stored.builtAt || null : fileEntry.builtAt || null,
      loadedAt: new Date().toISOString(),
    };
  }

  async load(file) {
    const { IP2Region } = require('ip2region/node');
    // 自备 xdb 时必须使用 database 配置，不能同时传 families（两者互斥）
    const reader = await IP2Region.open({
      database: { format: 'xdb', path: file, fields: FIELD_LIST },
    });
    if (this.reader) {
      try {
        this.reader.close();
      } catch {
        /* 忽略旧实例关闭异常 */
      }
    }
    this.reader = reader;
    this.cache.clear();
    this.error = null;
  }

  /** 同步查询；返回位置字符串或 null */
  lookup(ip) {
    if (!ip) return null;
    if (this.cache.has(ip)) return this.cache.get(ip);
    if (!this.reader) return null;
    let location = null;
    try {
      location = formatRegion(this.reader.lookup(ip));
    } catch {
      location = null;
    }
    if (this.cache.size >= CACHE_LIMIT) {
      const first = this.cache.keys().next();
      if (!first.done) this.cache.delete(first.value);
    }
    this.cache.set(ip, location);
    return location;
  }

  status() {
    return {
      loaded: Boolean(this.reader),
      source: this.source,
      error: this.error,
      localFile: this.source === 'updated' ? LOCAL_XDB : null,
      bundled: this.source === 'bundled',
      meta: this.meta,
      cacheSize: this.cache.size,
      upstream: { repo: UPSTREAM_REPO, path: UPSTREAM_PATH },
    };
  }

  async fetchJson(url, timeoutMs = 8000) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'store-sales-daybook', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`GitHub 接口返回 ${res.status}`);
    return res.json();
  }

  /** 校验上游是否有更新（只读，不下载） */
  async checkUpdate() {
    if (!this.reader) {
      return { ok: false, reachable: false, reason: '本地 IP 库未加载，请先安装数据文件' };
    }
    let commits;
    try {
      commits = await this.fetchJson(
        `https://api.github.com/repos/${UPSTREAM_REPO}/commits?path=${encodeURIComponent(UPSTREAM_PATH)}&per_page=1`,
      );
    } catch (err) {
      return { ok: false, reachable: false, reason: `无法连接 GitHub 校验更新：${err.message}` };
    }
    if (!Array.isArray(commits) || commits.length === 0) {
      return { ok: false, reachable: true, reason: '上游未返回提交记录' };
    }
    const latest = commits[0];
    const latestRevision = latest.sha || null;
    const latestDate = latest.commit && latest.commit.committer ? latest.commit.committer.date : null;
    const current = this.meta || {};
    const hasUpdate = Boolean(latestRevision && current.revision && latestRevision !== current.revision);
    return {
      ok: true,
      reachable: true,
      hasUpdate,
      current: {
        source: current.source,
        revision: current.revision,
        retrievedAt: current.retrievedAt,
        builtAt: current.builtAt,
        size: current.size,
      },
      latest: { revision: latestRevision, date: latestDate, downloadUrl: UPSTREAM_RAW },
    };
  }

  /** 下载并替换为上游最新 v4 库，成功后热加载 */
  async update() {
    fs.mkdirSync(IPDB_DIR, { recursive: true });
    const tmp = `${LOCAL_XDB}.download`;
    const check = await this.checkUpdate();
    if (!check.reachable) {
      const err = check.reason || '无法连接上游';
      throw new Error(err);
    }
    const res = await fetch(UPSTREAM_RAW, {
      headers: { 'User-Agent': 'store-sales-daybook' },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`下载 IP 库失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024 * 1024) throw new Error(`下载内容过小（${buf.length} 字节），已放弃`);

    fs.writeFileSync(tmp, buf);
    // 先用临时副本验证可被解析，避免写入损坏文件
    try {
      await this.load(tmp);
    } catch (err) {
      fs.unlinkSync(tmp);
      throw new Error(`下载的 IP 库无法解析：${err.message}`);
    }
    fs.renameSync(tmp, LOCAL_XDB);

    const meta = {
      source: 'updated',
      revision: check.latest ? check.latest.revision : null,
      retrievedAt: new Date().toISOString().slice(0, 10),
      builtAt: check.latest ? check.latest.date : null,
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      upstream: { repo: UPSTREAM_REPO, path: UPSTREAM_PATH },
    };
    writeJson(META_FILE, meta);
    await this.load(LOCAL_XDB);
    this.source = 'updated';
    this.meta = this.buildMeta(LOCAL_XDB, 'updated');
    return { updated: true, meta: this.meta };
  }
}

module.exports = { IpDatabase, formatRegion, IPDB_DIR, LOCAL_XDB };
