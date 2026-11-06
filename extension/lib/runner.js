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
  const state = { confirmed: 0, verified: 0, total: plan.itemCount, skipped: plan.skippedItems.length, created: [], buffer: null, pending: 0,
    moveRequests: 0, batchRequests: 0, target: null, phase: '准备目标收藏夹' };
  try {
    await assertFresh();
    if (!plan.itemCount) throw new Error('没有可移动的视频；失效收藏已保留在原收藏夹。');
    const folders = await client.folders();
    const sourceIds = new Set(plan.sources.map(source => source.id));
    for (const expected of plan.sources) {
      const source = folders.find(folder => folder.id === expected.id);
      if (!source || source.count !== expected.items.length) throw new Error('源收藏夹数量已变化，请重新读取并核对计划。');
    }
    const names = new Set(folders.map(folder => folder.title.trim().toLowerCase()));
    for (const chunk of plan.chunks) if (names.has(chunk.name.toLowerCase())) throw new Error(`目标“${chunk.name}”已存在。请修改基础名称，避免混入旧内容或改变已有收藏夹。`);
    // Preview/cache age cannot safely determine freshness during a long scan.
    // Re-read every source before creating anything, including skipped records,
    // so same-count replacements and changed availability are caught as well.
    state.phase = '核对来源内容';
    for (const [index, source] of plan.sources.entries()) {
      await assertFresh();
      onProgress({ ...state, detail: `执行前核对来源 ${index + 1}/${plan.sources.length}：“${source.title}”。尚未创建或移动。` });
      const actual = await client.resources(source, page => onProgress({ ...state,
        detail: `核对“${source.title}”第 ${page.page} 页：${page.read}/${page.expected} 条。尚未创建或移动。` }));
      if (!matchesSource(actual, source.items)) throw new Error(`源收藏夹“${source.title}”的内容或视频状态已变化，请重新读取源视频并核对计划。尚未创建或移动。`);
    }
    state.phase = '准备目标收藏夹';
    for (const chunk of plan.chunks) {
      await assertFresh(); onProgress({ ...state, detail: `准备 ${chunk.name}` });
      state.created.push(await client.create(chunk.name, plan.rules.privacy)); names.add(chunk.name.toLowerCase());
    }
    const engine = new TransferEngine(client, state, { assertFresh, onProgress, reservedNames: names });
    for (let index = 0; index < plan.chunks.length; index++) {
      state.target = state.created[index].title;
      await engine.process(plan.chunks[index], state.created[index]);
    }
    state.phase = '核对来源归属';
    onProgress({ ...state, detail: '确认已计划移动的视频没有遗留在原来源。' });
    await assertFresh();
    const after = await client.folders();
    const plannedKeys = new Set(plan.chunks.flatMap(chunk => chunk.items.map(item => `${item.id}:${item.type}`)));
    for (const source of after.filter(folder => sourceIds.has(folder.id) && folder.count > 0)) {
      await assertFresh();
      const remaining = await client.resources(source);
      const retained = new Set(plan.skippedItems.filter(item => item.sourceId === source.id).map(resourceKey));
      if (remaining.some(item => plannedKeys.has(resourceKey(item)) && !retained.has(resourceKey(item)))) throw new Error('部分计划视频仍在原收藏夹，未把复制或部分成功误认为移动完成。请核对来源与目标。');
    }
    state.phase = '完成';
    onProgress({ ...state, detail: `已移动并核对 ${state.verified} 条，移动请求 ${state.moveRequests} 次。${state.skipped ? `${state.skipped} 条失效收藏已跳过并保留在原夹。` : ''}${state.buffer ? `空私密中转夹“${state.buffer.title}”已保留，可自行删除。` : ''}` });
    // The UI can update counts without issuing another list or video scan.
    return { ...state, folders: after };
  } catch (cause) {
    const message = `${cause.message} 已提交 ${state.confirmed}/${state.total} 条、已核对 ${state.verified} 条。${state.pending ? `当前批次 ${state.pending} 条的实际状态需要核对。` : ''}本轮创建 ${state.created.length} 个目标。${state.buffer ? `请同时核对私密中转夹“${state.buffer.title}”（ID ${state.buffer.id}），不要删除其中尚有的视频。` : ''}已完成的移动不会自动撤销。`;
    throw new ExecutionError(message, { ...state, created: [...state.created] }, cause);
  }
}
