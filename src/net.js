'use strict';

/**
 * 客户端 IP 与设备指纹。
 *
 * 指纹目标：同一台设备切换 IP、切换网络（WiFi/4G/5G）时保持不变。
 * 因此只采用「设备固有」信息：前端 zxcvbn 不可用，这里用 UA 模板 + 屏幕 + 时区 + 语言 + 平台。
 * UA 在微信 WebView 中会夹带网络类型（如 `NetType/WIFI`、`NetType/4G`），
 * 拼接顺序和时区等字段也会随网络切换而变化，所以先做归一化再计算。
 */

const COUNTRY_TLDS = /^[a-z]{2,3}$/i;

/** 从 UA 中剥离网络类型标记、代理/隧道标识、被运营商注入的字段 */
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
  s = s.replace(/\bMicroMessenger\/[\d.]+/gi, 'MicroMessenger');
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** UA 主体：去掉版本号、App 构建号与语言标记，避免 App 升级/切换语言导致指纹漂移 */
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

/**
 * 由服务端可控字段计算稳定指纹。
 * client 为前端上报的稳定设备特征（screen/timezone/language/platform/hardwareConcurrency 等）。
 */
function computeFingerprint({ userAgent, client }) {
  const parts = [
    uaSkeleton(userAgent),
    client && client.screen ? String(client.screen) : '',
    client && client.timezone ? String(client.timezone) : '',
    client && client.language ? String(client.language) : '',
    client && client.platform ? String(client.platform) : '',
    client && client.hardwareConcurrency ? String(client.hardwareConcurrency) : '',
    client && client.deviceMemory ? String(client.deviceMemory) : '',
    client && client.colorDepth ? String(client.colorDepth) : '',
  ];
  return parts.filter(Boolean).join('|');
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
