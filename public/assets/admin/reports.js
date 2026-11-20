'use strict';

/* ============================================================
   数据报表：区间总览（总体 + 每个门店）/ 按日期折叠明细 / CSV 导出
   ============================================================ */

(function () {
  const { api, $, $$, escapeHtml, toast, todayStr, addDays, openModal } = window.SSD;
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
    // 三层折叠共用一个集合，key 见 foldKey：日期 → 门店 → 上午/下午
    openFolds: new Set(),
  };

  /**
   * 折叠状态 key。三层共用一个 Set，靠前缀区分层级，
   * 这样「切门店 / 换日期 / 翻页」时统一 clear 即可，不用维护三个集合。
   */
  const foldKey = {
    day: (date) => `d:${date}`,
    store: (date, storeId) => `s:${date}:${storeId}`,
    period: (date, storeId, period) => `p:${date}:${storeId}:${period}`,
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

  /**
   * 时段块（上午 / 下午）。默认收起，头部常显该时段的合计，
   * 展开才列出逐个商品明细。
   */
  function renderPeriodBlock(date, storeId, periodKey, period) {
    if (!period) return '';
    const key = foldKey.period(date, storeId, periodKey);
    const open = state.openFolds.has(key);
    const rows = (period.items || [])
      .map(
        (it) => `<tr>
          <td>${escapeHtml(it.alias)}<br><span class="tiny muted">${escapeHtml(it.productName)}</span>${
            it.correctedAt
              ? `<br><span class="pill pill-warn" title="该条已被管理员修正">已修正 ${
                  escapeHtml((it.correctedAt || '').slice(5, 16))
                }${it.correctedBy ? ` · ${escapeHtml(it.correctedBy)}` : ''}</span>`
              : ''
          }</td>
          <td class="num">${it.qty}</td>
          <td class="num"><button class="btn btn-sm btn-ghost" type="button" data-correct="${it.entryId}">修正</button></td>
        </tr>`,
      )
      .join('');
    return `<div class="period-block ${open ? 'open' : ''}">
      <button class="period-head" type="button" data-fold="${key}" aria-expanded="${open}">
        <span class="chev">▶</span>
        <b>${periodKey === 'am' ? '上午' : '下午'}</b>
        <span class="muted small">${period.itemCount} 项 · 合计 ${period.totalQty} 件 · 本品 ${period.ownQty ?? 0} 件</span>
        <span style="flex:1"></span>
        <span class="muted tiny">提交 ${escapeHtml((period.submittedAt || '').slice(5, 16))}${
      period.submitter ? ` · ${escapeHtml(period.submitter)}` : ''
    }</span>
      </button>
      <div class="period-body">
        <table class="entry-table">
          <thead><tr><th>商品（别名 / 品名）</th><th class="num">数量</th><th class="num">操作</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" class="muted">无明细</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  }

  /**
   * 门店块。同样默认收起：收起时只看门店合计，
   * 展开后才出现上午 / 下午两个时段（它们又各自默认收起）。
   */
  function renderStoreBlock(date, store) {
    const key = foldKey.store(date, store.storeId);
    const open = state.openFolds.has(key);
    const am = store.periods.am;
    const pm = store.periods.pm;
    // 收起状态下也要能一眼看出「上午多少、下午多少」
    const brief = [
      am ? `上午 ${am.totalQty}` : '',
      pm ? `下午 ${pm.totalQty}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `<div class="store-block ${open ? 'open' : ''}">
      <button class="store-block-head" type="button" data-fold="${key}" aria-expanded="${open}">
        <span class="chev">▶</span>
        <b class="mono">${escapeHtml(store.storeCode)}</b>
        <span>${escapeHtml(store.storeName)}</span>
        <span class="muted tiny">${brief}</span>
        <span style="flex:1"></span>
        <span class="muted small">合计 ${store.totalQty} 件 · 本品 ${store.ownQty ?? 0} 件</span>
      </button>
      <div class="store-block-body">
        ${renderPeriodBlock(date, store.storeId, 'am', am)}
        ${renderPeriodBlock(date, store.storeId, 'pm', pm)}
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
            const key = foldKey.day(day.date);
            const open = state.openFolds.has(key);
            return `<div class="fold ${open ? 'open' : ''}" data-date="${day.date}">
              <button class="fold-head" type="button" data-fold="${key}" aria-expanded="${open}">
                <span class="chev">▶</span>
                <span class="fh-date">${h.fmtDay(day.date)}</span>
                <span class="fh-meta">${day.stores.length} 家门店提交 · ${day.done}/${day.expected} 次 · ${day.totalQty} 件 · 本品 ${day.ownQty ?? 0} 件</span>
                <span style="flex:1"></span>
                <span class="pill ${day.rate >= 100 ? 'pill-ok' : day.rate > 0 ? 'pill-warn' : 'pill-danger'}">${day.rate.toFixed(
                  1,
                )}%</span>
              </button>
              <div class="fold-body">
                ${
                  day.stores.length
                    ? day.stores.map((store) => renderStoreBlock(day.date, store)).join('')
                    : h.empty('当日无提交', 'archive')
                }
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
    state.openFolds.clear();
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
    // 日期层沿用原有习惯：默认展开最近一天，省掉一次点击；
    // 门店层与上午/下午两层则一律收起，由用户逐级点开。
    if (state.detail.dates.length && state.openFolds.size === 0) {
      state.openFolds.add(foldKey.day(state.detail.dates[0].date));
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
      state.openFolds.clear();
      await refreshData();
    });
    $('#f-to').addEventListener('change', async (e) => {
      state.to = e.target.value || state.to;
      if (state.to < state.from) state.from = state.to;
      state.page = 1;
      state.openFolds.clear();
      await refreshData();
    });
    $('#f-store').addEventListener('change', async (e) => {
      state.storeId = e.target.value;
      state.page = 1;
      state.openFolds.clear();
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
        state.openFolds.clear();
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

  /** 从当前明细里按 entryId 找到条目及其上下文（门店 / 日期 / 时段） */
  function findEntry(entryId) {
    if (!state.detail) return null;
    for (const day of state.detail.dates) {
      for (const store of day.stores) {
        for (const periodKey of ['am', 'pm']) {
          const period = store.periods[periodKey];
          if (!period) continue;
          const item = (period.items || []).find((x) => String(x.entryId) === String(entryId));
          if (item) return { day, store, periodKey, item };
        }
      }
    }
    return null;
  }

  /**
   * 修正单条明细。两道关防止误操作：
   * 1) 弹窗里明确列出「哪家店、哪一天、哪个时段、哪个商品」，并回填当前数量；
   * 2) 提交前再弹一次确认，把「旧值 → 新值」摆出来。
   * 同时带上 expectedQty，若期间别人先改过，后端会拒绝而不是静默覆盖。
   */
  function openCorrectDialog(entryId) {
    const found = findEntry(entryId);
    if (!found) {
      toast('该条明细已刷新，请重新展开后再试', 'err');
      return;
    }
    const { day, store, periodKey, item } = found;
    const periodLabel = periodKey === 'am' ? '上午' : '下午';
    const productLabel =
      item.alias && item.alias !== item.productName
        ? `${item.productName}（${item.alias}）`
        : item.productName;

    const m = openModal({
      title: '修正销售明细',
      body: `
        <div class="panel" style="margin:0 0 14px"><div class="panel-body">
          <p class="small" style="margin:0 0 6px"><b>门店</b>：${escapeHtml(store.storeCode)} ${escapeHtml(
            store.storeName,
          )}</p>
          <p class="small" style="margin:0 0 6px"><b>日期</b>：${escapeHtml(day.date)} ${periodLabel}</p>
          <p class="small" style="margin:0 0 6px"><b>商品</b>：${escapeHtml(productLabel)}</p>
          <p class="small" style="margin:0"><b>当前数量</b>：<b>${item.qty}</b></p>
        </div></div>
        <div class="field">
          <label for="cc-qty">修正后的数量</label>
          <input class="input" id="cc-qty" type="number" step="1" value="${item.qty}" data-qty autocomplete="off">
          <p class="hint">数量为整数；负数表示退货件数。修正会写入操作日志（含修正前后值），且不可撤销。</p>
        </div>`,
      footer: `<button class="btn btn-ghost" data-act="cancel" type="button">取消</button>
               <button class="btn" data-act="ok" type="button">确认修正</button>`,
    });

    const input = $('[data-qty]', m.root);
    const okBtn = $('[data-act="ok"]', m.root);
    $('[data-act="cancel"]', m.root).addEventListener('click', () => m.close());
    if (input) {
      input.focus();
      input.select();
    }

    okBtn.addEventListener('click', async () => {
      const raw = input ? input.value.trim() : '';
      const qty = Number(raw);
      if (raw === '' || !Number.isInteger(qty) || Math.abs(qty) > 1_000_000) {
        toast('数量需为整数，绝对值不超过 1000000', 'err');
        if (input) input.focus();
        return;
      }
      if (qty === item.qty) {
        m.close();
        toast('数量未发生变化，无需修正', 'ok');
        return;
      }
      // 第二道关：把「旧值 → 新值」摆出来再问一次
      const sure = await window.SSD.confirmDialog({
        title: '确认修正这条数据',
        message: `${store.storeCode} ${store.storeName}\n${day.date} ${periodLabel} · ${productLabel}\n\n数量将从 ${item.qty} 改为 ${qty}。\n修正会写入操作日志并立即计入报表，且无法撤销。确定继续吗？`,
        okText: '确认修正',
        danger: true,
      });
      if (!sure) return;

      okBtn.disabled = true;
      okBtn.textContent = '修正中…';
      try {
        const res = await api.put('/api/reports/detail/entry', {
          entryId: item.entryId,
          qty,
          expectedQty: item.qty,
        });
        m.close();
        toast(res && res.unchanged ? '数量未发生变化' : `已修正：${item.qty} → ${qty}`, 'ok');
        // 重新拉取明细与总览，让合计、完成率同步到修正后的值
        await refreshData();
      } catch (err) {
        okBtn.disabled = false;
        okBtn.textContent = '确认修正';
        toast(err.message || '修正失败', 'err');
        // 被他人先改过时，刷新页面数据，避免用户仍拿旧值重试
        if (err && err.status === 409) {
          m.close();
          await refreshData();
        }
      }
    });
  }

  function bindDetail() {
    // 三层折叠用同一套委托：按钮自己带 data-fold，展开状态由 state.openFolds 决定
    // 这里只 toggle 最近的那个折叠容器，避免内层点击顺带把外层也收起来
    $$('[data-fold]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.fold;
        const opened = !state.openFolds.has(key);
        if (opened) state.openFolds.add(key);
        else state.openFolds.delete(key);
        btn.setAttribute('aria-expanded', String(opened));
        // 最近的折叠容器才是要切换的那个：时段 → 门店 → 日期
        const box = btn.closest('.period-block, .store-block, .fold');
        if (box) box.classList.toggle('open', opened);
      });
    });
    // 修正按钮在折叠区内部，行数是动态的，用逐个绑定即可（每次重绘都会重新绑）
    $$('[data-correct]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        // 按钮可能嵌在可点击容器里，阻止冒泡避免顺带触发展开/收起
        e.stopPropagation();
        openCorrectDialog(btn.dataset.correct);
      });
    });
  }

  async function render(view) {
    view.innerHTML = `<div class="panel"><div class="panel-body"><div class="skeleton" style="height:180px"></div></div></div>`;
    await loadOverview();
    state.page = 1;
    state.openFolds.clear();
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
