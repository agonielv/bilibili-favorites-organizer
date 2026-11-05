import { TransferEngine } from './transfer.js';
export class ExecutionError extends Error {
  constructor(message, state, cause) { super(message, { cause }); this.name = 'ExecutionError'; this.state = state; }
}
export async function executePlan(client, plan, { onProgress = () => {}, assertFresh = async () => {} } = {}) {
  const state = { confirmed: 0, verified: 0, total: plan.itemCount, created: [], buffer: null, pending: 0,
    moveRequests: 0, batchRequests: 0, target: null, phase: '准备目标收藏夹' };
  try {
    await assertFresh();
    const folders = await client.folders();
    const sourceCounts = new Map();
    for (const chunk of plan.chunks) for (const item of chunk.items) sourceCounts.set(item.sourceId, (sourceCounts.get(item.sourceId) || 0) + 1);
    for (const [id, expected] of sourceCounts) {
      const source = folders.find(folder => folder.id === id);
      if (!source || source.count !== expected) throw new Error('源收藏夹数量已变化，请重新读取并核对计划。');
    }
    const names = new Set(folders.map(folder => folder.title.trim().toLowerCase()));
    for (const chunk of plan.chunks) if (names.has(chunk.name.toLowerCase())) throw new Error(`目标“${chunk.name}”已存在。请修改基础名称，避免混入旧内容或改变已有收藏夹。`);
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
    for (const source of after.filter(folder => sourceCounts.has(folder.id) && folder.count > 0)) {
      await assertFresh();
      const remaining = await client.resources(source);
      if (remaining.some(item => plannedKeys.has(`${item.id}:${item.type}`))) throw new Error('部分计划视频仍在原收藏夹，未把复制或部分成功误认为移动完成。请核对来源与目标。');
    }
    state.phase = '完成';
    onProgress({ ...state, detail: `已移动并核对 ${state.verified} 条，移动请求 ${state.moveRequests} 次。${state.buffer ? `空私密中转夹“${state.buffer.title}”已保留，可自行删除。` : ''}` });
    return state;
  } catch (cause) {
    const message = `${cause.message} 已提交 ${state.confirmed}/${state.total} 条、已核对 ${state.verified} 条。${state.pending ? `当前批次 ${state.pending} 条的实际状态需要核对。` : ''}本轮创建 ${state.created.length} 个目标。${state.buffer ? `请同时核对私密中转夹“${state.buffer.title}”（ID ${state.buffer.id}），不要删除其中尚有的视频。` : ''}已完成的移动不会自动撤销。`;
    throw new ExecutionError(message, { ...state, created: [...state.created] }, cause);
  }
}
