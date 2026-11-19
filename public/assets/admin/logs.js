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
    ipLocation: '',
    from: addDays(todayStr(), -6),
    to: todayStr(),
    page: 1,
    pageSize: 30,
    data: null,
    actions: [],
    mode: 'location', // location | device
    ipdb: null,
  };

  function actionLabel(action) {
    return ACTION_LABEL[action] || action;
  }

  function actionTag(action) {
    const cls = DANGER_ACTIONS.has(action) ? 'danger' : OK_ACTIONS.has(action) ? 'ok' : '';
    return `<span class="action-tag ${cls}" title="${escapeHtml(action)}">${escapeHtml(actionLabel(action))}</span>`;
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

  function renderTable() {
    const data = state.data;
    if (!data) return '';
    const sourceHead =
      state.mode === 'location'
        ? `<th class="sortable" data-toggle-mode title="点击切换为 IP 与设备指纹">IP 归属地 ⇄</th>`
        : `<th class="sortable" data-toggle-mode title="点击切换为 IP 归属地">IP / 设备指纹 ⇄</th>`;

    const rows = data.rows.length
      ? data.rows
          .map(
            (r) => `<tr>
              <td class="tiny mono">${escapeHtml((r.created_at || '').slice(5, 19))}</td>
              <td class="small">${escapeHtml(r.actor_name || '—')}<br>
                <span class="tiny muted">${escapeHtml(window.Admin.ROLE[r.actor_role] || r.actor_role || '')}</span></td>
              <td>${actionTag(r.action)}</td>
              <td class="log-detail">${escapeHtml(r.detail || '')}</td>
              ${sourceCell(r)}
            </tr>`,
          )
          .join('')
      : `<tr><td colspan="5" class="empty">该时间范围内没有操作记录</td></tr>`;

    return `<div class="panel">
      <div class="panel-head">
        <div><h3>操作记录</h3><p>共 ${data.total} 条 · 第 ${data.page} / ${data.pages} 页</p></div>
        <div class="spacer" style="flex:1"></div>
        <button class="btn btn-sm btn-ghost" type="button" id="lg-refresh">刷新</button>
      </div>
      <div class="panel-body flush">
        <div class="table-wrap"><table class="data">
          <thead><tr>
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
        <input class="input search" id="lg-q" type="search" placeholder="搜索操作人 / 详情 / IP / 归属地" value="${escapeHtml(
          state.q,
        )}" autocomplete="off">
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
      <input class="input" id="lg-location" type="search" placeholder="归属地筛选，如 广东" value="${escapeHtml(
        state.ipLocation,
      )}">
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
    if (state.ipLocation) q.set('ipLocation', state.ipLocation);
    return q;
  }

  async function loadLogs() {
    const data = await api.get(`/api/logs?${query()}`);
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
    const loc = $('#lg-location');
    loc.addEventListener('change', async () => {
      state.ipLocation = loc.value.trim();
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
          message: '将从 GitHub 下载最新版 ip2region xdb（约 11 MB）并热替换，期间归属地解析会短暂使用旧库。继续吗？',
          okText: '开始更新',
        });
        if (!ok) return;
        updateBtn.disabled = true;
        updateBtn.textContent = '下载中…';
        try {
          const result = await api.post('/api/logs/ipdb/update', {});
          toast(`IP 库已更新（${(result.status.meta && result.status.meta.revision || '').slice(0, 10)}）`, 'ok');
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
