'use strict';

(function () {
  const { api, $, toast } = window.SSD;

  const form = $('#pwd-form');
  const errorBox = $('#form-error');
  const note = $('#pwd-note');
  const submitBtn = $('#submit-btn');

  const next = (() => {
    const n = new URLSearchParams(location.search).get('next');
    return n && n.startsWith('/') && !n.startsWith('//') ? n : '';
  })();

  $('#back-link').addEventListener('click', (e) => {
    e.preventDefault();
    location.href = next || '/';
  });

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  }

  /** 账号密码由环境变量托管时，页面只做说明，不允许提交 */
  function lockForManagedAccount() {
    form.querySelectorAll('input, button').forEach((el) => {
      el.disabled = true;
    });
    if (note) {
      note.innerHTML =
        '该账号的密码由环境变量 <span class="mono">INIT_ADMIN_PASSWORD</span> 托管，系统内不可修改。<br>' +
        '如需更换密码，请修改环境变量后重启服务。';
      note.classList.add('form-note-warn');
    }
    errorBox.classList.add('hidden');
  }

  api
    .get('/api/me')
    .then(({ user }) => {
      if (user && user.passwordManaged) lockForManagedAccount();
    })
    .catch(() => {
      /* 未登录会被 API 层跳转到登录页 */
    });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    const oldPassword = $('#old-password').value;
    const newPassword = $('#new-password').value;
    const confirm = $('#confirm-password').value;

    if (!oldPassword) return showError('请输入原密码');
    if (newPassword.length < 8) return showError('新密码至少 8 位');
    if (newPassword !== confirm) return showError('两次输入的新密码不一致');
    if (newPassword === oldPassword) return showError('新密码不能与原密码相同');

    submitBtn.disabled = true;
    submitBtn.textContent = '保存中…';
    try {
      await api.post('/api/auth/password', { oldPassword, newPassword });
      toast('密码已更新', 'ok');
      location.href = next || '/';
    } catch (err) {
      showError(err.message || '修改失败，请重试');
      submitBtn.disabled = false;
      submitBtn.textContent = '保 存';
    }
  });
})();
