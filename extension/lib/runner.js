import { TransferEngine, resourceKey } from './transfer.js';
function matchesSource(actual, expected) {
  const wanted = new Map(expected.map(item => [resourceKey(item), item]));
  const observed = new Set(actual.map(resourceKey));
  const fields = ['title', 'uploaderId', 'uploaderName', 'publishedAt', 'favoredAt'];
  return wanted.size === expected.length && observed.size === actual.length && actual.length === expected.length && actual.every(item => {
    const previous = wanted.get(resourceKey(item));
    return previous && !!item.unavailable === !!previous.unavailable && fields.every(field => item[field] === previous[field]);
  });
}
export class ExecutionError extends Error {
  constructor(message, state, cause) { super(message, { cause }); this.name = 'ExecutionError'; this.state = state; }
}
export async function executePlan(client, plan, { onProgress = () => {}, assertFresh = async () => {} } = {}) {
  const state = { confirmed: 0, verified: 0, total: plan.itemCount, skipped: plan.skippedItems.length, retained: plan.retainedItems.length, created: [], buffer: null, pending: 0,
    sourceRenamed: [], pendingRename: null, moveRequests: 0, batchRequests: 0, target: null, phase: '准备目标收藏夹' };
  try {
    await assertFresh();
    if (!plan.itemCount) throw new Error('没有可移动的视频；失效收藏已保留在原收藏夹。');
    const folders = await client.folders();
    for (const expected of plan.sources) {
      const source = folders.find(folder => folder.id === expected.id);
      if (!source) throw new Error('源收藏夹已不存在，请重新读取并核对计划。');
    }
    const names = new Set(folders.map(folder => folder.title.trim().toLowerCase()));
    const inheritedIds = new Set();
    for (const chunk of plan.chunks) {
      if (chunk.inheritedFrom) {
        const source = plan.sources.find(folder => folder.id === chunk.inheritedFrom), actual = folders.find(folder => folder.id === chunk.inheritedFrom);
        if (!source || source.title !== chunk.name || actual?.title !== source.title) throw new Error('来源收藏夹名称已变化，请重新生成名称继承预览。');
        inheritedIds.add(source.id);
      } else if (names.has(chunk.name.toLowerCase())) throw new Error(`目标“${chunk.name}”已存在。请修改基础名称，避免混入旧内容或改变已有收藏夹。`);
    }
    for (const rename of plan.sourceRenames || []) {
      if (!inheritedIds.has(rename.id) || !plan.sources.some(source => source.id === rename.id && source.title === rename.from)) throw new Error('来源改名计划无效，请重新生成预览。');
      if (names.has(rename.to.trim().toLowerCase())) throw new Error(`旧收藏夹名称“${rename.to}”已被占用，请重新生成预览。`);
    }
    // Preview/cache age cannot safely determine freshness during a long scan.
    // Re-read every source before creating anything, including skipped records,
    // so same-count replacements and changed availability are caught as well.
    state.phase = '核对来源内容';
    for (const [index, source] of plan.sources.entries()) {
      await assertFresh();
      const reading = { kind: 'preflight', source: { id: source.id, title: source.title }, read: 0, expected: source.items.length, step: 'start' };
      onProgress({ ...state, reading, detail: `执行前核对来源 ${index + 1}/${plan.sources.length}：“${source.title}”。尚未创建或移动。` });
      const actual = await client.resources(source, page => onProgress({ ...state,
        reading: { ...reading, ...page, step: 'page' },
        detail: `核对“${source.title}”第 ${page.page} 页：${page.read}/${page.expected} 条。尚未创建或移动。` }));
      if (actual.length !== source.items.length) throw new Error(`源收藏夹“${source.title}”数量已变化，请重新读取并核对计划。尚未创建或移动。`);
      if (!matchesSource(actual, source.items)) throw new Error(`源收藏夹“${source.title}”的内容或视频状态已变化，请重新读取源视频并核对计划。尚未创建或移动。`);
      onProgress({ ...state, reading: { ...reading, read: actual.length, step: 'complete' }, detail: `已核对来源 ${index + 1}/${plan.sources.length}：“${source.title}”。尚未创建或移动。` });
    }
    const metadata = new Map();
    if (inheritedIds.size) state.phase = '核对名称与设置';
    for (const id of inheritedIds) {
      await assertFresh();
      const source = plan.sources.find(folder => folder.id === id);
      onProgress({ ...state, detail: `正在核对名称与设置 ${metadata.size + 1}/${inheritedIds.size}：“${source.title}”。尚未改名、创建或移动。` });
      const info = await client.folderInfo(source);
      if (info.title !== source.title) throw new Error('来源收藏夹名称已变化，请重新生成名称继承预览。');
      metadata.set(id, info);
    }
    state.phase = '更新旧收藏夹名称';
    for (const rename of plan.sourceRenames || []) {
      await assertFresh(); state.pendingRename = { ...rename };
      onProgress({ ...state, detail: `旧收藏夹“${rename.from}”将改名为“${rename.to}”。` });
      await client.rename({ id: rename.id, title: rename.from }, rename.to, metadata.get(rename.id));
      await assertFresh(); const actual = await client.folderInfo({ id: rename.id, title: rename.to }), previous = metadata.get(rename.id);
      if (actual.title !== rename.to || ['privacy','intro','cover'].some(field => actual[field] !== previous[field])) throw new Error('旧收藏夹改名或设置核对未通过，请检查实际名称、可见性、简介及封面。');
      state.sourceRenamed.push({ ...rename }); state.pendingRename = null; names.add(rename.to.trim().toLowerCase());
      onProgress({ ...state, detail: `旧收藏夹已改名为“${rename.to}”，其他设置已保留。` });
    }
    state.phase = '准备目标收藏夹';
    const folderIds = new Set(folders.map(folder => folder.id));
    for (const chunk of plan.chunks) {
      await assertFresh(); onProgress({ ...state, detail: `准备 ${chunk.name}` });
      const created = await client.create(chunk.name, plan.rules.privacy);
      if (folderIds.has(created.id)) throw new Error('创建接口返回了已有收藏夹 ID，已停止，不会向已有收藏夹移动视频。');
      folderIds.add(created.id); state.created.push(created); names.add(chunk.name.toLowerCase());
    }
    const engine = new TransferEngine(client, state, { assertFresh, onProgress, reservedNames: names, reservedIds: folderIds });
    for (let index = 0; index < plan.chunks.length; index++) {
      state.target = state.created[index].title;
      await engine.process(plan.chunks[index], state.created[index]);
    }
    state.phase = '核对来源归属';
    onProgress({ ...state, detail: '核对视频已移出指定来源，其他来源的重复副本和失效收藏仍保留。' });
    await assertFresh();
    const after = await client.folders();
    for (const rename of state.sourceRenamed) {
      const source = after.find(folder => folder.id === rename.id);
      if (source && source.title !== rename.to) {
        await assertFresh(); const actual = await client.folderInfo(source);
        if (actual.title !== rename.to) throw new Error('旧收藏夹名称在整理期间发生变化，请核对实际名称。');
        source.title = actual.title;
      }
    }
    const movedBySource = new Map(), retainedBySource = new Map();
    for (const chunk of plan.chunks) for (const item of chunk.items) {
      if (!movedBySource.has(item.sourceId)) movedBySource.set(item.sourceId, new Set());
      movedBySource.get(item.sourceId).add(resourceKey(item));
    }
    for (const item of [...plan.skippedItems, ...plan.retainedItems]) {
      if (!retainedBySource.has(item.sourceId)) retainedBySource.set(item.sourceId, new Set());
      retainedBySource.get(item.sourceId).add(resourceKey(item));
    }
    for (const original of plan.sources) {
      const source = after.find(folder => folder.id === original.id), moved = movedBySource.get(original.id), retained = retainedBySource.get(original.id) || new Set();
      if (!source) throw new Error('源收藏夹已变化，无法确认视频归属，请核对来源与目标。');
      await assertFresh();
      const reading = { kind: 'sources', source, read: 0, expected: source.count, step: 'start' };
      onProgress({ ...state, reading, detail: `正在检查“${source.title}”的剩余收藏。` });
      const remaining = await client.resources(source, page => onProgress({ ...state,
        reading: { ...reading, ...page, step: 'page' }, detail: `检查“${source.title}”第 ${page.page} 页：${page.read}/${page.expected} 条。` }));
      if (remaining.some(item => moved?.has(resourceKey(item)))) throw new Error('部分计划视频仍在原收藏夹，未把复制或部分成功误认为移动完成。请核对来源与目标。');
      const remainingKeys = new Set(remaining.map(resourceKey));
      if ([...retained].some(key => !remainingKeys.has(key))) throw new Error('应保留在来源的重复副本或失效收藏发生变化，请核对来源与目标。');
      // Directory counts may lag a completed write. Only an actual content read
      // proves absence, including folders the directory currently calls empty.
      source.count = remaining.length;
      onProgress({ ...state, reading: { ...reading, read: remaining.length, step: 'complete' }, detail: `“${source.title}”的移动与保留归属已核对。` });
    }
    state.phase = '完成';
    onProgress({ ...state, detail: `已移动并核对 ${state.verified} 条，移动请求 ${state.moveRequests} 次。${state.retained ? `${state.retained} 条重复收藏记录已保留在原夹。` : ''}${state.skipped ? `${state.skipped} 条失效收藏已跳过并保留在原夹。` : ''}${state.buffer ? `空私密中转夹“${state.buffer.title}”已保留，可自行删除。` : ''}` });
    // The UI can update counts without issuing another list or video scan.
    return { ...state, folders: after };
  } catch (cause) {
    const renameStatus = state.sourceRenamed.length || state.pendingRename ? `本轮已核对改名 ${state.sourceRenamed.length} 个旧收藏夹。${state.pendingRename ? `当前改名“${state.pendingRename.from} → ${state.pendingRename.to}”（ID ${state.pendingRename.id}）的实际结果待核对，不会自动重试。` : ''}已完成的改名不会自动撤销。` : '';
    const message = `${cause.message} 已提交 ${state.confirmed}/${state.total} 条、已核对 ${state.verified} 条。${state.pending ? `当前批次 ${state.pending} 条的实际状态需要核对。` : ''}本轮创建 ${state.created.length} 个目标。${renameStatus}${state.buffer ? `请同时核对私密中转夹“${state.buffer.title}”（ID ${state.buffer.id}），不要删除其中尚有的视频。` : ''}已完成的移动不会自动撤销。`;
    throw new ExecutionError(message, { ...state, created: [...state.created] }, cause);
  }
}
