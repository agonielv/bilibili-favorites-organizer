const managerUrl = chrome.runtime.getURL('manager.html');
let opening = null;
// Only requests initiated by this extension, to its favorites API, receive these headers.
async function prepareTransport() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{ id: 1, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [
      { header: 'Referer', operation: 'set', value: 'https://space.bilibili.com/' },
      { header: 'Origin', operation: 'set', value: 'https://space.bilibili.com' },
    ] }, condition: { initiatorDomains: [chrome.runtime.id], requestDomains: ['api.bilibili.com'],
      urlFilter: '|https://api.bilibili.com/x/v3/fav/', resourceTypes: ['xmlhttprequest'] } }],
  });
}
let transport = prepareTransport();
// A rejected initialization is reported to the manager, never silently ignored.
transport.catch(() => {});
function openManager() {
  if (opening) return opening;
  opening = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [managerUrl] });
    for (const context of contexts) {
      try {
        await chrome.tabs.update(context.tabId, { active: true });
        await chrome.windows.update(context.windowId, { focused: true });
        return;
      } catch { /* The tab may have closed between discovery and activation. */ }
    }
    await chrome.tabs.create({ url: managerUrl });
  })().finally(() => { opening = null; });
  return opening;
}
chrome.action.onClicked.addListener(() => { openManager().catch(error => console.error('无法打开管理页', error.message)); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'OPEN_MANAGER') {
    const fromManager = sender.url === managerUrl;
    let fromFavorites = false;
    try { const url = new URL(sender.url); fromFavorites = url.origin === 'https://space.bilibili.com' && /^\/\d+\/favlist(?:\/|$)/.test(url.pathname); } catch {}
    if (!fromManager && !fromFavorites) return false;
    openManager().then(() => reply({ ok: true }), () => reply({ ok: false, error: '无法打开管理页，请点击工具栏图标。' }));
    return true;
  }
  if (message?.type === 'PREPARE_TRANSPORT' && sender.url === managerUrl) {
    transport.then(() => reply({ ok: true }), () => reply({ ok: false, error: '无法准备 B 站请求，请重新加载扩展后重试。' }));
    return true;
  }
  return false;
});
