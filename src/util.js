'use strict';

const path = require('path');

const TZ_OFFSET = Number.parseInt(process.env.APP_TZ_OFFSET ?? '8', 10) || 0;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PERIODS = ['am', 'pm'];
const PERIOD_LABEL = { am: '上午', pm: '下午' };
const MAKEUP_DEADLINE_HOUR = 12;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 业务时区下的“当前时间”，用 getUTC* 读取即为本地时间 */
function localNow() {
  return new Date(Date.now() + TZ_OFFSET * 3600 * 1000);
}

function dateStrOf(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function stampOf(d) {
  return `${dateStrOf(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function todayStr() {
  return dateStrOf(localNow());
}

function nowStamp() {
  return stampOf(localNow());
}

function localHour() {
  const d = localNow();
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return dateStrOf(new Date(Date.UTC(y, m - 1, d) + n * 86400000));
}

function diffDays(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function isDateStr(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  return dateStrOf(new Date(t)) === v;
}

function dateRange(from, to) {
  const list = [];
  if (!isDateStr(from) || !isDateStr(to) || from > to) return list;
  const span = diffDays(from, to);
  for (let i = 0; i <= span; i += 1) list.push(addDays(from, i));
  return list;
}

/**
 * 各时段的展示状态。
 * done 已提交 / due 待提交 / makeup 可补交 / overdue 逾期 / future 未到
 * 今日两个时段在 24 点前都可填报，因此今日未提交统一显示“待提交”，
 * 与 canEditPeriod 的判定保持一致，避免出现“显示逾期却还能填写”的矛盾。
 */
function periodState(bizDate, period, done) {
  if (done) return 'done';
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const hour = localHour();
  if (bizDate === today) return 'due';
  if (bizDate === yesterday) {
    return hour < MAKEUP_DEADLINE_HOUR ? 'makeup' : 'overdue';
  }
  return bizDate > today ? 'future' : 'overdue';
}

/** 今日两个时段均可填；昨日仅在 12:00 前可补交 */
function canEditPeriod(bizDate, period) {
  if (!PERIODS.includes(period) || !isDateStr(bizDate)) return false;
  const today = todayStr();
  if (bizDate === today) return true;
  if (bizDate === addDays(today, -1)) return localHour() < MAKEUP_DEADLINE_HOUR;
  return false;
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || undefined;
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel 友好的 CSV：BOM + CRLF */
function toCsv(rows) {
  return `\ufeff${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function percent(done, expected) {
  if (!expected) return 0;
  return Math.round((done / expected) * 1000) / 10;
}

function chunkArray(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** 从粘贴文本解析门店：每行「编码 + 名称」，支持制表符/逗号/空白分隔 */
function parseStoreLines(text) {
  const rows = [];
  const errors = [];
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  lines.forEach((line, idx) => {
    const parts = line.split(/\t|,|，|\s{2,}|\s+/).filter(Boolean);
    const code = (parts[0] || '').trim();
    const name = parts.slice(1).join(' ').trim();
    if (!code || !name) {
      errors.push(`第 ${idx + 1} 行格式无法识别：${line}`);
      return;
    }
    if (code.length > 64) errors.push(`第 ${idx + 1} 行编码过长：${code}`);
    if (name.length > 120) errors.push(`第 ${idx + 1} 行名称过长：${name}`);
    rows.push({ code, name });
  });
  return { rows, errors };
}

module.exports = {
  TZ_OFFSET,
  ROOT,
  DATA_DIR,
  UPLOAD_DIR,
  PUBLIC_DIR,
  PERIODS,
  PERIOD_LABEL,
  MAKEUP_DEADLINE_HOUR,
  pad,
  localNow,
  dateStrOf,
  stampOf,
  todayStr,
  nowStamp,
  localHour,
  addDays,
  diffDays,
  isDateStr,
  dateRange,
  periodState,
  canEditPeriod,
  HttpError,
  asyncHandler,
  toCsv,
  percent,
  chunkArray,
  parseStoreLines,
};
