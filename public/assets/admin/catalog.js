'use strict';

/* ============================================================
   商品档案（品名 / 别名 / 条码 / 状态）
   ============================================================ */

(function () {
  const { api, $, $$, escapeHtml, toast, openModal, confirmDialog, debounce } = window.SSD;
  const h = window.Admin.h;

  const isAdmin = () => window.Admin.state.user.role === 'admin';

  /* ==================== 商品档案 ==================== */

  const productState = {
    rows: [],
    counts: { active: 0, disabled: 0 },
    categories: [],
    kinds: [],
    q: '',
    status: '',
  };

  async function loadProducts() {
    const q = new URLSearchParams();
    if (productState.q) q.set('q', productState.q);
    if (productState.status) q.set('status', productState.status);
    const data = await api.get(`/api/products?${q}`);
    productState.rows = data.rows;
    productState.counts = data.counts;
    productState.categories = data.categories || [];
    productState.kinds = data.kinds || [];
  }

  /** 已有品类作为输入框的候选，选不中就直接当新品类提交 */
  function categoryOptions() {
    return productState.categories
      .map((c) => `<option value="${escapeHtml(c)}"></option>`)
      .join('');
  }

  function kindOptions(selected) {
    const kinds = productState.kinds.length
      ? productState.kinds
      : [
          { value: 'own', label: '本品' },
          { value: 'comp', label: '竞品' },
        ];
    return kinds
      .map(
        (k) =>
          `<option value="${k.value}" ${selected === k.value ? 'selected' : ''}>${escapeHtml(k.label)}</option>`,
      )
      .join('');
  }

  function renderProducts() {
    const rows = productState.rows;
    const body = rows.length
      ? rows
          .map(
            (p) => `<tr data-product="${p.id}">
              <td>${escapeHtml(p.name)}</td>
              <td><b>${escapeHtml(p.alias)}</b><br><span class="tiny muted">店员端仅显示别名</span></td>
              <td class="mono">${escapeHtml(p.barcode || '—')}</td>
              <td>${escapeHtml(p.category || '未分类')}</td>
              <td><span class="pill ${p.kind === 'own' ? 'pill-brand' : ''}">${escapeHtml(
                p.kindLabel || (p.kind === 'own' ? '本品' : '竞品'),
              )}</span></td>
              <td>${
                p.status === 'active'
                  ? '<span class="pill pill-ok">启用</span>'
                  : '<span class="pill">禁用</span>'
              }</td>
              <td>${
                isAdmin()
                  ? `<button class="btn btn-sm btn-ghost" type="button" data-act="edit">编辑</button>
                     <button class="btn btn-sm btn-ghost" type="button" data-act="toggle">${
                       p.status === 'active' ? '禁用' : '启用'
                     }</button>
                     <button class="btn btn-sm btn-danger" type="button" data-act="del">删除</button>`
                  : '<span class="tiny muted">只读</span>'
              }</td>
            </tr>`,
          )
          .join('')
      : `<tr><td colspan="7" class="empty">暂无商品，可先批量导入</td></tr>`;

    return `<div class="toolbar">
        <label class="search-box">
          <span class="search-ico" aria-hidden="true">${h.icon('search')}</span>
          <input class="input search" id="p-q" type="search" placeholder="搜索品名 / 别名 / 条码" value="${escapeHtml(
            productState.q,
          )}" autocomplete="off">
        </label>
        <select class="select" id="p-status" aria-label="按状态筛选">
          <option value="">全部状态</option>
          <option value="active" ${productState.status === 'active' ? 'selected' : ''}>启用（${
      productState.counts.active
    }）</option>
          <option value="disabled" ${productState.status === 'disabled' ? 'selected' : ''}>禁用（${
      productState.counts.disabled
    }）</option>
        </select>
        <div class="grow"></div>
        ${isAdmin() ? '<button class="btn btn-soft" type="button" id="p-batch">批量导入</button>' : ''}
        ${isAdmin() ? '<button class="btn" type="button" id="p-create">新增商品</button>' : ''}
      </div>
      <div class="panel">
        <div class="panel-body flush">
          <div class="table-wrap"><table class="data">
            <thead><tr><th>品名</th><th>别名（店员可见）</th><th>条码</th><th>品类</th><th>属性</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>${body}</tbody>
          </table></div>
        </div>
      </div>`;
  }

  function openProductDialog(product, onDone) {
    const isEdit = Boolean(product);
    const m = openModal({
      title: isEdit ? '编辑商品' : '新增商品',
      body: `<div class="field"><label>品名</label>
          <input class="input" id="pd-name" value="${escapeHtml(product ? product.name : '')}" placeholder="内部使用，店员不可见"></div>
        <div class="field"><label>别名</label>
          <input class="input" id="pd-alias" value="${escapeHtml(product ? product.alias : '')}" placeholder="店员端展示的名称，留空则用品名"></div>
        <div class="field"><label>条码（可选）</label>
          <input class="input" id="pd-barcode" value="${escapeHtml(product ? product.barcode : '')}" placeholder="唯一，可留空"></div>
        <div class="field"><label>品类</label>
          <input class="input" id="pd-category" list="pd-category-list" autocomplete="off"
            value="${escapeHtml(product ? product.category : '')}" placeholder="选择已有品类或直接输入新品类">
          <datalist id="pd-category-list">${categoryOptions()}</datalist>
          <div class="hint">汇总柱形图按品类分组；留空归入「未分类」。</div></div>
        <div class="field"><label>属性</label>
          <select class="select" id="pd-kind">${kindOptions(product ? product.kind : 'own')}</select>
          <div class="hint">本品在概览图中高亮显示，竞品作为对照；未设置按竞品统计。</div></div>
        <div class="field"><label>状态</label>
          <select class="select" id="pd-status">
            <option value="active" ${!product || product.status === 'active' ? 'selected' : ''}>启用</option>
            <option value="disabled" ${product && product.status === 'disabled' ? 'selected' : ''}>禁用（不参与填报与统计）</option>
          </select></div>`,
      footer: `<button class="btn btn-ghost" type="button" data-act="cancel">取消</button>
               <button class="btn" type="button" data-act="ok">保存</button>`,
    });
    $('[data-act="cancel"]', m.root).addEventListener('click', m.close);
    $('[data-act="ok"]', m.root).addEventListener('click', async () => {
      const payload = {
        name: $('#pd-name', m.root).value.trim(),
        alias: $('#pd-alias', m.root).value.trim(),
        barcode: $('#pd-barcode', m.root).value.trim(),
        category: $('#pd-category', m.root).value.trim(),
        kind: $('#pd-kind', m.root).value,
        status: $('#pd-status', m.root).value,
      };
      if (!payload.name) return toast('品名必填', 'err');
      if (!payload.alias) payload.alias = payload.name;
      const btn = $('[data-act="ok"]', m.root);
      btn.disabled = true;
      try {
        if (isEdit) await api.put(`/api/products/${product.id}`, payload);
        else await api.post('/api/products', payload);
        m.close();
        toast(isEdit ? '商品已更新' : '商品已新增', 'ok');
        onDone();
      } catch (err) {
        toast(err.message || '保存失败', 'err');
        btn.disabled = false;
      }
    });
  }

  function openBatchProducts(onDone) {
    const m = openModal({
      title: '批量导入商品',
      body: `<div class="field">
          <label>每行一条：品名 [别名] [条码] [品类] [属性]</label>
          <textarea class="textarea" rows="9" id="pb-text"
            placeholder="矿泉水 饮用水 6901234567890 饮料 本品&#10;可乐 汽水  饮料 竞品&#10;面包 现烤面包 烘焙 本品"></textarea>
          <div class="hint">字段之间用空格、逗号或制表符分隔；含制表符/逗号时严格按「品名, 别名, 条码, 品类, 属性」读取，纯空格分隔时条码须为纯数字，属性写在末尾（本品 / 竞品），其余并入品类。属性留空按竞品统计。</div>
        </div>`,
      footer: `<button class="btn btn-ghost" type="button" data-act="cancel">取消</button>
               <button class="btn" type="button" data-act="ok">导入</button>`,
    });
    $('[data-act="cancel"]', m.root).addEventListener('click', m.close);
    $('[data-act="ok"]', m.root).addEventListener('click', async () => {
      const text = $('#pb-text', m.root).value.trim();
      if (!text) return toast('请先粘贴商品信息', 'err');
      const btn = $('[data-act="ok"]', m.root);
      btn.disabled = true;
      try {
        const data = await api.post('/api/products/batch', { text });
        m.close();
        toast(`导入 ${data.created.length} 条${data.skipped.length ? `，跳过 ${data.skipped.length} 条` : ''}`, 'ok');
        onDone();
      } catch (err) {
        toast(err.message || '导入失败', 'err');
        btn.disabled = false;
      }
    });
  }

  function bindProducts(view) {
    const search = $('#p-q', view);
    // 边输边搜：停止输入后再请求；重渲染后把焦点与光标还给搜索框
    const runSearch = debounce(async (value) => {
      productState.q = value.trim();
      await loadProducts();
      await paintProducts();
      const el = $('#p-q');
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 300);
    search.addEventListener('input', (e) => runSearch(e.target.value));
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      runSearch.cancel();
      productState.q = search.value.trim();
      loadProducts().then(() => paintProducts());
    });
    $('#p-status', view).addEventListener('change', async (e) => {
      productState.status = e.target.value;
      await loadProducts();
      await paintProducts();
    });
    const batchBtn = $('#p-batch', view);
    if (batchBtn) {
      batchBtn.addEventListener('click', () =>
        openBatchProducts(async () => {
          await loadProducts();
          await paintProducts();
        }),
      );
    }
    const createBtn = $('#p-create', view);
    if (createBtn) {
      createBtn.addEventListener('click', () =>
        openProductDialog(null, async () => {
          await loadProducts();
          await paintProducts();
        }),
      );
    }

    $$('[data-product]', view).forEach((tr) => {
      const product = productState.rows.find((p) => p.id === Number(tr.dataset.product));
      if (!product) return;
      const refresh = async () => {
        await loadProducts();
        await paintProducts();
      };
      const editBtn = $('[data-act="edit"]', tr);
      if (editBtn) editBtn.addEventListener('click', () => openProductDialog(product, refresh));
      const delBtn = $('[data-act="del"]', tr);
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          const { sales, stores } = product.usage || { sales: 0, stores: 0 };
          // 强制删除会抹掉历史统计，确认框必须把「删掉多少条明细、多少家门店关联」说清楚
          const impact = sales || stores
            ? `该商品已有销售明细 ${sales} 条、门店关联 ${stores} 条，删除后这些数据一并清除，相关报表口径随之变化。`
            : '该商品暂无销售记录与门店关联，删除后仅移除档案。';
          const ok = await confirmDialog({
            title: '删除商品',
            message: `确定删除「${product.name}」吗？${impact}该操作不可恢复（操作日志会保留）。`,
            okText: '删除',
            danger: true,
          });
          if (!ok) return;
          try {
            const res = await api.del(`/api/products/${product.id}`);
            const removed = res && res.removed;
            toast(
              removed && (removed.sales || removed.stores)
                ? `商品已删除，连带清除明细 ${removed.sales} 条、门店关联 ${removed.stores} 条`
                : '商品已删除',
              'ok',
            );
            await refresh();
          } catch (err) {
            toast(err.message || '删除失败', 'err');
          }
        });
      }
      const toggleBtn = $('[data-act="toggle"]', tr);
      if (toggleBtn) {
        toggleBtn.addEventListener('click', async () => {
          const toDisabled = product.status === 'active';
          const ok = await confirmDialog({
            title: toDisabled ? '禁用商品' : '启用商品',
            message: toDisabled
              ? `禁用「${product.name}」后，该商品不再出现在店员填报列表，历史数据仍保留统计。`
              : `启用「${product.name}」后，未配置商品关联的门店会重新填报该商品。`,
            okText: toDisabled ? '禁用' : '启用',
            danger: toDisabled,
          });
          if (!ok) return;
          try {
            await api.put(`/api/products/${product.id}`, { status: toDisabled ? 'disabled' : 'active' });
            toast(toDisabled ? '商品已禁用' : '商品已启用', 'ok');
            await refresh();
          } catch (err) {
            toast(err.message || '操作失败', 'err');
          }
        });
      }
    });
  }

  async function paintProducts() {
    const view = $('#view');
    view.innerHTML = renderProducts();
    bindProducts(view);
    h.subtitle(
      `共 ${productState.rows.length} 条 · 启用 ${productState.counts.active} · 禁用 ${productState.counts.disabled}`,
    );
  }

  window.Admin.register({
    id: 'products',
    title: '商品档案',
    subtitle: '品名 / 别名 / 条码 / 状态',
    render: async () => {
      await loadProducts();
      await paintProducts();
    },
  });

})();
