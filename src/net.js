'use strict';

/**
 * 客户端 IP 与设备指纹。
 *
 * 指纹目标：同一台设备上的每次操作都记录同一个指纹，因此只采集少量公开、
 * 稳定的环境字段（平台大类、浏览器大类、屏幕、时区、语言主标签、CPU 核数、
 * 色深），做一次 FNV-1a 双通道哈希得到 16 位十六进制短码。
 *
 * 微信内置浏览器的 UA 会随网络切换带上 `NetType/WIFI`、`NetType/4G`，
 * 也可能夹带随会话变化的 `MMWEBID`/`wxuin`，这些都不代表设备变化，
 * 计算指纹前一律剔除；只保留「平台 + 浏览器」两个大类。
 */

const COUNTRY_TLDS = /^[a-z]{2,3}$/i;

/** 从 UA 中剥离网络类型标记、微信会话标识、代理/隧道标识、被运营商注入的字段 */
function normalizeUserAgent(ua) {
  let s = String(ua || '');
  if (!s) return '';
  s = s.replace(/\bNetType\/[^\s;)]+/gi, ' ');
  s = s.replace(/\bNetworkType[\/=][^\s;)]+/gi, ' ');
  s = s.replace(/\bnettype[\/=][^\s;)]+/gi, ' ');
  s = s.replace(/\bMNetworkType[^\s;)]*/gi, ' ');
  s = s.replace(/\bNetType[^\s;)]*/gi, ' ');
  // 微信/运营商常见的网络标识片段
  s = s.replace(/\b(4G|5G|3G|2G|WIFI|wifi)[-+ ]?(Network|Net|Type)\b/gi, ' ');
  s = s.replace(/\b(CSNetwork|CTNetwork|CUNetwork)\b/gi, ' ');
  // 随会话/账号变化的微信标识：MMWEBID_xxx、wxuin=xxx、pass_ticket=xxx
  s = s.replace(/\bMMWEBID[\/=_][^\s;)]*/gi, ' ');
  s = s.replace(/\bwxuin[=:][^\s;)]*/gi, ' ');
  s = s.replace(/\bpass_ticket[=:][^\s;)]*/gi, ' ');
  s = s.replace(/\bMicroMessenger\/[\d.]+/gi, 'MicroMessenger');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** UA 主体：去掉版本号、App 构建号与语言标记，避免 App 升级/切换语言导致 ua_hash 漂移 */
function uaSkeleton(ua) {
  let s = normalizeUserAgent(ua).toLowerCase();
  // (0x18003128) 这类微信构建号、[xxx] 这类运营商标记
  s = s.replace(/\(0x[0-9a-f]+\)/g, ' ');
  s = s.replace(/\b(language|locale)\/[^\s;)]+/gi, ' ');
  // 任意 name/version 形式的版本号（版本段允许字母，如 Mobile/15E148）
  s = s.replace(/\b([a-z][a-z0-9_.+-]*)\/[\w.+-]+/g, '$1');
  s = s.replace(/\bwv\b/g, ' ');
  s = s.replace(/\bversion[\w.]*/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/* ---------------- 轻量设备指纹 ---------------- */

/**
 * FNV-1a 32 位。一条通道用标准偏移基数，另一条换一个基数做第二通道，
 * 两段各 8 位十六进制拼成 16 位短码：同一输入永远得到同一结果，
 * 且不需要引入额外依赖。
 */
function fnv1a32(text, basis) {
  let hash = basis >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 16 位十六进制短码（双通道 FNV-1a） */
function shortHash(input) {
  const text = String(input == null ? '' : input);
  const a = fnv1a32(text, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a32(text, 0x050c5d1f).toString(16).padStart(8, '0');
  return `${a}${b}`;
}

/**
 * 平台大类：只看「iOS / Android / Windows / macOS / Linux」这一级。
 * 系统小版本升级、机型名称变化都不会改变它，避免指纹随升级漂移。
 */
function platformClass(userAgent, client) {
  const both = `${String(userAgent || '')} ${String((client && client.platform) || '')}`.toLowerCase();
  if (/iphone|ipad|ipod/.test(both)) return 'ios';
  if (/android/.test(both)) return 'android';
  if (/windows|win32|win64/.test(both)) return 'windows';
  if (/mac os x|macintosh|macintel/.test(both)) return 'macos';
  if (/linux|x11/.test(both)) return 'linux';
  return 'other';
}

/** 浏览器大类：微信 / Edge / Chrome / Safari / Firefox，不含版本号 */
function browserClass(userAgent) {
  const s = String(userAgent || '');
  if (/MicroMessenger/i.test(s)) return 'wechat';
  if (/Edg\//i.test(s)) return 'edge';
  if (/Chrome\//i.test(s)) return 'chrome';
  if (/Safari\//i.test(s)) return 'safari';
  if (/Firefox\//i.test(s)) return 'firefox';
  return 'other';
}

/**
 * 屏幕归一化：手机横竖屏切换时宽高会互换，排序后再拼，
 * 否则同一台手机转一次屏指纹就变了。
 */
function screenProfile(value) {
  const m = String(value || '').match(/(\d+)\s*[x×*]\s*(\d+)/i);
  if (!m) return '';
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return '';
  return `${Math.min(w, h)}x${Math.max(w, h)}`;
}

/** 语言只取主标签：zh-CN / zh-TW / zh_CN 都归为 zh */
function primaryLanguage(value) {
  const s = String(value || '').toLowerCase();
  return s.split(/[-_]/)[0].slice(0, 8);
}

/** 时区去掉空白与大小写差异（Asia/Shanghai 与 asia/shanghai 视为同一个） */
function timeZoneKey(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase().slice(0, 64);
}

/**
 * 参与指纹的字段拼装。刻意只取少量公开环境字段：
 * 平台大类、浏览器大类、屏幕、语言主标签、时区、CPU 核数、色深。
 * 不含 IP、网络类型、在线状态、电池、GPU 等易变项。
 */
function fingerprintSource({ userAgent, client } = {}) {
  const c = client && typeof client === 'object' ? client : {};
  return [
    platformClass(userAgent, c),
    browserClass(userAgent),
    screenProfile(c.screen),
    primaryLanguage(c.language),
    timeZoneKey(c.timezone),
    Number(c.hardwareConcurrency) || '',
    Number(c.colorDepth) || '',
  ].join('|');
}

/**
 * 设备指纹：本设备上的每次操作都得到同一个 16 位十六进制短码。
 * 微信 UA 里的 NetType/MMWEBID 等已在上面的归一化里剔除，
 * 因此切换 WiFi / 移动数据不会改变指纹。
 */
function computeFingerprint({ userAgent, client } = {}) {
  return shortHash(fingerprintSource({ userAgent, client }));
}

function isLikelyIp(value) {
  return typeof value === 'string' && /^[0-9a-f:.]+$/i.test(value);
}

function clientIp(req) {
  if (!req) return '';
  const headers = req.headers || {};
  const header = headers['x-forwarded-for'];
  if (typeof header === 'string' && header.trim()) {
    const first = header.split(',')[0].trim();
    if (isLikelyIp(first)) return first;
  }
  const real = headers['x-real-ip'];
  if (typeof real === 'string' && isLikelyIp(real.trim())) return real.trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
}

/** 判断是否内网/保留地址，内网地址不做归属地解析 */
function isPrivateIp(ip) {
  if (!ip) return true;
  const v = ip.replace(/^::ffff:/i, '');
  if (v === '::1' || v === '127.0.0.1' || v.startsWith('127.')) return true;
  if (/^10\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (/^169\.254\./.test(v)) return true;
  if (/^fc|^fd/i.test(v)) return true;
  if (/^fe80:/i.test(v)) return true;
  return false;
}

/** 登录设备名称：从 UA 提取可读的平台/浏览器标签，便于管理员辨认 */
function deviceLabel(ua) {
  const s = String(ua || '');
  if (!s) return '未知设备';
  const platform = /iPhone|iPad|iPod/i.test(s)
    ? 'iOS'
    : /Android/i.test(s)
      ? 'Android'
      : /Windows/i.test(s)
        ? 'Windows'
        : /Macintosh|Mac OS X/i.test(s)
          ? 'macOS'
          : /Linux/i.test(s)
            ? 'Linux'
            : '未知系统';
  const browser = /MicroMessenger/i.test(s)
    ? '微信'
    : /Edg\//i.test(s)
      ? 'Edge'
      : /Chrome\//i.test(s)
        ? 'Chrome'
        : /Safari\//i.test(s)
          ? 'Safari'
          : /Firefox\//i.test(s)
            ? 'Firefox'
            : '未知浏览器';
  return `${platform} · ${browser}`;
}

/** 网络类型：只用于展示，绝不参与指纹计算 */
function networkType(ua) {
  const s = String(ua || '');
  const m = s.match(/NetType\/([^\s;)]+)/i) || s.match(/\b(WIFI|4G|5G|3G|2G)\b/i);
  if (!m) return '未知';
  return m[1].toUpperCase();
}

module.exports = {
  normalizeUserAgent,
  uaSkeleton,
  computeFingerprint,
  clientIp,
  isPrivateIp,
  deviceLabel,
  networkType,
};
