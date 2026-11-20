'use strict';

/* ============================================================
   店销日集 · 前端公共层
   - 设备指纹：只上报少量公开环境字段，由服务端算成 16 位短码（不含网络类型）
   - API 封装：统一错误提示、401 跳转
   - UI：toast / modal / 格式化
   ============================================================ */

(function () {
  /**
   * 参与指纹的终端特征（服务端据此算 16 位短码）。
   * 刻意不含任何网络与易变信息：online 状态、connection.type、IP、
   * 电池、GPU、UA 里的 NetType/MMWEBID 等一律不采集，
   * 这样同一台设备切 WiFi / 移动数据、清缓存后重进，指纹都一样。
   */
  function deviceMeta() {
    const m = {
      screen: `${screen.width || 0}x${screen.height || 0}`,
      colorDepth: screen.colorDepth || 0,
      timezone: '',
      language: navigator.language || '',
      platform: navigator.platform || '',
      hardwareConcurrency: navigator.hardwareConcurrency || 0,
    };
    try {
      m.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      m.timezone = '';
    }
    return m;
  }

  function encodeMeta() {
    try {
      const json = JSON.stringify(deviceMeta());
      // 只含 ASCII 以外的字符时 btoa 会失败，先做 UTF-8 编码
      return btoa(unescape(encodeURIComponent(json)));
    } catch {
      return '';
    }
  }

  const DEVICE_META = encodeMeta();

  /* ---------------- API ---------------- */

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  async function request(method, url, body, options = {}) {
    const headers = {
      // 只上报环境特征，由服务端算成 16 位设备指纹短码；不再发送本地随机 id
      'x-device-meta': DEVICE_META,
    };
    let payload;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError('网络异常，请检查网络后重试', 0, 'NETWORK');
    }
    if (res.status === 401 && !options.allowUnauthorized) {
      if (!url.includes('/api/auth/login')) {
        location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
        throw new ApiError('登录已过期', 401, 'UNAUTHENTICATED');
      }
    }
    const type = res.headers.get('content-type') || '';
    let data = null;
    if (type.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      data = await res.text();
    }
    if (!res.ok) {
      const message = (data && data.error) || (typeof data === 'string' && data) || `请求失败（${res.status}）`;
      throw new ApiError(message, res.status, data && data.code);
    }
    return data;
  }

  const api = {
    get: (url, options) => request('GET', url, undefined, options),
    post: (url, body, options) => request('POST', url, body, options),
    put: (url, body, options) => request('PUT', url, body, options),
    patch: (url, body, options) => request('PATCH', url, body, options),
    del: (url, options) => request('DELETE', url, undefined, options),
    upload: (url, formData) => request('POST', url, formData),
  };

  /* ---------------- 工具 ---------------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------------- 线性图标 ----------------
     统一 24×24 视框、1.7px 描边、圆角端点；颜色与尺寸由 CSS 控制，
     避免此前混用 ◧ ▤ ⌂ 等杂项字符在不同系统上字形不一致的问题。 */
  const ICON_PATHS = {
    dashboard:
      '<rect x="3" y="3" width="7.6" height="7.6" rx="2"/><rect x="13.4" y="3" width="7.6" height="7.6" rx="2"/><rect x="3" y="13.4" width="7.6" height="7.6" rx="2"/><rect x="13.4" y="13.4" width="7.6" height="7.6" rx="2"/>',
    reports: '<path d="M4 20h16"/><path d="M7.5 20v-5.5"/><path d="M12 20V6.5"/><path d="M16.5 20v-8.5"/>',
    stores:
      '<path d="M3.5 10.6 12 3.6l8.5 7"/><path d="M5.9 9.5V20h12.2V9.5"/><path d="M9.9 20v-5.2h4.2V20"/>',
    products:
      '<path d="M12 3.3 20 7.7v8.6L12 20.7 4 16.3V7.7z"/><path d="M4 7.7 12 12l8-4.3"/><path d="M12 12v8.7"/>',
    users:
      '<circle cx="9.2" cy="8" r="3.3"/><path d="M3.4 20c0-3.2 2.6-5.4 5.8-5.4s5.8 2.2 5.8 5.4"/><path d="M16.3 5.4a3.3 3.3 0 0 1 0 5.7"/><path d="M17.1 14.9c2.2.6 3.6 2.3 3.6 5.1"/>',
    logs:
      '<path d="M9 6.5h11.5"/><path d="M9 12h11.5"/><path d="M9 17.5h11.5"/><circle cx="4.6" cy="6.5" r="1.1"/><circle cx="4.6" cy="12" r="1.1"/><circle cx="4.6" cy="17.5" r="1.1"/>',
    /* 空态与提示 */
    inbox:
      '<path d="M3.5 12.4 6.2 4.6h11.6l2.7 7.8"/><path d="M3.5 12.4h4.2l1.2 2.5h6.2l1.2-2.5h4.2v5.2a2.4 2.4 0 0 1-2.4 2.4H5.9a2.4 2.4 0 0 1-2.4-2.4z"/>',
    archive:
      '<rect x="3.5" y="4.6" width="17" height="4.4" rx="1.6"/><path d="M5.3 9v9.1a2 2 0 0 0 2 2h9.4a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
    shop:
      '<path d="M3.6 9.6V19a1.5 1.5 0 0 0 1.5 1.5h13.8A1.5 1.5 0 0 0 20.4 19V9.6"/><path d="M2.6 9.6 5.1 4h13.8l2.5 5.6z"/><path d="M9.6 20.5v-5.9h4.8v5.9"/>',
    alert:
      '<path d="M12 4.4 20.9 19.4H3.1z"/><path d="M12 10.2v3.9"/><circle cx="12" cy="16.7" r="0.95"/>',
    box:
      '<path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z"/><path d="M4 7.6 12 12l8-4.4"/><path d="M12 12v8.8"/><path d="M8 5.4l8 4.4"/>',
    search: '<circle cx="10.7" cy="10.7" r="6.3"/><path d="M15.4 15.4 20.4 20.4"/>',
    check: '<circle cx="12" cy="12" r="8.6"/><path d="M8 12.4l2.9 2.9L16.4 9.7"/>',
    /* 系统设置：齿轮 */
    settings:
      '<circle cx="12" cy="12" r="3.1"/><path d="M12 2.9l1.4 2.3 2.7-.4.6 2.6 2.4 1.3-1 2.5 1 2.5-2.4 1.3-.6 2.6-2.7-.4L12 21.1l-1.4-2.3-2.7.4-.6-2.6-2.4-1.3 1-2.5-1-2.5 2.4-1.3.6-2.6 2.7.4z"/>',
  };

  /** 渲染一个线性图标；未知名称回退到 inbox，避免出现空白占位 */
  function icon(name, extraClass) {
    const path = ICON_PATHS[name] || ICON_PATHS.inbox;
    return `<svg class="ico${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">${path}</svg>`;
  }


  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  function toast(message, type = '') {
    let host = $('#toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .22s ease, transform .22s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 240);
    }, type === 'err' ? 3400 : 2200);
  }

  function todayStr() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /**
   * 防抖：搜索框等到停止输入再发请求，避免每敲一个字就打一次接口。
   * 返回的函数带 cancel()，页面重新渲染前可取消待执行的调用。
   */
  function debounce(fn, wait = 260) {
    let timer = null;
    const wrapped = (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, wait);
    };
    wrapped.cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return wrapped;
  }

  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const t = new Date(y, m - 1, d + n);
    const pad = (x) => String(x).padStart(2, '0');
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }

  function weekdayLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return names[new Date(y, m - 1, d).getDay()];
  }

  function money(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function percentText(rate) {
    const v = Number(rate) || 0;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
  }

  function rateClass(rate) {
    const v = Number(rate) || 0;
    if (v >= 100) return 'pill-ok';
    if (v >= 50) return 'pill-warn';
    if (v > 0) return 'pill-danger';
    return '';
  }

  /** 复制到剪贴板，兼容微信 WebView 无 navigator.clipboard 的情况 */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 回退到 execCommand */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /* ---------------- 密码显隐 ---------------- */

  /**
   * 给密码框绑定「显示 / 隐藏」切换。
   * 手机上输长密码容易打错，能看一眼比反复清空重输省事；
   * 切换后保持光标在末尾，并把焦点还给输入框，避免键盘收起。
   * @param {HTMLInputElement} input
   * @param {HTMLButtonElement} button
   */
  function bindPasswordToggle(input, button) {
    if (!input || !button) return;
    button.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? '隐藏' : '显示';
      button.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      button.setAttribute('aria-pressed', show ? 'true' : 'false');
      button.title = show ? '隐藏密码' : '显示密码';
      const end = input.value.length;
      input.focus();
      try {
        input.setSelectionRange(end, end);
      } catch {
        /* 部分浏览器切换 password→text 后不支持选区，忽略 */
      }
    });
  }

  /* ---------------- 弹窗 ---------------- */

  /**
   * 打开弹窗。
   * @param {{title:string, body:string, footer?:string, wide?:boolean}} opts
   * @returns {{root:HTMLElement, close:Function}}
   */
  function openModal(opts) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal${opts.wide ? ' wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${escapeHtml(opts.title || '')}</h3>
          <button class="modal-close" type="button" aria-label="关闭">✕</button>
        </div>
        <div class="modal-body">${opts.body || ''}</div>
        ${opts.footer ? `<div class="modal-foot">${opts.footer}</div>` : ''}
      </div>`;
    document.body.appendChild(mask);
    const close = () => {
      mask.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close();
    });
    $('.modal-close', mask).addEventListener('click', close);
    return { root: mask, close };
  }

  function confirmDialog({ title, message, okText = '确定', danger = false }) {
    return new Promise((resolve) => {
      const m = openModal({
        title,
        body: `<p style="margin:0;font-size:14px;line-height:1.65;color:var(--ink-2)">${escapeHtml(message)}</p>`,
        footer: `<button class="btn btn-ghost" data-act="cancel" type="button">取消</button>
                 <button class="btn ${danger ? 'btn-danger' : ''}" data-act="ok" type="button" style="${
          danger ? 'background:#b91c1c;color:#fff;border-color:#b91c1c' : ''
        }">${escapeHtml(okText)}</button>`,
      });
      $('[data-act="cancel"]', m.root).addEventListener('click', () => {
        m.close();
        resolve(false);
      });
      $('[data-act="ok"]', m.root).addEventListener('click', () => {
        m.close();
        resolve(true);
      });
    });
  }

  function promptDialog({ title, label, value = '', placeholder = '', type = 'text', confirmText = '确定' }) {
    return new Promise((resolve) => {
      const m = openModal({
        title,
        body: `<div class="field"><label>${escapeHtml(label)}</label>
          <input class="input" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" data-input></div>`,
        footer: `<button class="btn btn-ghost" data-act="cancel" type="button">取消</button>
                 <button class="btn" data-act="ok" type="button">${escapeHtml(confirmText)}</button>`,
      });
      const input = $('[data-input]', m.root);
      input.focus();
      input.select();
      const done = (ok) => {
        const v = input.value;
        m.close();
        resolve(ok ? v : null);
      };
      $('[data-act="cancel"]', m.root).addEventListener('click', () => done(false));
      $('[data-act="ok"]', m.root).addEventListener('click', () => done(true));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(true);
      });
    });
  }

  /* ---------------- 其余 ---------------- */

  async function logout() {
    try {
      await api.post('/api/auth/logout', {});
    } catch {
      /* 忽略登出失败 */
    }
    location.href = '/login';
  }

  window.SSD = {
    api,
    ApiError,
    $,
    $$,
    escapeHtml,
    icon,
    toast,
    todayStr,
    debounce,
    addDays,
    weekdayLabel,
    money,
    percentText,
    rateClass,
    copyText,
    bindPasswordToggle,
    openModal,
    confirmDialog,
    promptDialog,
    logout,
    deviceMeta,
  };
})();
