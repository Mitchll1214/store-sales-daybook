'use strict';

/* ============================================================
   店员端：今日/昨日完成情况 + 引导式逐条填报
   - 一次只展示一个商品（只显示别名），确认后自动进入下一个
   - 全部确认后按钮变为「提交」
   ============================================================ */

(function () {
  const {
    api,
    $,
    toast,
    escapeHtml,
    weekdayLabel,
    todayStr,
    percentText,
    openModal,
    confirmDialog,
    copyText,
    logout,
    money,
  } = window.SSD;

  const state = {
    store: null,
    home: null,
    wizard: null, // { date, period, products, nextProduct, progress, readyToSubmit, images }
    values: new Map(), // productId -> { qty, amount }
    busy: false,
    // 本地暂存：避免误触返回丢失已填内容
    draftKey: '',
  };

  const viewHome = $('#view-home');
  const viewWizard = $('#view-wizard');

  /* ---------------- 首页 ---------------- */

  const STATE_LABEL = {
    done: { text: '已完成', cls: 'pill-ok' },
    due: { text: '待提交', cls: 'pill-warn' },
    makeup: { text: '可补交', cls: 'pill-info' },
    overdue: { text: '未提交', cls: 'pill-danger' },
    future: { text: '未开始', cls: '' },
  };

  const STATE_HINT = {
    done: '数据已提交，如需修改请联系管理员',
    due: '当天 24:00 前完成即可',
    makeup: '今日 12:00 前可补交',
    overdue: '已超过补交时限',
    future: '尚未到达该日期',
  };

  async function loadHome() {
    try {
      const data = await api.get('/api/sales/home');
      state.home = data;
      state.store = data.store;
      renderHome();
      return data;
    } catch (err) {
      toast(err.message || '加载失败', 'err');
      throw err;
    }
  }

  function renderHome() {
    const data = state.home;
    const today = data.today;
    $('#store-name').textContent = data.store.name;
    $('#store-sub').textContent = data.store.code;
    $('#hero-store').textContent = `${data.store.code} ${data.store.name}`;
    $('#hello').textContent = data.hello;

    const pending = data.slots[0].periods.filter((p) => !p.done).length;
    $('#hero-title').textContent =
      pending === 0 ? '今日数据已全部提交，辛苦了' : `今日还有 ${pending} 次待提交`;

    const host = $('#slots');
    host.innerHTML = data.slots
      .map((slot) => {
        const isToday = slot.date === today;
        const rows = slot.periods
          .map((p) => {
            const meta = STATE_LABEL[p.state] || STATE_LABEL.future;
            const canOpen = !p.done && (p.state === 'due' || p.state === 'makeup');
            const cls = p.done ? 'is-done' : canOpen ? 'is-open' : 'is-warn';
            const action = p.done
              ? '<span class="slot-action">已完成 ✓</span>'
              : canOpen
                ? '<span class="slot-action">去登记 →</span>'
                : `<span class="slot-action" style="color:var(--ink-4)">${STATE_HINT[p.state] || ''}</span>`;
            const summary = p.done
              ? `已于 ${(p.submittedAt || '').slice(11, 16)} 提交 · ${p.itemCount || 0} 项`
              : STATE_HINT[p.state] || '';
            return `
              <button class="slot ${cls}" type="button"
                      data-date="${slot.date}" data-period="${p.period}"
                      ${canOpen ? '' : 'disabled style="cursor:default"'}>
                <span class="slot-icon">${p.done ? '✓' : p.period === 'am' ? '☀' : '☾'}</span>
                <span class="slot-body">
                  <h3>${escapeHtml(p.label)}
                    <span class="pill ${meta.cls}">${meta.text}</span>
                  </h3>
                  <p>${escapeHtml(summary)}</p>
                </span>
                ${action}
              </button>`;
          })
          .join('');
        return `
          <div class="slot-group">
            <div class="slot-date">
              <span>${slot.date} ${weekdayLabel(slot.date)}</span>
              ${isToday ? '<span class="badge-today">今天</span>' : ''}
              ${slot.date === data.yesterday ? '<span class="badge-today" style="background:var(--warn-bg);color:var(--warn)">昨天</span>' : ''}
            </div>
            <div class="slot-grid">${rows}</div>
          </div>`;
      })
      .join('');

    host.querySelectorAll('.slot[data-period]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        openWizard(btn.dataset.date, btn.dataset.period);
      });
    });

    if (data.productCount === 0) {
      host.insertAdjacentHTML(
        'beforeend',
        `<div class="card" style="margin-top:14px">
           <div class="empty-state">
             <div class="icon">📦</div>
             <p>门店暂无可填报的商品，请联系管理员配置商品档案或门店关联商品。</p>
           </div>
         </div>`,
      );
    }
  }

  /* ---------------- 引导式填报 ---------------- */

  async function openWizard(date, period) {
    try {
      const data = await api.get(`/api/sales/session?date=${date}&period=${period}`);
      if (data.submitted) {
        toast('该时段已提交', 'err');
        await loadHome();
        return;
      }
      if (!data.editable) {
        toast('该时段已不可填报', 'err');
        await loadHome();
        return;
      }
      if (!data.productCount) {
        toast('门店暂无可填报的商品', 'err');
        return;
      }
      state.wizard = {
        date,
        period,
        periodLabel: data.periodLabel,
        products: data.productAliases || [],
        nextProduct: data.nextProduct,
        progress: data.progress,
        readyToSubmit: data.readyToSubmit,
        images: data.images || [],
      };
      state.values = new Map();
      state.draftKey = `ssd_draft_${state.store.code}_${date}_${period}`;
      restoreDraft();

      viewHome.classList.add('hidden');
      viewWizard.classList.remove('hidden');
      window.scrollTo(0, 0);
      renderWizard();
    } catch (err) {
      toast(err.message || '无法开始填报', 'err');
    }
  }

  function restoreDraft() {
    try {
      const raw = sessionStorage.getItem(state.draftKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          state.values.set(Number(k), v);
        }
      }
    } catch {
      /* 忽略损坏的草稿 */
    }
  }

  function saveDraft() {
    try {
      sessionStorage.setItem(state.draftKey, JSON.stringify(Object.fromEntries(state.values)));
    } catch {
      /* 存储不可用时忽略 */
    }
  }

  function clearDraft() {
    try {
      sessionStorage.removeItem(state.draftKey);
    } catch {
      /* 忽略 */
    }
  }

  /** 当前正在填写的商品：服务端下一个待填 + 本地草稿里已填但未提交的 */
  function currentProduct() {
    const w = state.wizard;
    if (!w) return null;
    return w.nextProduct;
  }

  function renderWizard() {
    const w = state.wizard;
    if (!w) return;
    const product = currentProduct();
    const done = w.progress.done;
    const total = w.progress.total;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const finished = !product;

    const head = `
      <div class="card" style="padding:16px 18px">
        <div class="wizard-head">
          <div style="min-width:0">
            <h2 style="font-size:15px">${escapeHtml(w.periodLabel)}填报 · ${escapeHtml(w.date)}</h2>
            <p class="small muted" style="margin:3px 0 0">${escapeHtml(state.store.name)}</p>
          </div>
          <span class="step-badge">${done} / ${total}</span>
        </div>
        <div class="progress-line"><i style="width:${pct}%"></i></div>
      </div>`;

    if (finished) {
      viewWizard.innerHTML = `${head}${renderFinishCard()}`;
      bindFinish();
      return;
    }

    const draft = state.values.get(product.id) || { qty: '', amount: '' };
    viewWizard.innerHTML = `
      ${head}
      <div class="product-stage" style="margin-top:14px">
        <p class="product-alias">当前商品</p>
        <h2 class="product-name">${escapeHtml(product.alias)}</h2>
        <p class="product-meta">第 ${done + 1} 个，共 ${total} 个</p>

        <div class="qty-amount">
          <div>
            <label class="tiny muted" style="display:block;text-align:left;margin-bottom:6px;font-weight:600">销售数量</label>
            <div class="qty-stepper">
              <button type="button" data-step="-1" aria-label="减少">−</button>
              <input id="qty-input" type="number" inputmode="numeric" pattern="[0-9]*"
                     min="0" step="1" value="${draft.qty === '' ? '' : Number(draft.qty)}"
                     placeholder="0" aria-label="销售数量">
              <button type="button" data-step="1" aria-label="增加">+</button>
            </div>
          </div>
          <div>
            <label class="tiny muted" style="display:block;text-align:left;margin-bottom:6px;font-weight:600">销售金额</label>
            <div class="amount-wrap">
              <span class="unit">¥</span>
              <input class="input" id="amount-input" type="number" inputmode="decimal"
                     min="0" step="0.01" value="${draft.amount === '' ? '' : Number(draft.amount)}"
                     placeholder="0.00" aria-label="销售金额">
            </div>
          </div>
        </div>
      </div>

      ${renderImageBlock()}

      <div class="wizard-actions">
        <button class="btn btn-block btn-lg" id="confirm-btn" type="button">确认，下一个</button>
        <p class="wizard-tip" id="wizard-tip">确认后自动进入下一个商品</p>
      </div>`;

    bindStepControls(product);
  }

  function renderImageBlock() {
    const imgs = (state.wizard.images || [])
      .map(
        (img) => `
        <div class="thumb" data-image="${img.id}">
          <img src="${img.url}" alt="${escapeHtml(img.name || '凭证')}" loading="lazy">
          <button type="button" data-del-image="${img.id}" aria-label="删除图片">✕</button>
        </div>`,
      )
      .join('');
    return `
      <div class="card" style="margin-top:14px;padding:16px 18px">
        <div class="card-head" style="margin-bottom:6px">
          <div>
            <h2 style="font-size:14px">凭证图片<span class="tiny muted" style="font-weight:400">（选填）</span></h2>
            <p>可上传小票或收银截图，最多便于核对</p>
          </div>
        </div>
        <div class="upload-row">
          ${imgs}
          <label class="upload-tile" for="image-input">
            <span>＋<br>上传</span>
            <input id="image-input" type="file" accept="image/*" class="hidden">
          </label>
        </div>
      </div>`;
  }

  function bindStepControls(product) {
    const qtyInput = $('#qty-input');
    const amountInput = $('#amount-input');
    const tip = $('#wizard-tip');

    const sync = () => {
      const qty = qtyInput.value === '' ? '' : Number(qtyInput.value);
      const amount = amountInput.value === '' ? '' : Number(amountInput.value);
      state.values.set(product.id, { qty, amount });
      saveDraft();
      const ready = qty !== '' && Number(qty) >= 0;
      $('#confirm-btn').disabled = !ready;
      tip.textContent = ready
        ? '确认后自动进入下一个商品'
        : '请填写销售数量（无销售请填 0）';
      // 数量与金额自动联动提示：金额留空按数量 × 0 处理不符合直觉，这里只做提示
      if (ready && amount === '' && Number(qty) > 0) {
        tip.textContent = '金额未填写将按 0 计入，建议补充销售金额';
      }
    };

    qtyInput.addEventListener('input', sync);
    amountInput.addEventListener('input', sync);
    // 回车 = 确认当前商品
    [qtyInput, amountInput].forEach((el) =>
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirmCurrent();
        }
      }),
    );

    viewWizard.querySelectorAll('[data-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = Number(btn.dataset.step);
        const cur = qtyInput.value === '' ? 0 : Number(qtyInput.value);
        const next = Math.max(0, Math.floor(cur + step));
        qtyInput.value = String(next);
        sync();
      });
    });

    $('#confirm-btn').addEventListener('click', confirmCurrent);

    const fileInput = $('#image-input');
    if (fileInput) fileInput.addEventListener('change', onPickImage);

    viewWizard.querySelectorAll('[data-del-image]').forEach((btn) => {
      btn.addEventListener('click', () => removeImage(Number(btn.dataset.delImage)));
    });

    sync();
    if (window.matchMedia('(pointer: fine)').matches) {
      qtyInput.focus();
    }
  }

  async function onPickImage(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('图片不能超过 5MB', 'err');
      return;
    }
    const w = state.wizard;
    const form = new FormData();
    form.append('file', file);
    form.append('date', w.date);
    form.append('period', w.period);
    try {
      toast('图片上传中…');
      const data = await api.upload('/api/sales/images', form);
      w.images = data.images || [];
      const position = document.activeElement;
      const scrollY = window.scrollY;
      renderWizard();
      window.scrollTo(0, scrollY);
      if (position && position.id) {
        const el = document.getElementById(position.id);
        if (el) el.focus();
      }
      toast('上传成功', 'ok');
    } catch (err) {
      toast(err.message || '上传失败', 'err');
    } finally {
      e.target.value = '';
    }
  }

  async function removeImage(id) {
    const ok = await confirmDialog({
      title: '删除图片',
      message: '确定删除这张凭证图片？删除后不可恢复，操作会被记录。',
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/sales/images/${id}`);
      state.wizard.images = state.wizard.images.filter((i) => i.id !== id);
      const scrollY = window.scrollY;
      renderWizard();
      window.scrollTo(0, scrollY);
      toast('已删除', 'ok');
    } catch (err) {
      toast(err.message || '删除失败', 'err');
    }
  }

  async function confirmCurrent() {
    const w = state.wizard;
    const product = currentProduct();
    if (!w || !product || state.busy) return;
    const value = state.values.get(product.id) || {};
    const qty = value.qty === '' || value.qty == null ? null : Number(value.qty);
    const amount = value.amount === '' || value.amount == null ? 0 : Number(value.amount);
    if (qty == null || !Number.isInteger(qty) || qty < 0) {
      toast('请填写正确的销售数量', 'err');
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      toast('请填写正确的销售金额', 'err');
      return;
    }

    state.busy = true;
    const btn = $('#confirm-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '保存中…';
    }
    try {
      const data = await api.put('/api/sales/entry', {
        date: w.date,
        period: w.period,
        productId: product.id,
        qty,
        amount,
      });
      state.values.delete(product.id);
      saveDraft();
      w.nextProduct = data.nextProduct;
      w.progress = data.progress;
      w.readyToSubmit = data.readyToSubmit;
      renderWizard();
      if (!data.nextProduct) {
        toast('全部商品已确认，可以提交了', 'ok');
      }
    } catch (err) {
      toast(err.message || '保存失败', 'err');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '确认，下一个';
      }
    } finally {
      state.busy = false;
    }
  }

  function renderFinishCard() {
    const w = state.wizard;
    return `
      <div class="card" style="margin-top:14px;text-align:center;padding:26px 18px">
        <div style="font-size:34px;line-height:1">✅</div>
        <h2 style="font-size:17px;margin:10px 0 6px">${w.progress.total} 个商品已全部确认</h2>
        <p class="small muted" style="margin:0">核对无误后提交，提交后本时段数据将被锁定。</p>
      </div>
      <div class="wizard-actions">
        <button class="btn btn-block btn-lg" id="submit-btn" type="button">提 交 ${escapeHtml(w.periodLabel)}数据</button>
        <button class="btn btn-block btn-ghost" id="back-btn" type="button" style="margin-top:10px">返回首页</button>
        <p class="wizard-tip">提交后不可自行修改，如需更正请联系管理员</p>
      </div>`;
  }

  function bindFinish() {
    $('#submit-btn').addEventListener('click', submitAll);
    $('#back-btn').addEventListener('click', backHome);
  }

  async function submitAll() {
    const w = state.wizard;
    if (!w || state.busy) return;
    const ok = await confirmDialog({
      title: '确认提交',
      message: `即将提交 ${w.date} ${w.periodLabel} 的销售数据，提交后不可再修改。`,
      okText: '确认提交',
    });
    if (!ok) return;
    state.busy = true;
    const btn = $('#submit-btn');
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const data = await api.post('/api/sales/submit', { date: w.date, period: w.period });
      clearDraft();
      toast(`${data.periodLabel}数据已提交`, 'ok');
      openModal({
        title: '提交成功',
        body: `<div style="text-align:center;padding:6px 0 2px">
                 <div style="font-size:36px">🎉</div>
                 <p style="margin:10px 0 4px;font-size:15px;font-weight:600">${escapeHtml(data.date)} ${escapeHtml(data.periodLabel)}</p>
                 <p class="small muted" style="margin:0">${data.itemCount} 个商品 · 数量 ${data.totalQty} · 金额 ¥${money(data.totalAmount)}</p>
               </div>`,
        footer: '<button class="btn btn-block" data-act="close" type="button">完成</button>',
      }).root.querySelector('[data-act="close"]')
        .addEventListener('click', async () => {
          document.querySelectorAll('.modal-mask').forEach((m) => m.remove());
          await backHome();
        });
    } catch (err) {
      toast(err.message || '提交失败', 'err');
      btn.disabled = false;
      btn.textContent = `提 交 ${w.periodLabel}数据`;
      // 缺项时回到对应商品继续填写
      if (err.code === 'INCOMPLETE' || err.code === 'ALREADY_SUBMITTED') {
        await backHome();
      }
    } finally {
      state.busy = false;
    }
  }

  async function backHome() {
    state.wizard = null;
    viewWizard.classList.add('hidden');
    viewWizard.innerHTML = '';
    viewHome.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'auto' });
    await loadHome();
  }

  /* ---------------- 顶部操作 ---------------- */

  $('#btn-help').addEventListener('click', () => {
    openModal({
      title: '填报说明',
      body: `<div class="small" style="line-height:1.8;color:var(--ink-2)">
        <p style="margin:0 0 8px"><b>每天两次提交</b>：上午、下午各提交一次，当天 24:00 前完成。</p>
        <p style="margin:0 0 8px"><b>补交规则</b>：昨日数据可在今天 12:00 前补交，逾期需联系管理员。</p>
        <p style="margin:0 0 8px"><b>商品逐个确认</b>：页面一次显示一个商品，填写数量与金额后点「确认」进入下一个；全部确认后按钮变为「提交」。</p>
        <p style="margin:0 0 8px"><b>无销售也要填</b>：数量填 0 即可，确保每个商品都有记录。</p>
        <p style="margin:0"><b>提交后锁定</b>：如需更正请联系管理员。</p>
      </div>`,
      footer: '<button class="btn btn-block" data-act="close" type="button">我知道了</button>',
    }).root.querySelector('[data-act="close"]').addEventListener('click', () => {
      document.querySelectorAll('.modal-mask').forEach((m) => m.remove());
    });
  });

  $('#btn-more').addEventListener('click', () => {
    const m = openModal({
      title: '更多操作',
      body: `<div style="display:grid;gap:10px">
        <button class="btn btn-ghost btn-block" data-act="refresh" type="button">刷新完成情况</button>
        <button class="btn btn-ghost btn-block" data-act="copy" type="button">复制门店名称</button>
        <button class="btn btn-danger btn-block" data-act="logout" type="button">退出登录</button>
      </div>`,
    });
    const close = () => m.close();
    m.root.querySelector('[data-act="refresh"]').addEventListener('click', async () => {
      close();
      await loadHome();
      toast('已刷新', 'ok');
    });
    m.root.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      close();
      const text = state.store ? `门店 ${state.store.code} ${state.store.name}` : '';
      toast((await copyText(text)) ? '已复制' : '复制失败，请手动记录', text ? 'ok' : 'err');
    });
    m.root.querySelector('[data-act="logout"]').addEventListener('click', async () => {
      close();
      if (await confirmDialog({ title: '退出登录', message: '确定退出当前门店登录？', okText: '退出', danger: true })) {
        logout();
      }
    });
  });

  /* ---------------- 启动 ---------------- */

  // 从后台切回前台时刷新（换设备/管理员改动状态后能及时反映）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.wizard) {
      loadHome().catch(() => {});
    }
  });

  loadHome().catch(() => {});

  // 暴露给调试与后续页面复用
  window.__clerk = { state, loadHome };
})();
