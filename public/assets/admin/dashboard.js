'use strict';

/* ============================================================
   概览：当日提交完成率 + 按区域管理员分组的商品柱状图
   一个管理员一行：左侧完成率，右侧该管理员管辖门店当天销量逐商品展开；
   每个商品各占一根柱子，本品（实色高亮）与竞品（浅灰）同图区分，
   商品按品类分区排列，点击一行展开门店维度明细。
   ============================================================ */

(function () {
  const { api, $, $$, escapeHtml, todayStr } = window.SSD;
  const h = window.Admin.h;

  const MAX_BAR = 96;
  /** 未提交 / 零销量商品也保留一条基线高度，保证每根柱子都有位置 */
  const ZERO_BAR = 2;

  const KIND_TEXT = { own: '本品', comp: '竞品' };

  const state = {
    date: todayStr(),
    data: null,
    open: new Set(),
  };

  function barHeight(qty, max) {
    if (!(qty > 0)) return ZERO_BAR;
    if (!(max > 0)) return ZERO_BAR;
    return Math.max(3, Math.round((qty / max) * MAX_BAR));
  }

  /** 单根商品柱：一个商品一柱，本品用品牌色描实，竞品用浅灰压在后面 */
  function productBar(item, max) {
    const value = Number(item.qty) || 0;
    const kind = item.kind === 'own' ? 'own' : 'comp';
    const height = barHeight(value, max);
    const short = item.alias && item.alias !== item.name ? item.alias : item.name;
    const title = `${item.name}${item.alias && item.alias !== item.name ? `（${item.alias}）` : ''} · ${
      KIND_TEXT[kind]
    } ${value} · ${item.category}`;
    return `<div class="bar-item bar-item-${kind}" title="${escapeHtml(title)}">
        <div class="bar-slot">
          <div class="bar bar-${kind}${value > 0 ? '' : ' zero'}" style="height:${height}px">
            ${value > 0 ? `<span class="bar-val">${value}</span>` : ''}
          </div>
        </div>
        <div class="bar-name">${escapeHtml(short)}</div>
      </div>`;
  }

  /** 商品按品类分区块排列，区块内每个商品各自一柱，柱高按全局最大值归一 */
  function renderChart(products, max) {
    if (!products || products.length === 0) {
      return '<div class="bars-empty">当天没有可统计的商品</div>';
    }
    const buckets = new Map();
    for (const item of products) {
      const key = item.category || '未分类';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(item);
    }
    return `<div class="bars">${[...buckets.entries()]
      .map(
        ([cat, list]) => `<div class="bar-cat">
          <div class="bar-cat-bars">${list.map((item) => productBar(item, max)).join('')}</div>
          <div class="bar-cat-name">${escapeHtml(cat)}</div>
        </div>`,
      )
      .join('')}</div>`;
  }

  /** 完成率方块：所有行（含未绑定组、门店行）最左侧统一展示 */
  function rateBox(completion, label) {
    const rate = Number(completion && completion.rate) || 0;
    const done = (completion && completion.done) || 0;
    const expected = (completion && completion.expected) || 0;
    return `<div class="mgr-rate ${h.heatClass(rate)}" title="已提交 ${done} / 应提交 ${expected}">
      <b>${rate}%</b>
      <span>${label} ${done}/${expected}</span>
    </div>`;
  }

  function renderStoreRow(store, max) {
    return `<div class="mgr-store">
      ${rateBox(store.completion, '提交')}
      <div class="mgr-store-meta">
        <b>${escapeHtml(store.storeCode)}</b>
        <span>${escapeHtml(store.storeName)}</span>
        <span class="muted small">合计 ${store.totalQty}</span>
      </div>
      <div class="mgr-chart">${renderChart(store.products, max)}</div>
    </div>`;
  }

  function renderGroup(group, max) {
    const key = group.managerId == null ? 'unbound' : String(group.managerId);
    const open = state.open.has(key);
    const unbound = group.managerId == null;
    return `<div class="mgr-row${open ? ' open' : ''}${unbound ? ' mgr-unbound' : ''}">
      <div class="mgr-head" data-mgr="${key}" role="button" tabindex="0" aria-expanded="${open ? 'true' : 'false'}">
        ${rateBox(group.completion, '提交')}
        <div class="mgr-meta">
          <b>${escapeHtml(group.managerName)}</b>
          <span>${group.storeCount} 家门店${unbound ? ' · 未分配' : ''}</span>
          <span class="mgr-legend"><i class="dot dot-own"></i>本品<i class="dot dot-comp"></i>竞品</span>
        </div>
        <div class="mgr-chart">${renderChart(group.products, max)}</div>
        <div class="mgr-chev">▸</div>
      </div>
      <div class="mgr-body">
        <div class="mgr-store-head">
          <span>门店</span>
          <span class="muted small">当天未提交的商品按 0 计入</span>
        </div>
        ${
          group.stores.length
            ? group.stores.map((store) => renderStoreRow(store, max)).join('')
            : '<div class="bars-empty">该管理员名下暂无门店</div>'
        }
      </div>
    </div>`;
  }

  function renderOverview(data) {
    if (!data.groups || data.groups.length === 0) {
      return h.empty('范围内暂无启用门店', 'shop');
    }
    // 柱高归一到一个全局最大值，便于跨管理员、跨门店比较
    let max = 0;
    for (const group of data.groups) {
      for (const item of group.products || []) max = Math.max(max, item.qty);
      for (const store of group.stores) {
        for (const item of store.products || []) max = Math.max(max, item.qty);
      }
    }
    return `<div class="mgr-list">${data.groups.map((group) => renderGroup(group, max)).join('')}</div>`;
  }

  function renderSummary(data) {
    const groups = data.groups || [];
    const totals = groups.reduce(
      (acc, g) => {
        acc.done += g.completion.done;
        acc.expected += g.completion.expected;
        acc.stores += g.storeCount;
        acc.qty += g.totalQty;
        return acc;
      },
      { done: 0, expected: 0, stores: 0, qty: 0 },
    );
    const rate = totals.expected ? Math.round((totals.done / totals.expected) * 1000) / 10 : 0;
    const managers = groups.filter((g) => g.managerId != null).length;
    return `<div class="stat-grid">
      <div class="stat accent">
        <div class="label">${h.fmtDay(data.date)}提交率</div>
        <div class="value">${rate}<small>%</small></div>
        <div class="sub">${totals.done} / ${totals.expected} 次提交</div>
      </div>
      <div class="stat">
        <div class="label">区域管理员</div>
        <div class="value">${managers}<small>位</small></div>
        <div class="sub">${groups.length > managers ? '另含 1 条未绑定汇总' : '均有门店绑定'}</div>
      </div>
      <div class="stat">
        <div class="label">参与门店</div>
        <div class="value">${totals.stores}<small>家</small></div>
        <div class="sub">启用状态门店</div>
      </div>
      <div class="stat">
        <div class="label">当日销量</div>
        <div class="value">${totals.qty}<small>件</small></div>
        <div class="sub">上午 + 下午合计</div>
      </div>
    </div>`;
  }

  function bind(view) {
    $$('.mgr-head', view).forEach((head) => {
      const toggle = () => {
        const key = head.dataset.mgr;
        if (state.open.has(key)) state.open.delete(key);
        else state.open.add(key);
        const row = head.closest('.mgr-row');
        const open = state.open.has(key);
        row.classList.toggle('open', open);
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      head.addEventListener('click', toggle);
      // 用 div + role="button"：内部含柱形图与多层块级结构，避免按钮内嵌块级元素
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });
  }

  async function render(view) {
    state.data = await api.get(`/api/reports/manager-day?date=${state.date}`);

    view.innerHTML = `
      <div class="toolbar">
        <div class="seg" id="day-seg">
          ${[0, 1, 2, 3, 4, 5, 6]
            .map((i) => {
              const date = window.SSD.addDays(todayStr(), -i);
              const active = date === state.date ? 'active' : '';
              return `<button type="button" class="${active}" data-date="${date}">${
                i === 0 ? '今天' : i === 1 ? '昨天' : h.shortDay(date)
              }</button>`;
            })
            .join('')}
        </div>
        <div class="grow"></div>
        <span class="muted small">口径：当天上午 + 下午销量合计，逐商品对比（本品高亮）</span>
      </div>

      ${renderSummary(state.data)}

      <div class="panel" style="margin-top:16px">
        <div class="panel-head">
          <div>
            <h3>${h.fmtDay(state.data.date)} 各区域管理员商品销量</h3>
            <p>每个商品单独成柱，本品高亮显示；点击一行展开该管理员名下各门店的明细，当天未提交的商品按 0 计入</p>
          </div>
        </div>
        <div class="panel-body">${renderOverview(state.data)}</div>
      </div>`;

    $$('#day-seg [data-date]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.date === state.date) return;
        state.date = btn.dataset.date;
        state.open.clear();
        await render(view);
      });
    });

    bind(view);
  }

  window.Admin.register({
    id: 'dashboard',
    title: '概览',
    subtitle: () => `${h.fmtDay(todayStr())} · 各区域管理员商品销量`,
    render,
  });
})();
