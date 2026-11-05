export const storage = {
  async get(key) { return (await chrome.storage.local.get(key))[key]; },
  async set(key, value) { await chrome.storage.local.set({ [key]: value }); },
};
export async function getSession() {
  const [uid, csrf] = await Promise.all(['DedeUserID', 'bili_jct'].map(name => chrome.cookies.get({ url: 'https://www.bilibili.com/', name })));
  if (!uid?.value || !/^\d+$/.test(uid.value) || !csrf?.value) throw new Error('未检测到有效 B 站登录态，请先登录 B 站，再点击“连接并读取列表”。');
  let token;
  try { token = decodeURIComponent(csrf.value); } catch { throw new Error('登录状态异常，请重新登录 B 站。'); }
  return { uid: uid.value, csrf: token };
}
export async function assertSession(expected) {
  const session = await getSession();
  if (session.uid !== expected.uid || session.csrf !== expected.csrf) throw new Error('登录账号或登录状态已变化，已停止任务。请重新连接并生成预览。');
  return session;
}
export async function exclusive(action) {
  return navigator.locks.request('bfo-api-task', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('另一个管理页正在读取或整理，请等待该任务完成。');
    return action();
  });
}
export async function prepareTransport() {
  const response = await chrome.runtime.sendMessage({ type: 'PREPARE_TRANSPORT' });
  if (!response?.ok) throw new Error(response?.error || '请求通道初始化失败，请重新加载扩展。');
}
