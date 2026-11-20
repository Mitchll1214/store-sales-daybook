'use strict';

/* ============================================================
   管理端核心：导航、hash 路由、页面注册与通用渲染工具
   ============================================================ */

(function () {
  const SSD = window.SSD;
  const { api, $, $$, escapeHtml, toast, todayStr, addDays, weekdayLabel, copyText, icon } = SSD;

  const NAV = [
    {
      group: '数据',
      items: [
        { id: 'dashboard', label: '概览', ico: 'dashboard', roles: ['admin', 'region_admin'] },
        { id: 'reports', label: '数据报表', ico: 'reports', roles: ['admin', 'region_admin'] },
      ],
    },
    {
      group: '配置',
      items: [
        { id: 'stores', label: '门店管理', ico: 'stores', roles: ['admin', 'region_admin'] },
        { id: 'products', label: '商品档案', ico: 'products', roles: ['admin', 'region_admin'] },
        { id: 'users', label: '用户管理', ico: 'users', roles: ['admin', 'region_admin'] },
      ],
    },
    {
      group: '系统',
      items: [
        { id: 'logs', label: '操作日志', ico: 'logs', roles: ['admin'] },
        { id: 'settings', label: '系统设置', ico: 'settings', roles: ['admin'] },
      ],
    },
  ];

  const modules = new Map();
  const state = {
    user: null,
    page: null,
    params: {},
  };

  /* ---------------- 页面注册 ---------------- */

  function register(def) {
    if (!def || !def.id) throw new Error('页面模块缺少 id');
    modules.set(def.id, def);
  }

  function allowed(item) {
    return !item.roles || item.roles.includes(state.user && state.user.role);
  }

  function navItems() {
    return NAV.map((group) => ({
      ...group,
      items: group.items.filter(allowed),
    })).filter((group) => group.items.length > 0);
  }

  /** 按内容长度分配两个字的导航图标，避免图标缺字 */
  function renderNav() {
    const groups = navItems();
    $('#nav').innerHTML = groups
      .map(
        (group) => `
        <div class="nav-label">${escapeHtml(group.group)}</div>
        ${group.items
          .map(
            (item) => `<button class="nav-item" type="button" data-page="${item.id}">
              <span class="ico">${icon(item.ico)}</span><span>${escapeHtml(item.label)}</span>
            </button>`,
          )
          .join('')}`,
      )
      .join('');

    // 移动端底部标签与侧边栏保持一致：按当前角色的全部可见项渲染，
    // 不再截断（此前只取前 5 项，导致管理员在手机上缺少「操作日志」等入口）
    const flat = groups.flatMap((g) => g.items);
    $('#mobile-tabs').innerHTML = flat
      .map(
        (item) => `<button type="button" data-page="${item.id}" title="${escapeHtml(item.label)}">
          <span class="ico">${icon(item.ico)}</span><span class="tab-label">${escapeHtml(item.label)}</span>
        </button>`,
      )
      .join('');

    $$('[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.page === state.page) return;
        location.hash = `#/${btn.dataset.page}`;
      });
    });
  }

  function markActive(pageId) {
    $$('.nav-item[data-page], .mobile-tabs button[data-page]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.page === pageId);
    });
  }

  /* ---------------- 路由 ---------------- */

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    const params = {};
    if (qs) {
      new URLSearchParams(qs).forEach((value, key) => {
        params[key] = value;
      });
    }
    return { id: path || '', params };
  }

  function defaultPage() {
    const first = navItems()[0];
    return first ? first.items[0].id : 'dashboard';
  }

  function findItem(id) {
    return NAV.flatMap((g) => g.items).find((i) => i.id === id) || null;
  }

  async function route() {
    const { id, params } = parseHash();
    const item = findItem(id);
    const usable = Boolean(item && modules.has(id) && allowed(item));
    if (!usable) {
      const fallback = defaultPage();
      if (id === fallback) return;
      location.replace(`#/${fallback}`);
      return;
    }
    await show(id, params);
  }

  async function show(id, params) {
    const mod = modules.get(id);
    if (!mod) return;
    const meta = NAV.flatMap((g) => g.items).find((i) => i.id === id);
    state.page = id;
    state.params = params || {};

    markActive(id);
    // 每次切页都顺手接一下 IP 库任务：任务可能在别的标签页发起，本页也要能看到进度胶囊
    ipdbFeed.refresh();
    $('#page-title').textContent = typeof mod.title === 'function' ? mod.title(params) : mod.title || (meta && meta.label) || '';
    $('#page-sub').textContent = typeof mod.subtitle === 'function' ? mod.subtitle(params) : mod.subtitle || '';
    $('#topbar-actions').innerHTML = '';
    const view = $('#view');
    view.innerHTML = `<div class="panel"><div class="panel-body"><div class="skeleton" style="height:120px"></div></div></div>`;

    try {
      await mod.render(view, params || {});
    } catch (err) {
      if (err && err.status === 401) return;
      view.innerHTML = `<div class="panel"><div class="empty-state">
        <div class="icon">${icon('alert')}</div>
        <p>${escapeHtml(err && err.message ? err.message : '页面加载失败')}</p>
      </div></div>`;
    }
    if (window.innerWidth <= 900) window.scrollTo({ top: 0 });
  }

  /* ---------------- 通用工具 ---------------- */

  const helpers = {
    /** 线性图标（页面模块可复用同一套图标） */
    icon,
    /** 顶栏右侧操作区（每次渲染前会被清空，由页面自行填充） */
    actions(html) {
      $('#topbar-actions').innerHTML = html || '';
    },
    subtitle(text) {
      $('#page-sub').textContent = text || '';
    },
    /** 刷新当前页 */
    reload() {
      return show(state.page, state.params);
    },
    fmtDay(dateStr) {
      if (!dateStr) return '';
      return `${dateStr} ${weekdayLabel(dateStr)}`;
    },
    shortDay(dateStr) {
      return String(dateStr || '').slice(5);
    },
    /** 完成率 → 热力等级 0-4 */
    heatLevel(rate) {
      const v = Number(rate) || 0;
      if (v >= 100) return 4;
      if (v >= 75) return 3;
      if (v >= 50) return 2;
      if (v > 0) return 1;
      return 0;
    },
    heatClass(rate) {
      return `heat-${helpers.heatLevel(rate)}`;
    },
    miniBar(rate) {
      const v = Math.max(0, Math.min(100, Number(rate) || 0));
      const cls = v >= 100 ? '' : v >= 50 ? '' : v > 0 ? 'low' : 'zero';
      return `<div class="mini-bar"><i class="${cls}" style="width:${v}%"></i></div>`;
    },
    pager(data, onGo) {
      const wrap = document.createElement('div');
      wrap.className = 'pager';
      wrap.innerHTML = `
        <button type="button" data-go="prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
        <span>第 ${data.page} / ${data.pages || 1} 页</span>
        <button type="button" data-go="next" ${data.page >= (data.pages || 1) ? 'disabled' : ''}>下一页</button>`;
      wrap.querySelector('[data-go="prev"]').addEventListener('click', () => onGo(data.page - 1));
      wrap.querySelector('[data-go="next"]').addEventListener('click', () => onGo(data.page + 1));
      return wrap;
    },
    /** 空态：图标统一用线性 SVG，调用方传图标名（inbox / archive / shop / alert） */
    empty(message, iconName = 'inbox') {
      return `<div class="empty-state"><div class="icon">${icon(iconName)}</div><p>${escapeHtml(message)}</p></div>`;
    },
    /** 日期区间快捷按钮 */
    rangeChips(onPick) {
      const wrap = document.createElement('div');
      wrap.className = 'seg';
      wrap.innerHTML = `
        <button type="button" data-days="7">近 7 天</button>
        <button type="button" data-days="14">近 14 天</button>
        <button type="button" data-days="30">近 30 天</button>`;
      wrap.querySelectorAll('[data-days]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const days = Number(btn.dataset.days);
          onPick(addDays(todayStr(), -(days - 1)), todayStr());
        });
      });
      return wrap;
    },
    /** 触发浏览器下载（携带会话 Cookie） */
    async download(url, filename) {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) {
        let message = `导出失败（${res.status}）`;
        try {
          const data = await res.json();
          if (data && data.error) message = data.error;
        } catch {
          /* 非 JSON 响应保持默认提示 */
        }
        toast(message, 'err');
        return false;
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filename || 'export.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4000);
      toast('已开始下载', 'ok');
      return true;
    },
    copy: copyText,
  };

  /* ---------------- IP 库后台任务 ---------------- */

  /**
   * IP 库更新是纯后台任务：状态存在服务端 ipdb 实例上，因此
   * - 用户点完「开始更新」就能切页面、甚至刷新浏览器，回来仍接得上同一次下载；
   * - 前端这里只轮询进度，并在顶栏显示「更新中 42%」，不阻塞任何操作。
   */
  const ipdbFeed = {
    job: null,
    status: null,
    listeners: new Set(),
    timer: null,
    polling: false,
    denied: false,
    announced: null,
    /** 上次成功轮询的时间戳，供 refresh() 节流 */
    lastPollAt: 0,

    snapshot() {
      return { job: this.job, status: this.status };
    },

    /** 订阅任务变化，返回取消订阅函数（页面离开前调用，避免重复订阅） */
    watch(fn) {
      this.listeners.add(fn);
      try {
        fn(this.snapshot());
      } catch {
        /* 首次同步失败不影响后续轮询 */
      }
      return () => this.listeners.delete(fn);
    },

    emit() {
      const snap = this.snapshot();
      this.listeners.forEach((fn) => {
        try {
          fn(snap);
        } catch {
          /* 单个订阅者出错不应打断轮询 */
        }
      });
      paintChip();
    },

    /** 百分比（无 total 时为 null），供胶囊与面板共用 */
    percent(job) {
      const p = (job || this.job || {}).progress;
      return p && p.total > 0 ? Math.min(100, Math.round((p.received / p.total) * 100)) : null;
    },

    async poll() {
      if (this.polling || this.denied) return;
      this.polling = true;
      this.lastPollAt = Date.now();
      try {
        const data = await api.get('/api/logs/ipdb/job');
        const before = this.job;
        this.job = data.job || null;
        this.status = data.status || null;
        this.emit();
        if (this.job && this.job.running) this.schedule();
        // 只提示「本次会话观察到从跑到不跑」的任务，避免每次进页面都弹旧结果
        else if (before && before.running) announce(this.job);
      } catch (err) {
        // 区域管理员没有操作日志权限（403），不必反复重试
        if (err && err.status === 403) this.denied = true;
      } finally {
        this.polling = false;
      }
    },

    schedule(delay = 1500) {
      if (this.timer || this.denied) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.poll();
      }, delay);
    },

    /**
     * 接上可能正在跑的任务。
     * 每次切页面都会调用：任务可能是在另一个标签页发起的，也可能是本页刷新前发起的，
     * 前端不应依赖「本页点过按钮」才知道要有进度条。这里加节流，避免频繁切页刷接口。
     */
    refresh() {
      if (this.denied) return Promise.resolve(null);
      const now = Date.now();
      if (this.lastPollAt && now - this.lastPollAt < 3000) return Promise.resolve(null);
      return this.poll();
    },

    /** 刚发起更新：立刻轮询并进入高频跟进 */
    begin() {
      this.announced = null;
      this.lastPollAt = 0;
      return this.poll();
    },
  };

  /** 任务结束的一次性提示：无论在哪个页面，结果都要让用户看到 */
  function announce(job) {
    if (!job || !job.id || ipdbFeed.announced === job.id) return;
    ipdbFeed.announced = job.id;
    if (job.stage === 'done') {
      const via = job.result && job.result.via && job.result.via.label ? `，来源 ${job.result.via.label}` : '';
      toast(`IP 库已更新完成${via}，详情见操作日志`, 'ok');
    } else if (job.stage === 'failed') {
      toast(`IP 库更新失败：${job.error || '未知错误'}，详情见操作日志`, 'err');
    }
  }

  /** 顶栏进度胶囊：只在有任务在跑时出现，点击跳到系统设置的 IP 库面板看进度 */
  function paintChip() {
    const chip = $('#ipdb-chip');
    if (!chip) return;
    const job = ipdbFeed.job;
    if (job && job.running) {
      const pct = ipdbFeed.percent(job);
      chip.hidden = false;
      // 胶囊很短：有百分比就给「更新中 42%」，没有就只给「更新中」
      chip.textContent = pct == null ? 'IP 库更新中' : `IP 库更新中 ${pct}%`;
      chip.title = `${job.stageText || '更新中'} · 点击查看进度`;
    } else {
      chip.hidden = true;
    }
  }

  /* ---------------- 启动 ---------------- */
  async function start() {
    let me;
    try {
      me = await api.get('/api/me');
    } catch {
      return;
    }
    state.user = me.user;
    const user = me.user;

    if (user.role !== 'admin' && user.role !== 'region_admin') {
      location.href = '/clerk';
      return;
    }

    $('#user-name').textContent = user.name || user.username || '管理员';
    $('#user-scope').textContent =
      user.role === 'region_admin'
        ? `区域管理员 · 管辖 ${(user.storeIds || []).length} 家门店`
        : `${user.roleLabel || '总部管理员'}${user.username ? ` · ${user.username}` : ''}`;
    $('#sidebar-role').textContent = user.roleLabel || '管理后台';

    renderNav();
    window.addEventListener('hashchange', route);
    // 侧边栏底部与手机端顶栏各有一个退出入口，走同一段确认逻辑
    const doLogout = () => {
      SSD.confirmDialog({ title: '退出登录', message: '确定要退出当前账号吗？', okText: '退出' }).then((ok) => {
        if (ok) SSD.logout();
      });
    };
    ['#btn-logout', '#btn-logout-mobile'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('click', doLogout);
    });
    // 顶栏进度胶囊：点一下跳到系统设置，IP 库面板在那里，完整结果在操作日志里留痕
    const chip = $('#ipdb-chip');
    if (chip) {
      chip.addEventListener('click', () => {
        if (state.page !== 'settings') location.hash = '#/settings';
      });
    }
    $('#btn-password').addEventListener('click', () => {
      if (user.passwordManaged) {
        SSD.confirmDialog({
          title: '密码由环境变量托管',
          message:
            '超级管理员的密码由环境变量 INIT_ADMIN_PASSWORD 提供，系统内不可修改。\n如需更换，请修改环境变量后重启服务。',
          okText: '知道了',
          cancelText: '',
        });
        return;
      }
      location.href = `/password?next=${encodeURIComponent('/admin')}`;
    });

    if (!location.hash) location.replace(`#/${defaultPage()}`);
    await route();
    // 进来时若已有 IP 库任务在跑（例如上一轮没看完就离开了），顶栏直接接着显示进度
    ipdbFeed.refresh();
  }

  window.Admin = {
    register,
    route,
    reload: () => helpers.reload(),
    state,
    helpers,
    start,
    /** IP 库后台任务订阅器：任何页面都能显示/跟进更新进度 */
    ipdbFeed,
    ROLE: { admin: '总部管理员', region_admin: '区域管理员', clerk: '店员' },
  };

  // 页面模块通过 Admin.register 挂载；这里把 helpers 一并暴露，方便简写
  window.Admin.h = helpers;
  // IP 库后台任务订阅器同时挂在 helpers 上：页面模块一贯用 h.xxx 取通用能力
  helpers.ipdbFeed = ipdbFeed;
})();
