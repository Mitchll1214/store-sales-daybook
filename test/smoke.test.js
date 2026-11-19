'use strict';

/* 端到端冒烟：真实启动 HTTP 服务，用 fetch 走完整业务链路 */

const assert = require('assert');
const os = require('os');
const path = require('path');

const ROOT = process.cwd();
// 允许指定临时目录（不同用例并行），默认落在系统临时目录，避免污染仓库
const TMP = process.argv[2] || path.join(os.tmpdir(), `store-sales-daybook-test-${process.pid}`);
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.INIT_ADMIN_PASSWORD = 'admin-pass-123';
process.env.PUBLIC_BASE_URL = '';

const { createApp } = require(path.join(ROOT, 'server.js'));

function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(res) {
      const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of all) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (!v) cookies.delete(k);
        else cookies.set(k, v);
      }
    },
  };
}

async function main() {
  const { app, db, ipdb } = await createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = jar();
  async function call(method, url, body, opts = {}) {
    const headers = { 'x-device-id': opts.deviceId || 'dev-test-1' };
    if (opts.session) headers.cookie = opts.session.header();
    if (opts.ua) headers['user-agent'] = opts.ua;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    if (opts.session) opts.session.absorb(res);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  const failures = [];
  async function check(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      console.log(`  ✗ ${name} → ${err.message}`);
    }
  }

  console.log('\n[1] 认证与权限');
  let token = null;
  await check('未登录访问 /api/me 返回 401', async () => {
    const r = await call('GET', '/api/me');
    assert.strictEqual(r.status, 401);
  });
  await check('错误密码返回 401', async () => {
    const r = await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
    assert.strictEqual(r.status, 401);
  });
  await check('管理员登录成功', async () => {
    const r = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin-pass-123' }, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    token = admin.header();
    assert.ok(token.includes('ssd_sid'));
  });
  await check('/api/me 返回管理员身份', async () => {
    const r = await call('GET', '/api/me', undefined, { session: admin });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.user.role, 'admin');
  });

  console.log('\n[2] 门店 / 商品 / 账号');
  await check('批量粘贴新增门店（制表符与空格混排）', async () => {
    const text = ['S001\t上海一店', 'S002  上海二店', 'S003,广州一店', 'S001 重复编码'].join('\n');
    const r = await call('POST', '/api/stores/batch', { text }, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.created.length, 3);
    assert.strictEqual(r.data.skipped.length, 1);
  });
  await check('门店自动生成免登录链接且带编码名称参数', async () => {
    const r = await call('GET', '/api/stores', undefined, { session: admin });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.rows.length, 3);
    const s = r.data.rows[0];
    assert.ok(s.autoLoginToken, '缺少 token');
    assert.ok(s.autoLoginUrl.includes('/s/'), s.autoLoginUrl);
    assert.ok(s.autoLoginUrl.includes('c=S001'), s.autoLoginUrl);
    assert.ok(/n=%E4%B8%8A%E6%B5%B7/.test(s.autoLoginUrl), s.autoLoginUrl);
    assert.strictEqual(s.autoLoginEnabled, true);
  });
  await check('修改门店名称与状态', async () => {
    const list = await call('GET', '/api/stores', undefined, { session: admin });
    const s3 = list.data.rows.find((s) => s.code === 'S003');
    const r = await call('PUT', `/api/stores/${s3.id}`, { code: 'S003', name: '广州一店', status: 'active' }, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.store.name, '广州一店');
  });
  let products = [];
  await check('创建商品（含别名、条码、品类与属性）', async () => {
    for (const p of [
      { name: '农夫山泉550ml', alias: '矿泉水', barcode: '6921168509256', category: '饮料', kind: 'own' },
      { name: '可口可乐330ml', alias: '可乐', barcode: '6928804011189', category: '饮料', kind: 'comp' },
      { name: '伊利纯牛奶250ml', alias: '纯牛奶', barcode: '', category: '乳品', kind: 'own' },
    ]) {
      const r = await call('POST', '/api/products', p, { session: admin });
      assert.strictEqual(r.status, 201, JSON.stringify(r.data));
      products.push(r.data.product);
    }
    assert.deepStrictEqual(products.map((p) => p.category), ['饮料', '饮料', '乳品']);
    assert.deepStrictEqual(products.map((p) => p.kind), ['own', 'comp', 'own']);
    assert.strictEqual(products[0].kindLabel, '本品');
    assert.strictEqual(products[1].kindLabel, '竞品');
  });
  await check('商品列表返回已有品类与属性选项', async () => {
    const r = await call('GET', '/api/products', undefined, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual(r.data.categories.slice().sort(), ['乳品', '饮料'].sort());
    assert.deepStrictEqual(r.data.kinds.map((k) => k.value), ['own', 'comp']);
  });
  await check('批量导入支持品类与属性', async () => {
    const text = ['面包\t现烤面包\t\t烘焙\t本品', '薯片\t薯片\t\t零食\t竞品'].join('\n');
    const r = await call('POST', '/api/products/batch', { text }, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.created.length, 2);
    assert.deepStrictEqual(
      r.data.created.map((p) => `${p.category}/${p.kind}`),
      ['烘焙/own', '零食/comp'],
    );
    // 批量导入只回显字段不含 id，按名称回查后清理，避免影响后续统计
    const list = await call('GET', '/api/products', undefined, { session: admin });
    for (const name of ['面包', '薯片']) {
      const row = list.data.rows.find((p) => p.name === name);
      assert.ok(row, `缺少导入的商品 ${name}`);
      const del = await call('DELETE', `/api/products/${row.id}`, undefined, { session: admin });
      assert.strictEqual(del.status, 200, JSON.stringify(del.data));
    }
  });
  await check('重复条码被拒绝', async () => {
    const r = await call('POST', '/api/products', { name: 'X', alias: 'X', barcode: '6921168509256' }, { session: admin });
    assert.strictEqual(r.status, 409);
  });
  let clerk;
  let clerkStore;
  await check('创建店员账号', async () => {
    const list = await call('GET', '/api/stores', undefined, { session: admin });
    clerkStore = list.data.rows.find((s) => s.code === 'S001');
    const r = await call(
      'POST',
      '/api/users',
      { username: 'clerk001', displayName: '张三', role: 'clerk', password: 'clerk-pass-123', storeId: clerkStore.id },
      { session: admin },
    );
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    clerk = r.data.user;
    assert.strictEqual(clerk.storeCode, 'S001');
  });
  // 区域管理员不经「区域」这一层，直接管辖若干门店
  let scopedStores = [];
  await check('创建区域管理员（管辖 S001、S002）', async () => {
    const list = await call('GET', '/api/stores', undefined, { session: admin });
    scopedStores = ['S001', 'S002'].map((code) => list.data.rows.find((s) => s.code === code));
    const r = await call(
      'POST',
      '/api/users',
      {
        username: 'multiadmin',
        displayName: '李四',
        role: 'region_admin',
        password: 'region-pass-123',
        storeIds: scopedStores.map((s) => s.id),
      },
      { session: admin },
    );
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.deepStrictEqual(
      r.data.user.storeIds.slice().sort((a, b) => a - b),
      scopedStores.map((s) => s.id).sort((a, b) => a - b),
    );
    assert.deepStrictEqual(r.data.user.storeNames.slice().sort(), ['上海一店', '上海二店']);
    // 数据范围列只显示门店编码，后端一并返回，便于前端换行展示
    assert.deepStrictEqual(r.data.user.storeCodes.slice().sort(), ['S001', 'S002']);
  });
  await check('区域管理员不选门店被拒绝', async () => {
    const r = await call(
      'POST',
      '/api/users',
      { username: 'noscope', displayName: '王五', role: 'region_admin', password: 'noscope-pass-123', storeIds: [] },
      { session: admin },
    );
    assert.strictEqual(r.status, 400, JSON.stringify(r.data));
  });
  await check('门店关联部分商品（S002 只关联两个商品）', async () => {
    const list = await call('GET', '/api/stores', undefined, { session: admin });
    const s2 = list.data.rows.find((s) => s.code === 'S002');
    const r = await call('PUT', `/api/stores/${s2.id}/products`, { productIds: [products[0].id, products[1].id] }, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.linkedCount, 2);
  });

  console.log('\n[3] 店员填报（引导式）');
  const store = jar();
  await check('店员登录', async () => {
    const r = await call('POST', '/api/auth/login', { username: 'clerk001', password: 'clerk-pass-123' }, { session: store });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  });
  await check('店员首页展示今天与昨天两个时段', async () => {
    const r = await call('GET', '/api/sales/home', undefined, { session: store });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.slots.length, 2);
    assert.strictEqual(r.data.slots[0].periods.length, 2);
    assert.strictEqual(r.data.slots[0].periods[0].state, 'due');
    assert.ok(r.data.productCount >= 3);
  });
  await check('填报会话只返回别名，不返回真实品名与条码', async () => {
    const r = await call('GET', '/api/sales/session?period=am', undefined, { session: store });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const raw = JSON.stringify(r.data);
    assert.ok(!raw.includes('农夫山泉'), '泄漏真实品名');
    assert.ok(!raw.includes('6921168509256'), '泄漏条码');
    assert.ok(raw.includes('矿泉水'), '缺少别名');
    assert.ok(r.data.nextProduct, '缺少下一个商品');
  });
  await check('逐个确认商品，返回下一个待填商品', async () => {
    let guard = 0;
    let next = null;
    const session = await call('GET', '/api/sales/session?period=am', undefined, { session: store });
    next = session.data.nextProduct;
    while (next) {
      const r = await call(
        'PUT',
        '/api/sales/entry',
        { date: session.data.date, period: 'am', productId: next.id, qty: 2 },
        { session: store },
      );
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      assert.ok(r.data.progress.done <= r.data.progress.total);
      next = r.data.nextProduct;
      guard += 1;
      if (guard > 20) throw new Error('商品队列未结束');
    }
    assert.ok(guard >= 3, `仅填写了 ${guard} 个商品`);
  });
  await check('未全部确认时提交被拒绝', async () => {
    const r = await call('POST', '/api/sales/submit', { date: new Date().toISOString().slice(0, 10), period: 'pm' }, { session: store });
    assert.strictEqual(r.status, 409, JSON.stringify(r.data));
  });
  let today = null;
  await check('上午提交成功', async () => {
    const session = await call('GET', '/api/sales/session?period=am', undefined, { session: store });
    today = session.data.date;
    const r = await call('POST', '/api/sales/submit', { date: today, period: 'am' }, { session: store });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.totalQty > 0, true);
  });
  await check('重复提交被拒绝', async () => {
    const r = await call('POST', '/api/sales/submit', { date: today, period: 'am' }, { session: store });
    assert.strictEqual(r.status, 409);
  });
  await check('提交后不可再改条目', async () => {
    const r = await call('PUT', '/api/sales/entry', { date: today, period: 'am', productId: products[0].id, qty: 9 }, { session: store });
    assert.strictEqual(r.status, 409);
  });
  await check('店员首页显示上午已完成、下午待填', async () => {
    const r = await call('GET', '/api/sales/home', undefined, { session: store });
    assert.strictEqual(r.data.slots[0].periods[0].done, true);
    assert.strictEqual(r.data.slots[0].periods[1].done, false);
  });
  await check('下午一键记 0 后可直接提交', async () => {
    const f = await call('POST', '/api/sales/fill-zero', { date: today, period: 'pm' }, { session: store });
    assert.strictEqual(f.status, 200, JSON.stringify(f.data));
    assert.strictEqual(f.data.readyToSubmit, true);
    const r = await call('POST', '/api/sales/submit', { date: today, period: 'pm' }, { session: store });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  });
  await check('昨日补交受 12:00 截止时间约束', async () => {
    // 用例本身不能依赖运行时时钟：12:00 前应可补交，12:00 后应锁定
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const r = await call('PUT', '/api/sales/entry', { date: y, period: 'am', productId: products[0].id, qty: 1 }, { session: store });
    if (new Date().getHours() < 12) {
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    } else {
      assert.strictEqual(r.status, 409, JSON.stringify(r.data));
    }
  });
  await check('店员无权访问门店管理与用户管理', async () => {
    const a = await call('GET', '/api/stores', undefined, { session: store });
    const b = await call('GET', '/api/users', undefined, { session: store });
    assert.strictEqual(a.status, 403);
    assert.strictEqual(b.status, 403);
  });

  console.log('\n[4] 免登录门店链接');
  await check('门店链接可直接进入店员页', async () => {
    const auto = jar();
    const r = await call('GET', `/s/${clerkStore.autoLoginToken}?c=S001&n=test`, undefined, { session: auto });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/clerk');
    const home = await call('GET', '/api/sales/home', undefined, { session: auto });
    assert.strictEqual(home.status, 200);
    assert.strictEqual(home.data.store.code, 'S001');
    assert.strictEqual(home.data.autoLogin, true);
  });
  await check('关闭开关后链接失效', async () => {
    const off = await call('PATCH', `/api/stores/${clerkStore.id}/auto-login`, { enabled: false }, { session: admin });
    assert.strictEqual(off.status, 200);
    const auto = jar();
    const r = await call('GET', `/s/${clerkStore.autoLoginToken}`, undefined, { session: auto });
    assert.strictEqual(r.status, 403);
    await call('PATCH', `/api/stores/${clerkStore.id}/auto-login`, { enabled: true }, { session: admin });
  });
  await check('重置链接后旧 token 失效，新 token 可用', async () => {
    const oldToken = clerkStore.autoLoginToken;
    const rot = await call('POST', `/api/stores/${clerkStore.id}/rotate-token`, {}, { session: admin });
    assert.strictEqual(rot.status, 200, JSON.stringify(rot.data));
    const newToken = rot.data.store.autoLoginToken;
    assert.notStrictEqual(newToken, oldToken);
    const j1 = jar();
    const r1 = await call('GET', `/s/${oldToken}`, undefined, { session: j1 });
    assert.strictEqual(r1.status, 403);
    const j2 = jar();
    const r2 = await call('GET', `/s/${newToken}`, undefined, { session: j2 });
    assert.strictEqual(r2.status, 302);
  });
  await check('二维码返回 SVG', async () => {
    const res = await fetch(`${base}/api/stores/${clerkStore.id}/qrcode`, {
      headers: { cookie: admin.header() },
    });
    const text = await res.text();
    assert.strictEqual(res.status, 200);
    assert.ok(text.includes('<svg'), text.slice(0, 80));
  });

  console.log('\n[5] 报表与门店隔离');
  await check('7 日看板返回 日期-门店编码-完成率', async () => {
    const r = await call('GET', '/api/reports/recent?days=7', undefined, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.dates.length, 7);
    assert.ok(r.data.rows.length >= 21);
    const row = r.data.rows[0];
    assert.ok('date' in row && 'storeCode' in row && 'rate' in row);
  });
  await check('单日总览逐门店统计', async () => {
    const r = await call('GET', `/api/reports/day?date=${today}`, undefined, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.totals.stores, 3);
    assert.strictEqual(r.data.totals.expected, 6);
    assert.strictEqual(r.data.totals.done, 2);
    assert.strictEqual(r.data.totals.rate, 33.3);
    assert.strictEqual(r.data.stores.length, 3);
    const s1 = r.data.stores.find((x) => x.storeCode === 'S001');
    assert.strictEqual(s1.done, 2);
    assert.strictEqual(s1.rate, 100);
    assert.ok(!('regions' in r.data), '不应再返回区域维度');
  });
  await check('门店完成率卡片', async () => {
    const r = await call('GET', `/api/reports/stores?from=${today}&to=${today}`, undefined, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.stores.length, 3);
    const s1 = r.data.stores.find((x) => x.storeCode === 'S001');
    assert.strictEqual(s1.done, 2);
    assert.strictEqual(s1.expected, 2);
    assert.strictEqual(s1.rate, 100);
    assert.strictEqual(r.data.totals.rate, 33.3);
  });
  await check('明细按日期折叠，含商品条目', async () => {
    const r = await call('GET', `/api/reports/detail?from=${today}&to=${today}`, undefined, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.dates.length, 1);
    const d = r.data.dates[0];
    assert.strictEqual(d.done, 2);
    assert.strictEqual(d.stores.length, 1);
    assert.ok(d.stores[0].periods.am.items.length >= 3);
  });
  await check('导出 CSV 含表头与合计', async () => {
    const res = await fetch(`${base}/api/reports/export?from=${today}&to=${today}`, {
      headers: { cookie: admin.header() },
    });
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(res.headers.get('content-type').includes('text/csv'), '类型不是 CSV');
    assert.ok(text.includes('门店编码') && text.includes('数量'));
    assert.ok(!text.includes('金额'), 'CSV 不应再包含金额列');
    assert.ok(text.includes('S001'));
    assert.ok(text.includes('合计'));
    assert.ok(/filename\*=UTF-8''/.test(res.headers.get('content-disposition') || ''));
  });
  const multi = jar();
  await check('区域管理员登录并只看到所辖门店', async () => {
    const login = await call('POST', '/api/auth/login', { username: 'multiadmin', password: 'region-pass-123' }, { session: multi });
    assert.strictEqual(login.status, 200, JSON.stringify(login.data));
    const stores = await call('GET', '/api/stores', undefined, { session: multi });
    assert.strictEqual(stores.status, 200);
    assert.deepStrictEqual(stores.data.rows.map((s) => s.code).sort(), ['S001', 'S002']);
  });
  await check('区域管理员可查看免登录链接与二维码', async () => {
    const stores = await call('GET', '/api/stores', undefined, { session: multi });
    const s = stores.data.rows[0];
    assert.ok(s.autoLoginUrl, '看不到链接');
    const qr = await fetch(`${base}/api/stores/${s.id}/qrcode`, { headers: { cookie: multi.header() } });
    assert.strictEqual(qr.status, 200);
  });
  await check('区域管理员不能修改门店信息', async () => {
    const stores = await call('GET', '/api/stores', undefined, { session: multi });
    const r = await call('PUT', `/api/stores/${stores.data.rows[0].id}`, { name: '改名' }, { session: multi });
    assert.strictEqual(r.status, 403);
  });
  await check('区域管理员不能查看未授权门店', async () => {
    const all = await call('GET', '/api/stores', undefined, { session: admin });
    const other = all.data.rows.find((s) => s.code === 'S003');
    const r = await call('GET', `/api/stores/${other.id}`, undefined, { session: multi });
    assert.strictEqual(r.status, 403);
  });
  await check('区域管理员账号列表只含所辖门店店员', async () => {
    const r = await call('GET', '/api/users', undefined, { session: multi });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.rows.every((u) => u.role === 'clerk' && ['S001', 'S002'].includes(u.storeCode)));
  });
  await check('区域管理员报表只统计所辖门店', async () => {
    const r = await call('GET', `/api/reports/day?date=${today}`, undefined, { session: multi });
    assert.strictEqual(r.data.totals.stores, 2);
    assert.strictEqual(r.data.totals.expected, 4);
    assert.strictEqual(r.data.totals.done, 2);
    assert.deepStrictEqual(r.data.stores.map((s) => s.storeCode).sort(), ['S001', 'S002']);
  });

  console.log('\n[5.1] 概览柱形图（区域管理员 × 商品）');
  await check('概览按区域管理员分组，未绑定门店单独成组', async () => {
    const r = await call('GET', `/api/reports/manager-day?date=${today}`, undefined, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual(r.data.kindOrder, ['own', 'comp']);
    assert.strictEqual(r.data.groups.length, 2);
    const bound = r.data.groups.find((g) => g.managerUsername === 'multiadmin');
    const unbound = r.data.groups.find((g) => g.managerId === null);
    assert.ok(bound, '缺少区域管理员分组');
    assert.ok(unbound, '缺少未绑定分组');
    assert.deepStrictEqual(bound.stores.map((s) => s.storeCode), ['S001', 'S002']);
    assert.deepStrictEqual(unbound.stores.map((s) => s.storeCode), ['S003']);
    assert.strictEqual(unbound.storeCount, 1);
  });
  await check('分组内按品类汇总，含本品/竞品与完成率', async () => {
    const r = await call('GET', `/api/reports/manager-day?date=${today}`, undefined, { session: admin });
    const bound = r.data.groups.find((g) => g.managerUsername === 'multiadmin');
    assert.strictEqual(bound.completion.done, 2);
    assert.strictEqual(bound.completion.expected, 4);
    assert.strictEqual(bound.completion.rate, 50);
    const drink = bound.categories.find((c) => c.name === '饮料');
    assert.ok(drink, '缺少饮料品类');
    assert.ok(drink.own > 0, '本品应有销量');
    assert.strictEqual(drink.total, drink.own + drink.comp);
    const s2 = bound.stores.find((s) => s.storeCode === 'S002');
    assert.strictEqual(s2.completion.rate, 0, '未提交门店完成率应为 0');
    assert.strictEqual(s2.totalQty, 0);
    assert.ok(s2.categories.length > 0, '未提交商品也应按 0 列出品类');
    assert.ok(s2.categories.every((c) => c.own === 0 && c.comp === 0));
  });
  await check('逐商品输出：每个商品各一柱，缺失补 0', async () => {
    const r = await call('GET', `/api/reports/manager-day?date=${today}`, undefined, { session: admin });
    const bound = r.data.groups.find((g) => g.managerUsername === 'multiadmin');
    // 顶层给出全量商品顺序，前端据此对齐各组的柱子列
    assert.ok(Array.isArray(r.data.products) && r.data.products.length > 0, '缺少顶层 products');
    for (const p of products) {
      assert.ok(
        r.data.products.some((x) => x.productId === p.id),
        `顶层商品顺序缺少 ${p.name}`,
      );
      const item = bound.products.find((x) => x.productId === p.id);
      assert.ok(item, `分组商品明细缺少 ${p.name}`);
      assert.strictEqual(item.kind, p.kind, `${p.name} 属性应为 ${p.kind}`);
      assert.strictEqual(item.category, p.category);
    }
    // 未提交的门店也要为每个商品留一根 0 柱
    const s2 = bound.stores.find((s) => s.storeCode === 'S002');
    for (const p of products) {
      const item = s2.products.find((x) => x.productId === p.id);
      assert.ok(item, `未提交门店缺少商品 ${p.name}`);
      assert.strictEqual(item.qty, 0, `未提交门店的 ${p.name} 应为 0`);
    }
    // 分组商品数量 = 所辖门店同一商品之和
    for (const item of bound.products) {
      const sum = bound.stores.reduce((acc, store) => {
        const hit = store.products.find((x) => x.productId === item.productId);
        return acc + (hit ? hit.qty : 0);
      }, 0);
      assert.strictEqual(item.qty, sum, `${item.name} 分组合计应等于门店之和`);
    }
    assert.ok(
      bound.products.some((x) => x.kind === 'own' && x.qty > 0),
      '本品应有销量用于高亮展示',
    );
  });
  await check('未分类商品归入「未分类」且排在最后', async () => {
    const noCat = await call('POST', '/api/products', { name: '杂项', alias: '杂项', category: '' }, { session: admin });
    assert.strictEqual(noCat.status, 201, JSON.stringify(noCat.data));
    const r = await call('GET', `/api/reports/manager-day?date=${today}`, undefined, { session: admin });
    const bound = r.data.groups.find((g) => g.managerUsername === 'multiadmin');
    assert.strictEqual(bound.categories[bound.categories.length - 1].name, '未分类');
    const del = await call('DELETE', `/api/products/${noCat.data.product.id}`, undefined, { session: admin });
    assert.strictEqual(del.status, 200, JSON.stringify(del.data));
  });
  await check('区域管理员的概览只按所辖门店统计', async () => {
    const r = await call('GET', `/api/reports/manager-day?date=${today}`, undefined, { session: multi });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.groups.length, 1, '不应出现未绑定或其他管理员分组');
    assert.deepStrictEqual(r.data.groups[0].stores.map((s) => s.storeCode), ['S001', 'S002']);
  });

  console.log('\n[6] 操作日志与 IP 库');
  await check('日志包含登录、创建、提交、导出等动作', async () => {
    const r = await call('GET', '/api/logs?pageSize=100', undefined, { session: admin });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const actions = new Set(r.data.rows.map((x) => x.action));
    for (const a of ['login', 'store_batch_create', 'product_create', 'user_create', 'sales_submit', 'report_export', 'auto_login']) {
      assert.ok(actions.has(a), `缺少动作 ${a}`);
    }
    const row = r.data.rows.find((x) => x.action === 'login');
    assert.ok(row.ip, '缺少 IP');
    assert.ok(row.device_id, '缺少设备指纹');
    assert.ok(row.device, '缺少设备标签');
  });
  await check('日志支持动作与关键字筛选', async () => {
    const r = await call('GET', '/api/logs?action=sales_submit', undefined, { session: admin });
    assert.ok(r.data.rows.length >= 2);
    assert.ok(r.data.rows.every((x) => x.action === 'sales_submit'));
  });
  await check('IP 库状态可读', async () => {
    const r = await call('GET', '/api/logs/ipdb', undefined, { session: admin });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.loaded, true);
    assert.ok(r.data.meta.revision);
  });
  await check('区域管理员无权访问操作日志', async () => {
    const r = await call('GET', '/api/logs', undefined, { session: multi });
    assert.strictEqual(r.status, 403);
  });

  console.log('\n[7] 设备指纹稳定性');
  await check('切换网络类型 UA 后指纹不变', async () => {
    const wifiUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN';
    const cellUA = wifiUA.replace('NetType/WIFI', 'NetType/4G');
    const deviceMeta = Buffer.from(
      JSON.stringify({ screen: '390x844', timezone: 'Asia/Shanghai', language: 'zh-CN', platform: 'iPhone' }),
    ).toString('base64');
    const send = async (ua, ipHeader) => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': ua,
          'x-device-meta': deviceMeta,
          'x-forwarded-for': ipHeader,
          cookie: '',
        },
        body: JSON.stringify({ username: 'clerk001', password: 'clerk-pass-123' }),
      });
      await res.text();
      return res.status;
    };
    await send(wifiUA, '203.0.113.10');
    await send(cellUA, '203.0.113.99');
    const rows = db
      .prepare(
        `SELECT device_id, ip, ip_location FROM audit_logs WHERE action = 'login' ORDER BY id DESC LIMIT 2`,
      )
      .all();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].device_id, rows[1].device_id, '指纹随网络变化');
    assert.notStrictEqual(rows[0].ip, rows[1].ip, 'IP 应不同');
  });

  server.close();
  db.close();

  console.log(`\n结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`);
  if (failures.length) {
    for (const f of failures) console.log(` - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('测试中断：', err);
  process.exit(1);
});
