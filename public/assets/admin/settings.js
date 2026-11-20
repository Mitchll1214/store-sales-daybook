'use strict';

/* ============================================================
   系统设置（仅总部管理员）
   - 数据备份与恢复：手动点一下生成快照，下载到本机，或从某份快照恢复
   - 恢复是覆盖全部数据的危险操作，必须输入「恢复」二次确认
   - IP 归属地库（ip2region）：查看库版本，校验上游并在后台热更新
   ============================================================ */

(function () {
  const { api, $, $$, escapeHtml, toast, openModal } = window.SSD;
  const h = window.Admin.h;

  const state = {
    current: null,
    backups: [],
    busy: false,
    ipdb: null,
  };

  /** 订阅 IP 库后台任务的取消函数：重新订阅或离开页面时先解绑，避免重复轮询渲染 */
  let unsubscribeFeed = null;

  function stampLabel(iso) {
    if (!iso) return '';
    // mtime 是 UTC ISO 串，转成浏览器本地时间显示，避免与页面上其他时间差 8 小时
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(
      d.getSeconds(),
    )}`;
  }

  function kindPill(kind) {
    if (kind === 'pre-restore') return '<span class="pill pill-warn">恢复前快照</span>';
    if (kind === 'pre-upgrade') return '<span class="pill pill-warn">升级前快照</span>';
    if (kind === 'auto') return '<span class="pill pill-ok">自动备份</span>';
    return '<span class="pill pill-info">手动备份</span>';
  }

  async function load() {
    const data = await api.get('/api/backup');
    state.current = data.current;
    state.backups = data.backups || [];
  }

  function renderCurrent() {
    const c = state.current;
    if (!c) return '';
    const health = c.ok
      ? '<span class="pill pill-ok">健康</span>'
      : `<span class="pill pill-danger">异常</span>`;
    const counts = c.counts || {};
    return `<div class="panel">
      <div class="panel-head">
        <div>
          <h3>当前数据库 ${health}</h3>
          <p>${escapeHtml(c.error || '数据自检通过，可以随时备份')}</p>
        </div>
        <div class="spacer" style="flex:1"></div>
        <button class="btn btn-sm btn-ghost" type="button" id="bk-refresh">刷新</button>
        <button class="btn btn-sm" type="button" id="bk-create">立即备份</button>
      </div>
      <div class="panel-body">
        <div class="stat-grid">
          <div class="stat"><div class="label">门店</div><div class="value">${counts.stores || 0}<small> 家</small></div></div>
          <div class="stat"><div class="label">账号</div><div class="value">${counts.users || 0}<small> 个</small></div></div>
          <div class="stat"><div class="label">销售记录</div><div class="value">${counts.entries || 0}<small> 条</small></div></div>
          <div class="stat"><div class="label">提交批次</div><div class="value">${counts.submissions || 0}<small> 批</small></div></div>
        </div>
        <p class="small muted" style="margin:12px 0 0">
          库文件：<span class="mono">${escapeHtml(c.path)}</span>（${escapeHtml(c.sizeLabel)}）<br>
          备份目录：<span class="mono">${escapeHtml(c.backupDir)}</span>
        </p>
      </div>
    </div>`;
  }

  function renderList() {
    const rows = state.backups.length
      ? state.backups
          .map(
            (b) => `<tr>
              <td class="mono">${escapeHtml(b.name)}</td>
              <td>${escapeHtml(stampLabel(b.mtime))}</td>
              <td>${escapeHtml(b.sizeLabel)}</td>
              <td>${kindPill(b.kind)}</td>
              <td class="row-actions">
                <button class="btn btn-sm btn-ghost" type="button" data-download="${escapeHtml(b.name)}">下载</button>
                <button class="btn btn-sm btn-soft" type="button" data-restore="${escapeHtml(b.name)}">恢复</button>
                <button class="btn btn-sm btn-ghost" type="button" data-delete="${escapeHtml(b.name)}">删除</button>
              </td>
            </tr>`,
          )
          .join('')
      : `<tr><td colspan="5" class="empty">还没有备份。点击上方「立即备份」生成第一份快照。</td></tr>`;

    return `<div class="panel">
      <div class="panel-head">
        <div>
          <h3>备份文件</h3>
          <p>共 ${state.backups.length} 份 · 备份是完整的一致性快照，可直接用于恢复</p>
        </div>
      </div>
      <div class="panel-body flush">
        <div class="table-wrap"><table class="data">
          <thead><tr><th>文件</th><th>生成时间</th><th>大小</th><th>类型</th><th class="row-actions">操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      <div class="panel-body">
        <p class="small muted" style="margin:0">
          恢复会<strong>用备份里的数据覆盖当前全部数据</strong>（门店、账号、销售记录、图片索引）。
          恢复前系统会自动生成一份「恢复前快照」，选错了还能再恢复回来。
        </p>
      </div>
    </div>`;
  }

  /* ---------------- IP 归属地库（ip2region） ---------------- */

  function renderIpdb() {
    const s = state.ipdb;
    if (!s) return '';
    const job = h.ipdbFeed.job;
    const running = Boolean(job && job.running);
    const badge = s.loaded
      ? `<span class="pill pill-ok">已加载</span>`
      : `<span class="pill pill-danger">未加载</span>`;
    const meta = s.meta || {};
    const pct = running ? h.ipdbFeed.percent(job) : null;
    const stageText = running ? job.stageText || '更新中' : '';

    // 任务进行中：把按钮换成进度，并说明「可以离开本页」
    const action = running
      ? `<span class="pill pill-info">${escapeHtml(stageText)}${pct == null ? '' : ` ${pct}%`}</span>
         <span class="small muted ipdb-leave">可离开本页</span>`
      : `<button class="btn btn-sm btn-soft" type="button" id="ipdb-check">校验更新</button>`;

    return `<div class="panel" id="ipdb-panel">
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
        ${action}
      </div>
      ${
        running
          ? `<div class="panel-body"><div class="progress-line"><i style="width:${pct == null ? 12 : pct}%"></i></div>
              <p class="small muted" style="margin:6px 0 0">${escapeHtml(stageText)}${
                job.source && job.source.label ? ` · ${escapeHtml(job.source.label)}` : ''
              } · 更新在后台进行，可以切到其他页面操作，完成后可在下方操作记录里查证。</p></div>`
          : `<div class="panel-body">
              <p class="small muted" style="margin:0">
                一次点击即可：先校验上游版本，确认有新版本才提示更新；更新在后台静默下载并热替换，无需重启服务。
                上游：<span class="mono">${escapeHtml((s.upstream && s.upstream.repo) || '')}</span>
              </p>
            </div>`
      }
    </div>`;
  }

  /**
   * 绑定「校验更新」按钮。
   * 这是 IP 库面板唯一的动作入口：先校验，确认有更新（或校验渠道全不通）时才弹窗，
   * 用户确认后转入后台静默下载，页面本身完全不阻塞。
   */
  function bindIpdbButton() {
    const checkBtn = $('#ipdb-check');
    if (!checkBtn || checkBtn.dataset.bound === '1') return;
    checkBtn.dataset.bound = '1';
    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      checkBtn.textContent = '校验中…';
      try {
        const result = await api.post('/api/logs/ipdb/check', {});
        if (result.ok === false && result.hasUpdate == null) {
          // 校验渠道全不通不代表不能下载（下载走另一组域名），因此仍给更新入口
          const go = await window.SSD.confirmDialog({
            title: '无法判断是否有更新',
            message: `${result.reason || '所有校验渠道都没连上。'}\n下载渠道与校验渠道不同，可以仍然尝试直接更新（约 11 MB，后台进行，可离开本页）。`,
            okText: '仍然更新',
          });
          if (go) await startIpdbUpdate();
        } else if (result.hasUpdate) {
          const go = await window.SSD.confirmDialog({
            title: '发现新的 IP 库版本',
            message: `上游已发布新版本（${
              result.basis === 'size' ? result.reason : '版本号已变更'
            }）。\n确认后在后台静默下载并热替换，约 11 MB；你可以立即离开本页去做别的操作，完成后可在操作日志里查证。是否开始？`,
            okText: '开始更新',
          });
          if (go) await startIpdbUpdate();
        } else {
          toast('当前 IP 库已是最新版本，无需更新', 'ok');
        }
      } catch (err) {
        toast(err.message || '校验失败', 'err');
      } finally {
        const btn = $('#ipdb-check');
        if (btn) {
          btn.disabled = false;
          btn.textContent = '校验更新';
        }
      }
    });
  }

  /**
   * 发起后台更新：接口立即返回 202，前端不做任何阻塞式等待。
   * 进度由 core.js 的 ipdbFeed 统一轮询，因此这里点完就能切页面甚至刷新。
   */
  async function startIpdbUpdate() {
    try {
      const result = await api.post('/api/logs/ipdb/update', {});
      if (result.started === false) toast('已有更新任务在进行，正在跟进它的进度', 'ok');
      else toast('已开始后台更新，可离开本页；完成后会在操作日志留痕', 'ok');
      h.ipdbFeed.begin();
      await loadIpdb();
      await paint();
    } catch (err) {
      toast(err.message || '更新失败', 'err');
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
    view.innerHTML = renderCurrent() + renderList() + renderIpdb();
    bind();
  }

  function bind() {
    const create = $('#bk-create');
    if (create) create.addEventListener('click', doCreate);
    const refresh = $('#bk-refresh');
    if (refresh) refresh.addEventListener('click', doRefresh);

    $$('[data-download]').forEach((btn) => {
      btn.addEventListener('click', () => {
        h.download(`/api/backup/${encodeURIComponent(btn.dataset.download)}/download`, btn.dataset.download);
      });
    });
    $$('[data-restore]').forEach((btn) => {
      btn.addEventListener('click', () => openRestoreDialog(btn.dataset.restore));
    });
    $$('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', () => doDelete(btn.dataset.delete));
    });

    bindIpdbButton();
  }

  /**
   * 后台任务进度只重绘 IP 库面板，不整页重渲染：
   * 否则备份列表的滚动位置、弹窗状态会每秒被冲掉一次。
   * 任务由运行态转为结束时（成功或失败），再补一次状态刷新——
   * 更新结果已经作为一条操作记录写进日志，位置就在「操作日志」页。
   */
  function subscribeFeed() {
    if (unsubscribeFeed) unsubscribeFeed();
    let wasRunning = Boolean(h.ipdbFeed.job && h.ipdbFeed.job.running);
    unsubscribeFeed = h.ipdbFeed.watch(({ job }) => {
      if (window.Admin.state.page !== 'settings') return;
      const host = $('#ipdb-panel');
      if (host) {
        const fresh = renderIpdb();
        if (fresh) host.outerHTML = fresh;
        // 面板里可能重新出现「校验更新」按钮，重新绑定它的点击
        bindIpdbButton();
      }
      const running = Boolean(job && job.running);
      if (wasRunning && !running) {
        wasRunning = false;
        // 收尾：把新的库版本读回来（更新日志请到操作日志页查证）
        (async () => {
          await loadIpdb();
          if (window.Admin.state.page === 'settings') await paint();
        })();
      } else {
        wasRunning = running;
      }
    });
  }

  async function doRefresh() {
    try {
      await load();
      await paint();
      toast('已刷新', 'ok');
    } catch (err) {
      toast(err.message || '刷新失败', 'err');
    }
  }

  async function doCreate() {
    if (state.busy) return;
    state.busy = true;
    const btn = $('#bk-create');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '备份中…';
    }
    try {
      const res = await api.post('/api/backup', {});
      toast(`已生成备份 ${res.backup.name}（${res.backup.sizeLabel}）`, 'ok');
      await load();
      await paint();
    } catch (err) {
      toast(err.message || '备份失败', 'err');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '立即备份';
      }
    } finally {
      state.busy = false;
    }
  }

  async function doDelete(name) {
    const ok = await window.SSD.confirmDialog({
      title: '删除备份',
      message: `确定删除备份「${name}」吗？删除后无法用于恢复。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/backup/${encodeURIComponent(name)}`);
      toast('已删除', 'ok');
      await load();
      await paint();
    } catch (err) {
      toast(err.message || '删除失败', 'err');
    }
  }

  /**
   * 恢复确认框：先展示这份备份里有多少数据，再要求手打「恢复」。
   * 两步都是为了防误触——恢复会覆盖全部当前数据。
   */
  async function openRestoreDialog(name) {
    let detail = null;
    try {
      detail = (await api.get(`/api/backup/${encodeURIComponent(name)}`)).backup;
    } catch (err) {
      toast(err.message || '读取备份信息失败', 'err');
      return;
    }
    if (!detail || !detail.ok) {
      toast((detail && detail.error) || '该备份不可用', 'err');
      return;
    }
    const c = detail.counts || {};
    const m = openModal({
      title: '从备份恢复数据',
      body: `<p class="small" style="margin:0 0 12px">
          即将用下面这份备份<strong>覆盖当前全部数据</strong>，请确认内容符合预期：
        </p>
        <div class="panel" style="margin:0 0 12px"><div class="panel-body">
          <p class="small mono" style="margin:0 0 8px">${escapeHtml(detail.name)}</p>
          <div class="stat-grid">
            <div class="stat"><div class="label">门店</div><div class="value">${c.stores || 0}</div></div>
            <div class="stat"><div class="label">账号</div><div class="value">${c.users || 0}</div></div>
            <div class="stat"><div class="label">销售记录</div><div class="value">${c.entries || 0}</div></div>
            <div class="stat"><div class="label">提交批次</div><div class="value">${c.submissions || 0}</div></div>
          </div>
        </div></div>
        <div class="field">
          <label>请输入「恢复」两个字确认</label>
          <input class="input" type="text" data-confirm placeholder="输入：恢复" autocomplete="off">
        </div>
        <p class="small muted" style="margin:8px 0 0">
          恢复前会自动生成一份当前数据的快照保存在备份列表里；恢复完成后可能需要重新登录。
        </p>`,
      footer: `<button class="btn btn-ghost" data-act="cancel" type="button">取消</button>
               <button class="btn" data-act="ok" type="button" disabled style="background:#b91c1c;color:#fff;border-color:#b91c1c">确认恢复</button>`,
    });

    const input = $('[data-confirm]', m.root);
    const okBtn = $('[data-act="ok"]', m.root);
    input.addEventListener('input', () => {
      okBtn.disabled = input.value.trim() !== '恢复';
    });
    $('[data-act="cancel"]', m.root).addEventListener('click', () => m.close());

    okBtn.addEventListener('click', async () => {
      if (input.value.trim() !== '恢复') return;
      okBtn.disabled = true;
      okBtn.textContent = '恢复中…';
      try {
        const res = await api.post(`/api/backup/${encodeURIComponent(name)}/restore`, { confirmText: '恢复' });
        m.close();
        toast(`已恢复到 ${res.restored}，数据已重新加载`, 'ok');
        // 恢复后会话表也被换掉，当前登录可能已失效；这里失败也不能把恢复结果吞掉，
        // 因此单独兜住刷新异常，让用户仍能看到「恢复成功」的提示。
        try {
          await load();
          await paint();
        } catch {
          toast('恢复已完成，请刷新页面或重新登录查看数据', 'ok');
          return;
        }
        if (res.relogin) {
          window.SSD.confirmDialog({
            title: '恢复完成',
            message: '数据已恢复到所选备份。若接下来的操作提示登录失效，重新登录即可。',
            okText: '知道了',
          });
        }
      } catch (err) {
        toast(err.message || '恢复失败', 'err');
        okBtn.disabled = false;
        okBtn.textContent = '确认恢复';
      }
    });
    input.focus();
  }

  window.Admin.register({
    id: 'settings',
    title: '系统设置',
    subtitle: '数据备份与恢复、IP 归属地库',
    render: async (view) => {
      view.innerHTML = `<div class="panel"><div class="panel-body"><div class="skeleton" style="height:140px"></div></div></div>`;
      await Promise.all([load(), loadIpdb()]);
      await paint();
      subscribeFeed();
      // 进入本页时若已有 IP 库任务在跑（可能在别的标签页发起），立即接上它的进度
      await h.ipdbFeed.refresh();
    },
  });
})();
