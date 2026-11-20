'use strict';

/* ============================================================
   用户管理：总部管理员创建/维护账号；区域管理员可查看所辖门店店员
   ============================================================ */

(function () {
  const { api, $, $$, escapeHtml, toast, openModal, confirmDialog, debounce } = window.SSD;
  const h = window.Admin.h;

  /** 新建账号的默认初始密码（可在弹窗内改成其他密码），须满足后端「至少 8 位」校验 */
  const DEFAULT_PASSWORD = '88888888';

  const state = {
    rows: [],
    counts: {},
    q: '',
    role: '',
    status: '',
    options: { stores: [] },
  };

  const isAdmin = () => window.Admin.state.user.role === 'admin';

  async function load() {
    const q = new URLSearchParams();
    if (state.q) q.set('q', state.q);
    if (state.role) q.set('role', state.role);
    if (state.status) q.set('status', state.status);
    const data = await api.get(`/api/users?${q}`);
    state.rows = data.rows;
    state.counts = data.counts || {};
    // 门店选项每次进页面都重新拉：新增 / 改名 / 停用的门店能立刻在「管辖门店」里选到
    if (isAdmin()) state.options = await api.get('/api/users/options');
  }

  /** 数据范围：店员一个门店、区域管理员一组门店编码、总部管理员全部 */
  function scopeCodes(user) {
    if (user.role === 'clerk') return user.storeCode ? [user.storeCode] : [];
    if (user.role === 'region_admin') return Array.isArray(user.storeCodes) ? user.storeCodes : [];
    return [];
  }

  /** 只展示门店编码，换行铺开，避免长名称把整行撑爆（名称一律不显示） */
  function renderScope(user) {
    if (user.role === 'admin') return '<span class="scope-all">全部门店</span>';
    const codes = scopeCodes(user);
    if (codes.length === 0) return '<span class="scope-none">未分配门店</span>';
    return `<div class="scope-codes">${codes
      .map((code) => `<span class="scope-code">${escapeHtml(code)}</span>`)
      .join('')}</div>`;
  }

  /** 姓名首字做头像，一眼区分账号类型 */
  function initial(name) {
    const text = String(name || '').trim();
    return text ? Array.from(text)[0] : '?';
  }

  function avatarClass(role) {
    if (role === 'admin') return ' is-admin';
    if (role === 'region_admin') return ' is-region';
    return '';
  }

  /** 最近登录拆成日期 + 时间两行，比一长串时间戳更好扫 */
  function loginCell(value) {
    if (!value) return '<span class="login-none">从未登录</span>';
    const stamp = String(value);
    const day = stamp.slice(0, 10);
    const time = stamp.slice(11, 16);
    return `<div class="login-cell"><b>${escapeHtml(day)}</b>${time ? `<span>${escapeHtml(time)}</span>` : ''}</div>`;
  }

  function renderTable() {
    const body = state.rows.length
      ? state.rows
          .map(
            (u) => `<tr data-user="${u.id}">
              <td>
                <div class="user-cell">
                  <span class="user-avatar${avatarClass(u.role)}">${escapeHtml(initial(u.displayName))}</span>
                  <span class="user-id">
                    <b>${escapeHtml(u.displayName)}</b>
                    <span class="user-account">${escapeHtml(u.username)}</span>
                  </span>
                </div>
              </td>
              <td><span class="pill ${
                u.role === 'admin' ? 'pill-brand' : u.role === 'region_admin' ? 'pill-info' : ''
              }">${escapeHtml(u.roleLabel)}</span></td>
              <td class="scope-cell">${renderScope(u)}</td>
              <td>${
                u.status === 'active'
                  ? '<span class="pill pill-ok"><i class="dot"></i>启用</span>'
                  : '<span class="pill pill-danger"><i class="dot"></i>禁用</span>'
              }</td>
              <td>${loginCell(u.lastLoginAt)}</td>
              <td>
                <div class="row-actions">
                ${
                  isAdmin()
                    ? `<button class="btn btn-sm btn-ghost" type="button" data-act="edit">编辑</button>
                       ${
                         u.passwordManaged
                           ? '<span class="tiny muted" title="密码由环境变量 INIT_ADMIN_PASSWORD 托管">密码托管</span>'
                           : '<button class="btn btn-sm btn-ghost" type="button" data-act="pwd">重置密码</button>'
                       }
                       ${
                         u.isBuiltin
                           ? ''
                           : '<button class="btn btn-sm btn-ghost" type="button" data-act="del">删除</button>'
                       }`
                    : '<span class="tiny muted">只读</span>'
                }
                </div>
              </td>
            </tr>`,
          )
          .join('')
      : `<tr><td colspan="6" class="empty">没有匹配的账号</td></tr>`;

    return `<div class="panel">
      <div class="panel-body flush">
        <div class="table-wrap"><table class="data user-table">
          <thead><tr><th>姓名 / 账号</th><th class="col-role">角色</th><th class="col-scope">数据范围</th><th class="col-status">状态</th><th class="col-login">最近登录</th><th>操作</th></tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </div>
    </div>`;
  }

  function renderToolbar() {
    return `<div class="toolbar">
      <label class="search-box">
        <span class="search-ico" aria-hidden="true">${h.icon('search')}</span>
        <input class="input search" id="u-q" type="search" placeholder="搜索姓名 / 账号 / 门店" value="${escapeHtml(
          state.q,
        )}" autocomplete="off">
      </label>
      <select class="select" id="u-role" aria-label="按角色筛选">
        <option value="">全部角色</option>
        <option value="admin" ${state.role === 'admin' ? 'selected' : ''}>总部管理员（${state.counts.admin || 0}）</option>
        <option value="region_admin" ${state.role === 'region_admin' ? 'selected' : ''}>区域管理员（${
          state.counts.region_admin || 0
        }）</option>
        <option value="clerk" ${state.role === 'clerk' ? 'selected' : ''}>店员（${state.counts.clerk || 0}）</option>
      </select>
      <select class="select" id="u-status" aria-label="按状态筛选">
        <option value="">全部状态</option>
        <option value="active" ${state.status === 'active' ? 'selected' : ''}>启用</option>
        <option value="disabled" ${state.status === 'disabled' ? 'selected' : ''}>禁用</option>
      </select>
      <div class="grow"></div>
      ${isAdmin() ? '<button class="btn" type="button" id="u-create">创建账号</button>' : ''}
    </div>`;
  }

  async function openUserDialog(user, onDone) {
    const isEdit = Boolean(user);
    const role = isEdit ? user.role : 'clerk';
    // 打开弹窗时再拉一次门店列表：刚在门店管理里新增 / 改名的门店能立刻选到。
    // 编辑时排除本人，否则自己正管辖的门店会被当成「已被占用」而默认隐藏。
    if (isAdmin()) {
      try {
        state.options = await api.get(`/api/users/options${isEdit ? `?excludeUserId=${user.id}` : ''}`);
      } catch {
        /* 拉取失败时沿用上次缓存，不阻断弹窗 */
      }
    }
    const m = openModal({
      title: isEdit ? '编辑账号' : '创建账号',
      wide: true,
      body: `${
        isEdit
          ? `<p class="form-note" style="margin-top:0">账号与角色创建后不可修改，如需调整请新建账号。</p>`
          : `<div class="field"><label>账号</label>
               <input class="input" id="us-username" placeholder="3-32 位字母、数字或 _ . @ -" autocomplete="off"></div>`
      }
        <div class="field"><label>姓名</label>
          <input class="input" id="us-name" value="${escapeHtml(isEdit ? user.displayName : '')}" placeholder="真实姓名"></div>
        ${
          isEdit
            ? ''
            : `<div class="field"><label>角色</label>
                 <select class="select" id="us-role">
                   <option value="clerk">店员（绑定单个门店）</option>
                   <option value="region_admin">区域管理员（管辖多家门店）</option>
                   <option value="admin">总部管理员（全部权限）</option>
                 </select></div>`
        }
        <div class="field" data-for="clerk"><label>绑定门店</label>
          <select class="select" id="us-store">
            <option value="">请选择门店</option>
            ${state.options.stores
              .map(
                (s) =>
                  `<option value="${s.id}" ${
                    isEdit && user.storeId === s.id ? 'selected' : ''
                  }>${escapeHtml(`${s.code} ${s.name}`)}${s.status === 'disabled' ? '（停用）' : ''}</option>`,
              )
              .join('')}
          </select></div>
        <div class="field" data-for="region_admin"><label>管辖门店（可多选）</label>
          <div class="store-picker">
            <div class="picker-head">
              <input class="input" id="us-store-filter" type="search" placeholder="搜索门店编码或名称，多个关键词用逗号分隔" autocomplete="off">
              <button class="btn btn-sm btn-ghost" type="button" data-pick="all">全选</button>
              <button class="btn btn-sm btn-ghost" type="button" data-pick="none">清空</button>
              <span class="pick-count" id="us-store-count">已选 0 家</span>
            </div>
            <label class="picker-toggle">
              <input type="checkbox" id="us-store-showall">
              <span>显示全部门店（含已被其他区域管理员管辖的）</span>
            </label>
            <div class="picker-grid" id="us-store-grid">
              ${state.options.stores
                .map((s) => {
                  const selected = isEdit && user.storeIds.includes(s.id);
                  return `<label class="pick-item" data-search="${escapeHtml(`${s.code} ${s.name}`)}" data-bound="${
                    s.bound ? '1' : '0'
                  }">
                    <input type="checkbox" value="${s.id}" ${selected ? 'checked' : ''}>
                    <span class="pick-text">
                      <b>${escapeHtml(s.code)}</b>
                      <span>${escapeHtml(s.name)}</span>
                    </span>
                    ${s.bound ? '<span class="pill pill-info">已被管辖</span>' : ''}
                    ${s.status === 'disabled' ? '<span class="pill">停用</span>' : ''}
                  </label>`;
                })
                .join('')}
            </div>
            <div class="picker-empty" id="us-store-empty" hidden>没有匹配的门店</div>
          </div>
          <div class="hint">默认只列出尚未被其他区域管理员管辖的门店；需要跨区关联时勾选上方「显示全部门店」。区域管理员只能查看这些门店的填报与报表数据。</div></div>
        <div class="field"><label>手机号（可选）</label>
          <input class="input" id="us-phone" value="${escapeHtml(isEdit ? user.phone : '')}"></div>
        ${
          isEdit
            ? `<div class="field"><label>状态</label>
                 <select class="select" id="us-status" ${user.passwordManaged ? 'disabled' : ''}>
                   <option value="active" ${user.status === 'active' ? 'selected' : ''}>启用</option>
                   <option value="disabled" ${user.status === 'disabled' ? 'selected' : ''}>禁用（立即下线）</option>
                 </select>
                 ${
                   user.passwordManaged
                     ? '<div class="hint">该账号由环境变量托管，状态与密码均不可在系统内修改。</div>'
                     : ''
                 }</div>`
            : `<div class="field"><label>初始密码</label>
                 <input class="input" id="us-password" type="text" value="${DEFAULT_PASSWORD}" autocomplete="off">
                 <div class="hint">默认预填 ${DEFAULT_PASSWORD}，可改成其他密码；本人首次登录后仍需自行修改。</div></div>`
        }`,
      footer: `<button class="btn btn-ghost" type="button" data-act="cancel">取消</button>
               <button class="btn" type="button" data-act="ok">${isEdit ? '保存' : '创建'}</button>`,
    });

    const updateRoleFields = () => {
      const roleSelect = $('#us-role', m.root);
      const current = isEdit ? role : roleSelect ? roleSelect.value : 'clerk';
      $$('[data-for]', m.root).forEach((el) => {
        el.style.display = el.dataset.for === current ? '' : 'none';
      });
    };
    if (!isEdit) $('#us-role', m.root).addEventListener('change', updateRoleFields);
    updateRoleFields();

    /* ---- 管辖门店：勾选卡片（默认只看未绑定门店 / 多关键词搜索 / 全选 / 清空 / 已选计数） ---- */
    const boxes = () => $$('#us-store-grid input[type="checkbox"]', m.root);
    const pickedIds = () => boxes().filter((i) => i.checked).map((i) => Number(i.value));
    const showAllInput = $('#us-store-showall', m.root);
    const filterInput = $('#us-store-filter', m.root);

    /** 同步卡片高亮与「已选 N 家」 */
    const syncPickState = () => {
      boxes().forEach((box) => box.closest('.pick-item').classList.toggle('checked', box.checked));
      $('#us-store-count', m.root).textContent = `已选 ${pickedIds().length} 家`;
    };
    const visibleBoxes = () => boxes().filter((i) => !i.closest('.pick-item').hidden);

    /**
     * 按「显示全部 + 搜索词」重算可见门店。
     *
     * 隐藏规则：
     * 1. 未勾选「显示全部」时，隐藏已被其他区域管理员管辖的门店（data-bound=1）；
     *    但已勾选的门店始终可见——编辑账号时不能把他现有的管辖范围藏起来；
     * 2. 搜索词按逗号（含全角，）拆分，任一关键词命中即可（OR），空关键词忽略。
     */
    const applyFilter = () => {
      const showAll = showAllInput.checked;
      const keywords = filterInput.value
        .split(/[,，]/)
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
      let shown = 0;
      $$('.pick-item', m.root).forEach((item) => {
        const box = item.querySelector('input[type="checkbox"]');
        const hiddenByBound = !showAll && !box.checked && item.dataset.bound === '1';
        const text = item.dataset.search.toLowerCase();
        const hitKeyword = keywords.length === 0 || keywords.some((k) => text.includes(k));
        const hit = !hiddenByBound && hitKeyword;
        item.hidden = !hit;
        if (hit) shown += 1;
      });
      $('#us-store-empty', m.root).hidden = shown > 0;
    };

    boxes().forEach((box) => box.addEventListener('change', syncPickState));
    filterInput.addEventListener('input', applyFilter);
    showAllInput.addEventListener('change', applyFilter);
    $$('[data-pick]', m.root).forEach((btn) => {
      btn.addEventListener('click', () => {
        // 「全选」只作用于当前筛选出的门店，避免搜索时误选全部
        const target = btn.dataset.pick === 'all';
        visibleBoxes().forEach((box) => {
          box.checked = target;
        });
        syncPickState();
      });
    });
    applyFilter();
    syncPickState();

    $('[data-act="cancel"]', m.root).addEventListener('click', m.close);
    $('[data-act="ok"]', m.root).addEventListener('click', async () => {
      const btn = $('[data-act="ok"]', m.root);
      const targetRole = isEdit ? role : $('#us-role', m.root).value;
      const payload = {
        displayName: $('#us-name', m.root).value.trim(),
        phone: $('#us-phone', m.root).value.trim(),
      };
      if (!isEdit) {
        payload.username = $('#us-username', m.root).value.trim();
        payload.role = targetRole;
        payload.password = $('#us-password', m.root).value;
        // 默认已预填，改动后仍需满足后端「至少 8 位」
        if (payload.password.length < 8) return toast('初始密码至少 8 位', 'err');
      }
      if (targetRole === 'clerk') {
        payload.storeId = $('#us-store', m.root).value || null;
        if (!payload.storeId) return toast('店员必须绑定门店', 'err');
      }
      if (targetRole === 'region_admin') {
        payload.storeIds = pickedIds();
        if (payload.storeIds.length === 0) return toast('区域管理员至少管辖一家门店', 'err');
      }
      if (isEdit) {
        const statusSelect = $('#us-status', m.root);
        // 托管账号的状态开关被禁用时，不应提交状态字段
        if (statusSelect && !statusSelect.disabled) payload.status = statusSelect.value;
      }
      if (!payload.displayName) return toast('姓名必填', 'err');

      btn.disabled = true;
      try {
        if (isEdit) await api.put(`/api/users/${user.id}`, payload);
        else await api.post('/api/users', payload);
        m.close();
        toast(isEdit ? '账号已更新' : '账号已创建', 'ok');
        onDone();
      } catch (err) {
        toast(err.message || '保存失败', 'err');
        btn.disabled = false;
      }
    });
  }

  function openResetDialog(user, onDone) {
    const m = openModal({
      title: `重置密码 · ${user.username}`,
      body: `<div class="field"><label>新密码</label>
          <input class="input" id="rs-password" type="text" placeholder="至少 8 位">
          <div class="hint">重置后该账号所有登录状态失效，本人下次登录需修改密码。</div></div>`,
      footer: `<button class="btn btn-ghost" type="button" data-act="cancel">取消</button>
               <button class="btn" type="button" data-act="ok">重置</button>`,
    });
    $('[data-act="cancel"]', m.root).addEventListener('click', m.close);
    $('[data-act="ok"]', m.root).addEventListener('click', async () => {
      const password = $('#rs-password', m.root).value;
      if (password.length < 8) return toast('密码至少 8 位', 'err');
      const btn = $('[data-act="ok"]', m.root);
      btn.disabled = true;
      try {
        await api.post(`/api/users/${user.id}/reset-password`, { password });
        m.close();
        toast('密码已重置', 'ok');
        onDone();
      } catch (err) {
        toast(err.message || '重置失败', 'err');
        btn.disabled = false;
      }
    });
  }

  function bind() {
    // 搜索改为边输边搜：停下来再发请求，重渲染后把焦点与光标还给输入框
    const searchInput = $('#u-q');
    const runSearch = debounce(async (value, keepFocus) => {
      state.q = value.trim();
      await refresh();
      if (!keepFocus) return;
      const el = $('#u-q');
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 300);
    searchInput.addEventListener('input', (e) => {
      runSearch(e.target.value, document.activeElement === searchInput);
    });
    // 回车立即生效，不等防抖
    searchInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      runSearch.cancel();
      state.q = searchInput.value.trim();
      refresh();
    });
    $('#u-role').addEventListener('change', async (e) => {
      state.role = e.target.value;
      await refresh();
    });
    $('#u-status').addEventListener('change', async (e) => {
      state.status = e.target.value;
      await refresh();
    });
    const createBtn = $('#u-create');
    if (createBtn) createBtn.addEventListener('click', () => openUserDialog(null, refresh));

    $$('[data-user]').forEach((tr) => {
      const user = state.rows.find((u) => u.id === Number(tr.dataset.user));
      if (!user) return;
      const editBtn = $('[data-act="edit"]', tr);
      if (editBtn) editBtn.addEventListener('click', () => openUserDialog(user, refresh));
      const pwdBtn = $('[data-act="pwd"]', tr);
      if (pwdBtn) pwdBtn.addEventListener('click', () => openResetDialog(user, refresh));
      const delBtn = $('[data-act="del"]', tr);
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: '删除账号',
            message: `确定删除「${user.displayName}（${user.username}）」吗？该操作不可恢复，历史操作日志会保留。`,
            okText: '删除',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.del(`/api/users/${user.id}`);
            toast('账号已删除', 'ok');
            await refresh();
          } catch (err) {
            toast(err.message || '删除失败', 'err');
          }
        });
      }
    });
  }

  async function paint() {
    const view = $('#view');
    view.innerHTML = `${renderToolbar()}${renderTable()}`;
    bind();
    h.subtitle(
      `共 ${state.rows.length} 个账号 · 总部 ${state.counts.admin || 0} / 区域 ${state.counts.region_admin || 0} / 店员 ${
        state.counts.clerk || 0
      }`,
    );
  }

  async function refresh() {
    await load();
    await paint();
  }

  window.Admin.register({
    id: 'users',
    title: '用户管理',
    subtitle: '账号、角色与数据范围',
    render: async (view) => {
      view.innerHTML = `<div class="panel"><div class="panel-body"><div class="skeleton" style="height:120px"></div></div></div>`;
      await load();
      await paint();
    },
  });
})();
