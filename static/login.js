const password = document.getElementById('password');
const toggle = document.getElementById('togglePassword');

// The toggle stays hidden without JS rather than showing a dead button
toggle.hidden = false;
toggle.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(show));
  toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  password.focus();
});
