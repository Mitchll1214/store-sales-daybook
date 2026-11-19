'use strict';

(function () {
  const { api, $, toast } = window.SSD;

  const form = $('#login-form');
  const errorBox = $('#form-error');
  const submitBtn = $('#submit-btn');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  }

  function clearError() {
    errorBox.classList.add('hidden');
    errorBox.textContent = '';
  }

  // 页脚年份：避免硬编码过期
  const yearEl = $('#brand-year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // 密码显隐：手机上输长密码容易打错，能看一眼比反复重输省事
  window.SSD.bindPasswordToggle($('#password'), $('#toggle-password'));

  api
    .get('/api/auth/bootstrap', { allowUnauthorized: true })
    .then((data) => {
      if (data && data.brandName) {
        $('#brand-name').textContent = data.brandName;
        // 左栏品牌区与表单标题共用同一个名称，避免两处文案不一致
        const wordmark = $('#brand-wordmark');
        if (wordmark) wordmark.textContent = data.brandName;
      }
      document.title = `登录 · ${data.brandName || '店销日集'}`;
    })
    .catch(() => {
      /* 引导信息失败不影响登录 */
    });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if (!username || !password) {
      showError('请输入账号和密码');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '登录中…';
    try {
      const data = await api.post(
        '/api/auth/login',
        { username, password },
        { allowUnauthorized: true },
      );
      const next = new URLSearchParams(location.search).get('next');
      const target = next && next.startsWith('/') && !next.startsWith('//') ? next : data.redirect;
      if (data.mustChangePassword) {
        toast('首次登录，请先修改初始密码', 'ok');
        location.href = `/password?next=${encodeURIComponent(target)}`;
        return;
      }
      location.href = target;
    } catch (err) {
      showError(err.message || '登录失败，请重试');
      submitBtn.disabled = false;
      submitBtn.textContent = '登 录';
      $('#password').select();
    }
  });

  // 输入时清除错误提示
  form.addEventListener('input', clearError);
})();
