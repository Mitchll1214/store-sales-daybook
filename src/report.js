'use strict';

/**
 * 报表与完成情况计算。
 * 完成情况以「门店 × 日期 × 时段」为单位：存在提交记录即视为完成。
 * 期望值 = 参与统计的门店数 × 2 个时段（上午/下午）。
 */

const { PERIODS, PERIOD_LABEL, addDays, diffDays, isDateStr, percent, periodState } = require('./util');

/** 门店当前应填报的商品（启用 + 已关联；未配置关联时默认全部启用商品） */
function productsForStore(db, storeId) {
  const linked = db.prepare('SELECT count(*) AS c FROM store_products WHERE store_id = ?').get(storeId).c;
  if (linked === 0) {
    return db
      .prepare("SELECT id, name, alias, barcode, status FROM products WHERE status = 'active' ORDER BY id")
      .all();
  }
  return db
    .prepare(
      `SELECT p.id, p.name, p.alias, p.barcode, p.status
       FROM store_products sp JOIN products p ON p.id = sp.product_id
       WHERE sp.store_id = ? AND p.status = 'active'
       ORDER BY p.id`,
    )
    .all(storeId);
}

/** 门店的可见商品数量（用于判断是否存在可填报内容） */
function productCountForStores(db, storeIds) {
  const counts = new Map(storeIds.map((id) => [id, 0]));
  if (storeIds.length === 0) return counts;
  const marks = storeIds.map(() => '?').join(',');
  const activeTotal = db.prepare("SELECT count(*) AS c FROM products WHERE status = 'active'").get().c;
  const linkedCounts = db
    .prepare(
      `SELECT sp.store_id AS storeId, count(*) AS c
       FROM store_products sp JOIN products p ON p.id = sp.product_id
       WHERE p.status = 'active' AND sp.store_id IN (${marks})
       GROUP BY sp.store_id`,
    )
    .all(...storeIds);
  for (const id of storeIds) counts.set(id, activeTotal);
  for (const row of linkedCounts) counts.set(row.storeId, row.c);
  return counts;
}

/** 读取 [from, to] 区间内的提交记录，返回 Map：`${storeId}|${date}|${period}` */
function submissionIndex(db, storeIds, from, to) {
  const index = new Map();
  if (storeIds.length === 0) return index;
  const marks = storeIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT store_id, biz_date, period, item_count, total_qty, submitted_at, submitter_name
       FROM sale_submissions
       WHERE store_id IN (${marks}) AND biz_date BETWEEN ? AND ?`,
    )
    .all(...storeIds, from, to);
  for (const row of rows) {
    index.set(`${row.store_id}|${row.biz_date}|${row.period}`, row);
  }
  return index;
}

/** 统计范围内的门店，按编码排序 */
function scopedStores(db, storeIds, { includeDisabled = false } = {}) {
  if (storeIds.length === 0) return [];
  const marks = storeIds.map(() => '?').join(',');
  const statusClause = includeDisabled ? '' : "AND s.status = 'active'";
  return db
    .prepare(
      `SELECT s.id, s.code, s.name, s.status
       FROM stores s
       WHERE s.id IN (${marks}) ${statusClause}
       ORDER BY s.code`,
    )
    .all(...storeIds);
}

/**
 * 单日完成情况：门店级明细 + 总览。
 */
function dayOverview(db, { date, storeIds }) {
  const stores = scopedStores(db, storeIds);
  const index = submissionIndex(db, stores.map((s) => s.id), date, date);
  const items = stores.map((store) => {
    const periods = {};
    let done = 0;
    for (const period of PERIODS) {
      const row = index.get(`${store.id}|${date}|${period}`);
      periods[period] = { done: Boolean(row), submittedAt: row ? row.submitted_at : null };
      if (row) done += 1;
    }
    return {
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      periods,
      done,
      expected: PERIODS.length,
      rate: percent(done, PERIODS.length),
    };
  });

  const expected = items.length * PERIODS.length;
  const done = items.reduce((sum, i) => sum + i.done, 0);
  return {
    date,
    totals: { stores: items.length, expected, done, rate: percent(done, expected) },
    stores: items,
  };
}

/**
 * 最近 N 天完成情况（管理员首页）：每次返回 日期-门店编码-完成率。
 */
function recentDays(db, { storeIds, days = 7, endDate }) {
  const end = endDate || require('./util').todayStr();
  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) dates.push(addDays(end, -i));
  const from = dates[0];
  const stores = scopedStores(db, storeIds);
  const index = submissionIndex(db, stores.map((s) => s.id), from, end);

  const rows = [];
  for (const date of dates) {
    for (const store of stores) {
      let done = 0;
      for (const period of PERIODS) {
        if (index.has(`${store.id}|${date}|${period}`)) done += 1;
      }
      rows.push({
        date,
        storeId: store.id,
        storeCode: store.code,
        storeName: store.name,
        done,
        expected: PERIODS.length,
        rate: percent(done, PERIODS.length),
      });
    }
  }
  const perDay = dates.map((date) => {
    const dayRows = rows.filter((r) => r.date === date);
    const expected = dayRows.length * PERIODS.length;
    const done = dayRows.reduce((sum, r) => sum + r.done, 0);
    return { date, stores: dayRows.length, expected, done, rate: percent(done, expected) };
  });
  return { from, to: end, dates, rows, perDay, stores: stores.length };
}

/**
 * 门店维度完成情况（管理员报表顶部的门店卡片）。
 */
function storeOverview(db, { storeIds, from, to }) {
  if (!isDateStr(from) || !isDateStr(to) || from > to) {
    return { from, to, stores: [], totals: { expected: 0, done: 0, rate: 0 } };
  }
  const spanDays = diffDays(from, to) + 1;
  const stores = scopedStores(db, storeIds);
  const index = submissionIndex(db, stores.map((s) => s.id), from, to);

  const items = stores.map((store) => {
    let done = 0;
    for (let i = 0; i < spanDays; i += 1) {
      const date = addDays(from, i);
      for (const period of PERIODS) {
        if (index.has(`${store.id}|${date}|${period}`)) done += 1;
      }
    }
    const expected = spanDays * PERIODS.length;
    return {
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      expected,
      done,
      rate: percent(done, expected),
    };
  });
  const expected = items.reduce((s, r) => s + r.expected, 0);
  const done = items.reduce((s, r) => s + r.done, 0);
  return {
    from,
    to,
    days: spanDays,
    totals: {
      stores: stores.length,
      expected,
      done,
      rate: percent(done, expected),
    },
    stores: items,
  };
}

/**
 * 按日期折叠的明细：日期 → 门店 → 时段 → 商品条目。
 */
function detailByDate(db, { storeIds, from, to, storeId, page = 1, pageSize = 7 }) {
  if (!isDateStr(from) || !isDateStr(to) || from > to) {
    return { from, to, dates: [], total: 0 };
  }
  const stores = scopedStores(db, storeIds);
  const allowed = new Set(
    stores.filter((s) => (storeId ? s.id === Number(storeId) : true)).map((s) => s.id),
  );
  const allDates = [];
  for (let i = 0; i <= diffDays(from, to); i += 1) allDates.push(addDays(from, i));
  // 最新的日期排在前面，按页返回，避免一次拉取过长区间
  const ordered = allDates.slice().reverse();
  const size = Math.min(Math.max(Number(pageSize) || 7, 1), 31);
  const current = Math.max(Number(page) || 1, 1);
  const pageDates = ordered.slice((current - 1) * size, current * size);

  const submissions = db
    .prepare(
      `SELECT sub.store_id, sub.biz_date, sub.period, sub.item_count, sub.total_qty,
              sub.submitted_at, sub.submitter_name
       FROM sale_submissions sub
       WHERE sub.biz_date BETWEEN ? AND ?`,
    )
    .all(from, to)
    .filter((r) => allowed.has(r.store_id));

  const entries = db
    .prepare(
      `SELECT e.id AS entryId, e.store_id, e.biz_date, e.period, e.qty,
              e.corrected_at, e.corrected_by_name,
              p.name AS productName, p.barcode, p.alias, p.kind
       FROM sale_entries e JOIN products p ON p.id = e.product_id
       WHERE e.biz_date BETWEEN ? AND ?`,
    )
    .all(from, to)
    .filter((r) => allowed.has(r.store_id));

  const storeMap = new Map(stores.map((s) => [s.id, s]));
  const dates = pageDates.map((date) => {
    const daySubs = submissions.filter((r) => r.biz_date === date);
    const perStore = new Map();
    for (const sub of daySubs) {
      const store = storeMap.get(sub.store_id);
      if (!store) continue;
      if (!perStore.has(sub.store_id)) {
        perStore.set(sub.store_id, {
          storeId: store.id,
          storeCode: store.code,
          storeName: store.name,
          periods: {},
          totalQty: 0,
          ownQty: 0,
        });
      }
      const bucket = perStore.get(sub.store_id);
      // 本品合计按该时段明细汇总：提交记录只存了总件数，分不出本品 / 竞品
      const periodEntries = entries.filter(
        (e) => e.store_id === sub.store_id && e.biz_date === date && e.period === sub.period,
      );
      const periodOwnQty = periodEntries
        .filter((e) => e.kind === 'own')
        .reduce((sum, e) => sum + e.qty, 0);
      bucket.periods[sub.period] = {
        done: true,
        itemCount: sub.item_count,
        totalQty: sub.total_qty,
        ownQty: periodOwnQty,
        submittedAt: sub.submitted_at,
        submitter: sub.submitter_name,
        items: periodEntries.map((e) => ({
          entryId: e.entryId,
          productName: e.productName,
          alias: e.alias,
          barcode: e.barcode,
          kind: e.kind === 'own' ? 'own' : 'comp',
          qty: e.qty,
          correctedAt: e.corrected_at || null,
          correctedBy: e.corrected_by_name || '',
        })),
      };
      bucket.totalQty += sub.total_qty;
      bucket.ownQty += periodOwnQty;
    }
    const storeRows = [...perStore.values()].sort((a, b) => a.storeCode.localeCompare(b.storeCode));
    const expected = allowed.size * PERIODS.length;
    const done = daySubs.length;
    return {
      date,
      expected,
      done,
      rate: percent(done, expected),
      totalQty: storeRows.reduce((s, r) => s + r.totalQty, 0),
      ownQty: storeRows.reduce((s, r) => s + r.ownQty, 0),
      stores: storeRows,
    };
  });

  return {
    from,
    to,
    page: current,
    pageSize: size,
    total: ordered.length,
    pages: Math.max(Math.ceil(ordered.length / size), 1),
    dates,
  };
}

/** 销售明细行（用于 CSV 导出与明细表） */
function detailRows(db, { storeIds, from, to, storeId, period }) {
  if (!isDateStr(from) || !isDateStr(to) || from > to) return [];
  if (diffDays(from, to) > 366) return [];
  const stores = scopedStores(db, storeIds, { includeDisabled: true });
  const storeMap = new Map(stores.map((s) => [s.id, s]));
  const allowed = new Set(
    stores.filter((s) => (storeId ? s.id === Number(storeId) : true)).map((s) => s.id),
  );
  if (allowed.size === 0) return [];

  const where = ['e.biz_date BETWEEN ? AND ?'];
  const params = [from, to];
  if (period && PERIODS.includes(period)) {
    where.push('e.period = ?');
    params.push(period);
  }
  const rows = db
    .prepare(
      `SELECT e.biz_date AS date, e.period, s.id AS storeId, s.code AS storeCode, s.name AS storeName,
              p.name AS productName, p.alias, p.barcode,
              e.qty, e.updated_at AS updatedAt,
              sub.submitted_at AS submittedAt, sub.submitter_name AS submitter
       FROM sale_entries e
       JOIN products p ON p.id = e.product_id
       JOIN stores s ON s.id = e.store_id
       LEFT JOIN sale_submissions sub
         ON sub.store_id = e.store_id AND sub.biz_date = e.biz_date AND sub.period = e.period
       WHERE ${where.join(' AND ')}
       ORDER BY e.biz_date DESC, s.code, e.period, p.id`,
    )
    .all(...params);

  return rows
    .filter((r) => allowed.has(r.storeId))
    .map((r) => ({
      date: r.date,
      period: r.period,
      periodLabel: PERIOD_LABEL[r.period] || r.period,
      storeCode: r.storeCode,
      storeName: r.storeName,
      productName: r.productName,
      alias: r.alias,
      barcode: r.barcode || '',
      qty: r.qty,
      submittedAt: r.submittedAt || '',
      submitter: r.submitter || '',
      updatedAt: r.updatedAt,
    }))
    .map(({ updatedAt, ...rest }) => rest);
}

/** 品类：留空的统一归入「未分类」，避免图上出现空白柱 */
function categoryOf(product) {
  return String(product.category || '').trim() || '未分类';
}

/** 商品属性只认本品 / 竞品，其余一律按竞品（与数据库默认值一致） */
const KIND_ORDER = ['own', 'comp'];

/**
 * 按区域管理员分组的当日商品汇总（概览柱形图）。
 *
 * - 口径：当天上午 + 下午的销售数量合计；当天没有记录的商品按 0 计入。
 * - 一个区域管理员一组：该管理员管辖门店的汇总；同一门店被多个管理员管辖时，
 *   各自组内都会统计到它（各组独立看数，不做跨组相加）。
 * - 不被任何启用状态区域管理员管辖的门店，单独汇总成「未绑定」一组。
 * - 每组都带 stores 明细，供前端点击展开门店维度。
 */
function managerDay(db, { date, storeIds }) {
  const empty = { date, kindOrder: KIND_ORDER, categories: [], categoryTotals: [], products: [], groups: [] };
  if (!isDateStr(date)) return empty;
  const stores = scopedStores(db, storeIds);
  if (stores.length === 0) return empty;
  const ids = stores.map((s) => s.id);
  const marks = ids.map(() => '?').join(',');

  // 当天销量：门店 × 商品，上午与下午合并
  const entryRows = db
    .prepare(
      `SELECT e.store_id AS storeId, e.product_id AS productId, SUM(e.qty) AS qty,
              p.name, p.alias, p.category, p.kind
       FROM sale_entries e JOIN products p ON p.id = e.product_id
       WHERE e.biz_date = ? AND e.store_id IN (${marks})
       GROUP BY e.store_id, e.product_id`,
    )
    .all(date, ...ids);

  // 商品元数据：启用商品（用于补 0 柱）+ 当天有记录的禁用商品（只用于归类）
  const activeProducts = db
    .prepare("SELECT id, name, alias, category, kind FROM products WHERE status = 'active' ORDER BY id")
    .all();
  const productMeta = new Map();
  for (const p of activeProducts) {
    productMeta.set(p.id, {
      name: p.name,
      alias: p.alias || p.name,
      category: categoryOf(p),
      kind: p.kind === 'own' ? 'own' : 'comp',
    });
  }
  for (const row of entryRows) {
    if (!productMeta.has(row.productId)) {
      productMeta.set(row.productId, {
        name: row.name || row.alias || `商品 #${row.productId}`,
        alias: row.alias || row.name || `商品 #${row.productId}`,
        category: categoryOf(row),
        kind: row.kind === 'own' ? 'own' : 'comp',
      });
    }
  }

  // 门店 → 应填报商品：未配置关联时视为全部启用商品（与 productsForStore 一致）
  const linkedRows = db
    .prepare(`SELECT store_id AS storeId, product_id AS productId FROM store_products WHERE store_id IN (${marks})`)
    .all(...ids);
  const linked = new Map(ids.map((id) => [id, []]));
  for (const row of linkedRows) {
    const bucket = linked.get(row.storeId);
    if (bucket) bucket.push(row.productId);
  }
  const allActiveIds = activeProducts.map((p) => p.id);
  const productsByStore = new Map();
  for (const id of ids) {
    const own = linked.get(id) || [];
    // 未提交 / 未配置时也要有柱：取该门店应填报的商品，缺失的按 0 计
    const productIds = own.length ? own : allActiveIds;
    productsByStore.set(id, productIds.filter((pid) => productMeta.has(pid)));
  }

  // 当天提交情况：门店 × 上午/下午
  const index = submissionIndex(db, ids, date, date);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const entriesByStore = new Map(ids.map((id) => [id, []]));
  for (const row of entryRows) {
    const bucket = entriesByStore.get(row.storeId);
    if (bucket) bucket.push(row);
  }

  // 全局商品集合：所有门店应填报商品的并集，保证各组柱子对齐、缺失商品补 0
  const globalProductIds = [];
  const seenProduct = new Set();
  for (const id of ids) {
    for (const pid of productsByStore.get(id) || []) {
      if (seenProduct.has(pid)) continue;
      seenProduct.add(pid);
      globalProductIds.push(pid);
    }
  }
  // 商品顺序：品类总量高的在前（「未分类」垫底），同类内按当天销量降序
  const qtyAll = new Map();
  for (const row of entryRows) {
    const qty = Number(row.qty) || 0;
    qtyAll.set(row.productId, (qtyAll.get(row.productId) || 0) + qty);
  }
  const catTotals = new Map();
  for (const pid of globalProductIds) {
    const meta = productMeta.get(pid);
    if (!meta) continue;
    catTotals.set(meta.category, (catTotals.get(meta.category) || 0) + (qtyAll.get(pid) || 0));
  }
  const catOrder = [...catTotals.keys()].sort((a, b) => {
    if (a === '未分类') return 1;
    if (b === '未分类') return -1;
    const diff = (catTotals.get(b) || 0) - (catTotals.get(a) || 0);
    return diff !== 0 ? diff : a.localeCompare(b, 'zh-CN');
  });
  const catRank = new Map(catOrder.map((name, i) => [name, i]));
  const productOrder = globalProductIds
    .filter((pid) => productMeta.has(pid))
    .sort((a, b) => {
      const ma = productMeta.get(a);
      const mb = productMeta.get(b);
      return (
        (catRank.get(ma.category) ?? 999) - (catRank.get(mb.category) ?? 999) ||
        (qtyAll.get(b) || 0) - (qtyAll.get(a) || 0) ||
        a - b
      );
    });

  /** 按全局顺序输出商品（没有数量的补 0），并汇总品类维度 */
  function productList(qtyMap) {
    return productOrder.map((pid) => {
      const meta = productMeta.get(pid);
      return {
        productId: pid,
        name: meta.name,
        alias: meta.alias,
        category: meta.category,
        kind: meta.kind,
        qty: qtyMap.get(pid) || 0,
      };
    });
  }

  /** 由商品行汇总品类（保留旧字段，兼容既有调用方） */
  function categoriesOf(products) {
    const buckets = new Map();
    for (const item of products) {
      if (!buckets.has(item.category)) buckets.set(item.category, { own: 0, comp: 0 });
      buckets.get(item.category)[item.kind] += item.qty;
    }
    return catOrder
      .filter((name) => buckets.has(name))
      .map((name) => {
        const v = buckets.get(name);
        return { name, own: v.own, comp: v.comp, total: v.own + v.comp };
      });
  }

  /** 门店维度：逐个商品输出（本品 / 竞品各自一柱），未提交的商品 qty 为 0 */
  function storeStat(store) {
    const qtyMap = new Map();
    for (const row of entriesByStore.get(store.id) || []) {
      if (!productMeta.has(row.productId)) continue;
      qtyMap.set(row.productId, (qtyMap.get(row.productId) || 0) + (Number(row.qty) || 0));
    }
    const products = productList(qtyMap);
    let done = 0;
    for (const period of PERIODS) {
      if (index.has(`${store.id}|${date}|${period}`)) done += 1;
    }
    return {
      storeId: store.id,
      storeCode: store.code,
      storeName: store.name,
      completion: { done, expected: PERIODS.length, rate: percent(done, PERIODS.length) },
      totalQty: products.reduce((sum, p) => sum + p.qty, 0),
      ownQty: products.filter((p) => p.kind === 'own').reduce((sum, p) => sum + p.qty, 0),
      compQty: products.filter((p) => p.kind === 'comp').reduce((sum, p) => sum + p.qty, 0),
      products,
      categories: categoriesOf(products),
    };
  }

  /** 管理员维度：所辖门店逐商品相加，同样补 0 */
  function buildGroup(managerId, managerName, managerUsername, storeList) {
    const stats = storeList.map(storeStat);
    const qtyMap = new Map();
    for (const stat of stats) {
      for (const item of stat.products) {
        qtyMap.set(item.productId, (qtyMap.get(item.productId) || 0) + item.qty);
      }
    }
    const products = productList(qtyMap);
    const done = stats.reduce((sum, s) => sum + s.completion.done, 0);
    const expected = stats.length * PERIODS.length;
    return {
      managerId,
      managerName,
      managerUsername: managerUsername || '',
      storeCount: stats.length,
      completion: { done, expected, rate: percent(done, expected) },
      totalQty: products.reduce((sum, p) => sum + p.qty, 0),
      ownQty: products.filter((p) => p.kind === 'own').reduce((sum, p) => sum + p.qty, 0),
      compQty: products.filter((p) => p.kind === 'comp').reduce((sum, p) => sum + p.qty, 0),
      products,
      categories: categoriesOf(products),
      stores: stats,
    };
  }

  // 门店归属：只认启用状态的区域管理员
  const managers = db
    .prepare(
      `SELECT id, display_name AS name, username FROM users
       WHERE role = 'region_admin' AND status = 'active' ORDER BY id`,
    )
    .all();
  const linkRows = db
    .prepare(
      `SELECT us.user_id AS userId, us.store_id AS storeId
       FROM user_stores us JOIN users u ON u.id = us.user_id
       WHERE u.role = 'region_admin' AND u.status = 'active'`,
    )
    .all();
  const managerStores = new Map(managers.map((m) => [m.id, new Set()]));
  for (const row of linkRows) {
    if (!storeById.has(row.storeId)) continue;
    const set = managerStores.get(row.userId);
    if (set) set.add(row.storeId);
  }

  const groups = [];
  const claimed = new Set();
  for (const manager of managers) {
    const set = managerStores.get(manager.id);
    if (!set || set.size === 0) continue;
    for (const storeId of set) claimed.add(storeId);
    const storeList = [...set].map((id) => storeById.get(id)).filter(Boolean).sort((a, b) => a.code.localeCompare(b.code));
    groups.push(buildGroup(manager.id, manager.name, manager.username, storeList));
  }
  const unbound = stores.filter((s) => !claimed.has(s.id));
  if (unbound.length > 0) groups.push(buildGroup(null, '未绑定区域管理员', '', unbound));

  return {
    date,
    kindOrder: KIND_ORDER,
    categories: catOrder,
    /**
     * 当期品类汇总（概览顶部柱形图）：按门店并集去重后，把每个品类的本品 / 竞品销量相加。
     * 与下方分组不同，这里同一门店被多个管理员管辖也只算一次，是「全部可见门店」的整体口径。
     * 品类顺序与下方图一致（品类总量高的在前，「未分类」垫底），未提交的品类按 0 保留。
     */
    categoryTotals: catOrder.map((name) => {
      let own = 0;
      let comp = 0;
      for (const pid of globalProductIds) {
        const meta = productMeta.get(pid);
        if (!meta || meta.category !== name) continue;
        const qty = qtyAll.get(pid) || 0;
        if (meta.kind === 'own') own += qty;
        else comp += qty;
      }
      return { name, own, comp, total: own + comp };
    }),
    // 全量商品顺序（含品类与属性），前端据此渲染统一的柱子列
    products: productOrder.map((pid) => {
      const meta = productMeta.get(pid);
      return { productId: pid, name: meta.name, alias: meta.alias, category: meta.category, kind: meta.kind };
    }),
    groups,
  };
}

/** 店员首页：今天与昨天的时段状态 */
function clerkHome(db, storeId) {
  const { todayStr } = require('./util');
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const index = submissionIndex(db, [storeId], yesterday, today);
  const products = productsForStore(db, storeId);

  const slots = [today, yesterday].map((date) => ({
    date,
    label: date === today ? '今天' : '昨天',
    periods: PERIODS.map((period) => {
      const row = index.get(`${storeId}|${date}|${period}`);
      return {
        period,
        label: PERIOD_LABEL[period],
        done: Boolean(row),
        submittedAt: row ? row.submitted_at : null,
        itemCount: row ? row.item_count : 0,
        totalQty: row ? row.total_qty : 0,
        state: periodState(date, period, Boolean(row)),
      };
    }),
  }));

  return {
    today,
    yesterday,
    slots,
    productCount: products.length,
    allDoneToday: slots[0].periods.every((p) => p.done),
  };
}

module.exports = {
  productsForStore,
  productCountForStores,
  submissionIndex,
  scopedStores,
  dayOverview,
  recentDays,
  storeOverview,
  detailByDate,
  detailRows,
  managerDay,
  clerkHome,
};
