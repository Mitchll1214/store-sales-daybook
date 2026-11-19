'use strict';

/**
 * 镜像构建期预置 ip2region xdb。
 *
 * 用法：
 *   node scripts/fetch-ipdb.js --out vendor [--fallback node_modules/ip2region/data]
 *
 * 行为：
 *   1. 优先从 ip2region 上游仓库下载最新 v4 xdb，并记录 commit 版本；
 *   2. 下载失败（网络不可用/被墙）时回退复制 npm 包内置 xdb，保证镜像仍可离线构建；
 *   3. 输出 ip2region_v4.xdb + meta.json（含来源、版本、sha256），供运行期展示与版本校验。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'lionsoul2014/ip2region';
const FILE_PATH = 'data/ip2region_v4.xdb';
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/master/${FILE_PATH}`;
const MIN_BYTES = 1024 * 1024;

function parseArgs(argv) {
  const out = { out: 'vendor', fallback: '', strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.out = argv[++i] || out.out;
    else if (arg === '--fallback') out.fallback = argv[++i] || '';
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('node scripts/fetch-ipdb.js --out vendor [--fallback node_modules/ip2region/data] [--strict]');
      process.exit(0);
    }
  }
  return out;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function latestRevision() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(FILE_PATH)}&per_page=1`, {
    headers: { 'User-Agent': 'store-sales-daybook-build', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub 接口返回 ${res.status}`);
  const commits = await res.json();
  if (!Array.isArray(commits) || commits.length === 0) throw new Error('上游未返回提交记录');
  const latest = commits[0];
  return {
    revision: latest.sha || null,
    builtAt: (latest.commit && latest.commit.committer && latest.commit.committer.date) || null,
  };
}

async function download() {
  const res = await fetch(RAW_URL, {
    headers: { 'User-Agent': 'store-sales-daybook-build' },
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < MIN_BYTES) throw new Error(`下载内容过小（${buf.length} 字节），可能是错误页面`);
  return buf;
}

function copyAsset(from, to) {
  if (from && fs.existsSync(from)) {
    fs.copyFileSync(from, to);
    return true;
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  const fallbackDir = args.fallback ? path.resolve(args.fallback) : '';
  fs.mkdirSync(outDir, { recursive: true });

  const target = path.join(outDir, 'ip2region_v4.xdb');
  const metaFile = path.join(outDir, 'meta.json');
  let meta;

  try {
    console.log(`[ipdb] 正在从 ${RAW_URL} 下载…`);
    const [buf, version] = await Promise.all([download(), latestRevision().catch((err) => {
      console.warn(`[ipdb] 获取上游版本号失败（不影响下载）：${err.message}`);
      return { revision: null, builtAt: null };
    })]);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    meta = {
      origin: 'upstream-download',
      source: REPO,
      file: FILE_PATH,
      revision: version.revision,
      builtAt: version.builtAt,
      retrievedAt: new Date().toISOString().slice(0, 10),
      size: buf.length,
      sha256: sha256(buf),
    };
    console.log(`[ipdb] 下载完成：${(buf.length / 1024 / 1024).toFixed(1)} MB，revision ${String(meta.revision).slice(0, 10)}`);
  } catch (err) {
    if (args.strict) {
      console.error(`[ipdb] 下载失败且指定了 --strict：${err.message}`);
      process.exit(1);
    }
    console.warn(`[ipdb] 上游下载失败，回退到 npm 包内置 xdb：${err.message}`);
    const fallbackFile = fallbackDir ? path.join(fallbackDir, 'ip2region_v4.xdb') : '';
    if (!fallbackFile || !fs.existsSync(fallbackFile)) {
      console.error('[ipdb] 未找到可用的回退 xdb，请检查 --fallback 参数或网络。');
      process.exit(1);
    }
    fs.copyFileSync(fallbackFile, target);
    const manifest = (fallbackDir && readJsonSafe(path.join(fallbackDir, 'manifest.json'))) || {};
    const entry = ((manifest.files || []).find((f) => f.family === 4)) || {};
    meta = {
      origin: 'npm-fallback',
      source: REPO,
      file: FILE_PATH,
      revision: (manifest.upstream && manifest.upstream.revision) || null,
      builtAt: entry.builtAt || null,
      retrievedAt: (manifest.upstream && manifest.upstream.retrievedAt) || null,
      size: fs.statSync(target).size,
      sha256: sha256(fs.readFileSync(target)),
    };
    console.log('[ipdb] 已使用 npm 包内置 xdb 作为镜像内置版本。');
  }

  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  // 附带许可证，满足 ip2region 的 Apache-2.0 分发要求
  copyAsset(
    path.join(fallbackDir || path.join(process.cwd(), 'node_modules', 'ip2region', 'data'), 'LICENSE.ip2region.md'),
    path.join(outDir, 'LICENSE.ip2region.md'),
  );
  console.log(`[ipdb] 已写入 ${target} 与 ${metaFile}`);
}

main().catch((err) => {
  console.error('[ipdb] 预置失败：', err);
  process.exit(1);
});
