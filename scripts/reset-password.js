'use strict';

/**
 * 重置任意账号密码（应急/运维用）。
 *
 * 用法：
 *   node --experimental-sqlite scripts/reset-password.js --user admin --password 新密码
 *   node --experimental-sqlite scripts/reset-password.js --user admin            # 随机生成
 *
 * 说明：
 *   - 数据目录与容器一致，读 DATA_DIR / DB_PATH 环境变量（默认 ./data/app.db）；
 *   - 重置后清除该账号全部会话，强制重新登录；
 *   - 重置动作写入操作日志（actor=system，标注「命令行重置」）；
 *   - 默认要求新密码至少 8 位，可用 --allow-weak 放宽（不推荐）。
 */

// 与 server.js 一致：先读根目录 .env，命令行脚本也能用同一套配置
require('../src/env');

const path = require('path');
const crypto = require('crypto');
const { openDatabase } = require('../src/db');
const { hashPassword, passwordWeakness } = require('../src/security');
const { nowStamp } = require('../src/util');

function parseArgs(argv) {
  const out = { user: '', password: '', allowWeak: false, unlock: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--user' || a === '-u') out.user = argv[++i] || '';
    else if (a === '--password' || a === '-p') out.password = argv[++i] || '';
    else if (a === '--allow-weak') out.allowWeak = true;
    else if (a === '--unlock') out.unlock = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log(
    [
      '重置账号密码',
      '',
      '  node --experimental-sqlite scripts/reset-password.js --user <账号> [--password <新密码>] [--allow-weak] [--unlock]',
      '',
      '  --user       要重置的账号（必填）',
      '  --password   新密码；省略则随机生成并打印',
      '  --allow-weak 允许少于 8 位的密码',
      '  --unlock     同时把被禁用的账号改回启用状态',
      '',
      '数据位置由 DATA_DIR / DB_PATH 决定，容器内默认 /app/data/app.db。',
    ].join('\n'),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!args.user) {
    console.error('缺少 --user 参数\n');
    usage();
    process.exitCode = 1;
    return;
  }

  let password = args.password;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  if (!args.allowWeak) {
    const weakness = passwordWeakness(password);
    if (weakness) {
      console.error(`${weakness}；如确需弱密码请加 --allow-weak。`);
      process.exitCode = 1;
      return;
    }
  }

  // openDatabase 会执行迁移与初始化；这里只是借助它保证 schema 可用
  const db = openDatabase();
  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(args.user);
    if (!user) {
      console.error(`账号不存在：${args.user}`);
      process.exitCode = 1;
      return;
    }
    const stamp = nowStamp();
    const nextStatus = args.unlock ? 'active' : user.status;
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, status = ?, updated_at = ? WHERE id = ?').run(
      hashPassword(password),
      nextStatus,
      stamp,
      user.id,
    );
    const killed = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id).changes;
    db.prepare(
      `INSERT INTO audit_logs (user_id, actor_name, actor_role, action, target_type, target_id, detail, created_at)
       VALUES (?, 'system', 'system', 'user_reset_password_cli', 'user', ?, ?, ?)`,
    ).run(
      user.id,
      String(user.id),
      `命令行重置 ${user.role} 账号 ${user.username}（${user.display_name}）的密码，已清除 ${killed} 个会话${
        args.unlock ? '，并恢复为启用状态' : ''
      }`,
      stamp,
    );

    console.log('========================================================');
    console.log('  密码重置完成');
    console.log(`  账号：${user.username}（${user.display_name}，${user.role}）`);
    console.log(generated ? `  新密码：${password}  （随机生成，仅本次显示）` : '  新密码：已按参数设置');
    console.log(`  已清除会话：${killed} 个；下次登录后需修改密码`);
    console.log('========================================================');
  } finally {
    db.close();
  }
}

main();
