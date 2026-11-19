'use strict';

/* ============================================================
   数据报表：区间总览（总体 + 每个门店）/ 按日期折叠明细 / CSV 导出
   ============================================================ */

(function () {
  const { api, $, $$, escapeHtml, todayStr, addDays } = window.SSD;
  const h = window.Admin.h;

  const state = {
    from: addDays(todayStr(), -6),
    to: todayStr(),
    storeId: '',
    tab: 'overview', // overview | detail
    stores: [],
    overview: null,
    detail: null,
    page: 1,
    pageSize: 7,
    openDates: new Set(),
  };

  function rangeQuery() {
    const q = new URLSearchParams({ from: state.from, to: state.to });
    if (state.storeId) q.set('storeId', state.storeId);
    return q;
  }

  function renderToolbar() {
    return `<div class="toolbar">
      <div class="seg" id="tab-seg">
        <button type="button" data-tab="overview" class="${state.tab === 'overview' ? 'active' : ''}">总览</button>
        <button type="button" data-tab="detail" class="${state.tab === 'detail' ? 'active' : ''}">明细</button>
      </div>
      <div class="grow"></div>
      <input class="input" type="date" id="f-from" value="${state.from}" max="${todayStr()}">
      <span class="muted small">至</span>
      <input class="input" type="date" id="f-to" value="${state.to}" max="${todayStr()}">
      <select class="select" id="f-store">
        <option value="">全部门店</option>
        ${state.stores
          .map(
            (s) =>
              `<option value="${s.id}" ${String(state.storeId) === String(s.id) ? 'selected' : ''}>${escapeHtml(
                `${s.code} ${s.name}`,
              )}</option>`,
          )
          .join('')}
      </select>
      <button class="btn btn-soft" type="button" id="btn-export">导出明细</button>
    </div>`;
  }

  function renderOverview() {
    const data = state.overview;
    if (!data) return h.empty('暂无数据');
    const t = data.totals;
    const behind = data.stores.filter((s) => s.rate < 100);
    return `
      <div class="stat-grid">
        <div class="stat accent">
          <div class="label">区间完成率</div>
          <div class="value">${t.rate.toFixed(1)}<small>%</small></div>
          <div class="sub">${t.done} / ${t.expected} 次提交</div>
        </div>
        <div class="stat">
          <div class="label">统计门店</div>
          <div class="value">${t.stores}<small>家</small></div>
          <div class="sub">${data.from} ~ ${data.to}（${data.days} 天）</div>
        </div>
        <div class="stat">
          <div class="label">已完成门店</div>
          <div class="value">${data.stores.filter((s) => s.rate >= 100).length}<small>家</small></div>
          <div class="sub">每个时段均已提交</div>
        </div>
        <div class="stat">
          <div class="label">未达 100% 门店</div>
          <div class="value">${behind.length}<small>家</small></div>
          <div class="sub">需重点跟进</div>
        </div>
      </div>

      <div class="panel" style="margin-top:16px">
        <div class="panel-head">
          <div>
            <h3>门店完成率</h3>
            <p>点击卡片查看该门店的提交明细</p>
          </div>
        </div>
        <div class="panel-body">
          ${
            data.stores.length === 0
              ? h.empty('暂无门店数据', 'shop')
              : `<div class="store-rate-grid">${data.stores
                  .map(
                    (s) => `<div class="store-rate-card" data-store="${s.storeId}" role="button" tabindex="0">
                      <div class="rc-head">
                        <div>
                          <h3>${escapeHtml(s.storeCode)} ${escapeHtml(s.storeName)}</h3>
                          <div class="rc-meta">${data.days} 天 · 应填 ${s.expected} 次</div>
                        </div>
                        <span class="pill ${s.rate >= 100 ? 'pill-ok' : s.rate >= 50 ? 'pill-warn' : 'pill-danger'}">${
                      s.rate >= 100 ? '达标' : s.rate > 0 ? '进行中' : '未提交'
                    }</span>
                      </div>
                      <div class="rc-rate">${s.rate.toFixed(1)}%</div>
                      ${h.miniBar(s.rate)}
                      <div class="rc-foot" style="margin-top:8px">
                        <span>${s.done} / ${s.expected} 次</span>
                        <span>查看明细</span>
                      </div>
                    </div>`,
                  )
                  .join('')}</div>`
          }
        </div>
      </div>`;
  }

  function renderPeriodBlock(periodKey, period) {
    if (!period) return '';
    const rows = (period.items || [])
      .map(
        (it) => `<tr>
          <td>${escapeHtml(it.alias)}<br><span class="tiny muted">${escapeHtml(it.productName)}</span></td>
          <td class="num">${it.qty}</td>
        </tr>`,
      )
      .join('');
    return `<div style="margin-top:8px">
      <div class="small" style="display:flex;gap:10px;flex-wrap:wrap;align-items:baseline">
        <b>${periodKey === 'am' ? '上午' : '下午'}</b>
        <span class="muted">${period.itemCount} 项 · 数量 ${period.totalQty}</span>
        <span class="muted tiny">提交 ${escapeHtml((period.submittedAt || '').slice(5, 16))}${
      period.submitter ? ` · ${escapeHtml(period.submitter)}` : ''
    }</span>
      </div>
      <table class="entry-table" style="margin-top:4px">
        <thead><tr><th>商品（别名 / 品名）</th><th class="num">数量</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="2" class="muted">无明细</td></tr>'}</tbody>
      </table>
    </div>`;
  }

  function renderStoreBlock(store) {
    return `<div class="store-block">
      <div class="store-block-head">
        <b class="mono">${escapeHtml(store.storeCode)}</b>
        <span>${escapeHtml(store.storeName)}</span>
        <span class="grow" style="flex:1"></span>
        <span class="muted small">合计 ${store.totalQty} 件</span>
      </div>
      <div class="store-block-body">
        ${renderPeriodBlock('am', store.periods.am)}
        ${renderPeriodBlock('pm', store.periods.pm)}
      </div>
    </div>`;
  }

  function renderDetail() {
    const data = state.detail;
    if (!data) return h.empty('暂无数据');
    if (!data.dates.length) return h.empty('所选区间没有提交记录', 'archive');
    return `<div class="panel">
      <div class="panel-body flush">
        ${data.dates
          .map((day) => {
            const open = state.openDates.has(day.date);
            return `<div class="fold ${open ? 'open' : ''}" data-date="${day.date}">
              <button class="fold-head" type="button" data-toggle="${day.date}">
                <span class="chev">▶</span>
                <span class="fh-date">${h.fmtDay(day.date)}</span>
                <span class="fh-meta">${day.stores.length} 家门店提交 · ${day.done}/${day.expected} 次 · ${day.totalQty} 件</span>
                <span style="flex:1"></span>
                <span class="pill ${day.rate >= 100 ? 'pill-ok' : day.rate > 0 ? 'pill-warn' : 'pill-danger'}">${day.rate.toFixed(
                  1,
                )}%</span>
              </button>
              <div class="fold-body">
                ${day.stores.length ? day.stores.map(renderStoreBlock).join('') : h.empty('当日无提交', 'archive')}
              </div>
            </div>`;
          })
          .join('')}
      </div>
      <div class="pager" id="detail-pager"></div>
    </div>`;
  }

  function mountPager() {
    const host = $('#detail-pager');
    if (!host || !state.detail) return;
    const d = state.detail;
    host.innerHTML = `
      <button type="button" data-go="prev" ${d.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${d.page} / ${d.pages} 页 · 共 ${d.total} 天</span>
      <button type="button" data-go="next" ${d.page >= d.pages ? 'disabled' : ''}>下一页</button>`;
    host.querySelector('[data-go="prev"]').addEventListener('click', () => gotoPage(d.page - 1));
    host.querySelector('[data-go="next"]').addEventListener('click', () => gotoPage(d.page + 1));
  }

  async function gotoPage(page) {
    if (page < 1 || page > (state.detail ? state.detail.pages : 1)) return;
    state.page = page;
    state.openDates.clear();
    await loadDetail();
    renderCurrent();
  }

  async function loadOverview() {
    const options = await api.get('/api/reports/options');
    state.stores = options.stores;
    state.overview = await api.get(`/api/reports/stores?${rangeQuery()}`);
  }

  async function loadDetail() {
    const q = rangeQuery();
    q.set('page', state.page);
    q.set('pageSize', state.pageSize);
    state.detail = await api.get(`/api/reports/detail?${q}`);
    if (state.detail.dates.length && state.openDates.size === 0) {
      state.openDates.add(state.detail.dates[0].date);
    }
  }

  function renderCurrent() {
    const view = $('#view');
    view.innerHTML = `${renderToolbar()}${
      state.tab === 'overview' ? `<div style="margin-top:14px">${renderOverview()}</div>` : `<div style="margin-top:14px">${renderDetail()}</div>`
    }`;
    bindToolbar();
    if (state.tab === 'detail') {
      bindDetail();
      mountPager();
    } else {
      bindOverview();
    }
  }

  function bindToolbar() {
    $$('#tab-seg [data-tab]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (state.tab === btn.dataset.tab) return;
        state.tab = btn.dataset.tab;
        state.page = 1;
        if (state.tab === 'detail' && !state.detail) await loadDetail();
        renderCurrent();
      });
    });
    $('#f-from').addEventListener('change', async (e) => {
      state.from = e.target.value || state.from;
      if (state.from > state.to) state.to = state.from;
      state.page = 1;
      state.openDates.clear();
      await refreshData();
    });
    $('#f-to').addEventListener('change', async (e) => {
      state.to = e.target.value || state.to;
      if (state.to < state.from) state.from = state.to;
      state.page = 1;
      state.openDates.clear();
      await refreshData();
    });
    $('#f-store').addEventListener('change', async (e) => {
      state.storeId = e.target.value;
      state.page = 1;
      state.openDates.clear();
      await refreshData();
    });
    $('#btn-export').addEventListener('click', async () => {
      const btn = $('#btn-export');
      btn.disabled = true;
      btn.textContent = '导出中…';
      const q = rangeQuery();
      await h.download(`/api/reports/export?${q}`, `销售明细_${state.from}_${state.to}.csv`);
      btn.disabled = false;
      btn.textContent = '导出明细';
    });
  }

  async function refreshData() {
    await Promise.all([loadOverview(), loadDetail()]);
    renderCurrent();
  }

  function bindOverview() {
    $$('[data-store]').forEach((card) => {
      const open = () => {
        state.storeId = card.dataset.store || '';
        state.tab = 'detail';
        state.page = 1;
        state.openDates.clear();
        refreshData();
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  }

  function bindDetail() {
    $$('[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const date = btn.dataset.toggle;
        if (state.openDates.has(date)) state.openDates.delete(date);
        else state.openDates.add(date);
        const fold = btn.closest('.fold');
        if (fold) fold.classList.toggle('open');
      });
    });
  }

  async function render(view) {
    view.innerHTML = `<div class="panel"><div class="panel-body"><div class="skeleton" style="height:180px"></div></div></div>`;
    await loadOverview();
    state.page = 1;
    state.openDates.clear();
    await loadDetail();
    renderCurrent();
  }

  window.Admin.register({
    id: 'reports',
    title: '数据报表',
    subtitle: () => `${state.from} ~ ${state.to} · 完成情况与销售明细`,
    render,
  });
})();
