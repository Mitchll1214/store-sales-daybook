'use strict';

/* ============================================================
   操作日志（仅总部管理员）
   - 来源列默认展示 IP 归属地（ip2region），点击表头切换为 IP + 设备指纹
   - IP 库状态展示与「校验 / 更新」按钮
   ============================================================ */

(function () {
  const { api, $, $$, escapeHtml, toast, todayStr, addDays, debounce } = window.SSD;
  const h = window.Admin.h;

  const ACTION_LABEL = {
    login: '登录成功',
    logout: '退出登录',
    login_failed: '登录失败',
    login_blocked: '登录被限制',
    password_change: '修改密码',
    auto_login: '免登录进入',
    auto_login_failed: '免登录失败',
    user_create: '创建账号',
    user_update: '修改账号',
    user_delete: '删除账号',
    user_reset_password: '重置密码',
    user_reset_password_cli: '命令行重置密码',
    init_admin_password_sync: '同步初始密码',
    store_create: '新增门店',
    store_batch_create: '批量新增门店',
    store_update: '修改门店',
    store_auto_login_enable: '开启免登录链接',
    store_auto_login_disable: '关闭免登录链接',
    store_auto_login_rotate: '重置免登录链接',
    store_products_update: '修改门店商品关联',
    product_create: '新增商品',
    product_batch_create: '批量导入商品',
    product_update: '修改商品',
    product_delete: '删除商品',
    log_delete: '删除操作日志',
    sales_submit: '提交销售数据',
    sales_fill_zero: '批量记 0',
    image_upload: '上传凭证图片',
    image_delete: '删除凭证图片',
    report_export: '导出报表',
    ipdb_check: '校验 IP 库',
    ipdb_update: '更新 IP 库',
    ipdb_update_failed: '更新 IP 库失败',
  };

  const DANGER_ACTIONS = new Set([
    'user_delete',
    'product_delete',
    'log_delete',
    'image_delete',
    'login_failed',
    'login_blocked',
    'auto_login_failed',
    'ipdb_update_failed',
  ]);
  const OK_ACTIONS = new Set(['sales_submit', 'login', 'store_create', 'user_create', 'report_export']);

  const state = {
    q: '',
    action: '',
    from: addDays(todayStr(), -6),
    to: todayStr(),
    page: 1,
    pageSize: 30,
    data: null,
    actions: [],
    mode: 'location', // location | device
    ipdb: null,
    // 勾选只对当前页有效：翻页、改筛选、刷新都会清空，避免「以为还在选」地误删
    selected: new Set(),
  };

  function actionLabel(action) {
    return ACTION_LABEL[action] || action;
  }

  function actionTag(action) {
    const cls = DANGER_ACTIONS.has(action) ? 'danger' : OK_ACTIONS.has(action) ? 'ok' : '';
    return `<span class="action-tag ${cls}" title="${escapeHtml(action)}">${escapeHtml(actionLabel(action))}</span>`;
  }

  /**
   * 操作人单元：按「谁在操作」分两种展示。
   * - 门店操作（店员账号 / 免登录链接）：门店编码 + 门店名称，店员账号名放在下面一行，
   *   一眼看出是哪家店做的，需要追人时也还有线索。
   * - 账号操作（总部 / 区域管理员）：账号 + 姓名，同名或改名时都能对上号。
   * 老数据没有 actor_username 与门店列（v5/v6 之前写入的），退化为只显示姓名并标注角色。
   */
  function actorCell(row) {
    const name = row.actor_name || '';
    const username = row.actor_username || '';
    const storeCode = row.actor_store_code || '';
    const storeName = row.actor_store_name || '';
    const role = window.Admin.ROLE[row.actor_role] || row.actor_role || '';

    if (storeCode || storeName) {
      const staff = username || name;
      return `<span class="ac-store">${escapeHtml(storeCode || '—')}</span>
        <span class="ac-name">${escapeHtml(storeName || name || '—')}</span>
        <span class="tiny muted">${escapeHtml(role)}${staff ? ` · ${escapeHtml(staff)}` : ''}</span>`;
    }
    if (!username) {
      return `<span class="ac-name">${escapeHtml(name || '—')}</span>
        <span class="tiny muted">${escapeHtml(role)}</span>`;
    }
    return `<span class="ac-account">${escapeHtml(username)}</span>
      <span class="ac-name">${escapeHtml(name || username)}</span>
      <span class="tiny muted">${escapeHtml(role)}</span>`;
  }

  function sourceCell(row) {
    if (state.mode === 'location') {
      const loc = row.ip_location || '—';
      return `<td class="device-cell">${escapeHtml(loc)}<span class="fp">${escapeHtml(row.ip || '')}</span></td>`;
    }
    return `<td class="device-cell">${escapeHtml(row.device || '未知设备')}
      <span class="fp">${escapeHtml(row.ip || '')}</span>
      <span class="fp" title="${escapeHtml(row.device_id || '')}">指纹 ${
      escapeHtml(String(row.device_id || '').slice(0, 16)) || '—'
    }</span></td>`;
  }

  /**
   * 详情单元：按换行拆成多行渲染。
   * 超过 2 行（或单行过长）时默认折叠，点「展开全部」查看完整变更明细，
   * 这样表格不会被一条长日志撑开，细节又不会丢。
   */
  function detailCell(row) {
    const text = String(row.detail || '').trim();
    if (!text) return `<td class="log-detail"><span class="muted">—</span></td>`;
    const lines = text.split('\n');
    const foldable = lines.length > 2 || text.length > 110;
    const body = lines.map((line) => `<span class="dl-line">${escapeHtml(line) || '&nbsp;'}</span>`).join('');
    const toggle = foldable
      ? `<button class="dl-toggle" type="button" data-detail-toggle data-lines="${lines.length}"
           aria-expanded="false" aria-label="展开完整日志详情">展开全部（${lines.length} 行）</button>`
      : '';
    return `<td class="log-detail${foldable ? ' foldable' : ''}">
      <div class="dl-body${foldable ? '' : ' open'}" data-detail-body>${body}</div>
      ${toggle}
    </td>`;
  }

  function renderTable() {
    const data = state.data;
    if (!data) return '';
    const sourceHead =
      state.mode === 'location'
        ? `<th class="sortable" data-toggle-mode title="点击切换为 IP 与设备指纹">IP 归属地 ⇄</th>`
        : `<th class="sortable" data-toggle-mode title="点击切换为 IP 归属地">IP / 设备指纹 ⇄</th>`;

    const picked = state.selected.size;
    const allPicked = data.rows.length > 0 && data.rows.every((r) => state.selected.has(r.id));

    const rows = data.rows.length
      ? data.rows
          .map(
            (r) => `<tr class="${state.selected.has(r.id) ? 'picked' : ''}">
              <td class="pick-cell"><input type="checkbox" data-pick="${r.id}" ${
                state.selected.has(r.id) ? 'checked' : ''
              } aria-label="选择该条记录"></td>
              <td class="tiny mono">${escapeHtml((r.created_at || '').slice(5, 19))}</td>
              <td class="actor-cell">${actorCell(r)}</td>
              <td>${actionTag(r.action)}</td>
              ${detailCell(r)}
              ${sourceCell(r)}
            </tr>`,
          )
          .join('')
      : `<tr><td colspan="6" class="empty">该时间范围内没有操作记录</td></tr>`;

    return `<div class="panel">
      <div class="panel-head">
        <div><h3>操作记录</h3><p>共 ${data.total} 条 · 第 ${data.page} / ${data.pages} 页${
          picked ? ` · 已选 ${picked} 条` : ''
        }</p></div>
        <div class="spacer" style="flex:1"></div>
        <button class="btn btn-sm btn-danger" type="button" id="lg-delete" ${picked ? '' : 'disabled'}>删除所选${
          picked ? `（${picked}）` : ''
        }</button>
        <button class="btn btn-sm btn-ghost" type="button" id="lg-refresh">刷新</button>
      </div>
      <div class="panel-body flush">
        <div class="table-wrap"><table class="data log-table">
          <thead><tr>
            <th class="pick-cell"><input type="checkbox" data-pick-all ${allPicked ? 'checked' : ''}
              aria-label="全选本页" ${data.rows.length ? '' : 'disabled'}></th>
            <th>时间</th><th>操作人</th><th>动作</th><th>详情</th>${sourceHead}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      <div class="pager" id="lg-pager"></div>
    </div>`;
  }

  function renderToolbar() {
    return `<div class="toolbar">
      <label class="search-box">
        <span class="search-ico" aria-hidden="true">${h.icon('search')}</span>
        <input class="input search" id="lg-q" type="search"
          placeholder="搜索操作人账号 / 姓名 / 详情 / IP / 设备指纹" value="${escapeHtml(state.q)}" autocomplete="off">
      </label>
      <select class="select" id="lg-action" aria-label="按动作筛选">
        <option value="">全部动作</option>
        ${state.actions
          .map(
            (a) =>
              `<option value="${escapeHtml(a.action)}" ${state.action === a.action ? 'selected' : ''}>${escapeHtml(
                actionLabel(a.action),
              )}（${a.c}）</option>`,
          )
          .join('')}
      </select>
      <input class="input" type="date" id="lg-from" value="${state.from}" max="${todayStr()}">
      <span class="muted small">至</span>
      <input class="input" type="date" id="lg-to" value="${state.to}" max="${todayStr()}">
    </div>`;
  }

  function renderIpdb() {
    const s = state.ipdb;
    if (!s) return '';
    const badge = s.loaded
      ? `<span class="pill pill-ok">已加载</span>`
      : `<span class="pill pill-danger">未加载</span>`;
    const meta = s.meta || {};
    return `<div class="panel">
      <div class="panel-head">
        <div>
          <h3>IP 归属地库（ip2region）${badge}</h3>
          <p>${escapeHtml(
            s.loaded
              ? `${s.source === 'updated' ? '在线更新版本' : '镜像内置版本'}${
                  meta.revision ? ` · ${String(meta.revision).slice(0, 10)}` : ''
                }${meta.builtAt ? ` · 构建于 ${String(meta.builtAt).slice(0, 10)}` : ''}`
              : s.error || '未能加载 IP 库文件，日志将仅记录 IP 原值',
          )}</p>
        </div>
        <div class="spacer" style="flex:1"></div>
        <button class="btn btn-sm btn-ghost" type="button" id="ipdb-check">校验更新</button>
        <button class="btn btn-sm btn-soft" type="button" id="ipdb-update">更新 IP 库</button>
      </div>
      <div class="panel-body">
        <p class="small muted" style="margin:0">
          校验只读取上游版本信息，不下载；更新会下载最新 v4 xdb 并热替换，无需重启服务。
          上游：<span class="mono">${escapeHtml((s.upstream && s.upstream.repo) || '')}</span>
        </p>
      </div>
    </div>`;
  }

  function mountPager() {
    const host = $('#lg-pager');
    if (!host || !state.data) return;
    const d = state.data;
    host.innerHTML = `
      <button type="button" data-go="prev" ${d.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${d.page} / ${d.pages} 页</span>
      <button type="button" data-go="next" ${d.page >= d.pages ? 'disabled' : ''}>下一页</button>`;
    host.querySelector('[data-go="prev"]').addEventListener('click', () => gotoPage(d.page - 1));
    host.querySelector('[data-go="next"]').addEventListener('click', () => gotoPage(d.page + 1));
  }

  async function gotoPage(page) {
    if (!state.data || page < 1 || page > state.data.pages) return;
    state.page = page;
    await loadLogs();
    await paint();
  }

  function query() {
    const q = new URLSearchParams({
      from: state.from,
      to: state.to,
      page: String(state.page),
      pageSize: String(state.pageSize),
    });
    if (state.q) q.set('q', state.q);
    if (state.action) q.set('action', state.action);
    return q;
  }

  async function loadLogs() {
    // 选中状态只属于当前这一屏：翻页、筛选、刷新后一律清空
    state.selected.clear();
    let data = await api.get(`/api/logs?${query()}`);
    // 把当前页删空了就退回最后一页，不要停在空白页上
    if (data.rows.length === 0 && data.total > 0 && data.page > data.pages) {
      state.page = data.pages;
      data = await api.get(`/api/logs?${query()}`);
    }
    state.data = data;
    state.actions = data.actions || [];
  }

  async function refresh() {
    await loadLogs();
    await paint();
  }

  function bind() {
    const search = $('#lg-q');
    // 边输边搜：停止输入后再请求；重渲染后把焦点与光标还给搜索框
    const runSearch = debounce(async (value) => {
      state.q = value.trim();
      state.page = 1;
      await refresh();
      const el = $('#lg-q');
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 300);
    search.addEventListener('input', (e) => runSearch(e.target.value));
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      runSearch.cancel();
      state.q = search.value.trim();
      state.page = 1;
      refresh();
    });
    $('#lg-action').addEventListener('change', async (e) => {
      state.action = e.target.value;
      state.page = 1;
      await refresh();
    });
    $('#lg-from').addEventListener('change', async (e) => {
      state.from = e.target.value || state.from;
      if (state.from > state.to) state.to = state.from;
      state.page = 1;
      await refresh();
    });
    $('#lg-to').addEventListener('change', async (e) => {
      state.to = e.target.value || state.to;
      if (state.to < state.from) state.from = state.to;
      state.page = 1;
      await refresh();
    });

    const refreshBtn = $('#lg-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);

    // 勾选状态即时反馈：只改按钮与行高亮，不重渲染表格（避免丢失展开的详情与滚动位置）
    const deleteBtn = $('#lg-delete');
    const syncPicked = () => {
      const picked = state.selected.size;
      if (deleteBtn) {
        deleteBtn.disabled = picked === 0;
        deleteBtn.textContent = picked ? `删除所选（${picked}）` : '删除所选';
      }
      const all = $('[data-pick-all]');
      const rows = state.data ? state.data.rows : [];
      if (all) all.checked = rows.length > 0 && rows.every((r) => state.selected.has(r.id));
      $$('[data-pick]').forEach((box) => {
        const tr = box.closest('tr');
        if (tr) tr.classList.toggle('picked', box.checked);
      });
      if (state.data) {
        const p = $('.panel-head p');
        if (p) {
          const base = `共 ${state.data.total} 条 · 第 ${state.data.page} / ${state.data.pages} 页`;
          p.textContent = picked ? `${base} · 已选 ${picked} 条` : base;
        }
      }
    };

    $$('[data-pick]').forEach((box) => {
      box.addEventListener('change', () => {
        const id = Number(box.dataset.pick);
        if (box.checked) state.selected.add(id);
        else state.selected.delete(id);
        syncPicked();
      });
    });

    const allBox = $('[data-pick-all]');
    if (allBox) {
      allBox.addEventListener('change', () => {
        const rows = state.data ? state.data.rows : [];
        state.selected.clear();
        if (allBox.checked) rows.forEach((r) => state.selected.add(r.id));
        $$('[data-pick]').forEach((box) => {
          box.checked = allBox.checked;
        });
        syncPicked();
      });
    }

    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        const ids = [...state.selected];
        if (!ids.length) return;
        const ok = await window.SSD.confirmDialog({
          title: '删除操作记录',
          message: `确定删除所选的 ${ids.length} 条操作记录吗？该操作不可恢复，删除动作本身会写入一条新的操作日志。`,
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        deleteBtn.disabled = true;
        try {
          const result = await api.post('/api/logs/delete', { ids });
          toast(`已删除 ${result.deleted} 条操作记录`, 'ok');
          state.selected.clear();
          await refresh();
        } catch (err) {
          toast(err.message || '删除失败', 'err');
          deleteBtn.disabled = false;
        }
      });
    }

    // 详情展开/收起：就地切换，不重渲染，避免翻页状态与滚动位置丢失
    $$('[data-detail-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cell = btn.closest('.log-detail');
        const body = cell && cell.querySelector('[data-detail-body]');
        if (!body) return;
        const open = body.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = open ? '收起' : `展开全部（${btn.dataset.lines} 行）`;
        btn.setAttribute('aria-label', open ? '收起日志详情' : '展开完整日志详情');
      });
    });

    $$('[data-toggle-mode]').forEach((th) => {
      th.addEventListener('click', async () => {
        state.mode = state.mode === 'location' ? 'device' : 'location';
        await paint();
      });
    });

    const checkBtn = $('#ipdb-check');
    if (checkBtn) {
      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = '校验中…';
        try {
          const result = await api.post('/api/logs/ipdb/check', {});
          if (!result.reachable) toast(result.reason || '无法连接上游', 'err');
          else if (result.hasUpdate) toast('发现新的 IP 库版本，可点击「更新 IP 库」', 'ok');
          else toast('当前 IP 库已是最新版本', 'ok');
          await loadIpdb();
          await paint();
        } catch (err) {
          toast(err.message || '校验失败', 'err');
        } finally {
          checkBtn.disabled = false;
          checkBtn.textContent = '校验更新';
        }
      });
    }

    const updateBtn = $('#ipdb-update');
    if (updateBtn) {
      updateBtn.addEventListener('click', async () => {
        const ok = await window.SSD.confirmDialog({
          title: '更新 IP 库',
          message:
            '将从 GitHub 及其 CDN 镜像下载最新版 ip2region xdb（约 11 MB）并热替换，期间归属地解析会短暂使用旧库。网络较慢时可能需等待 1–3 分钟，请勿关闭页面。继续吗？',
          okText: '开始更新',
        });
        if (!ok) return;
        updateBtn.disabled = true;
        updateBtn.textContent = '下载中…';
        try {
          const result = await api.post('/api/logs/ipdb/update', {});
          const via = result.via && result.via.label ? `，下载源 ${result.via.label}` : '';
          const rev = ((result.status.meta && result.status.meta.revision) || '').slice(0, 10);
          toast(`IP 库已更新${rev ? `（版本 ${rev}）` : ''}${via}`, 'ok');
          await loadIpdb();
          await paint();
        } catch (err) {
          toast(err.message || '更新失败', 'err');
        } finally {
          updateBtn.disabled = false;
          updateBtn.textContent = '更新 IP 库';
        }
      });
    }
  }

  async function loadIpdb() {
    try {
      state.ipdb = await api.get('/api/logs/ipdb');
    } catch {
      state.ipdb = null;
    }
  }

  async function paint() {
    const view = $('#view');
    view.innerHTML = `${renderToolbar()}${renderTable()}${renderIpdb()}`;
    bind();
    mountPager();
    h.subtitle(`默认展示 IP 归属地，点击来源列表头可切换设备指纹`);
  }

  window.Admin.register({
    id: 'logs',
    title: '操作日志',
    subtitle: '账号、密码、图片等关键操作全量记录',
    render: async (view) => {
      view.innerHTML = `<div class="panel"><div class="panel-body"><div class="skeleton" style="height:140px"></div></div></div>`;
      await Promise.all([loadLogs(), loadIpdb()]);
      await paint();
    },
  });
})();
