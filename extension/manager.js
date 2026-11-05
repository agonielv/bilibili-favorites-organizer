import { DEFAULT_RULES, validateRules, buildPlan } from './lib/planner.js';
import { RequestQueue } from './lib/request.js';
import { BiliClient } from './lib/client.js';
import { executePlan } from './lib/runner.js';
import { storage, getSession, assertSession, exclusive, prepareTransport } from './lib/platform.js';

const $ = id => document.getElementById(id);
const format = n => Number(n).toLocaleString('zh-CN');
const CACHE_TTL = 10 * 60 * 1000;
let folders = [], selected = new Set(), connectedUid = null, snapshot = null, plan = null;
let stage = 'selection', busy = false, activeSession = null, identityDirty = false, keepPreference = true, pages = 0, shown = 0;
const queue = new RequestQueue({ storage });
const client = new BiliClient(queue, async () => {
  if (!activeSession || identityDirty) throw new Error('登录状态已变化，请重新连接并生成预览。');
  return assertSession(activeSession);
});
function report(error) { $('error').textContent = error.message || String(error); $('error').scrollIntoView({ block: 'nearest' }); }
function guarded(action) { return async () => { $('error').textContent = ''; try { await action(); } catch (error) { report(error); } }; }
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}
function readRules() {
  return validateRules({ group: $('group-enabled').checked, groupOrder: $('group-order').value, keep: keepPreference,
    time: document.querySelector('[name=time-order]:checked').value, privacy: $('privacy').value,
    base: $('base-name').value, capacity: Number($('capacity').value) });
}
function syncRules() {
  const grouped = $('group-enabled').checked;
  $('group-order').disabled = busy || !grouped;
  $('keep-uploader').disabled = busy || !grouped;
  $('keep-uploader').checked = grouped && keepPreference;
  $('time-label').textContent = grouped ? '组内视频排序' : '全部视频排序';
  $('keep-hint').textContent = grouped ? '容量不足时，整体放入下一个收藏夹' : '未按 UP 主聚合时，以视频容量拆分';
}
function applyRules(value) {
  const rules = validateRules(value);
  $('group-enabled').checked = rules.group; $('group-order').value = rules.groupOrder;
  keepPreference = rules.keep; document.querySelector(`[name=time-order][value=${rules.time}]`).checked = true;
  $('privacy').value = rules.privacy; $('base-name').value = rules.base; $('capacity').value = rules.capacity; syncRules();
}
async function saveRules() {
  let rules;
  try { rules = readRules(); } catch { return; }
  try { await storage.set('rules', rules); } catch { report(new Error('无法保存设置，请检查浏览器存储权限。')); }
}
async function saveSelection() { if (connectedUid) await storage.set('selection:' + connectedUid, [...selected]); }
function setBusy(value) {
  busy = value;
  for (const element of document.querySelectorAll('button, input, select')) element.disabled = value;
  if (!value) { syncRules(); renderFolders(); $('review').disabled = !snapshot || !plan; }
  $('organizer').setAttribute('aria-busy', String(value));
}
async function task(action) {
  if (busy) throw new Error('当前任务尚未完成。');
  setBusy(true);
  try {
    return await exclusive(async () => {
      activeSession = await getSession(); identityDirty = false;
      await prepareTransport();
      return action(activeSession);
    });
  } finally { activeSession = null; setBusy(false); }
}
function renderFolders() {
  $('folders').replaceChildren();
  const query = $('search').value.trim().toLowerCase();
  let visible = 0;
  folders.forEach((folder, index) => {
    if (!folder.title.toLowerCase().includes(query)) return;
    visible++;
    const row = document.createElement('label'); row.className = 'folder-row';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(folder.id); check.disabled = busy;
    check.setAttribute('aria-label', '选择收藏夹 ' + folder.title);
    check.onchange = guarded(async () => { if (check.checked) selected.add(folder.id); else selected.delete(folder.id); snapshot = null; plan = null; renderFolders(); await saveSelection(); });
    const art = document.createElement('div'); art.className = 'folder-art color' + index % 3; art.append(icon('folder'));
    const label = document.createElement('div'); const name = document.createElement('strong'); name.textContent = folder.title;
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = '收藏夹'; label.append(name, meta);
    const count = document.createElement('span'); count.className = 'folder-count num'; count.textContent = format(folder.count);
    row.append(check, art, label, count); $('folders').append(row);
  });
  if (!folders.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.textContent = connectedUid ? '账号暂无可整理的收藏夹。' : '先连接 B 站，读取你的收藏夹列表。';
    if (!connectedUid) {
      const line = document.createElement('div'); line.className = 'login-actions';
      const login = document.createElement('button'); login.className = 'plain'; login.textContent = '打开 B 站登录'; login.disabled = busy;
      login.onclick = guarded(() => chrome.tabs.create({ url: 'https://www.bilibili.com/' })); line.append(login); empty.append(line);
    }
    $('folders').append(empty);
  }
  $('no-match').hidden = !folders.length || visible > 0;
  $('selection-count').textContent = '已选 ' + selected.size + ' 个';
  $('selection-total').textContent = format(folders.filter(f => selected.has(f.id)).reduce((n, f) => n + f.count, 0));
  $('generate').disabled = busy || !connectedUid || !selected.size;
  $('select-all').disabled = busy || !folders.length; $('select-none').disabled = busy || !selected.size;
}
function setStage(next) {
  stage = next; $('selection').hidden = stage !== 'selection'; $('preview').hidden = stage !== 'preview';
  for (const id of ['step1', 'step2']) $(id).removeAttribute('aria-current');
  $(stage === 'selection' ? 'step1' : 'step2').setAttribute('aria-current', 'step');
  $('page-title').textContent = stage === 'selection' ? '让收藏，井然有序。' : '每一组，都恰到好处。';
  $('page-desc').textContent = stage === 'selection' ? '从选择到预览，每一步都由你决定。' : '先核对分组计划，再确认开始移动。';
  $('page-title').focus();
}
function showOrganizer() {
  $('help').hidden = true; $('organizer').hidden = false;
  $('nav-organize').classList.add('active'); $('nav-help').classList.remove('active');
  $('nav-organize').setAttribute('aria-current', 'page'); $('nav-help').removeAttribute('aria-current'); setStage(stage);
}
function selectionKey() { return [...selected].sort().join(','); }
function fresh(value = snapshot) { return value && value.uid === connectedUid && value.key === selectionKey() && Date.now() - value.at < CACHE_TTL; }
function pageProgress(value) {
  pages++; $('scan-count').textContent = pages;
  $('status').textContent = `读取“${value.folder.title}”第 ${value.page} 页：${format(value.read)} / ${value.expected ?? '?'} 条。`;
}
async function connect() {
  await task(async session => {
    snapshot = null; plan = null;
    $('status').textContent = '正在读取你的收藏夹列表…';
    const loaded = await client.folders(session.uid);
    const previous = await storage.get('selection:' + session.uid);
    connectedUid = session.uid; folders = loaded;
    const available = new Set(folders.map(f => f.id));
    selected = new Set((Array.isArray(previous) ? previous : []).filter(id => available.has(id)));
    $('account-label').textContent = 'UID ' + connectedUid; $('connect').textContent = '刷新收藏夹列表';
    stage = 'selection'; showOrganizer();
    $('status').textContent = `已读取 ${folders.length} 个收藏夹。选择后点击“生成整理预览”才会读取视频。`;
  });
}
async function generate(force = false) {
  const rules = readRules();
  if (!selected.size || !connectedUid) throw new Error('请先连接并选择源收藏夹。');
  const current = await getSession();
  if (current.uid !== connectedUid) throw new Error('账号已变化，请重新连接。');
  let reused = false;
  if (!force && fresh()) reused = true;
  else {
    await task(async session => {
      if (session.uid !== connectedUid) throw new Error('账号已变化，请重新连接。');
      const sources = folders.filter(f => selected.has(f.id));
      const items = await client.snapshot(sources, pageProgress);
      snapshot = { uid: session.uid, key: selectionKey(), at: Date.now(), items };
    });
  }
  plan = buildPlan(snapshot.items, rules);
  await saveRules();
  renderPlan(); $('execution-panel').hidden = true; setStage('preview');
  $('status').textContent = reused ? '已复用本次读取数据，没有重新扫描。' : '只读预览已生成。尚未创建收藏夹或移动视频。';
  if (plan.missingDates) $('status').textContent += ` ${plan.missingDates} 条缺少发布时间，已放在所属排序范围末尾，并按收藏时间等信息排序。`;
}
function renderPlan() {
  $('video-total').textContent = format(plan.itemCount); $('uploader-total').textContent = format(plan.uploaderCount); $('target-total').textContent = format(plan.chunks.length);
  $('sample-time').textContent = '采集于 ' + new Date(snapshot.at).toLocaleTimeString();
  const r = plan.rules;
  $('rule-summary').textContent = [r.group ? $('group-order').selectedOptions[0].textContent : '不按 UP 主聚合', r.group && r.keep ? '同 UP 不拆分' : '按容量可拆分', r.time === 'desc' ? '发布时间降序' : '发布时间升序', `每夹 ${r.capacity} 条`, r.privacy === 'private' ? '私密' : '公开'].join(' · ');
  $('plan').replaceChildren(); shown = 0; renderMore(); $('review').disabled = false;
}
function renderMore() {
  const end = Math.min(shown + 50, plan.chunks.length);
  for (const chunk of plan.chunks.slice(shown, end)) {
    const card = document.createElement('article'); card.className = 'plan-card';
    const top = document.createElement('div'); top.className = 'plan-top';
    const nameBox = document.createElement('div'); nameBox.className = 'plan-name';
    const title = document.createElement('h3'); title.textContent = chunk.name; nameBox.append(icon('folder'), title);
    const count = document.createElement('span'); count.textContent = `${format(chunk.items.length)} / ${format(plan.rules.capacity)} 条`; top.append(nameBox, count);
    const track = document.createElement('div'); track.className = 'capacity-track'; const fill = document.createElement('span'); fill.style.width = chunk.items.length / plan.rules.capacity * 100 + '%'; track.append(fill);
    const ups = new Map(); for (const item of chunk.items) ups.set(item.uploaderName, (ups.get(item.uploaderName) || 0) + 1);
    const summary = document.createElement('div'); summary.className = 'uploader-list'; summary.textContent = [...ups].map(([name, n]) => `${name} ${n}条`).join(' · ');
    const details = document.createElement('details'); details.className = 'video-detail'; const heading = document.createElement('summary'); heading.textContent = '查看前 3 条视频的展示顺序'; details.append(heading);
    for (const item of chunk.items.slice(0, 3)) {
      const row = document.createElement('div'); row.className = 'video-row'; row.dataset.publishedAt = item.publishedAt;
      const label = document.createElement('span'); label.textContent = item.title;
      const date = document.createElement('time'); date.textContent = item.publishedAt ? new Date(item.publishedAt * 1000).toLocaleDateString() : '发布时间未知';
      row.append(label, date); details.append(row);
    }
    card.append(top, track, summary, details); $('plan').append(card);
  }
  shown = end; $('load-more').hidden = shown === plan.chunks.length;
  $('load-more').textContent = `显示更多分组（已显示 ${shown}/${plan.chunks.length}）`;
}
function cancel() { $('confirm').close(); $('status').textContent = '已取消，预览已保留。没有创建收藏夹、移动视频或刷新页面。'; }
function review() {
  if (!fresh()) throw new Error('预览已过期或失效，请返回重新生成预览后再执行。');
  const r = plan.rules;
  $('confirm-summary').textContent = `${format(plan.itemCount)} 条收藏记录 → ${plan.chunks.length} 个${r.privacy === 'private' ? '私密' : '公开'}收藏夹。${r.time === 'desc' ? '最新发布在前' : '最早发布在前'}。`;
  $('confirm').showModal();
}
function executionProgress(state) {
  $('execution-panel').hidden = false; $('execution-title').textContent = state.phase;
  $('progress-text').textContent = `${format(state.confirmed)} / ${format(state.total)} 条`;
  $('progress-bar').style.width = state.confirmed / state.total * 100 + '%';
  $('execution-message').textContent = state.detail;
}
async function execute() {
  if (!fresh()) { $('confirm').close(); throw new Error('预览已失效，请重新生成。'); }
  const approved = plan, originalSnapshot = snapshot;
  $('confirm').close();
  $('execution-panel').hidden = false;
  $('execution-title').textContent = '准备执行';
  $('execution-message').className = '';
  $('execution-message').textContent = '正在核对登录状态与执行计划…';
  $('progress-text').textContent = `0 / ${format(approved.itemCount)} 条`;
  $('progress-bar').style.width = '0%';
  try {
    await task(async session => {
      if (session.uid !== originalSnapshot.uid || !fresh(originalSnapshot)) throw new Error('账号或预览已变化，请重新生成预览。');
      // Invalidate before writing, including uncertain writes and partially created destinations.
      snapshot = null;
      $('execution-message').className = '';
      const result = await executePlan(client, approved, { onProgress: executionProgress,
        assertFresh: async () => { if (identityDirty) throw new Error('登录状态已变化，已停止任务。'); await assertSession(session); } });
      $('execution-title').textContent = '整理完成'; $('execution-message').className = 'success';
      $('execution-message').textContent = `已移动并核对 ${format(result.verified)} 条，共 ${format(result.moveRequests)} 次移动请求（含中转和校正）。${result.buffer ? ` 空私密中转夹“${result.buffer.title}”（ID ${result.buffer.id}）已保留，可在 B 站自行删除。` : ''}`;
      $('status').textContent = '本次预览已失效。再次整理请返回生成新预览。';
    });
  } catch (error) {
    $('execution-panel').hidden = false; $('execution-title').textContent = '任务已停止'; $('execution-message').className = '';
    $('execution-message').textContent = error.message; throw error;
  } finally { $('sample-time').textContent = snapshot ? '预览尚未执行' : '预览已失效'; }
}
async function openFavorites() {
  const session = await getSession(); await chrome.tabs.create({ url: `https://space.bilibili.com/${session.uid}/favlist` });
}
$('connect').onclick = guarded(connect); $('generate').onclick = guarded(() => generate()); $('refresh').onclick = guarded(() => generate(true));
$('review').onclick = guarded(review); $('execute').onclick = guarded(execute); $('cancel').onclick = cancel;
$('confirm').addEventListener('cancel', event => { event.preventDefault(); cancel(); });
$('search').oninput = renderFolders;
$('select-all').onclick = guarded(async () => { selected = new Set(folders.map(f => f.id)); snapshot = null; plan = null; renderFolders(); await saveSelection(); });
$('select-none').onclick = guarded(async () => { selected.clear(); snapshot = null; plan = null; renderFolders(); await saveSelection(); });
$('group-enabled').onchange = () => { syncRules(); void saveRules(); };
$('keep-uploader').onchange = () => { keepPreference = $('keep-uploader').checked; void saveRules(); };
for (const element of document.querySelectorAll('#selection select, #selection input:not([type=checkbox]):not([type=search])')) element.addEventListener('change', () => { void saveRules(); });
$('reset-rules').onclick = guarded(async () => { applyRules(DEFAULT_RULES); await saveRules(); $('status').textContent = '已恢复默认规则。重新生成预览会复用有效快照。'; });
$('back').onclick = () => { $('error').textContent = ''; setStage('selection'); $('status').textContent = snapshot ? '可以修改规则后复用预览。' : '请生成新预览后再执行。'; };
$('load-more').onclick = renderMore; $('nav-organize').onclick = showOrganizer; $('nav-entry').onclick = guarded(openFavorites);
$('nav-help').onclick = () => { $('organizer').hidden = true; $('help').hidden = false; $('nav-organize').classList.remove('active'); $('nav-help').classList.add('active'); $('nav-organize').removeAttribute('aria-current'); $('nav-help').setAttribute('aria-current', 'page'); $('page-title').textContent = '简单使用，清楚掌控。'; $('page-desc').textContent = '两个入口，一套规则，一个专属管理页。'; };
$('help-back').onclick = showOrganizer;
$('clear-settings').onclick = guarded(async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter(key => key === 'rules' || key.startsWith('selection:')));
  applyRules(DEFAULT_RULES); selected.clear(); snapshot = null; plan = null; setStage('selection'); renderFolders();
  $('status').textContent = '已清除保存的设置；接口冷却状态保留。';
});
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (!cookie.domain.endsWith('bilibili.com') || !['DedeUserID', 'bili_jct'].includes(cookie.name)) return;
  identityDirty = true; snapshot = null;
  if (!busy) { folders = []; selected.clear(); connectedUid = null; plan = null; $('account-label').textContent = '登录已变化'; $('connect').textContent = '连接并读取列表'; renderFolders(); $('review').disabled = true; }
  $('status').textContent = '登录状态已变化，请重新连接；正在运行的任务将在下一次操作前停止。';
});
(async () => {
  try { const saved = await storage.get('rules'); applyRules(saved || DEFAULT_RULES); }
  catch { applyRules(DEFAULT_RULES); }
  renderFolders(); $('review').disabled = true;
  try { const session = await getSession(); $('account-label').textContent = '已登录 · 点击连接'; }
  catch { $('account-label').textContent = '未登录 B 站'; }
})().catch(report);
