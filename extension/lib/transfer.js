import { moveOperations } from './planner.js';
export const BATCH_SIZES = Object.freeze([2, 20, 100]);
export const resourceKey = item => `${item.id}:${item.type}`;
const keys = items => items.map(resourceKey);
export function sameOrder(actual, expected) { return actual.length === expected.length && actual.every((item, i) => resourceKey(item) === resourceKey(expected[i])); }
function assertMembers(actual, expected, label) {
  const wanted = new Set(keys(expected)), observed = new Set(keys(actual));
  if (observed.size !== actual.length || wanted.size !== expected.length || actual.length !== expected.length || actual.some(item => !wanted.has(resourceKey(item)))) throw new Error(`${label}的视频归属或数量异常，已停止；不会移动计划外视频。`);
}
function groupsBySource(items) {
  const groups = new Map();
  for (const item of items) { if (!groups.has(item.sourceId)) groups.set(item.sourceId, []); groups.get(item.sourceId).push(item); }
  return [...groups].map(([sourceId, items]) => ({ sourceId, items }));
}
export function shouldStage(items) {
  if (items.length < 40) return false;
  const direct = moveOperations(items, 100).length;
  const grouped = groupsBySource(items).reduce((n, op) => n + Math.ceil(op.items.length / 100), 0);
  // Includes extra buffer membership scans, writes and conservative startup overhead.
  return 2 * direct > (2 * (grouped + Math.ceil(items.length / 100)) + Math.ceil(items.length / 20) + 8) * 1.15;
}
class UnsupportedBatch extends Error {}
export class TransferEngine {
  constructor(client, state, { assertFresh, onProgress, reservedNames, reservedIds }) {
    Object.assign(this, { client, state, assertFresh, onProgress, reservedNames, reservedIds });
    this.orderBulk = true; this.sizeIndex = 0; this.membershipCap = 100; this.orientation = 'write';
    this.buffer = null; this.looseIndex = 0;
  }
  notify(phase, detail) { this.state.phase = phase; this.onProgress({ ...this.state, detail }); }
  async read(folder, { kind = 'positions', expected = null } = {}) {
    await this.assertFresh();
    const reading = { kind, source: { id: folder.id, title: folder.title }, expected, read: 0, step: 'start' };
    const emit = (update, detail) => this.onProgress({ ...this.state, reading: { ...reading, ...update }, detail });
    emit({}, `正在读取“${folder.title}”的所有分页。`);
    const actual = await this.client.resources(folder, page => emit({ ...page, step: 'page' },
      `读取“${folder.title}”第 ${page.page} 页：${page.read}/${page.expected} 条。`));
    // Target verification completes only after the caller has compared every ID
    // and position (and any repair has finished), not when the last page arrives.
    if (kind !== 'targets') emit({ step: 'complete', read: actual.length }, `“${folder.title}”的所有分页已读取，继续核对。`);
    return actual;
  }
  async head(folder) {
    await this.assertFresh();
    if (this.client.inspect) return this.client.inspect(folder);
    const items = await this.read(folder); return { items: items.slice(0, 20), count: items.length };
  }
  async send(sourceId, target, items, ordered = false) {
    await this.assertFresh();
    this.state.pending = items.length;
    this.state.moveRequests++;
    if (items.length > 1) this.state.batchRequests++;
    await this.client.move({ sourceId, items: ordered && this.orientation === 'display' ? [...items].reverse() : items }, target.id);
    this.state.pending = 0;
  }
  async ensureBuffer() {
    if (this.buffer) return this.buffer;
    let name = `整理中转-${Date.now().toString(36)}`;
    while (this.reservedNames.has(name.toLowerCase())) name += 'x';
    this.notify('准备私密中转夹', '需要中转或校正排序；仅处理本次计划内的视频。');
    await this.assertFresh();
    const created = await this.client.create(name, 'private');
    if (this.reservedIds.has(created.id)) throw new Error('中转夹创建接口返回了已有收藏夹 ID，已停止，不会改动该收藏夹。');
    this.reservedIds.add(created.id); this.buffer = created;
    this.state.buffer = { ...this.buffer };
    this.reservedNames.add(name.toLowerCase());
    return this.buffer;
  }
  async sourceContains(sourceId, items) {
    const actual = new Set(keys(await this.read({ id: sourceId, title: '来源核对' })));
    if (items.some(item => !actual.has(resourceKey(item)))) throw new Error('部分视频不在预期来源中，已停止以避免重复移动。');
  }
  // Unordered transfers are only used inside this task's private buffer.
  // Explicit batch rejections may be partial: observe both locations before splitting.
  async looseOperation(sourceId, destination, items, allowed, attempt) {
    if (attempt) attempt.count++;
    try { await this.send(sourceId, destination, items); }
    catch (error) {
      if (error.rateLimited || error.ambiguousWrite || !error.rejected || error.code !== -400 || items.length === 1) throw error;
      const actual = await this.read(destination);
      if (actual.some(item => !allowed.has(resourceKey(item)))) throw new Error('中转夹出现计划外内容，已停止。');
      const present = new Set(keys(actual));
      const remaining = items.filter(item => !present.has(resourceKey(item)));
      const source = new Set(keys(await this.read({ id: sourceId, title: '来源核对' })));
      if (items.some(item => present.has(resourceKey(item)) === source.has(resourceKey(item)))) throw new Error('批量请求后的归属不明确，已停止；不会盲目重放。');
      this.state.pending = 0;
      if (attempt?.canAbort && attempt.count === 1 && actual.every(item => items.some(candidate => resourceKey(candidate) === resourceKey(item)))) {
        // The very first two-item staging probe was rejected. Return only IDs observed
        // in the new buffer, verify their source, then avoid staging the entire job.
        this.membershipCap = 1; this.orderBulk = false;
        for (const item of actual) await this.send(destination.id, { id: sourceId }, [item]);
        if ((await this.read(destination)).length) throw new Error('批量探测回退未完成，请核对中转夹。');
        await this.sourceContains(sourceId, items);
        throw new UnsupportedBatch('当前接口不支持批量，已核对后改用逐条移动。');
      }
      this.membershipCap = Math.min(this.membershipCap, Math.max(1, Math.floor(items.length / 2)));
      if (this.membershipCap === 1) this.orderBulk = false;
      for (let start = 0; start < remaining.length;) {
        const part = remaining.slice(start, start + this.membershipCap);
        await this.looseOperation(sourceId, destination, part, allowed);
        // Nested negotiation may lower membershipCap; advance by the records actually
        // handed to the nested operation, not by the new smaller cap.
        start += part.length;
      }
    }
  }
  async looseTransfer(operations, destination, base = [], canAbort = false) {
    const expected = [...base, ...operations.flatMap(op => op.items)];
    const allowed = new Set(keys(expected));
    if (allowed.size !== expected.length) throw new Error('中转计划出现重复视频，已停止。');
    const attempt = { count: 0, canAbort: canAbort && base.length === 0 };
    let transferred = 0;
    for (const op of operations) {
      for (let start = 0; start < op.items.length;) {
        const size = Math.min(this.membershipCap, BATCH_SIZES[this.looseIndex], op.items.length - start);
        await this.looseOperation(op.sourceId, destination, op.items.slice(start, start + size), allowed, attempt);
        transferred += size;
        this.notify('批量转移', `${destination.title} · 已提交 ${transferred}/${expected.length - base.length} 条，随后核对实际归属。`);
        if (size > 1) {
          const head = await this.head(destination);
          if (head.items.some(item => !allowed.has(resourceKey(item)))) throw new Error('中转夹出现计划外内容，已停止。');
          if (head.count !== base.length + transferred) { this.membershipCap = 1; this.orderBulk = false; }
          else if (this.looseIndex < BATCH_SIZES.length - 1) this.looseIndex++;
        }
        start += size;
      }
    }
    let actual = await this.read(destination);
    if (new Set(keys(actual)).size !== actual.length || actual.some(item => !allowed.has(resourceKey(item)))) throw new Error('中转夹出现重复或计划外内容，已停止。');
    const present = new Set(keys(actual));
    // A success response may still represent a partial batch. Only move IDs proven absent
    // at destination and present at their original transfer source; never retry by assumption.
    let repaired = false;
    for (const op of operations) {
      const missing = op.items.filter(item => !present.has(resourceKey(item)));
      if (!missing.length) continue;
      await this.sourceContains(op.sourceId, missing);
      this.orderBulk = false; this.membershipCap = 1; repaired = true;
      for (const item of missing) await this.send(op.sourceId, destination, [item]);
    }
    if (repaired) actual = await this.read(destination);
    assertMembers(actual, expected, '中转夹');
    return actual;
  }
  async collect(chunk) {
    const buffer = await this.ensureBuffer();
    if ((await this.read(buffer)).length) throw new Error('中转夹不是空夹，已停止以保护现有内容。');
    this.notify('批量汇入中转夹', `正在汇入 ${chunk.name} 的 ${chunk.items.length} 条视频。`);
    try { await this.looseTransfer(groupsBySource(chunk.items), buffer, [], true); }
    catch (error) { if (error instanceof UnsupportedBatch) return chunk.items; throw error; }
    return chunk.items.map(item => ({ ...item, sourceId: buffer.id }));
  }
  async repair(target, desired, chunkItems, completed, mode = 'single') {
    this.notify('核对并校正顺序', `${target.title} 的批量结果需要校正，先核对实际归属。`);
    const actual = await this.read(target);
    const desiredSet = new Set(keys(desired));
    if (new Set(keys(actual)).size !== actual.length || actual.some(item => !desiredSet.has(resourceKey(item)))) throw new Error('目标中出现计划外视频或重复项，已停止；不会自动改动这些内容。');
    const buffer = await this.ensureBuffer();
    const held = await this.read(buffer);
    const chunkSet = new Set(keys(chunkItems));
    const existing = new Set(keys(held));
    if (held.some(item => !chunkSet.has(resourceKey(item))) || actual.some(item => existing.has(resourceKey(item)))) throw new Error('中转与目标归属冲突，已停止。');
    // Return only this task's known target records. No delete/copy/reorder endpoint is used.
    if (actual.length) await this.looseTransfer([{ sourceId: target.id, items: actual }], buffer, held);
    const buffered = await this.read(buffer);
    const bufferedSet = new Set(keys(buffered));
    const missing = desired.filter(item => !bufferedSet.has(resourceKey(item)));
    for (const op of groupsBySource(missing)) await this.sourceContains(op.sourceId, op.items);
    if (missing.length) await this.looseTransfer(groupsBySource(missing), buffer, buffered);
    if ((await this.read(target)).length) throw new Error('目标视频未完全回到中转夹，已停止，避免重复移动。');
    this.state.confirmed = completed;
    if (mode !== 'single' && this.membershipCap > 1 && this.orderBulk) {
      if (mode === 'flip') this.orientation = this.orientation === 'write' ? 'display' : 'write';
      const fromBuffer = desired.map(item => ({ ...item, sourceId: buffer.id }));
      try {
        for (const op of moveOperations(fromBuffer, Math.min(BATCH_SIZES[this.sizeIndex], this.membershipCap))) await this.send(buffer.id, target, op.items, true);
      } catch (error) {
        if (error.rateLimited || error.ambiguousWrite || !error.rejected || error.code !== -400 || this.state.pending <= 1) throw error;
        this.membershipCap = Math.max(1, Math.floor(this.state.pending / 2));
        await this.repair(target, desired, chunkItems, completed, 'keep');
        return;
      }
      const result = await this.read(target);
      if (sameOrder(result, desired)) { this.state.confirmed = completed + desired.length; return; }
      // One bounded orientation trial; arbitrary ordering never triggers a retry loop.
      await this.repair(target, desired, chunkItems, completed, 'single');
      return;
    }
    this.orderBulk = false;
    for (const item of [...desired].reverse()) {
      await this.send(buffer.id, target, [item]);
      this.state.confirmed++;
      this.notify('精确校正顺序', `${target.title} · ${this.state.confirmed}/${this.state.total}`);
    }
    if (!sameOrder(await this.read(target), desired)) throw new Error('逐条校正后顺序仍不一致，已停止，不会报告成功。');
  }
  async process(chunk, target) {
    const initial = await this.head(target);
    if (initial.count !== 0 || initial.items.length) throw new Error('新目标收藏夹已有内容，已停止；不会移动或覆盖计划外视频。');
    const completed = this.state.verified;
    let items = chunk.items;
    if (this.orderBulk && this.membershipCap > 1 && shouldStage(items)) items = await this.collect(chunk);
    const writeOrder = [...items].reverse();
    let offset = 0, expected = [];
    while (offset < writeOrder.length) {
      const size = this.orderBulk ? Math.min(BATCH_SIZES[this.sizeIndex], this.membershipCap) : 1;
      const sourceId = writeOrder[offset].sourceId;
      const batch = [];
      while (offset < writeOrder.length && batch.length < size && writeOrder[offset].sourceId === sourceId) batch.push(writeOrder[offset++]);
      const next = [...batch].reverse().concat(expected);
      try { await this.send(sourceId, target, batch, true); }
      catch (error) {
        if (error.rateLimited || error.ambiguousWrite || !error.rejected || error.code !== -400 || batch.length === 1) throw error;
        this.membershipCap = Math.min(this.membershipCap, Math.max(1, Math.floor(batch.length / 2)));
        if (this.membershipCap === 1) this.orderBulk = false;
        await this.repair(target, next, items, completed, 'keep');
        expected = next;
        continue;
      }
      this.state.confirmed = completed + next.length;
      this.state.pending = batch.length;
      if (batch.length > 1) {
        const head = await this.head(target);
        const matches = head.count === next.length && head.items.length > 0 && sameOrder(head.items, next.slice(0, head.items.length));
        if (!matches) {
          const payload = this.orientation === 'display' ? [...batch].reverse() : batch;
          const appearsInPayloadOrder = head.count === next.length && head.items.length >= batch.length && sameOrder(head.items.slice(0, batch.length), payload);
          await this.repair(target, next, items, completed, appearsInPayloadOrder ? 'flip' : 'single');
        } else if (batch.length === size && this.sizeIndex < BATCH_SIZES.length - 1) this.sizeIndex++;
      }
      expected = next;
      this.state.pending = 0;
      this.state.confirmed = completed + expected.length;
      this.notify('移动视频', `${target.title} · 本批 ${batch.length} 条 · 已提交 ${this.state.confirmed}/${this.state.total}`);
    }
    this.notify('核对完整展示顺序', `核对 ${target.title} 的所有分页，而不只检查前几条。`);
    if (!sameOrder(await this.read(target, { kind: 'targets', expected: chunk.items.length }), chunk.items)) await this.repair(target, items, items, completed);
    this.state.confirmed = completed + chunk.items.length;
    this.state.verified += chunk.items.length;
    if (this.buffer && (await this.read(this.buffer)).length) throw new Error('中转夹仍有未完成视频，已停止，请核对本次中转夹。');
    this.onProgress({ ...this.state, reading: { kind: 'targets', source: target, read: chunk.items.length,
      expected: chunk.items.length, step: 'complete' }, detail: `“${target.title}”的全部视频与展示顺序已核对。` });
  }
}
