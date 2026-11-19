'use strict';

/**
 * 本地运行时加载 .env。
 *
 * 背景：docker compose 会自动读取项目根目录的 .env，但直接 `npm start` / `npm run dev`
 * 时 Node 不会，导致「按文档把 INIT_ADMIN_PASSWORD 写进 .env 却完全不生效」。
 * 这里在进程启动最早期补上同样的行为，让两种运行方式表现一致。
 *
 * 规则：
 *   - 只读取项目根目录的 .env（可用 ENV_FILE 覆盖路径），文件不存在则静默跳过；
 *   - 不覆盖已存在的真实环境变量，命令行/compose 传入的优先级始终更高；
 *   - 不引入 dotenv 依赖，直接使用 Node 22 内置的 process.loadEnvFile。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(ROOT, '.env');

function loadEnvFile() {
  if (typeof process.loadEnvFile !== 'function') return false;
  if (!fs.existsSync(ENV_FILE)) return false;
  try {
    process.loadEnvFile(ENV_FILE);
    return true;
  } catch (err) {
    console.error(`[env] 读取 ${ENV_FILE} 失败，已忽略：${err.message}`);
    return false;
  }
}

const loaded = loadEnvFile();

module.exports = { ENV_FILE, loaded, loadEnvFile };
