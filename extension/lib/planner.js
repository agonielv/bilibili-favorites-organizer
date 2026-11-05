export const DEFAULT_RULES = Object.freeze({ group: true, groupOrder: 'count-desc', keep: true, time: 'desc', capacity: 1000, base: 'UP聚合', privacy: 'private' });
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true });
export function validateRules(input) {
  const rules = { ...DEFAULT_RULES, ...input };
  if (!Number.isInteger(rules.capacity) || rules.capacity < 1 || rules.capacity > 1000) throw new Error('容量请填写 1–1000 的整数。');
  if (!['count-desc', 'count-asc', 'name'].includes(rules.groupOrder) || !['asc', 'desc'].includes(rules.time) || !['private', 'public'].includes(rules.privacy)) throw new Error('整理规则无效，请恢复默认后重试。');
  if (typeof rules.group !== 'boolean' || typeof rules.keep !== 'boolean') throw new Error('分组规则无效。');
  rules.base = String(rules.base).trim() || DEFAULT_RULES.base;
  if (Array.from(rules.base).length > 10 || /[\u0000-\u001f]/.test(rules.base)) throw new Error('基础名称应为 1–10 个字符，不能包含控制字符。');
  return rules;
}
export function normalizeMedia(media, folder) {
  const id = String(media.id || '');
  if (!/^\d+$/.test(id) || id === '0') throw new Error('接口返回了无效的视频 ID，已停止读取。');
  const type = Number(media.type ?? 2);
  if (type !== 2) throw new Error(`收藏夹“${folder.title}”含非视频收藏，本版仅处理视频，请单独选择视频收藏夹。`);
  const candidates = [media.pubtime, media.pub_time, media.ctime, media.publish_time, media.publishTime, media.arc?.pubdate, media.archive?.pubdate];
  return { id, type, title: String(media.title || `视频 ${id}`), sourceId: String(folder.id), sourceTitle: String(folder.title),
    uploaderId: String(media.upper?.mid || '0'), uploaderName: String(media.upper?.name || '未知 UP 主'),
    publishedAt: candidates.map(Number).find(n => Number.isFinite(n) && n > 0) || 0,
    favoredAt: Number(media.fav_time) || 0 };
}
export function compareVideos(time) {
  return (a, b) => {
    // Unknown publication dates stay last in both directions; ties are deterministic.
    if (!!a.publishedAt !== !!b.publishedAt) return a.publishedAt ? -1 : 1;
    const direction = time === 'asc' ? 1 : -1;
    return direction * (a.publishedAt - b.publishedAt) || direction * (a.favoredAt - b.favoredAt) ||
      collator.compare(a.title, b.title) || collator.compare(a.id, b.id) || collator.compare(a.sourceId, b.sourceId);
  };
}
export function buildPlan(items, inputRules) {
  const rules = validateRules(inputRules);
  if (!items.length) throw new Error('所选收藏夹没有可移动的视频。');
  const resources = new Set();
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.id}:${item.type}`;
    if (resources.has(key)) throw new Error('同一视频出现在多个所选源收藏夹中。为避免丢失归属或重复移动，请分别选择这些收藏夹；本版不自动去重。');
    resources.add(key);
    if (!grouped.has(item.uploaderId)) grouped.set(item.uploaderId, { id: item.uploaderId, name: item.uploaderName, items: [] });
    grouped.get(item.uploaderId).items.push(item);
  }
  let groups = [...grouped.values()];
  if (rules.group) {
    for (const group of groups) group.items.sort(compareVideos(rules.time));
    groups.sort((a, b) => (rules.groupOrder === 'name' ? 0 : (rules.groupOrder === 'count-asc' ? 1 : -1) * (a.items.length - b.items.length)) || collator.compare(a.name, b.name) || collator.compare(a.id, b.id));
  } else groups = [{ name: '', items: [...items].sort(compareVideos(rules.time)) }];
  const chunks = [];
  let current = [];
  for (const group of groups) {
    if (rules.group && rules.keep) {
      if (group.items.length > rules.capacity) throw new Error(`“${group.name}”有 ${group.items.length} 条，超过容量 ${rules.capacity}。请提高容量或关闭“同一 UP 主不拆分”。`);
      if (current.length && current.length + group.items.length > rules.capacity) { chunks.push(current); current = []; }
      current.push(...group.items);
    } else {
      for (let start = 0; start < group.items.length;) {
        const take = Math.min(rules.capacity - current.length, group.items.length - start);
        current.push(...group.items.slice(start, start + take));
        start += take;
        if (current.length === rules.capacity) { chunks.push(current); current = []; }
      }
    }
  }
  if (current.length) chunks.push(current);
  return { rules, itemCount: items.length, uploaderCount: grouped.size, missingDates: items.filter(i => !i.publishedAt).length,
    chunks: chunks.map((items, index) => ({ name: rules.base + (chunks.length > 1 ? `-${index + 1}` : ''), items })) };
}
// Never merge nonadjacent source segments just to obtain a larger batch.
export function moveOperations(items, maxBatch = 1) {
  if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 100) throw new Error('无效的批量大小。');
  const operations = [];
  for (const item of [...items].reverse()) {
    const last = operations.at(-1);
    if (last && last.sourceId === item.sourceId && last.items.length < maxBatch) last.items.push(item);
    else operations.push({ sourceId: item.sourceId, items: [item] });
  }
  return operations;
}
