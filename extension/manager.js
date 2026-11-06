import { DEFAULT_RULES, validateRules, buildPlan } from './lib/planner.js';
import { RequestQueue, COOLDOWN_KEY } from './lib/request.js';
import { BiliClient } from './lib/client.js';
import { SourceCache } from './lib/source-cache.js';
import { attachFolderSelection } from './lib/folder-selection.js';
import { executePlan } from './lib/runner.js';
import { storage, getSession, assertSession, exclusive, prepareTransport } from './lib/platform.js';

const $ = id => document.getElementById(id);
const format = n => Number(n).toLocaleString('zh-CN');
const time = at => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
const cache = new SourceCache();
const queue = new RequestQueue({ storage });
let folders = [], selected = new Set(), connectedUid = null, activeId = null, filter = 'all';
let snapshot = null, plan = null, taskReadback = null, stage = 'selection', busy = false, activeSession = null, identityDirty = false;
let keepPreference = true, pages = 0, shown = 0, metadataStale = false, lastTask = null, taskStarted = 0, taskUid = null;
let announcedPhase = '', lastAnnouncement = 0;
let folderSelection;
let lastFolderAnnouncement = 0;
const client = new BiliClient(queue, async () => {
  if (!activeSession || identityDirty) throw new Error('登录状态已变化，请重新连接并生成预览。');
  return assertSession(activeSession);
});
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}
function status(message) { $('status').textContent = message; }
function report(error) {
  const message = error.message || String(error);
  $('error').textContent = message;
  if (error.rateLimited) updateCooldown();
  if (!document.querySelector('dialog[open]')) $('error').scrollIntoView({ block: 'nearest' });
}
function guarded(action) {
  return async event => { $('error').textContent = ''; try { await action(event); } catch (error) { report(error); } };
}
function selectionKey() { return [...selected].sort().join(','); }
function fresh(value = snapshot) {
  // A long read/review does not expire the plan. The runner checks the actual
  // source contents again after confirmation, before creating or moving anything.
  return value && value.uid === connectedUid && value.key === selectionKey();
}
function clearFieldErrors() {
  for (const id of ['capacity', 'base-name']) {
    $(id).removeAttribute('aria-invalid'); $(id).removeAttribute('aria-describedby'); $(id + '-error').hidden = true;
  }
}
function ruleSummary(rules) {
  return [rules.group ? ({ 'count-desc': 'UP 视频数量多到少', 'count-asc': 'UP 视频数量少到多', name: 'UP 名称 A–Z' }[rules.groupOrder]) : '不按 UP 主聚合',
    rules.group && rules.keep ? '同 UP 不拆分' : '允许按容量拆分', rules.time === 'desc' ? '发布时间降序' : '发布时间升序',
    `每夹 ${format(rules.capacity)} 条`, rules.privacy === 'private' ? '私密' : '公开'].join(' · ');
}
function readRules(showErrors = false) {
  try {
    return validateRules({ group: $('group-enabled').checked, groupOrder: $('group-order').value, keep: keepPreference,
      time: document.querySelector('[name=time-order]:checked').value, privacy: $('privacy').value,
      base: $('base-name').value, capacity: Number($('capacity').value) });
  } catch (error) {
    if (showErrors) {
      const id = error.message.startsWith('容量') ? 'capacity' : error.message.startsWith('基础名称') ? 'base-name' : null;
      if (id) {
        $(id).setAttribute('aria-invalid', 'true'); $(id).setAttribute('aria-describedby', id + '-error');
        $(id + '-error').textContent = error.message; $(id + '-error').hidden = false;
        if (window.matchMedia('(max-width: 1279px)').matches && !$('rules-dialog').open) openPanel('rules');
        $(id).focus();
      }
    }
    throw error;
  }
}
function syncRules() {
  const grouped = $('group-enabled').checked;
  $('group-order').disabled = busy || !grouped; $('keep-uploader').disabled = busy || !grouped;
  $('keep-uploader').checked = grouped && keepPreference;
  $('time-label').textContent = grouped ? '组内视频排序' : '全部视频排序';
  $('keep-hint').textContent = grouped ? '容量不足时整体放入下一夹' : '未聚合时按时间与容量拆分';
  $('privacy-summary').textContent = $('privacy').value === 'private' ? '私密' : '公开';
  $('privacy-hint').textContent = $('privacy').value === 'private' ? '仅自己可见' : '其他用户可见';
  try { $('rule-summary').textContent = ruleSummary(readRules()); } catch { $('rule-summary').textContent = '请检查输入的规则。'; }
}
function applyRules(value) {
  const rules = validateRules(value);
  $('group-enabled').checked = rules.group; $('group-order').value = rules.groupOrder; keepPreference = rules.keep;
  document.querySelector(`[name=time-order][value=${rules.time}]`).checked = true;
  $('privacy').value = rules.privacy; $('base-name').value = rules.base; $('capacity').value = rules.capacity; syncRules();
}
async function saveRules() {
  let rules; try { rules = readRules(); } catch { return; }
  try { await storage.set('rules', rules); } catch { report(new Error('无法保存设置，请检查浏览器存储权限。')); }
}
async function saveSelection() { if (connectedUid) await storage.set('selection:' + connectedUid, [...selected]); }
function updateControls() {
  const cooling = queue.cooldownUntil > Date.now();
  for (const el of document.querySelectorAll('[data-mutation]')) el.disabled = busy;
  for (const el of document.querySelectorAll('[data-network]')) el.disabled = busy || cooling;
  $('generate').disabled = busy || cooling || !connectedUid || !selected.size;
  $('review').disabled = busy || cooling || !plan?.itemCount || !fresh();
  $('execute').disabled = busy || cooling || !plan?.itemCount || !fresh();
  $('refresh').disabled = busy || cooling || !connectedUid || !selected.size;
  const visible = visibleFolders();
  $('select-all').disabled = busy || !visible.length;
  $('select-none').disabled = busy || !visible.some(f => selected.has(f.id));
  $('select-entire').disabled = busy || !folders.length; $('clear-entire').disabled = busy || !selected.size;
  $('generate').textContent = stage === 'preview' ? '重新生成预览' : '生成整理预览';
  syncRules();
}
function setBusy(value) {
  if (value) folderSelection?.cancel();
  busy = value;
  // Read-only browsing, local filters, and help stay available during a task.
  updateControls(); renderFolders();
}
async function task(action) {
  if (busy) throw new Error('当前任务尚未完成。');
  setBusy(true);
  try {
    return await exclusive(async () => {
      activeSession = await getSession(); identityDirty = false; await prepareTransport();
      return action(activeSession);
    });
  } finally {
    activeSession = null; setBusy(false);
    if (identityDirty) resetIdentity();
  }
}
function visibleFolders() {
  const query = $('search').value.trim().toLowerCase();
  return folders.filter(folder => folder.title.toLowerCase().includes(query) &&
    (filter !== 'selected' || selected.has(folder.id)) && (filter !== 'empty' || folder.count === 0));
}
function renderFolders() {
  folderSelection?.cancel();
  const container = $('folders'), focused = document.activeElement, visible = visibleFolders();
  const rows = new Map([...container.querySelectorAll('.folder-row')].map(row => [row.dataset.folderId, row]));
  const keep = new Set(visible.map(folder => folder.id));
  for (const child of [...container.children]) if (!keep.has(child.dataset.folderId)) child.remove();
  visible.forEach((folder, index) => {
    let row = rows.get(folder.id);
    if (!row) {
      row = node('div', undefined, 'folder-row'); row.dataset.folderId = folder.id;
      const checkLabel = node('label', undefined, 'check-wrap'), check = node('input');
      check.type = 'checkbox'; check.setAttribute('aria-label', '选择收藏夹 ' + folder.title);
      check.onchange = guarded(async () => {
        if (busy) return;
        if (check.checked) selected.add(folder.id); else selected.delete(folder.id);
        invalidatePlan(); renderFolders(); await saveSelection();
      });
      checkLabel.append(check);
      const view = node('button', undefined, 'folder-name'), label = node('span'); view.type = 'button';
      label.append(node('span', folder.title, 'folder-title'), node('span', '', 'folder-state'));
      view.append(icon('folder'), label); view.onclick = () => viewFolder(folder.id);
      row.append(checkLabel, view, node('span', '', 'folder-count'));
    }
    row.classList.toggle('active', activeId === folder.id);
    row.classList.toggle('selected', selected.has(folder.id));
    const check = row.querySelector('input'); check.checked = selected.has(folder.id); check.disabled = busy;
    check.setAttribute('aria-label', '选择收藏夹 ' + folder.title);
    row.querySelector('.folder-title').textContent = folder.title;
    row.querySelector('.folder-count').textContent = format(folder.count);
    row.querySelector('.folder-state').textContent = activeId === folder.id ? '当前查看' : '收藏夹';
    row.querySelector('.folder-name').setAttribute('aria-current', activeId === folder.id ? 'true' : 'false');
    if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
  });
  if (!folders.length) {
    container.replaceChildren(node('div', connectedUid ? '账号暂无可整理的收藏夹。' : '先连接 B 站，读取收藏夹列表。', 'empty-state'));
    if (!connectedUid) {
      const login = node('button', '打开 B 站登录', 'glass-button');
      login.onclick = guarded(() => chrome.tabs.create({ url: 'https://www.bilibili.com/' })); container.firstChild.append(login);
    }
  }
  if (focused?.isConnected && document.activeElement !== focused && !focused.disabled) focused.focus({ preventScroll: true });
  else if (focused?.matches?.('.folder-row input') && !focused.isConnected) (container.querySelector('input:not(:disabled)') || $('search')).focus({ preventScroll: true });
  $('folder-count').textContent = folders.length;
  $('selection-count').textContent = '已选 ' + selected.size + ' 个';
  $('filter-count').textContent = connectedUid ? `找到 ${visible.length} / ${folders.length} 个` : '尚未连接';
  $('select-all').textContent = `全选筛选结果（${visible.length}）`;
  $('select-entire').textContent = `选择全部收藏夹（${folders.length}）`;
  $('clear-entire').textContent = `取消所有选择（${selected.size}）`;
  $('no-match').hidden = !folders.length || visible.length > 0;
  const hidden = [...selected].filter(id => !keep.has(id)).length;
  $('hidden-selection').hidden = !hidden;
  $('hidden-selection-text').textContent = `还有 ${hidden} 个已选来源不在当前筛选结果中。`;
  $('inspect-selection').textContent = `查看全部已选（${selected.size}）`;
  $('folders-open').textContent = `收藏夹目录 · 已选 ${selected.size} 个`;
  for (const button of document.querySelectorAll('[data-filter]')) {
    const active = button.dataset.filter === filter; button.classList.toggle('current', active); button.setAttribute('aria-pressed', String(active));
  }
  renderScope(); renderActive(); updateControls();
}
function renderScope() {
  const sources = folders.filter(folder => selected.has(folder.id));
  const exact = fresh(), total = exact ? snapshot.items.length : sources.reduce((n, folder) => n + folder.count, 0);
  $('source-total').textContent = selected.size; $('selection-total').textContent = format(total);
  $('total-label').textContent = metadataStale ? '任务前数量 · 待核对' : exact ? '已读取收藏记录' : '预计收藏记录';
  $('scope-total').textContent = stage === 'preview' && plan && !lastTask ? `本次整理 ${selected.size} 个来源 · 移动 ${format(plan.itemCount)} 条${plan.retainedItems.length ? ` · 保留 ${format(plan.retainedItems.length)} 条重复记录` : ''}` :
    stage === 'preview' && lastTask ? `本次整理 ${selected.size} 个来源 · ${format(lastTask.total)} 条` :
    `本次已选 ${selected.size} 个收藏夹 · ${exact ? '' : '预计 '}${format(total)} 条${metadataStale ? '（任务前）' : ''}`;
  const visible = new Set(visibleFolders().map(folder => folder.id)), hidden = sources.filter(source => !visible.has(source.id)).length;
  $('bottom-scope').textContent = `${hidden ? `包含 ${hidden} 个筛选外来源 · ` : ''}查看全部已选来源`;
  $('source-chips').replaceChildren();
  for (const folder of sources.slice(0, 4)) {
    const chip = node('button', `${folder.title} · ${format(folder.count)} 条${visible.has(folder.id) ? '' : ' · 筛选外'}`, 'source-chip');
    chip.onclick = () => viewFolder(folder.id); $('source-chips').append(chip);
  }
  if (sources.length > 4) { const more = node('button', `另 ${sources.length - 4} 个来源`, 'source-chip'); more.onclick = showScope; $('source-chips').append(more); }
  if (!sources.length) $('source-chips').append(node('p', '勾选左侧收藏夹，加入本次整理。', 'caption muted'));
}
function renderActive() {
  const folder = folders.find(folder => folder.id === activeId);
  $('active-title').textContent = folder?.title || '查看收藏夹';
  $('active-selection').hidden = !folder;
  $('active-selection').textContent = selected.has(activeId) ? '已加入整理' : '仅查看 · 未勾选';
  const historical = folder && taskReadback?.uid === connectedUid ? taskReadback.items.filter(item => item.sourceId === folder.id) : [];
  const entry = folder && (cache.peek(connectedUid, folder.id) || (historical.length ? { items: historical, at: taskReadback.at, historical: true } : null));
  $('active-meta').textContent = folder ? `${metadataStale ? '任务前目录，待核对 · ' : ''}列表显示 ${format(folder.count)} 条${entry ? ` · ${entry.historical ? '任务前样本（非实时） · ' : ''}读取于 ${time(entry.at)}` : ''}` : '连接后点击收藏夹名称查看摘要。';
  const content = $('active-content'); content.replaceChildren();
  if (!entry) {
    content.append(node('h3', '尚未读取视频'), node('p', '生成预览后可查看已读取内容；切换与搜索不会自动扫描。'));
  } else {
    content.append(node('h3', '来源展示顺序 · 前 3 条'));
    for (const item of entry.items.slice(0, 3)) {
      const row = node('div', undefined, 'video-row'); row.append(node('span', item.title), node('time', item.publishedAt ? new Date(item.publishedAt * 1000).toLocaleDateString('zh-CN') : '发布时间未知')); content.append(row);
    }
    if (!entry.items.length) content.append(node('p', '本次读取的收藏夹为空。'));
  }
}
function viewFolder(id) {
  activeId = id; renderFolders();
  if (stage === 'preview') { $('source-dialog').append($('source-detail')); showDialog('source-dialog'); }
}
function fillSourceList(container, exactSnapshot = null) {
  container.replaceChildren(); const visible = new Set(visibleFolders().map(folder => folder.id));
  for (const folder of folders.filter(folder => selected.has(folder.id))) {
    const count = exactSnapshot ? exactSnapshot.items.filter(item => item.sourceId === folder.id).length : folder.count;
    const skipped = exactSnapshot?.items.filter(item => item.sourceId === folder.id && item.unavailable).length || 0;
    const row = node('li'); row.append(node('span', folder.title), node('span', `${format(count)} 条${skipped ? ` · ${format(skipped)} 条失效保留` : ''}${visible.has(folder.id) ? '' : ' · 筛选外'}`)); container.append(row);
  }
  if (!selected.size) container.append(node('li', '尚未选择来源。'));
}
function showScope() { fillSourceList($('scope-list'), fresh() ? snapshot : null); showDialog('scope-dialog'); }
function showDialog(id) { if (!$(id).open) $(id).showModal(); }
function openPanel(kind) {
  const panel = kind === 'directory' ? $('directory-panel') : lastTask && stage === 'preview' ? $('task-settings') : $('rules-panel');
  const id = kind === 'directory' ? 'directory-dialog' : 'rules-dialog';
  $(id).append(panel); showDialog(id);
}
function restorePanels() {
  $('directory-slot').append($('directory-panel'));
  $('rules-slot').append($('rules-panel'), $('task-settings'));
}
function setStage(next, focus = true) {
  stage = next; $('selection').hidden = stage !== 'selection'; $('preview').hidden = stage !== 'preview';
  $('generate').hidden = !!lastTask || stage === 'preview' && !!plan && fresh();
  $('review').hidden = stage !== 'preview' || !!lastTask;
  $('back').hidden = stage !== 'preview' || !!lastTask;
  $('new-task').hidden = !lastTask;
  $('page-title').textContent = stage === 'selection' ? '本次整理' : lastTask ? lastTask.phase === '完成' ? '整理完成' : lastTask.phase : '整理计划';
  $('page-desc').textContent = stage === 'selection' ? '选择与规则' : lastTask ? '执行任务' : '预览与执行';
  for (const [id, active] of [['step1', stage === 'selection'], ['step2', stage === 'preview']]) {
    $(id).className = active ? 'step-active' : 'step-rest'; $(id).removeAttribute('aria-current'); if (active) $(id).setAttribute('aria-current', 'step');
  }
  $('rules-panel').hidden = stage === 'preview' && !!lastTask;
  $('task-settings').hidden = stage !== 'preview' || !lastTask;
  if (focus && !document.querySelector('dialog[open]')) $('page-title').focus({ preventScroll: true });
  updateControls();
}
function invalidatePlan() {
  snapshot = null; plan = null;
  if (stage === 'preview' && !busy) setStage('selection', false);
}
function pageProgress(value) {
  pages++; $('scan-count').textContent = pages;
  status(`读取“${value.folder.title}”第 ${value.page} 页：${format(value.read)} / ${value.expected ?? '?'} 条。`);
}
async function connect() {
  await task(async session => {
    const loaded = await client.folders(session.uid), previous = await storage.get('selection:' + session.uid);
    cache.clear(session.uid); snapshot = null; plan = null; lastTask = null; taskReadback = null; metadataStale = false;
    connectedUid = session.uid; folders = loaded;
    const available = new Set(folders.map(folder => folder.id));
    selected = new Set((Array.isArray(previous) ? previous : []).filter(id => available.has(id)));
    activeId = available.has(activeId) ? activeId : folders[0]?.id || null;
    $('account-label').textContent = 'UID ' + connectedUid; $('connect').textContent = '刷新收藏夹列表';
    $('list-updated').textContent = '列表更新于 ' + time(Date.now());
    setStage('selection'); status(`已读取 ${folders.length} 个收藏夹。点击生成预览后才读取视频。`);
  });
}
async function generate(force = false) {
  clearFieldErrors(); const rules = readRules(true);
  if (!connectedUid || !selected.size) throw new Error('请先连接并选择源收藏夹。');
  if (force) { cache.clear(connectedUid); snapshot = null; plan = null; }
  let collected;
  await task(async session => {
    if (session.uid !== connectedUid) throw new Error('账号已变化，请重新连接。');
    collected = await cache.collect(session.uid, folders.filter(folder => selected.has(folder.id)), folder => client.resources(folder, pageProgress));
    await assertSession(session);
    if (identityDirty) throw new Error('登录状态已变化，请重新连接。');
    snapshot = collected; plan = buildPlan(snapshot.items, rules, snapshot.sources, folders);
    const counts = new Map();
    for (const item of collected.items) counts.set(item.sourceId, (counts.get(item.sourceId) || 0) + 1);
    for (const folder of folders.filter(folder => selected.has(folder.id))) folder.count = counts.get(folder.id) || 0;
    lastTask = null; taskReadback = null; metadataStale = false; await saveRules(); renderPlan();
    $('execution-panel').hidden = true; $('preview-content').hidden = false;
    setStage('preview'); status(collected.loaded ? '只读预览已生成。尚未创建收藏夹或移动视频。' : '已复用本次读取数据，没有重新扫描。');
    if (plan.renamedTargets) status($('status').textContent + ` ${plan.renamedTargets} 个目标与已有收藏夹重名，已自动添加编号；请以预览中的名称为准。`);
    if (plan.skippedItems.length) status($('status').textContent + ` ${format(plan.skippedItems.length)} 条失效收藏已跳过，将保留在原收藏夹，不会删除。${plan.itemCount ? '' : '没有可移动的视频。'}`);
    if (plan.missingDates) status($('status').textContent + ` ${plan.missingDates} 条缺少发布时间，已放在所属排序范围末尾。`);
  });
}
function renderPlan() {
  $('video-total').textContent = format(plan.itemCount); $('uploader-total').textContent = format(plan.uploaderCount); $('target-total').textContent = plan.chunks.length;
  $('duplicate-note').hidden = !plan.retainedItems.length;
  $('duplicate-note').textContent = duplicateSummary(plan);
  $('sample-time').textContent = `最早来源读取于 ${time(snapshot.at)} · 本次预览生成于 ${time(snapshot.completedAt)}。预览不按时长过期；执行前重新核对来源内容。`;
  $('unavailable-summary').hidden = !plan.skippedItems.length;
  $('unavailable-summary').textContent = `共读取 ${format(plan.recordCount)} 条收藏，其中 ${format(plan.itemCount)} 条视频将移动，${format(plan.skippedItems.length)} 条已失效${plan.retainedItems.length ? `，另有 ${format(plan.retainedItems.length)} 条重复收藏记录` : ''}。失效收藏保留在原夹，不参与分组、移动或删除。`;
  $('unavailable-details').hidden = !plan.skippedItems.length;
  $('unavailable-sources').replaceChildren();
  for (const source of plan.sources) {
    const count = source.items.filter(item => item.unavailable).length;
    if (count) $('unavailable-sources').append(node('li', `${source.title}：${format(count)} 条失效收藏，保留在原夹。`));
  }
  $('plan').replaceChildren(); shown = 0; renderMore();
}
function duplicateSummary(value) {
  return value.retainedItems.length ? `重复视频按左侧列表顺序只移动第一份有效副本；其余 ${format(value.retainedItems.length)} 条重复收藏记录保留在各自源收藏夹。` : '';
}
function renderMore() {
  const end = Math.min(shown + 50, plan.chunks.length);
  for (const chunk of plan.chunks.slice(shown, end)) {
    const card = node('article', undefined, 'plan-card'), top = node('div', undefined, 'plan-top'), name = node('div', undefined, 'plan-name');
    name.append(icon('folder'), node('h3', chunk.name)); top.append(name, node('span', `${format(chunk.items.length)} / ${format(plan.rules.capacity)} 条`));
    const track = node('div', undefined, 'capacity-track'), fill = node('span'); fill.style.width = chunk.items.length / plan.rules.capacity * 100 + '%'; track.append(fill);
    const ups = new Map(); for (const item of chunk.items) ups.set(item.uploaderName, (ups.get(item.uploaderName) || 0) + 1);
    const details = node('details', undefined, 'video-detail'); details.append(node('summary', '查看前 3 条视频的展示顺序'));
    for (const item of chunk.items.slice(0, 3)) {
      const row = node('div', undefined, 'video-row'); row.dataset.publishedAt = item.publishedAt;
      row.append(node('span', item.title), node('time', item.publishedAt ? new Date(item.publishedAt * 1000).toLocaleDateString('zh-CN') : '发布时间未知')); details.append(row);
    }
    card.append(top, track, node('p', [...ups].map(([name, n]) => `${name} ${n}条`).join(' · '), 'uploader-list'), details); $('plan').append(card);
  }
  shown = end; $('load-more').hidden = shown === plan.chunks.length; $('load-more').textContent = `显示更多分组（${shown}/${plan.chunks.length}）`;
}
function cancel() { $('confirm').close(); status('已取消，预览已保留。没有创建收藏夹、移动视频或刷新页面。'); }
function review() {
  if (!fresh() || !plan?.itemCount) throw new Error('预览已失效或没有可移动的视频，请检查来源并重新生成预览。');
  const r = plan.rules; fillSourceList($('confirm-sources'), snapshot);
  $('confirm-title').textContent = `确认移动 ${format(plan.itemCount)} 条？`;
  $('confirm-summary').textContent = `${selected.size} 个来源 · ${format(plan.itemCount)} 条可移动视频 → ${plan.chunks.length} 个${r.privacy === 'private' ? '私密' : '公开'}收藏夹。${plan.skippedItems.length ? `另有 ${format(plan.skippedItems.length)} 条失效收藏保留在原夹，不会删除。` : ''}执行前将重新读取并核对来源，期间不会创建或移动。`;
  $('confirm-summary').textContent += duplicateSummary(plan);
  $('confirm-rules').textContent = `${ruleSummary(r)}。目标：${plan.chunks.map(chunk => chunk.name).slice(0, 4).join('、')}${plan.chunks.length > 4 ? ' 等' : ''}。`;
  $('execute').textContent = `确认移动 ${format(plan.itemCount)} 条`; showDialog('confirm');
}
function renderLocations(state, sources) {
  const locations = [...sources.map(folder => ({ ...folder, kind: '来源' })), ...(state.created || []).map(folder => ({ ...folder, kind: '目标' })), ...(state.buffer ? [{ ...state.buffer, kind: '私密中转夹' }] : [])];
  $('location-links').replaceChildren();
  for (const folder of locations) {
    const link = node('a', `${folder.kind}：${folder.title}`); link.href = `https://space.bilibili.com/${taskUid}/favlist?fid=${encodeURIComponent(folder.id)}&ftype=create`;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; $('location-links').append(link);
  }
  $('task-locations').hidden = !locations.length;
  $('location-note').textContent = state.phase === '完成' ? '目标和来源均已核对。如有空私密中转夹，可前往 B 站自行删除。' : '中断时请同时核对来源、目标及中转夹。不要删除仍含视频的中转夹。';
}
function executionProgress(state) {
  lastTask = state;
  $('execution-panel').hidden = false; $('preview-content').hidden = true;
  $('execution-title').textContent = state.phase; $('page-title').textContent = state.phase;
  $('progress-text').textContent = `${format(state.confirmed)} / ${format(state.total)} 条`;
  $('verified-text').textContent = `${format(state.verified)} / ${format(state.total)} 条`;
  for (const [key, count, bar] of [['submitted-progress', state.confirmed, 'progress-bar'], ['verified-progress', state.verified, 'verified-bar']]) {
    const percent = state.total ? Math.min(100, count / state.total * 100) : 0;
    $(bar).style.width = percent + '%'; $(key).setAttribute('aria-valuenow', Math.round(percent)); $(key).setAttribute('aria-valuetext', `${count} / ${state.total} 条`);
  }
  $('execution-target').textContent = state.phase === '完成' ? '全部目标与来源归属已核对' : state.target ? `当前目标：${state.target}` : '正在准备本次整理';
  $('submitted-hint').textContent = state.phase === '完成' ? '全部目标已完成核对' : state.phase === '核对来源归属' ? '目标已提交，正在检查来源' : '仍需完整核对，可能校正';
  $('execution-message').textContent = state.detail;
  $('execution-meta').textContent = `已用时 ${Math.floor((Date.now() - taskStarted) / 1000)} 秒 · 移动请求 ${state.moveRequests || 0} 次`;
  const phase = state.phase === '完成' ? 'done' : state.phase === '核对来源归属' ? 'sources' : state.target ? 'transfer' : 'prepare';
  let previous = true;
  for (const step of $('task-steps').children) {
    const active = step.dataset.phase === phase; step.classList.toggle('done', previous && !active); step.removeAttribute('aria-current');
    if (active) { step.setAttribute('aria-current', 'step'); previous = false; }
  }
  const now = Date.now();
  if (announcedPhase !== state.phase || now - lastAnnouncement >= 2000) {
    status(`${state.phase}：已提交 ${format(state.confirmed)} 条，已完整核对 ${format(state.verified)} 条。`); announcedPhase = state.phase; lastAnnouncement = now;
  }
}
async function execute() {
  if (!fresh() || !plan?.itemCount) { $('confirm').close(); throw new Error('预览已失效或没有可移动的视频，请重新生成。'); }
  const approved = plan, originalSnapshot = snapshot, sources = folders.filter(folder => selected.has(folder.id)).map(folder => ({ ...folder }));
  taskReadback = originalSnapshot; taskUid = originalSnapshot.uid;
  $('confirm').close(); taskStarted = Date.now(); announcedPhase = ''; $('pending-message').hidden = true;
  $('execution-state').textContent = '进行中'; $('execution-message').className = 'task-explanation';
  executionProgress({ phase: '准备执行', confirmed: 0, verified: 0, total: approved.itemCount, moveRequests: 0, detail: '正在核对登录状态与执行计划…' });
  $('task-scope-summary').textContent = `${sources.length} 个来源 · ${format(approved.itemCount)} 条 → ${approved.chunks.length} 个目标。${duplicateSummary(approved)}`;
  $('task-rule-summary').textContent = ruleSummary(approved.rules); setStage('preview', false);
  try {
    await task(async session => {
      if (session.uid !== originalSnapshot.uid || !fresh(originalSnapshot)) throw new Error('账号或预览已变化，请重新生成。');
      snapshot = null; cache.clear(connectedUid); metadataStale = true;
      const result = await executePlan(client, approved, { onProgress: state => { executionProgress(state); renderLocations(state, sources); },
        assertFresh: async () => { if (identityDirty) throw new Error('登录状态已变化，已停止任务。'); await assertSession(session); } });
      folders = result.folders; metadataStale = false;
      executionProgress({ ...result, phase: '完成', detail: `已移动并核对 ${format(result.verified)} 条，共 ${format(result.moveRequests)} 次移动请求（含中转和校正）。${result.retained ? ` ${format(result.retained)} 条重复收藏记录已保留在原夹。` : ''}${result.skipped ? ` ${format(result.skipped)} 条失效收藏已保留在原夹，未删除。` : ''}${result.buffer ? ` 空私密中转夹“${result.buffer.title}”已保留，可在 B 站自行删除。` : ''}` });
      $('execution-title').textContent = '整理完成'; $('page-title').textContent = '整理完成'; $('execution-state').textContent = '已完成';
      $('execution-message').classList.add('success'); $('list-updated').textContent = '列表更新于 ' + time(Date.now());
      status(`整理完成：已移动并核对 ${format(result.verified)} 条，来源归属检查通过。${result.retained ? `${format(result.retained)} 条重复收藏记录已保留在原夹。` : ''}${result.skipped ? `${format(result.skipped)} 条失效收藏已保留在原夹，未删除。` : ''}再次整理需要生成新预览。`);
    });
  } catch (error) {
    executionProgress({ ...(error.state || lastTask), phase: '任务已停止', detail: error.message });
    renderLocations(error.state || lastTask, sources);
    $('execution-title').textContent = '任务已停止'; $('page-title').textContent = '任务已停止'; $('execution-state').textContent = '已停止';
    $('execution-message').textContent = error.message;
    if (error.state?.pending) { $('pending-message').hidden = false; $('pending-message').textContent = `当前批次 ${error.state.pending} 条的实际状态待核对，请先查看视频位置，不要重复执行旧计划。`; }
    snapshot = null; cache.clear(connectedUid); status('任务已停止。已完成的移动不会自动撤销，请核对本次视频位置。'); throw error;
  } finally {
    $('sample-time').textContent = '预览已失效'; setStage('preview', false); renderFolders();
  }
}
function updateCooldown() {
  const seconds = Math.max(0, Math.ceil((queue.cooldownUntil - Date.now()) / 1000));
  $('cooldown-panel').hidden = !seconds;
  if (seconds) $('cooldown-text').textContent = `至少 ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} 后才允许再次尝试。`;
  updateControls();
}
function resetIdentity() {
  folderSelection.cancel();
  folders = []; selected.clear(); activeId = null; connectedUid = null; snapshot = null; plan = null; taskReadback = null; cache.clear(null);
  $('account-label').textContent = '登录已变化'; $('connect').textContent = '连接并读取列表';
  renderFolders(); status('登录状态已变化，请重新连接；旧预览不能再次执行。');
}
async function openFavorites() {
  const session = await getSession(); await chrome.tabs.create({ url: `https://space.bilibili.com/${session.uid}/favlist` });
}
async function changeScope(mode) {
  if (busy) return;
  folderSelection.cancel();
  const scope = mode === 'all' || mode === 'clear' ? folders : visibleFolders();
  for (const folder of scope) { if (mode === 'all' || mode === 'visible') selected.add(folder.id); else selected.delete(folder.id); }
  $('scope-menu').open = false; invalidatePlan(); renderFolders(); await saveSelection();
}
function newTask() { if (busy) return; folderSelection.cancel(); lastTask = null; taskReadback = null; plan = null; snapshot = null; $('error').textContent = ''; setStage('selection'); renderFolders(); status('请选择来源并生成新预览。'); }
function rulesChanged() {
  if (busy) return; folderSelection.cancel(); clearFieldErrors(); invalidatePlan(); syncRules(); renderScope(); void saveRules();
}
folderSelection = attachFolderSelection($('folders'), {
  enabled: () => !!connectedUid && !busy,
  getSelected: () => selected,
  onPreview: next => {
    selected = next;
    for (const row of $('folders').querySelectorAll('.folder-row')) {
      const checked = selected.has(row.dataset.folderId);
      row.querySelector('input').checked = checked; row.classList.toggle('selected', checked);
    }
    $('selection-count').textContent = '已选 ' + selected.size + ' 个';
    $('folders-open').textContent = `收藏夹目录 · 已选 ${selected.size} 个`;
    renderScope(); renderActive(); updateControls();
    if (Date.now() - lastFolderAnnouncement > 250) {
      status(`正在框选：已选 ${selected.size} 个收藏夹。松开鼠标确认，Esc 撤销本次框选。`); lastFolderAnnouncement = Date.now();
    }
  },
  onFinish: ({ changed, cancelled }) => {
    if (changed) { invalidatePlan(); void saveSelection().catch(report); }
    renderFolders();
    status(`${cancelled ? '已撤销本次框选，保留原选择。' : ''}已选 ${selected.size} 个收藏夹。框选只修改整理范围，没有读取或移动视频。`);
  },
});
$('connect').onclick = guarded(connect); $('generate').onclick = guarded(() => generate()); $('refresh').onclick = guarded(() => generate(true));
$('review').onclick = guarded(review); $('execute').onclick = guarded(execute); $('cancel').onclick = cancel;
$('confirm').addEventListener('cancel', event => { event.preventDefault(); cancel(); });
$('search').oninput = renderFolders;
$('clear-search').onclick = () => { $('search').value = ''; renderFolders(); $('search').focus(); };
$('reset-filter').onclick = () => { $('search').value = ''; filter = 'all'; renderFolders(); $('search').focus(); };
for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => { filter = button.dataset.filter; renderFolders(); };
$('select-all').onclick = guarded(() => changeScope('visible')); $('select-none').onclick = guarded(() => changeScope('remove'));
$('select-entire').onclick = guarded(() => changeScope('all')); $('clear-entire').onclick = guarded(() => changeScope('clear'));
for (const id of ['inspect-selection', 'scope-open', 'bottom-scope']) $(id).onclick = showScope;
$('group-enabled').onchange = rulesChanged;
$('keep-uploader').onchange = () => { keepPreference = $('keep-uploader').checked; rulesChanged(); };
for (const element of document.querySelectorAll('#rules-panel select, #rules-panel input:not([type=checkbox])')) element.addEventListener('change', rulesChanged);
$('reset-rules').onclick = guarded(async () => { clearFieldErrors(); applyRules(DEFAULT_RULES); invalidatePlan(); await saveRules(); status('已恢复默认规则，有效来源数据可继续复用。'); });
$('back').onclick = () => { $('error').textContent = ''; setStage('selection'); status(fresh() ? '修改规则可复用已读取的数据。' : '请生成新预览。'); };
$('new-task').onclick = newTask; $('load-more').onclick = renderMore; $('nav-entry').onclick = guarded(openFavorites);
$('nav-help').onclick = () => showDialog('help-dialog');
$('folders-open').onclick = () => openPanel('directory'); $('rules-open').onclick = () => openPanel('rules');
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
for (const id of ['directory-dialog', 'rules-dialog']) $(id).addEventListener('close', restorePanels);
$('source-dialog').addEventListener('close', () => $('selection').append($('source-detail')));
$('clear-settings').onclick = guarded(async () => {
  if (busy) return;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter(key => key === 'rules' || key.startsWith('selection:')));
  applyRules(DEFAULT_RULES); selected.clear(); cache.clear(connectedUid); snapshot = null; plan = null; lastTask = null; taskReadback = null;
  setStage('selection', false); renderFolders(); status('已清除保存设置，接口冷却状态保留。');
});
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('resize', () => {
  for (const id of ['directory-dialog', 'rules-dialog']) if ($(id).open) $(id).close();
});
window.addEventListener('focus', () => { queue.cooldown().then(updateCooldown).catch(report); });
chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && changes[COOLDOWN_KEY]) { queue.cooldownUntil = Number(changes[COOLDOWN_KEY].newValue) || 0; updateCooldown(); } });
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (!(cookie.domain === 'bilibili.com' || cookie.domain.endsWith('.bilibili.com')) || !['DedeUserID', 'bili_jct'].includes(cookie.name)) return;
  identityDirty = true; snapshot = null; plan = null; cache.clear(null);
  if (!busy) resetIdentity(); else status('登录状态已变化，任务将在下一次请求前停止。');
});
(async () => {
  try { applyRules(await storage.get('rules') || DEFAULT_RULES); } catch { applyRules(DEFAULT_RULES); }
  await queue.cooldown(); renderFolders(); setStage('selection', false); updateCooldown();
  try { await getSession(); $('account-label').textContent = '已登录 · 点击连接'; } catch { $('account-label').textContent = '未登录 B 站'; }
  setInterval(updateCooldown, 1000);
})().catch(report);
