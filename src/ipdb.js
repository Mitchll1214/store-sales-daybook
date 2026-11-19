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

/**
 * 下载超时。11 MB 的 xdb 在 100 KB/s 的链路上要 110 秒，原先固定 120 秒经常刚好卡死，
 * 用户看到的就是浏览器抛出的英文 "The operation was aborted due to timeout"。
 * 这里给足余量，并允许用环境变量按部署网络调整。
 */
const DOWNLOAD_TIMEOUT_MS = (() => {
  const n = Number(process.env.IPDB_DOWNLOAD_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 30000 ? n : 240000;
})();
/**
 * 一次「更新 IP 库」的总时间预算。多源回退时若每个源都等到自己超时，
 * 最坏情况会挂十几分钟，前端按钮一直转圈。这里给整轮下载封顶，
 * 用完之后后续源只保留最小尝试时间。
 */
const DOWNLOAD_TOTAL_BUDGET_MS = (() => {
  const n = Number(process.env.IPDB_DOWNLOAD_BUDGET_MS);
  return Number.isFinite(n) && n >= 60000 ? n : 300000;
})();
/** 单个源至少给这么长时间，避免总预算耗尽后还没试就放弃 */
const MIN_ATTEMPT_MS = 15000;
/** 版本校验只查 GitHub API，超时短一些，避免拖住「校验更新」按钮 */
const CHECK_TIMEOUT_MS = 8000;

/**
 * 下载源，按顺序回退。GitHub 官方域名在部分网络下不可达或被限速，
 * CDN 镜像通常可用；三者内容一致，任一下载成功即可。
 * IPDB_MIRROR_URL 可指向自建镜像（放在最前面）。
 */
const DOWNLOAD_SOURCES = (() => {
  const list = [];
  const mirror = String(process.env.IPDB_MIRROR_URL || '').trim();
  if (mirror) list.push({ id: 'mirror', label: '自定义镜像', url: mirror });
  list.push(
    { id: 'github-raw', label: 'GitHub 直连', url: UPSTREAM_RAW },
    {
      id: 'jsdelivr',
      label: 'jsDelivr CDN',
      url: `https://cdn.jsdelivr.net/gh/${UPSTREAM_REPO}@master/${UPSTREAM_PATH}`,
    },
    {
      id: 'jsdelivr-fastly',
      label: 'jsDelivr（Fastly）',
      url: `https://fastly.jsdelivr.net/gh/${UPSTREAM_REPO}@master/${UPSTREAM_PATH}`,
    },
  );
  return list;
})();

/**
 * 把底层网络错误翻译成用户能看懂的中文。
 * fetch 的超时是 AbortSignal 触发的，原样透传只会得到一句英文。
 */
function describeFetchError(err, timeoutMs) {
  const name = (err && err.name) || '';
  const message = String((err && err.message) || err || '');
  if (name === 'TimeoutError' || /aborted due to timeout|timed out/i.test(message)) {
    const seconds = timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) : timeoutMs;
    return `${seconds} 秒内无响应，连接超时`;
  }
  if (name === 'AbortError') return '请求被中断';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
    const cause = err && err.cause;
    const causeText = cause ? cause.code || cause.message : '';
    return causeText ? `无法连接（${causeText}）` : '无法连接网络';
  }
  return message || '未知错误';
}

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

  async fetchJson(url, timeoutMs = CHECK_TIMEOUT_MS) {
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
      return {
        ok: false,
        reachable: false,
        reason: `无法连接 GitHub 校验更新：${describeFetchError(err, CHECK_TIMEOUT_MS)}`,
        hint: '校验只是查询版本信息；网络受限时可直接点「更新 IP 库」，系统会改走 CDN 镜像下载',
      };
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

  /**
   * 从单个源下载 xdb。
   * 区分「超时」「HTTP 错误」「内容过小」「解析失败」，并把底层英文错误翻成中文。
   * @param {object} source {id,label,url}
   * @param {number} timeoutMs 本次尝试可用的时间（已扣除总预算消耗）
   */
  async downloadFrom(source, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
    const attempt = Math.max(timeoutMs, MIN_ATTEMPT_MS);
    let buf;
    try {
      const res = await fetch(source.url, {
        headers: { 'User-Agent': 'store-sales-daybook' },
        signal: AbortSignal.timeout(attempt),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw new Error(`${source.label}：${describeFetchError(err, attempt)}`);
    }
    if (buf.length < 1024 * 1024) {
      throw new Error(`${source.label}：下载内容过小（${buf.length} 字节）`);
    }
    return buf;
  }

  /**
   * 下载并替换为上游最新 v4 库，成功后热加载。
   *
   * 关键点：
   * - 不因为 GitHub API 校验失败就放弃——校验只是为了拿版本号，下载走独立的多源回退；
   * - 任一源成功即用，全部失败时把每个源的原因汇总返回，便于判断是网络还是上游问题；
   * - 先写临时副本、验证可解析后再原子替换，避免写坏本地库。
   */
  async update() {
    fs.mkdirSync(IPDB_DIR, { recursive: true });
    const tmp = `${LOCAL_XDB}.download`;

    // 版本信息只用于展示；取不到也不影响下载，因此失败不抛出
    let latest = null;
    try {
      const check = await this.checkUpdate();
      if (check.reachable) latest = check.latest || null;
    } catch {
      /* 忽略：版本信息可选 */
    }

    const failures = [];
    let buf = null;
    let usedSource = null;
    const deadline = Date.now() + DOWNLOAD_TOTAL_BUDGET_MS;
    for (const source of DOWNLOAD_SOURCES) {
      const remaining = deadline - Date.now();
      try {
        buf = await this.downloadFrom(source, Math.min(remaining, DOWNLOAD_TIMEOUT_MS));
        usedSource = source;
        break;
      } catch (err) {
        failures.push(err.message);
      }
      if (Date.now() >= deadline) {
        failures.push(`总耗时超出 ${Math.round(DOWNLOAD_TOTAL_BUDGET_MS / 1000)} 秒预算，已停止尝试其余源`);
        break;
      }
    }
    if (!buf) {
      throw new Error(`所有下载源均失败（${failures.join('；')}）。可设置 IPDB_MIRROR_URL 指向可访问的镜像后重试`);
    }

    fs.writeFileSync(tmp, buf);
    // 先用临时副本验证可被解析，避免写入损坏文件
    try {
      await this.load(tmp);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件可能已不存在 */
      }
      throw new Error(`下载的 IP 库无法解析：${err.message}`);
    }
    fs.renameSync(tmp, LOCAL_XDB);

    const meta = {
      source: 'updated',
      revision: latest ? latest.revision : null,
      retrievedAt: new Date().toISOString().slice(0, 10),
      builtAt: latest ? latest.date : null,
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      upstream: { repo: UPSTREAM_REPO, path: UPSTREAM_PATH },
      downloadSource: usedSource ? usedSource.id : null,
    };
    writeJson(META_FILE, meta);
    await this.load(LOCAL_XDB);
    this.source = 'updated';
    this.meta = this.buildMeta(LOCAL_XDB, 'updated');
    return { updated: true, meta: this.meta, via: usedSource ? { id: usedSource.id, label: usedSource.label } : null };
  }
}

module.exports = { IpDatabase, formatRegion, IPDB_DIR, LOCAL_XDB };
