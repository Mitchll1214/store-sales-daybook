'use strict';

/**
 * ip2region 归属地解析 + IP 库在线校验/更新。
 * 数据文件优先级：DATA_DIR/ipdb/ip2region_v4.xdb（可在线更新）→ vendor/（镜像构建时下载）→ npm 包内置 xdb。
 *
 * 更新链路对国内服务器做了专门适配，分两段各自独立回退：
 * - 校验：GitHub API 只给版本号，国内常被墙；失败后用「Range 探测下载源体积」兜底，
 *   只要有一个 CDN 通，就能判断上游文件是否变过。
 * - 下载：多个源依次回退，先按延迟把可用源排到前面，避免在不通的源上干等几分钟。
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
const USER_AGENT = 'store-sales-daybook';
const CACHE_LIMIT = 5000;
/** 小于这个体积的响应一定不是完整的 xdb（正常约 11 MB），用来识别被墙时返回的错误页 */
const MIN_XDB_BYTES = 1024 * 1024;

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
 * 空闲超时：连接建立后多久没收到新数据就放弃。
 * 用「空闲」而不是纯总时长，是因为慢速链路持续有数据时不该被判超时，
 * 而彻底不通的源又应该尽快跳过、换下一个。
 */
const DOWNLOAD_IDLE_MS = (() => {
  const n = Number(process.env.IPDB_DOWNLOAD_IDLE_MS);
  return Number.isFinite(n) && n >= 10000 ? n : 45000;
})();
/**
 * 一次「更新 IP 库」的总时间预算。多源回退时若每个源都等到自己超时，
 * 最坏情况会挂十几分钟。这里给整轮下载封顶，用完之后后续源只保留最小尝试时间。
 */
const DOWNLOAD_TOTAL_BUDGET_MS = (() => {
  const n = Number(process.env.IPDB_DOWNLOAD_BUDGET_MS);
  return Number.isFinite(n) && n >= 60000 ? n : 300000;
})();
/** 单个源至少给这么长时间，避免总预算耗尽后还没试就放弃 */
const MIN_ATTEMPT_MS = 15000;
/** 版本校验只查 GitHub API，超时短一些，避免拖住「校验更新」按钮 */
const CHECK_TIMEOUT_MS = 8000;
/** 探测单个下载源是否可用（只取 1 字节）的超时 */
const PROBE_TIMEOUT_MS = 12000;

/**
 * 下载源，按顺序回退。
 *
 * 清单是逐个实测出来的（同一天并发探测，全部返回 11122742 字节的同一个文件）：
 * - 可用：jsDelivr 四个节点（cdn / fastly / gcore / testingcf）、gh-proxy.com、
 *   ghfast.top、ghproxy.net；
 * - 不可用或需要登录，因此**没有**放进来：GitHub 直连（国内超时）、ghproxy.cc、
 *   gh.llkk.cc、github.moeyy.xyz、raw.gitmirror.com、cdn.statically.io、
 *   gitee（大文件需登录，返回 403）、registry.npmmirror.com 的文件接口（403）。
 *   最后一家只提供包元数据，不提供 xdb 本体，无法当下载源。
 *
 * 多家 jsDelivr 节点并不是冗余摆设：它们走不同的 CDN 边缘，某一家的域名被
 * 干扰时其余几家通常仍可用；三家 GitHub 反代同理，各自的存活周期都不稳定。
 * IPDB_MIRROR_URL 可指向自建镜像（放在最前面，优先级最高，适合完全离线部署）。
 * 注意运行期还会按探测延迟重排，这里的顺序只是探测全部失败时的兜底。
 */
const DOWNLOAD_SOURCES = (() => {
  const list = [];
  const mirror = String(process.env.IPDB_MIRROR_URL || '').trim();
  if (mirror) list.push({ id: 'mirror', label: '自定义镜像', url: mirror, publicUrl: null });
  const jsdelivr = (id, label, host) => ({
    id,
    label,
    url: `https://${host}/gh/${UPSTREAM_REPO}@master/${UPSTREAM_PATH}`,
    publicUrl: `https://${host}/gh/${UPSTREAM_REPO}@master/${UPSTREAM_PATH}`,
  });
  const proxy = (id, label, host) => ({
    id,
    label,
    url: `https://${host}/${UPSTREAM_RAW}`,
    publicUrl: `https://${host}/${UPSTREAM_RAW}`,
  });
  list.push(
    jsdelivr('jsdelivr', 'jsDelivr CDN', 'cdn.jsdelivr.net'),
    jsdelivr('jsdelivr-fastly', 'jsDelivr（Fastly）', 'fastly.jsdelivr.net'),
    jsdelivr('jsdelivr-gcore', 'jsDelivr（Gcore）', 'gcore.jsdelivr.net'),
    jsdelivr('jsdelivr-testingcf', 'jsDelivr（Cloudflare）', 'testingcf.jsdelivr.net'),
    proxy('ghproxy', 'gh-proxy 加速', 'gh-proxy.com'),
    proxy('ghfast', 'ghfast 加速', 'ghfast.top'),
    proxy('ghproxy-net', 'ghproxy.net 加速', 'ghproxy.net'),
    { id: 'github-raw', label: 'GitHub 直连', url: UPSTREAM_RAW, publicUrl: UPSTREAM_RAW },
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
  if (name === 'AbortError') return message && !/aborted/i.test(message) ? message : '请求被中断';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNABORTED/i.test(message)) {
    const cause = err && err.cause;
    const causeText = cause ? cause.code || cause.message : '';
    return causeText ? `无法连接（${causeText}）` : '无法连接网络';
  }
  return message || '未知错误';
}

/** 人类可读的体积，用于校验结果与日志详情 */
function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

/** 从 `bytes 0-0/11122742` 里取出总长度：支持 Range 的源靠它判断文件是否变过 */
function totalFromRange(header) {
  const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(String(header || ''));
  return m ? Number(m[1]) : 0;
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

/** 任务阶段的中文说明：前端轮询时直接展示，省得再翻译一遍 */
const STAGE_TEXT = {
  queued: '排队中',
  probing: '选择下载渠道',
  downloading: '正在下载',
  verifying: '校验文件',
  applying: '应用到线上',
  done: '更新完成',
  failed: '更新失败',
};

class IpDatabase {
  constructor() {
    this.reader = null;
    this.meta = null;
    this.cache = new Map();
    this.source = 'none';
    this.error = null;
    /** 最近一次（或正在进行的）更新任务，供前端跨页轮询 */
    this.job = null;
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
      /** 上次下载时该源返回的 ETag，下次同源探测可精确比对（不同源 ETag 规则不同，不可跨源比较） */
      etag: source === 'updated' ? stored.etag || null : null,
      downloadedVia: source === 'updated' ? stored.downloadSource || null : null,
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

  /** 本地库指纹：校验时与上游对比，前端也用它展示「当前版本」 */
  localFingerprint() {
    const m = this.meta || {};
    return {
      source: this.source,
      revision: m.revision || null,
      size: m.size || 0,
      sha256: m.sha256 || null,
      retrievedAt: m.retrievedAt || null,
      builtAt: m.builtAt || null,
      downloadedVia: m.downloadedVia || null,
    };
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
      /** 可用下载渠道（只给 id/名称，自建镜像地址不外泄） */
      sources: DOWNLOAD_SOURCES.map((s) => ({ id: s.id, label: s.label })),
      job: this.jobSnapshot(),
    };
  }

  /* ---------------- 后台更新任务 ---------------- */

  /**
   * 启动一次后台更新。下载动辄几分钟，必须脱离 HTTP 请求生命周期——
   * 否则用户一离开页面、请求被浏览器取消，服务端也白下了一场。
   * 已有任务在跑时直接复用，不重复下载。
   */
  startUpdate() {
    if (this.job && this.job.running) return { started: false, job: this.jobSnapshot() };
    const job = {
      id: `ipdb-${Date.now().toString(36)}`,
      running: true,
      stage: 'queued',
      stageText: STAGE_TEXT.queued,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      elapsedMs: null,
      progress: null,
      source: null,
      check: null,
      result: null,
      error: null,
    };
    this.job = job;
    job.promise = this.runUpdate(job);
    return { started: true, job: this.jobSnapshot(), promise: job.promise };
  }

  async runUpdate(job) {
    const began = Date.now();
    const setStage = (stage, extra) => {
      job.stage = stage;
      job.stageText = STAGE_TEXT[stage] || stage;
      if (extra) Object.assign(job, extra);
    };
    try {
      setStage('probing');
      const result = await this.update({
        onStage: (stage, extra) => setStage(stage, extra),
        onProgress: (progress) => {
          job.progress = progress;
          job.source = progress && progress.source ? progress.source : job.source;
        },
      });
      job.result = result;
      job.progress = null;
      setStage('done');
    } catch (err) {
      job.error = err.message;
      job.progress = null;
      setStage('failed');
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      job.elapsedMs = Date.now() - began;
    }
    return job;
  }

  /** 任务快照（去掉 promise 等不可序列化字段），可安全 JSON 返回给前端 */
  jobSnapshot() {
    const j = this.job;
    if (!j) return null;
    return {
      id: j.id,
      running: j.running,
      stage: j.stage,
      stageText: j.stageText,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      elapsedMs: j.elapsedMs,
      progress: j.progress,
      source: j.source,
      result: j.result,
      error: j.error,
    };
  }

  /**
   * 等当前任务结束，拿到该任务的最终快照。
   * 路由用它来「任务结束后补写审计」——请求已经返回，审计只能挂在任务上等。
   */
  waitForUpdate() {
    const job = this.job;
    if (!job) return Promise.resolve(null);
    if (!job.promise) return Promise.resolve(this.jobSnapshot());
    return job.promise.then(() => {
      const snap = this.jobSnapshot();
      return { ...snap, result: job.result || null, error: job.error || null };
    });
  }

  /* ---------------- 校验 ---------------- */

  async fetchJson(url, timeoutMs = CHECK_TIMEOUT_MS) {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`GitHub 接口返回 ${res.status}`);
    return res.json();
  }

  /** 通道一：GitHub API 取最新提交号。国内常被墙，但成功时最精确。 */
  async checkViaApi() {
    const began = Date.now();
    try {
      const commits = await this.fetchJson(
        `https://api.github.com/repos/${UPSTREAM_REPO}/commits?path=${encodeURIComponent(UPSTREAM_PATH)}&per_page=1`,
      );
      if (!Array.isArray(commits) || commits.length === 0) {
        return { id: 'github-api', label: 'GitHub API', ok: false, ms: Date.now() - began, reason: '上游未返回提交记录' };
      }
      const latest = commits[0];
      return {
        id: 'github-api',
        label: 'GitHub API',
        ok: true,
        ms: Date.now() - began,
        revision: latest.sha || null,
        date: latest.commit && latest.commit.committer ? latest.commit.committer.date : null,
      };
    } catch (err) {
      return {
        id: 'github-api',
        label: 'GitHub API',
        ok: false,
        ms: Date.now() - began,
        reason: describeFetchError(err, CHECK_TIMEOUT_MS),
      };
    }
  }

  /**
   * 通道二：直接问下载源「这个文件多大」。
   * 只发 `Range: bytes=0-0`，拿到 Content-Range 总长度和 ETag 就掐断，不付 11 MB 流量。
   * GitHub API 不通时，只要有一个 CDN 可用，仍能判断上游文件有没有变过。
   */
  async probeSource(source, timeoutMs = PROBE_TIMEOUT_MS) {
    const began = Date.now();
    try {
      const res = await fetch(source.url, {
        headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      // 不支持 Range 的源会回 200 并开始推整个文件，这里立刻掐断
      try {
        if (res.body) await res.body.cancel();
      } catch {
        /* 连接可能已经结束 */
      }
      if (!res.ok && res.status !== 206) {
        return { id: source.id, label: source.label, ok: false, ms: Date.now() - began, reason: `HTTP ${res.status}` };
      }
      const size = totalFromRange(res.headers.get('content-range')) || Number(res.headers.get('content-length')) || 0;
      return {
        id: source.id,
        label: source.label,
        ok: true,
        ms: Date.now() - began,
        size,
        etag: res.headers.get('etag') || null,
        ranged: res.status === 206,
      };
    } catch (err) {
      return {
        id: source.id,
        label: source.label,
        ok: false,
        ms: Date.now() - began,
        reason: describeFetchError(err, timeoutMs),
      };
    }
  }

  /**
   * 校验上游是否有更新（只读，不下载）。
   *
   * 判定顺序：版本号（精确）→ 文件体积（够用）→ 无法确定。
   * `hasUpdate` 只有 true / false / null 三种值：null 表示渠道全不通，
   * 前端据此提示「无法判断，仍可尝试更新」，而不是把网络问题说成「已是最新」。
   */
  async checkUpdate() {
    const current = this.localFingerprint();
    if (!this.reader) {
      return {
        ok: false,
        hasUpdate: null,
        basis: 'none',
        reason: '本地 IP 库未加载，请先安装数据文件',
        current,
        latest: null,
        channels: [],
        probes: [],
      };
    }

    const [api, ...probes] = await Promise.all([
      this.checkViaApi(),
      ...DOWNLOAD_SOURCES.map((source) => this.probeSource(source)),
    ]);
    const channels = [api, ...probes];
    const base = { current, channels, probes };

    // 1) 版本号：两边都有提交号时最可靠
    if (api.ok && api.revision && current.revision) {
      return {
        ...base,
        ok: true,
        hasUpdate: api.revision !== current.revision,
        basis: 'revision',
        reason: null,
        latest: { revision: api.revision, date: api.date, downloadUrl: UPSTREAM_RAW },
      };
    }

    // 2) 体积：CDN 支持 Range 时能拿到上游文件的精确字节数
    const sized = probes.filter((p) => p.ok && p.size > 0);
    if (current.size && sized.length) {
      const differs = sized.filter((p) => p.size !== current.size);
      if (differs.length) {
        return {
          ...base,
          ok: true,
          hasUpdate: true,
          basis: 'size',
          reason: `上游文件 ${formatBytes(differs[0].size)}，本地 ${formatBytes(current.size)}`,
          latest: { revision: api.ok ? api.revision : null, size: differs[0].size, via: differs[0].label },
        };
      }
      return {
        ...base,
        ok: true,
        hasUpdate: false,
        basis: 'size',
        reason: `上游文件与本地同为 ${formatBytes(current.size)}`,
        latest: { revision: api.ok ? api.revision : null, size: current.size, via: sized[0].label },
      };
    }

    // 3) 拿不到版本号也量不到体积：如实说「判断不了」，别谎报已是最新
    return {
      ...base,
      ok: false,
      hasUpdate: null,
      basis: 'none',
      reason: api.ok ? '上游未提供可比的版本信息' : api.reason,
      hint: '所有校验渠道都没连上；下载渠道可能与校验不同，仍可点「校验更新」后选择直接更新',
      latest: api.ok ? { revision: api.revision, date: api.date, downloadUrl: UPSTREAM_RAW } : null,
    };
  }

  /* ---------------- 下载 ---------------- */

  /**
   * 从单个源下载 xdb。
   * 区分「空闲超时」「总超时」「HTTP 错误」「内容过小」，并把底层英文错误翻成中文。
   */
  async downloadFrom(source, options = {}) {
    const totalMs = Math.max(options.timeoutMs || DOWNLOAD_TIMEOUT_MS, MIN_ATTEMPT_MS);
    const idleMs = Math.max(options.idleMs || DOWNLOAD_IDLE_MS, 10000);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    const ctrl = new AbortController();
    let idleTimer = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(new Error(`${Math.round(idleMs / 1000)} 秒没有收到数据`)), idleMs);
    };
    const hardTimer = setTimeout(() => ctrl.abort(new Error(`${Math.round(totalMs / 1000)} 秒内未下载完成`)), totalMs);
    armIdle();

    try {
      const res = await fetch(source.url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('响应没有内容');
      /**
       * 下载总量只能在没有压缩时采信 content-length。
       * CDN 常对 xdb 用 gzip/br 传输，此时 content-length 是压缩后的大小（约 5.9 MB），
       * 而 for-await 拿到的是解压后的数据（11.1 MB），拿它当分母会出现 188% 的进度，
       * 或者刚开头就显示 100% 然后长时间不动。宁可没有百分比，也不给错的百分比。
       */
      const encoding = String(res.headers.get('content-encoding') || '').toLowerCase();
      const compressed = encoding && encoding !== 'identity';
      const expected = compressed
        ? 0
        : Number(res.headers.get('content-length')) || totalFromRange(res.headers.get('content-range')) || 0;
      const chunks = [];
      let received = 0;
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        chunks.push(buf);
        received += buf.length;
        armIdle();
        if (onProgress) onProgress({ received, total: expected, source: { id: source.id, label: source.label } });
      }
      const data = Buffer.concat(chunks);
      if (data.length < MIN_XDB_BYTES) {
        throw new Error(`下载内容过小（${data.length} 字节），可能是错误页面`);
      }
      return data;
    } catch (err) {
      throw new Error(`${source.label}：${describeFetchError(err, totalMs)}`);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
    }
  }

  /**
   * 决定下载顺序：先并发探测所有源，可用的按延迟从快到慢排，失败的挪到最后。
   * 这样国内服务器不会在连不通的 GitHub 直连上白等 45 秒。
   */
  async orderSources(probes) {
    const results = probes || (await Promise.all(DOWNLOAD_SOURCES.map((s) => this.probeSource(s))));
    const byId = new Map(results.map((p) => [p.id, p]));
    const alive = [];
    const dead = [];
    for (const source of DOWNLOAD_SOURCES) {
      const probe = byId.get(source.id) || null;
      const entry = { ...source, probe };
      if (probe && probe.ok) alive.push(entry);
      else dead.push(entry);
    }
    alive.sort((a, b) => (a.probe.ms || 1e9) - (b.probe.ms || 1e9));
    return [...alive, ...dead];
  }

  /**
   * 下载并替换为上游最新 v4 库，成功后热加载。
   *
   * 关键点：
   * - 不因为 GitHub API 校验失败就放弃——校验只是为了拿版本号，下载走独立的多源回退；
   * - 任一源成功即用，全部失败时把每个源的原因汇总返回，便于判断是网络还是上游问题；
   * - 先写临时副本、验证可解析后再原子替换，避免写坏本地库。
   */
  async update(options = {}) {
    const onStage = typeof options.onStage === 'function' ? options.onStage : null;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const stage = (name, extra) => {
      if (onStage) onStage(name, extra);
    };

    fs.mkdirSync(IPDB_DIR, { recursive: true });
    const tmp = `${LOCAL_XDB}.download`;

    // 版本信息只用于展示；取不到也不影响下载，因此失败不抛出
    let latest = null;
    let probes = null;
    try {
      const check = await this.checkUpdate();
      if (check.reachable !== false) latest = check.latest || null;
      probes = check.probes || null;
    } catch {
      /* 忽略：版本信息可选 */
    }

    stage('probing');
    const order = await this.orderSources(probes);

    const failures = [];
    let buf = null;
    let usedSource = null;
    let usedProbe = null;
    const deadline = Date.now() + DOWNLOAD_TOTAL_BUDGET_MS;
    for (const source of order) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        failures.push(`总耗时超出 ${Math.round(DOWNLOAD_TOTAL_BUDGET_MS / 1000)} 秒预算，已停止尝试其余渠道`);
        break;
      }
      stage('downloading', { source: { id: source.id, label: source.label } });
      try {
        buf = await this.downloadFrom(source, {
          timeoutMs: Math.min(remaining, DOWNLOAD_TIMEOUT_MS),
          onProgress,
        });
        usedSource = source;
        usedProbe = source.probe || null;
        break;
      } catch (err) {
        failures.push(err.message);
      }
    }
    if (!buf) {
      throw new Error(`所有下载渠道均失败（${failures.join('；')}）。可设置 IPDB_MIRROR_URL 指向可访问的镜像后重试`);
    }

    stage('verifying');
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
    stage('applying');
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
      etag: usedProbe && usedProbe.etag ? usedProbe.etag : null,
    };
    writeJson(META_FILE, meta);
    await this.load(LOCAL_XDB);
    this.source = 'updated';
    this.meta = this.buildMeta(LOCAL_XDB, 'updated');
    return {
      updated: true,
      meta: this.meta,
      via: usedSource ? { id: usedSource.id, label: usedSource.label } : null,
    };
  }
}

module.exports = { IpDatabase, formatRegion, formatBytes, IPDB_DIR, LOCAL_XDB };
