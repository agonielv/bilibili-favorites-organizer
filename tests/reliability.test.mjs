import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../extension/lib/planner.js';
import { executePlan } from '../extension/lib/runner.js';
import { MemoryClient, makeItem } from './memory-client.mjs';
const key = item => `${item.id}:${item.type}`;
const writes = client => client.events.filter(event => ['move', 'create'].includes(event.type));

test('stale directory zero cannot hide copied videos left in a source', async () => {
  const items = [makeItem(1), makeItem(2)], client = new MemoryClient(items);
  const list = client.folders.bind(client), move = client.move.bind(client);
  let lists = 0;
  client.folders = async () => { const folders = await list(); lists++; return folders.map(folder => (lists > 1 && folder.id === '10') ? { ...folder, count: 0 } : folder); };
  client.move = async (op, id) => { await move(op, id); client.data.get(op.sourceId).items.push(...op.items.map(item => ({ ...item }))); };
  await assert.rejects(executePlan(client, buildPlan(items, {})), /仍在原收藏夹/);
});
test('stale directory counts do not block an unchanged source or leave stale UI totals', async () => {
  const items = [makeItem(1), makeItem(2)], client = new MemoryClient(items);
  const list = client.folders.bind(client);
  client.folders = async () => (await list()).map(folder => folder.id === '10' ? { ...folder, count: 999 } : folder);
  const result = await executePlan(client, buildPlan(items, {}));
  assert.equal(result.verified, 2); assert.equal(result.folders.find(folder => folder.id === '10').count, 0);
});
test('preview avoids existing names, including unselected folders and other planned targets', () => {
  const existing = ['UP聚合-1','UP聚合-1-2','UP聚合-2','UP聚合-2-2'].map(title => ({ title }));
  const plan = buildPlan([makeItem(1),makeItem(2)], { capacity: 1, keep: false }, [], existing);
  assert.deepEqual(plan.chunks.map(chunk => chunk.name), ['UP聚合-1-3','UP聚合-2-3']);
  assert.equal(plan.renamedTargets, 2);
  assert.equal(new Set([...existing.map(folder => folder.title), ...plan.chunks.map(chunk => chunk.name)]).size, 6);
});
test('existing source IDs and reused target IDs from creation are rejected before moving', async () => {
  for (const reused of ['10', '100000']) {
    const items = [makeItem(1),makeItem(2)], client = new MemoryClient(items);
    const create = client.create.bind(client);
    client.create = async (title, privacy) => {
      if (reused === '10' || client.events.some(event => event.type === 'create')) return { id: reused, title };
      return create(title, privacy);
    };
    await assert.rejects(executePlan(client, buildPlan(items, { capacity: 1, keep: false })), /已有收藏夹 ID/);
    assert(!writes(client).some(event => event.type === 'move'));
    assert.deepEqual(client.data.get('10').items.map(item => item.id), ['1','2']);
  }
});
test('unexpected content in a newly created target is protected before the first move', async () => {
  const items = [makeItem(1)], client = new MemoryClient(items), create = client.create.bind(client);
  client.create = async (...args) => { const folder = await create(...args); client.data.get(folder.id).items.push(makeItem(999)); return folder; };
  await assert.rejects(executePlan(client, buildPlan(items, {})), /新目标收藏夹已有内容/);
  assert(!writes(client).some(event => event.type === 'move'));
});
test('a reused buffer ID cannot turn a pre-existing empty folder into a staging area', async () => {
  const items = Array.from({ length: 180 }, (_, i) => makeItem(i + 1, 10 + i % 3)), client = new MemoryClient(items);
  client.data.set('99', { id: '99', title: '保留的空夹', items: [] });
  const create = client.create.bind(client);
  client.create = async (title, privacy) => title.startsWith('整理中转-') ? { id: '99', title } : create(title, privacy);
  await assert.rejects(executePlan(client, buildPlan(items, {})), /中转夹.*已有收藏夹 ID/);
  assert(!writes(client).some(event => event.type === 'move'));
  assert.deepEqual(client.data.get('99').items, []);
});

test('2000 seeded duplicate/unavailable/order/partial-batch combinations conserve every source membership', async () => {
  let seed = 26441831;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = values => values[Math.floor(random() * values.length)];
  for (let scenario = 0; scenario < 2000; scenario++) {
    const input = [], n = 5 + Math.floor(random() * 170), sourceCount = 1 + Math.floor(random() * 6);
    for (let id = 1; id <= n; id++) {
      const memberships = new Set([Math.floor(random() * sourceCount)]);
      if (random() < .6) memberships.add(Math.floor(random() * sourceCount));
      if (random() < .2) memberships.add(Math.floor(random() * sourceCount));
      const up = 1 + Math.floor(random() * 9), published = random() < .15 ? 0 : Math.floor(random() * 1000);
      for (const source of memberships) input.push({ ...makeItem(id, 10 + source, up, published), unavailable: id > 1 && random() < .15 });
    }
    input.sort((a, b) => Number(a.sourceId) - Number(b.sourceId));
    // Independent oracle: one available occurrence is removed from its original
    // source; every other original membership must still be there at the end.
    const chosen = new Map();
    for (const item of input) if (!item.unavailable && !chosen.has(key(item))) chosen.set(key(item), item);
    const options = { order: pick(['write','display','arbitrary']), maxBatch: pick([1,2,3,7,20,100]),
      partialReject: random() < .5, partialSuccess: random() < .2, hiddenTail: random() < .15, pageSize: pick([20,100]) };
    const rules = { group: random() < .7, keep: false, capacity: pick([1,13,40,1000]),
      groupOrder: pick(['count-desc','count-asc','name']), time: pick(['asc','desc']), privacy: pick(['private','public']) };
    const plan = buildPlan(input, rules), client = new MemoryClient(input, options);
    let result;
    try { result = await executePlan(client, plan); }
    catch (error) { throw new Error(`Scenario ${scenario}, ${JSON.stringify({ options, rules })}: ${error.message}`, { cause: error }); }
    assert.equal(result.verified, chosen.size);
    let total = 0;
    for (const folder of client.data.values()) total += folder.items.length;
    assert.equal(total, input.length, `Scenario ${scenario}: membership loss or unexpected copying`);
    for (const sourceId of new Set(input.map(item => item.sourceId))) {
      const expected = input.filter(item => item.sourceId === sourceId && chosen.get(key(item)) !== item).map(key).sort();
      assert.deepEqual(client.data.get(sourceId).items.map(key).sort(), expected);
    }
    const targetKeys = [];
    for (const [index, folder] of result.created.entries()) {
      const actual = client.data.get(folder.id).items;
      assert.deepEqual(actual.map(key), plan.chunks[index].items.map(key));
      targetKeys.push(...actual.map(key));
    }
    assert.deepEqual(targetKeys.sort(), [...chosen.keys()].sort());
    if (result.buffer) assert.equal(client.data.get(result.buffer.id).items.length, 0);
  }
});
