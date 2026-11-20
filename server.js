'use strict';

// 必须最先加载：让本地 `npm start` 也能读到根目录 .env（docker compose 由 compose 自己注入）
require('./src/env');

const path = require('path');
const express = require('express');
const { openDatabase, closeDatabase } = require('./src/db');
const { IpDatabase } = require('./src/ipdb');
const { Audit } = require('./src/audit');
const { Auth, homePath, parseCookies, COOKIE_NAME } = require('./src/auth');
const { LoginLimiter } = require('./src/security');
const { PUBLIC_DIR, DATA_DIR, asyncHandler, todayStr } = require('./src/util');
const { createAuthRoutes, publicUser } = require('./src/routes/auth');
const { createStoreRoutes } = require('./src/routes/stores');
const { createProductRoutes } = require('./src/routes/catalog');
const { createUserRoutes } = require('./src/routes/users');
const { createSalesRoutes } = require('./src/routes/sales');
const { createReportRoutes } = require('./src/routes/reports');
const { createLogRoutes } = require('./src/routes/logs');
const { createBackupRoutes } = require('./src/routes/backup');
const { startAutoBackup } = require('./src/backup');

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function createApp() {
  const db = openDatabase();
  const ipdb = new IpDatabase();
  await ipdb.init();

  const audit = new Audit(db, ipdb);
  const auth = new Auth(db);
  const limiter = new LoginLimiter();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(auth.middleware());

  // 健康检查（供 Docker healthcheck 使用）
  app.get('/healthz', (req, res) => {
    res.json({ ok: true, today: todayStr(), version: '1.0.0' });
  });

  app.use('/api/auth', createAuthRoutes({ db, auth, audit, limiter }));
  app.use('/api/stores', createStoreRoutes({ db, audit }));
  app.use('/api/products', createProductRoutes({ db, audit }));
  app.use('/api/users', createUserRoutes({ db, audit }));
  app.use('/api/sales', createSalesRoutes({ db, audit }));
  app.use('/api/reports', createReportRoutes({ db, audit }));
  app.use('/api/logs', createLogRoutes({ db, audit, ipdb }));
  app.use('/api/backup', createBackupRoutes({ db, audit }));

  app.get(
    '/api/me',
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: '请先登录', code: 'UNAUTHENTICATED' });
      res.json({ user: publicUser(req.user) });
    }),
  );

  /** 页面路由：服务端仅做会话判定与跳转，页面逻辑在前端 JS */
  app.get('/', (req, res) => res.redirect(req.user ? homePath(req.user) : '/login'));

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(homePath(req.user));
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  app.get('/admin', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role !== 'admin' && req.user.role !== 'region_admin') return res.redirect('/clerk');
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });

  app.get('/clerk', (req, res) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role !== 'clerk' && !req.user.autoLogin) return res.redirect('/admin');
    res.sendFile(path.join(PUBLIC_DIR, 'clerk.html'));
  });

  app.get('/password', (req, res) => {
    if (!req.user) return res.redirect('/login');
    res.sendFile(path.join(PUBLIC_DIR, 'password.html'));
  });

  /** 免登录门店链接：一次性兑换会话后跳转店员页 */
  app.get(
    '/s/:token',
    asyncHandler(async (req, res) => {
      const result = auth.autoLogin(req, res, req.params.token);
      if (!result.ok) {
        audit.log(req, {
          action: 'auto_login_failed',
          targetType: 'store',
          targetId: result.store ? result.store.id : null,
          detail: `${result.reason}（token 前缀 ${String(req.params.token).slice(0, 6)}…）`,
        });
        return res.status(403).send(renderMessage('免登录链接不可用', result.reason));
      }
      audit.log(req, {
        action: 'auto_login',
        targetType: 'store',
        targetId: result.store.id,
        detail: `通过免登录链接进入门店 ${result.store.code} ${result.store.name}`,
        actor: {
          // 门店已经单独占两行展示，这里只标出「怎么进来的」，避免重复一遍店名
          name: '免登录链接',
          role: 'clerk',
          storeCode: result.store.code,
          storeName: result.store.name,
        },
      });
      return res.redirect('/clerk');
    }),
  );

  // 静态资源（不使用目录索引，避免暴露目录结构）
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-store');
          return;
        }
        // CSS/JS 文件名没有内容指纹（始终是 app.css、common.js），若允许强缓存，
        // 重建镜像后浏览器会拿「新 HTML + 旧缓存资源」，登录页等页面会错版。
        // 改为每次协商：ETag 命中即 304，几乎零开销，也不会再出现版本错配。
        res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: '接口不存在' });
    }
    return res.status(404).send(renderMessage('页面不存在', '请检查链接是否正确'));
  });

  // 统一错误处理：区分客户端错误与服务器错误，避免泄漏堆栈
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) {
      console.error('[error]', req.method, req.originalUrl, err);
    }
    const message =
      status >= 500 ? '服务器内部错误，请稍后重试' : err.message || '请求处理失败';
    if (req.path.startsWith('/api/') || req.accepts(['json', 'html']) === 'json') {
      return res.status(status).json({ error: message, code: err.code || undefined });
    }
    return res.status(status).send(renderMessage('请求处理失败', message));
  });

  // 定期清理过期会话
  const sweeper = setInterval(() => {
    try {
      auth.purgeExpired();
    } catch (err) {
      console.error('[session] 清理失败', err.message);
    }
  }, 3600 * 1000);
  sweeper.unref();

  // 定时自动备份：备份不能只靠管理员手动点，否则没人点就等于没有备份。
  // 只用 AUTO_BACKUP_HOURS=0 可关闭；内部异常只记日志，不影响主服务。
  const autoBackup = startAutoBackup(db);

  return { app, db, ipdb, audit, auth, autoBackup };
}

function renderMessage(title, detail) {
  const safeTitle = String(title).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const safeDetail = String(detail || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle} · 店销日集</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937}
  .card{background:#fff;border-radius:16px;padding:32px 28px;max-width:420px;margin:16px;
    box-shadow:0 8px 30px rgba(15,23,42,.08);text-align:center}
  h1{font-size:18px;margin:0 0 8px}
  p{margin:0;color:#64748b;font-size:14px;line-height:1.6}
  a{display:inline-block;margin-top:20px;color:#0f766e;text-decoration:none;font-size:14px}
</style></head>
<body><div class="card"><h1>${safeTitle}</h1><p>${safeDetail}</p>
<a href="/login">返回登录</a></div></body></html>`;
}

if (require.main === module) {
  createApp()
    .then(({ app, db }) => {
      const server = app.listen(PORT, HOST, () => {
        console.log(`店销日集已启动：http://${HOST}:${PORT}  （数据目录 ${DATA_DIR}）`);
      });

      // docker compose stop / restart 默认发 SIGTERM，此前没有处理，进程被直接杀掉，
      // 未 checkpoint 的 -wal 留在数据卷里，下次启动就可能自检判损坏并清库。
      // 这里先把 WAL 合并进主库再退出；重复信号只生效一次。
      let closing = false;
      const shutdown = (signal) => {
        if (closing) return;
        closing = true;
        console.log(`[server] 收到 ${signal}，正在优雅关闭…`);

        let done = false;
        let timer = null;
        const finish = (reason) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          closeDatabase(db, reason);
          process.exit(0);
        };

        // 这个定时器**不能 unref**：它同时承担「保活」职责。若 unref，一旦 server.close
        // 因 keep-alive 连接迟迟不回调，事件循环就没有任何待办，进程会直接退出，
        // 收尾代码永远执行不到（实测 WAL 残留 300KB 未合并）。
        timer = setTimeout(() => finish(`${signal} 超时强制关闭`), 8000);

        // 先停止接收新请求，再收尾数据库：避免关库瞬间还有写事务在跑。
        server.close(() => finish(signal));
        // keep-alive 空闲连接不会自己断，server.close 会一直等它们；主动清理掉。
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((err) => {
      console.error('启动失败：', err);
      process.exit(1);
    });
}

module.exports = { createApp, renderMessage };
