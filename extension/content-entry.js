(() => {
  const id = 'bfo-extension-entry';
  let lastPath = '';
  function update() {
    const onFavorites = /^\/\d+\/favlist(?:\/|$)/.test(location.pathname);
    const existing = document.getElementById(id);
    if (!onFavorites) { existing?.remove(); lastPath = location.pathname; return; }
    if (existing && lastPath === location.pathname) return;
    lastPath = location.pathname;
    if (existing) return;
    const host = document.createElement('div');
    host.id = id;
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{position:fixed;right:24px;bottom:24px;z-index:2147483646;font-family:system-ui,sans-serif}button{display:flex;align-items:center;gap:10px;min-height:46px;padding:11px 17px;border:1px solid #d7e4f5;border-radius:13px;background:#fff;color:#0069d2;box-shadow:0 5px 24px #163b6c21;font:600 14px system-ui;cursor:pointer}button:hover{background:#eff6ff}button:focus-visible{outline:3px solid #409cff;outline-offset:4px}button:disabled{opacity:.6}span{font-size:18px}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '整理收藏夹 ↗';
    button.title = '在独立标签页中打开收藏夹整理';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({ type: 'OPEN_MANAGER' });
        if (!result?.ok) throw new Error();
        button.textContent = '整理收藏夹 ↗';
      } catch { button.textContent = '打开失败，请点击扩展图标'; }
      finally { button.disabled = false; }
    });
    root.append(style, button);
    document.documentElement.append(host);
  }
  update();
  // Space pages navigate without reloading; this performs no network requests.
  setInterval(update, 1000);
  window.addEventListener('popstate', update);
  document.addEventListener('visibilitychange', update);
})();
