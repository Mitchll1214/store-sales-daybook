'use strict';

/* ============================================================
   门店管理：批量新增、编辑、商品关联、免登录链接（复制 / 二维码 / 开关）
   区域管理员：只读门店信息，可查看链接与二维码
   ============================================================ */

(function () {
  const { api, $, $$, escapeHtml, toast, openModal, confirmDialog, copyText, debounce } = window.SSD;
  const h = window.Admin.h;

  const state = {
    rows: [],
    q: '',
    status: '',
    canEdit: false,
  };

  async function load() {
    const q = new URLSearchParams();
    if (state.q) q.set('q', state.q);
    if (state.status) q.set('status', state.status);
    const data = await api.get(`/api/stores?${q}`);
    state.rows = data.rows;
    state.canEdit = window.Admin.state.user.role === 'admin';
  }

  function renderStoreCard(store) {
    const scope =
      store.productScope === 'linked'
        ? `<span class="pill pill-info">关联 ${store.linkedCount} 个商品</span>`
        : `<span class="pill">全部启用商品（${store.activeProductCount}）</span>`;
    const statusPill =
      store.status === 'active' ? '<span class="pill pill-ok">启用</span>' : '<span class="pill pill-danger">停用</span>';
    const linkPill = store.autoLoginEnabled
      ? '<span class="pill pill-ok">免登录链接可用</span>'
      : '<span class="pill">免登录链接已关闭</span>';
    // 别名是店员端唯一可见的门店标识，这里并列显示便于管理员核对「店员看到的是什么」
    const aliasPill = store.alias
      ? `<span class="pill pill-info" title="店员端显示这个别名">别名 ${escapeHtml(store.alias)}</span>`
      : '<span class="pill pill-warn" title="未设置别名，店员端只显示「本门店」">未设别名</span>';

    return `<div class="store-card" data-store="${store.id}">
      <div class="sc-head">
        <div>
          <h3>${escapeHtml(store.name)}</h3>
          <div class="sc-code">${escapeHtml(store.code)}</div>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end">${aliasPill}${statusPill}${linkPill}</div>
      </div>

      <div class="sc-info">${scope}</div>

      <div class="link-row">
        <input type="text" readonly value="${escapeHtml(store.autoLoginUrl || '免登录链接不可用')}" data-link readonly>
        <button type="button" data-act="copy" ${store.autoLoginUrl ? '' : 'disabled'}>复制链接</button>
        <button type="button" data-act="qr" ${store.autoLoginUrl ? '' : 'disabled'}>二维码</button>
      </div>

      <div class="sc-actions">
        ${
          state.canEdit
            ? `<button class="btn btn-sm btn-soft" type="button" data-act="edit">编辑</button>
               <button class="btn btn-sm btn-ghost" type="button" data-act="products">关联商品</button>
               <button class="btn btn-sm btn-ghost" type="button" data-act="toggle">${
                 store.autoLoginEnabled ? '关闭免登录' : '开启免登录'
               }</button>
               <button class="btn btn-sm btn-ghost" type="button" data-act="rotate">重置链接</button>`
            : `<span class="tiny muted">区域管理员可查看链接与二维码，门店信息由总部维护</span>`
        }
      </div>
    </div>`;
  }

  function renderList() {
    if (state.rows.length === 0) {
      return `<div class="panel"><div class="panel-body">${h.empty('没有匹配的门店，可批量粘贴新增', 'shop')}</div></div>`;
    }
    return `<div class="store-card-grid" id="store-grid">${state.rows.map(renderStoreCard).join('')}</div>`;
  }

  function renderToolbar() {
    return `<div class="toolbar">
      <label class="search-box">
        <span class="search-ico" aria-hidden="true">${h.icon('search')}</span>
        <input class="input search" id="f-q" type="search" placeholder="搜索门店编码 / 名称 / 别名" value="${escapeHtml(
          state.q,
        )}" autocomplete="off">
      </label>
      <select class="select" id="f-status" aria-label="按状态筛选">
        <option value="">全部状态</option>
        <option value="active" ${state.status === 'active' ? 'selected' : ''}>启用</option>
        <option value="disabled" ${state.status === 'disabled' ? 'selected' : ''}>停用</option>
      </select>
      <div class="grow"></div>
      <span class="muted small">共 ${state.rows.length} 家</span>
      ${state.canEdit ? '<button class="btn btn-soft" type="button" id="btn-batch">批量新增</button>' : ''}
      ${state.canEdit ? '<button class="btn" type="button" id="btn-create">新增门店</button>' : ''}
    </div>`;
  }

  /* ---------------- 弹窗 ---------------- */

  function openBatchDialog(onDone) {
    const m = openModal({
      title: '批量新增门店',
      body: `<div class="field">
          <label>粘贴门店编码与名称</label>
          <textarea class="textarea" rows="9" id="batch-text"
            placeholder="S001  城东旗舰店&#10;S002  城西分店&#10;S003,广州一店,羊城店&#10;&#10;每行一家，编码与名称用空格、逗号或制表符分隔；用逗号 / 制表符时可再加一段门店别名"></textarea>
          <div class="hint">门店编码唯一；免登录链接会在创建时自动生成并默认开启。别名只在店员端显示，留空时店员端显示「本门店」。</div>
        </div>
`,
      footer: `<button class="btn btn-ghost" type="button" data-act="cancel">取消</button>
               <button class="btn" type="button" data-act="ok">开始导入</button>`,
    });
    $('[data-act="cancel"]', m.root).addEventListener('click', m.close);
    $('[data-act="ok"]', m.root).addEventListener('click', async () => {
      const text = $('#batch-text', m.root).value.trim();
      if (!text) return toast('请先粘贴门店信息', 'err');
      const btn = $('[data-act="ok"]', m.root);
      btn.disabled = true;
      btn.textContent = '导入中…';
      try {
        const data = await api.post('/api/stores/batch', { text });
        m.close();
        const skipped = data.skipped || [];
        toast(`新增 ${data.created.length} 家门店${skipped.length ? `，跳过 ${skipped.length} 家` : ''}`, 'ok');
        if (skipped.length) {
          const detail = openModal({
            title: `已跳过的 ${skipped.length} 家门店`,
            body: `<div class="table-wrap"><table class="data">
              <thead><tr><th>编码</th><th>名称</th><th>原因</th></tr></thead>
              <tbody>${skipped
                .map(
                  (s) =>
                    `<tr><td class="mono">${escapeHtml(s.code)}</td><td>${escapeHtml(s.name)}</td><td class="muted">${escapeHtml(
                      s.reason,
                    )}</td></tr>`,
                )
                .join('')}</tbody></table></div>`,
            footer: '<button class="btn" type="button" data-act="close">知道了</button>',
          });
          $('[data-act="close"]', detail.root).addEventListener('click', detail.close);
        }
        onDone();
      } catch (err) {
        toast(err.message || '导入失败', 'err');
        btn.disabled = false;
        btn.textContent = '开始导入';
      }
    });
  }

  function openStoreDialog(store, onDone) {
    const isEdit = Boolean(store);
    const m = openModal({
      title: isEdit ? '编辑门店' : '新增门店',
      body: `<div class="field"><label>门店编码</label>
          <input class="input" id="st-code" value="${escapeHtml(store ? store.code : '')}" placeholder="如 S001" autocomplete="off"></div>
        <div class="field"><label>门店名称</label>
          <input class="input" id="st-name" value="${escapeHtml(store ? store.name : '')}" placeholder="如 城东旗舰店" autocomplete="off"></div>
        <div class="field"><label>门店别名（店员端可见）</label>
          <input class="input" id="st-alias" value="${escapeHtml(store ? store.alias || '' : '')}" placeholder="如 城东店" autocomplete="off">
          <div class="hint">店员端所有显示门店名称与编码的地方都会换成这个别名；留空时只显示「本门店」。后台与操作日志仍用真实编码与名称。</div></div>
        <div class="field"><label>状态</label>
          <select class="select" id="st-status">
            <option value="active" ${!store || store.status === 'active' ? 'selected' : ''}>启用</option>
            <option value="disabled" ${store && store.status === 'disabled' ? 'selected' : ''}>停用（不参与统计）</option>
          </select></div>
        <div class="field"><label>备注（可选）</label>
          <input class="input" id="st-remark" value="${escapeHtml(store ? store.remark : '')}" placeholder="内部备注"></div>`,
      footer: `<button class="btn btn-ghost" type="button" data-act="cancel">取消</button>
               <button class="btn" type="button" data-act="ok">保存</button>`,
    });
    $('[data-act="cancel"]', m.root).addEventListener('click', m.close);
    $('[data-act="ok"]', m.root).addEventListener('click', async () => {
      const payload = {
        code: $('#st-code', m.root).value.trim(),
        name: $('#st-name', m.root).value.trim(),
        alias: $('#st-alias', m.root).value.trim(),
        status: $('#st-status', m.root).value,
        remark: $('#st-remark', m.root).value.trim(),
      };
      if (!payload.code || !payload.name) return toast('编码与名称均必填', 'err');
      const btn = $('[data-act="ok"]', m.root);
      btn.disabled = true;
      try {
        if (isEdit) await api.put(`/api/stores/${store.id}`, payload);
        else await api.post('/api/stores', payload);
        m.close();
        toast(isEdit ? '门店已更新' : '门店已创建，免登录链接已生成', 'ok');
        onDone();
      } catch (err) {
        toast(err.message || '保存失败', 'err');
        btn.disabled = false;
      }
    });
  }

  async function openProductsDialog(store) {
    let detail;
    try {
      detail = await api.get(`/api/stores/${store.id}`);
      const products = await api.get('/api/products?status=active');
      const linked = new Set(detail.linkedProductIds || []);
      const useAll = linked.size === 0;
      const m = openModal({
        title: `关联商品 · ${store.code}`,
        wide: true,
        body: `<p class="form-note" style="margin-top:0">
            不勾选任何商品时，门店默认关联<b>全部启用状态商品</b>；勾选后只填报所选商品。
          </p>
          <div class="picker-head">
            <label class="checkline" style="margin:0">
              <input type="checkbox" id="pk-all" ${useAll ? 'checked' : ''}>
              <span>关联全部启用商品（${products.rows.length}）</span>
            </label>
            <div class="grow" style="flex:1"></div>
            <input class="input" id="pk-search" type="search" placeholder="筛选商品" style="max-width:180px">
          </div>
          <div class="product-picker" id="pk-list">
            ${products.rows
              .map(
                (p) => `<label data-name="${escapeHtml(`${p.name} ${p.alias} ${p.barcode}`)}">
                  <input type="checkbox" value="${p.id}" ${linked.has(p.id) ? 'checked' : ''}>
                  <span>${escapeHtml(p.alias)}<br><span class="tiny muted">${escapeHtml(p.name)}</span></span>
                  <span class="p-meta">${escapeHtml(p.barcode || '无条码')}</span>
                </label>`,
              )
              .join('')}
          </div>`,
        footer: `<button class="btn btn-ghost" type="button" data-act="cancel">取消</button>
                 <button class="btn" type="button" data-act="ok">保存关联</button>`,
      });

      const allBox = $('#pk-all', m.root);
      const boxes = () => $$('#pk-list input[type="checkbox"]', m.root);
      const syncDisabled = () => {
        boxes().forEach((b) => {
          b.disabled = allBox.checked;
          if (allBox.checked) b.checked = false;
        });
      };
      syncDisabled();
      allBox.addEventListener('change', syncDisabled);
      $('#pk-search', m.root).addEventListener('input', (e) => {
        const kw = e.target.value.trim();
        $$('#pk-list label', m.root).forEach((label) => {
          label.style.display = !kw || label.dataset.name.includes(kw) ? '' : 'none';
        });
      });

      $('[data-act="cancel"]', m.root).addEventListener('click', m.close);
      $('[data-act="ok"]', m.root).addEventListener('click', async () => {
        const ids = allBox.checked ? [] : boxes().filter((b) => b.checked).map((b) => Number(b.value));
        const btn = $('[data-act="ok"]', m.root);
        btn.disabled = true;
        try {
          await api.put(`/api/stores/${store.id}/products`, { productIds: ids });
          m.close();
          toast(ids.length ? `已关联 ${ids.length} 个商品` : '已恢复为全部启用商品', 'ok');
          await refresh();
        } catch (err) {
          toast(err.message || '保存失败', 'err');
          btn.disabled = false;
        }
      });
    } catch (err) {
      toast(err.message || '加载商品失败', 'err');
    }
  }

  async function openQrDialog(store) {
    const m = openModal({
      title: `免登录二维码 · ${store.code}`,
      body: `<div class="qr-box">
          <div id="qr-host"><div class="skeleton" style="height:240px"></div></div>
          <div class="qr-meta">
            <div><b>${escapeHtml(store.code)} · ${escapeHtml(store.name)}</b></div>
            <div>店员端显示为：${escapeHtml(store.displayAlias || store.alias || '本门店')}</div>
            <div class="mono" style="overflow-wrap:anywhere">${escapeHtml(store.autoLoginUrl || '')}</div>
            <div class="tiny muted">链接只有随机 token，不含门店编码与名称</div>
            ${store.autoLoginEnabled ? '' : '<div style="color:var(--danger)">该门店免登录链接当前已关闭，扫码会提示不可用</div>'}
          </div>
        </div>`,
      footer: `<button class="btn btn-ghost" type="button" data-act="copy">复制链接</button>
               <button class="btn" type="button" data-act="close">关闭</button>`,
    });
    try {
      const res = await fetch(`/api/stores/${store.id}/qrcode`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(`二维码加载失败（${res.status}）`);
      const svg = await res.text();
      const host = $('#qr-host', m.root);
      if (host) host.innerHTML = svg;
    } catch (err) {
      const host = $('#qr-host', m.root);
      if (host) host.innerHTML = `<div class="empty-state"><div class="icon">${h.icon('alert')}</div><p>${escapeHtml(err.message)}</p></div>`;
    }
    $('[data-act="close"]', m.root).addEventListener('click', m.close);
    $('[data-act="copy"]', m.root).addEventListener('click', async () => {
      const ok = await copyText(store.autoLoginUrl || '');
      toast(ok ? '链接已复制' : '复制失败，请手动长按选择', ok ? 'ok' : 'err');
    });
  }

  /* ---------------- 绑定 ---------------- */

  function bindGrid() {
    $$('.store-card').forEach((card) => {
      const storeId = Number(card.dataset.store);
      const store = state.rows.find((s) => s.id === storeId);
      if (!store) return;

      const copyBtn = $('[data-act="copy"]', card);
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          const ok = await copyText(store.autoLoginUrl || '');
          toast(ok ? '链接已复制' : '复制失败，请手动长按选择', ok ? 'ok' : 'err');
        });
      }
      const qrBtn = $('[data-act="qr"]', card);
      if (qrBtn) qrBtn.addEventListener('click', () => openQrDialog(store));

      const editBtn = $('[data-act="edit"]', card);
      if (editBtn) editBtn.addEventListener('click', () => openStoreDialog(store, refresh));

      const productBtn = $('[data-act="products"]', card);
      if (productBtn) productBtn.addEventListener('click', () => openProductsDialog(store));

      const toggleBtn = $('[data-act="toggle"]', card);
      if (toggleBtn) {
        toggleBtn.addEventListener('click', async () => {
          const enable = !store.autoLoginEnabled;
          const ok = await confirmDialog({
            title: enable ? '开启免登录链接' : '关闭免登录链接',
            message: enable
              ? '开启后，任何拿到该链接的人都能进入本门店的填报页，请仅在可信任范围内分享。'
              : '关闭后，已分享的链接和二维码都会立即失效，扫码会提示不可用。',
            okText: enable ? '开启' : '关闭',
            danger: !enable,
          });
          if (!ok) return;
          try {
            await api.patch(`/api/stores/${store.id}/auto-login`, { enabled: enable });
            toast(enable ? '免登录链接已开启' : '免登录链接已关闭', 'ok');
            await refresh();
          } catch (err) {
            toast(err.message || '操作失败', 'err');
          }
        });
      }

      const rotateBtn = $('[data-act="rotate"]', card);
      if (rotateBtn) {
        rotateBtn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: '重置免登录链接',
            message: '重置后旧链接与旧二维码立即失效，需要重新分发新链接。确定重置吗？',
            okText: '重置',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.post(`/api/stores/${store.id}/rotate-token`, {});
            toast('链接已重置，请重新分发', 'ok');
            await refresh();
          } catch (err) {
            toast(err.message || '重置失败', 'err');
          }
        });
      }
    });
  }

  function bindToolbar() {
    const input = $('#f-q');
    // 边输边搜：停止输入后再请求；重渲染后把焦点与光标还给搜索框
    const runSearch = debounce(async (value) => {
      state.q = value.trim();
      await refresh();
      const el = $('#f-q');
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 300);
    input.addEventListener('input', (e) => runSearch(e.target.value));
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      runSearch.cancel();
      state.q = input.value.trim();
      refresh();
    });
    $('#f-status').addEventListener('change', async (e) => {
      state.status = e.target.value;
      await refresh();
    });
    const batchBtn = $('#btn-batch');
    if (batchBtn) batchBtn.addEventListener('click', () => openBatchDialog(refresh));
    const createBtn = $('#btn-create');
    if (createBtn) createBtn.addEventListener('click', () => openStoreDialog(null, refresh));
  }

  async function refresh() {
    await load();
    await paint();
  }

  async function paint() {
    const view = $('#view');
    view.innerHTML = `${renderToolbar()}${renderList()}`;
    bindToolbar();
    bindGrid();
    h.subtitle(
      state.canEdit ? '批量新增、维护门店与免登录链接' : '查看所辖门店及其免登录链接与二维码',
    );
  }

  async function render(view) {
    view.innerHTML = `<div class="panel"><div class="panel-body"><div class="skeleton" style="height:160px"></div></div></div>`;
    try {
      await load();
      await paint();
    } catch (err) {
      view.innerHTML = `<div class="panel"><div class="panel-body">${h.empty(
        err.message || '门店加载失败',
        'alert',
      )}</div></div>`;
    }
  }

  window.Admin.register({
    id: 'stores',
    title: '门店管理',
    subtitle: '批量新增、维护门店与免登录链接',
    render,
  });
})();
