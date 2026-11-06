import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../extension/lib/planner.js';
import { executePlan } from '../extension/lib/runner.js';
import { MemoryClient, makeItem } from './memory-client.mjs';

const count = 6000;
function fixture({ mixed = false, retained = false } = {}) {
  const unique = Array.from({ length: count }, (_, i) => makeItem(i + 1, mixed ? 10 + i % 3 : 10));
  const duplicates = retained ? unique.filter((_, i) => i % 10 === 0).map(item => ({ ...item, sourceId: '99' })) : [];
  const unavailable = retained ? [{ ...makeItem(9001, 99), unavailable: true }] : [];
  return [...unique, ...duplicates, ...unavailable];
}
function targetMoves(client, id) { return client.events.filter(event => event.type === 'move' && event.targetId === id); }
function assertResult(client, result, items) {
  assert.equal(result.verified, count);
  assert.equal(result.created.length, 6);
  for (let target = 0; target < 6; target++) {
    assert.deepEqual(client.data.get(result.created[target].id).items.map(item => item.id),
      Array.from({ length: 1000 }, (_, i) => String(count - target * 1000 - i)));
  }
  for (const source of new Set(items.map(item => item.sourceId))) {
    assert.deepEqual(client.data.get(source).items.map(item => item.id),
      items.filter(item => item.sourceId === source && (source === '99')).map(item => item.id));
  }
  if (result.buffer) assert.equal(client.data.get(result.buffer.id).items.length, 0);
}
function transientClient(items, anomaly, at = 3) {
  const client = new MemoryClient(items), move = client.move.bind(client);
  let targetRequests = 0;
  client.move = async (operation, targetId) => {
    const isTarget = client.data.get(targetId).title.startsWith('UP聚合');
    const inject = isTarget && ++targetRequests === at;
    if (inject) client.options[anomaly === 'partial' ? 'partialSuccess' : 'order'] = anomaly === 'partial' ? true : 'arbitrary';
    try { return await move(operation, targetId); }
    finally { if (inject) { delete client.options.partialSuccess; delete client.options.order; } }
  };
  return client;
}

function stagingPartialClient(items, { options = {}, afterRejection = false } = {}) {
  const client = new MemoryClient(items, options), move = client.move.bind(client);
  let injected = false, rejected = false;
  client.move = async (operation, targetId) => {
    const inject = !injected && client.data.get(targetId).title.startsWith('整理中转-') && operation.items.length > 1 &&
      operation.items.length <= (options.maxBatch ?? 100) && (!afterRejection || rejected);
    if (inject) { injected = true; client.options.partialSuccess = true; }
    try { return await move(operation, targetId); }
    catch (error) { if (error.rejected) rejected = true; throw error; }
    finally { if (inject) delete client.options.partialSuccess; }
  };
  return client;
}

test('one partial-success staging probe does not permanently disable supported batches', async () => {
  const items = fixture({ mixed: true, retained: true }), client = stagingPartialClient(items);
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  assert(targetMoves(client, result.created[0].id).every(event => event.ids.length === 1));
  assert.deepEqual(targetMoves(client, result.created[1].id).slice(0, 3).map(event => event.ids.length), [2, 20, 100]);
  for (const target of result.created.slice(2)) assert.equal(targetMoves(client, target.id)[0].ids.length, 100);
  assert(result.moveRequests < 1200, 'a reconciled staging anomaly must not force later targets into singles');
  assert(!client.events.some(event => event.type === 'move' && event.sourceId === '99'));
});

test('permanently partial-success staging probes abandon collection instead of doubling every transfer', async () => {
  const items = fixture({ mixed: true }), client = new MemoryClient(items, { partialSuccess: true });
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  assert(result.moveRequests < count + 50);
  assert(client.requests < 6500);
  assert.equal(result.batchRequests, 6);
});

test('staging recovery never restores a batch limit learned from explicit rejection', async () => {
  const items = fixture({ mixed: true }), client = stagingPartialClient(items, { options: { maxBatch: 5 }, afterRejection: true });
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  assert.deepEqual(targetMoves(client, result.created[0].id).slice(0, 2).map(event => event.ids.length), [2, 5]);
  const firstTargetWrite = client.events.findIndex(event => event.type === 'move' && event.targetId === result.created[0].id);
  assert(client.events.slice(firstTargetWrite).filter(event => event.type === 'move').every(event => event.ids.length <= 5));
  assert(result.moveRequests < 3500);
});

test('an explicitly rejected staging probe keeps a single-only API disabled across later targets', async () => {
  const items = fixture({ mixed: true }), client = new MemoryClient(items, { maxBatch: 1, partialReject: true });
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  assert.equal(result.batchRequests, 1);
  for (const target of result.created) assert(targetMoves(client, target.id).every(event => event.ids.length === 1));
});

test('a large first staging rejection negotiates its API cap instead of claiming batches are unsupported', async () => {
  const items = fixture({ mixed: true }), client = new MemoryClient(items), move = client.move.bind(client);
  client.move = async (operation, targetId) => {
    if (client.data.get(targetId).title.startsWith('整理中转-') &&
        [...client.data.values()].some(folder => folder.title === 'UP聚合-1' && folder.items.length === 1000)) {
      client.options.maxBatch = 5;
    }
    return move(operation, targetId);
  };
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  for (const target of result.created.slice(1)) {
    assert(targetMoves(client, target.id).some(event => event.ids.length > 1));
    assert(targetMoves(client, target.id).every(event => event.ids.length <= 5));
  }
  assert(result.moveRequests < 3600);
});

for (const failure of ['rateLimited', 'ambiguousWrite']) test(`${failure} during the first write after staging rollback stops without replay`, async () => {
  const items = fixture({ mixed: true }), client = stagingPartialClient(items), move = client.move.bind(client);
  client.move = async (operation, targetId) => {
    if (client.data.get(targetId).title === 'UP聚合-1') {
      client.requests++; client.moves++;
      client.events.push({ type: 'move', sourceId: operation.sourceId, targetId, ids: operation.items.map(item => item.id) });
      throw Object.assign(new Error('probe stopped'), { [failure]: true });
    }
    return move(operation, targetId);
  };
  await assert.rejects(executePlan(client, buildPlan(items, { group: false, keep: false })),
    error => error.cause[failure] && error.state.verified === 0 && error.state.pending === 1);
  assert.equal(client.events.at(-1).type, 'move');
  assert.equal(client.events.at(-1).ids.length, 1);
});

for (const failure of ['rateLimited', 'ambiguousWrite']) test(`${failure} while restoring the partial staging probe stops before verification or replay`, async () => {
  const items = fixture({ mixed: true }), client = stagingPartialClient(items), move = client.move.bind(client);
  client.move = async (operation, targetId) => {
    if (client.data.get(operation.sourceId).title.startsWith('整理中转-') && Number(targetId) < 100000) {
      await move(operation, targetId);
      throw Object.assign(new Error('restore stopped'), { [failure]: true });
    }
    return move(operation, targetId);
  };
  await assert.rejects(executePlan(client, buildPlan(items, { group: false, keep: false })),
    error => error.cause[failure] && error.state.verified === 0 && error.state.pending === 1);
  assert.equal(client.events.at(-1).type, 'move');
  assert.equal(client.events.at(-1).ids.length, 1);
});

for (const anomaly of ['partial', 'order']) test(`a verified repaired prefix permits one batch recovery after one ${anomaly} anomaly`, async () => {
  const items = fixture(), client = transientClient(items, anomaly);
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  const firstWrites = targetMoves(client, result.created[0].id);
  const firstSingle = firstWrites.findIndex(event => event.ids.length === 1);
  assert(firstSingle >= 0);
  assert.equal(firstWrites.slice(firstSingle).find(event => event.ids.length > 1)?.ids.length, 2);
  for (const target of result.created.slice(1)) assert.equal(targetMoves(client, target.id)[0].ids.length, 100);
  assert(result.moveRequests < 250, 'a verified repair must not force the remainder into single writes');
});

test('a completed target defers its recovery probe until the next destination is observed empty', async () => {
  const items = fixture(), client = transientClient(items, 'order', 12);
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  assert.deepEqual(targetMoves(client, result.created[1].id).slice(0, 3).map(event => event.ids.length), [2, 20, 100]);
  for (const target of result.created.slice(2)) assert.equal(targetMoves(client, target.id)[0].ids.length, 100);
});

test('batching recovery preserves other source duplicates and unavailable records after staged transfer', async () => {
  const items = fixture({ mixed: true, retained: true }), client = transientClient(items, 'order');
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  assert(result.buffer);
  for (const target of result.created.slice(1)) assert.equal(targetMoves(client, target.id)[0].ids.length, 100);
  assert(!client.events.some(event => event.type === 'move' && event.sourceId === '99'));
  assert(result.moveRequests < 400);
});

test('a genuinely single-only API is not probed again for every target', async () => {
  const items = fixture(), client = new MemoryClient(items, { maxBatch: 1 });
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  assert.equal(result.batchRequests, 1);
  for (const target of result.created.slice(1)) assert(targetMoves(client, target.id).every(event => event.ids.length === 1));
});

test('a recovered probe preserves the explicitly learned API batch cap', async () => {
  const items = fixture(), client = transientClient(items, 'order', 10);
  client.options.maxBatch = 5;
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  assert.equal(targetMoves(client, result.created[1].id)[0].ids.length, 5);
  for (const target of result.created.slice(1)) assert(targetMoves(client, target.id).every(event => event.ids.length <= 5));
  assert(result.moveRequests < 1500);
});

test('permanently arbitrary batches have bounded recovery work on each new target', async () => {
  const items = fixture(), client = new MemoryClient(items, { order: 'arbitrary' });
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assertResult(client, result, items);
  assert(result.moveRequests < count + 60, 'arbitrary order must not cause repeated full-target repair attempts');
  assert(result.batchRequests <= 32);
});

for (const failure of ['rateLimited', 'ambiguousWrite']) test(`${failure} during a recovered probe stops without later API calls`, async () => {
  const items = fixture(), client = transientClient(items, 'order', 12), move = client.move.bind(client);
  client.move = async (operation, targetId) => {
    if (client.data.get(targetId).title === 'UP聚合-2') {
      client.requests++; client.moves++;
      client.events.push({ type: 'move', sourceId: operation.sourceId, targetId, ids: operation.items.map(item => item.id) });
      throw Object.assign(new Error('probe stopped'), { [failure]: true });
    }
    return move(operation, targetId);
  };
  await assert.rejects(executePlan(client, buildPlan(items, { group: false, keep: false })),
    error => error.cause[failure] && error.state.verified === 1000 && error.state.pending === 2);
  assert.equal(client.events.at(-1).type, 'move');
  assert.equal(client.events.at(-1).ids.length, 2);
});

for (const failure of ['rateLimited', 'ambiguousWrite']) test(`${failure} during same-target recovery never replays the uncertain probe`, async () => {
  const items = fixture(), client = transientClient(items, 'partial'), move = client.move.bind(client);
  let repaired = false;
  client.move = async (operation, targetId) => {
    if (client.data.get(targetId).title === 'UP聚合-1') {
      if (repaired && operation.items.length > 1) {
        client.requests++; client.moves++;
        client.events.push({ type: 'move', sourceId: operation.sourceId, targetId, ids: operation.items.map(item => item.id) });
        throw Object.assign(new Error('probe stopped'), { [failure]: true });
      }
      if (operation.items.length === 1) repaired = true;
    }
    return move(operation, targetId);
  };
  await assert.rejects(executePlan(client, buildPlan(items, { group: false, keep: false })),
    error => error.cause[failure] && error.state.verified === 0 && error.state.pending === 2);
  assert.equal(client.events.at(-1).type, 'move');
  assert.equal(client.events.at(-1).ids.length, 2);
});

function lateCorruptionClient() {
  const items = Array.from({ length: 1000 }, (_, i) => makeItem(i + 1)), client = new MemoryClient(items, { pageSize: 20 });
  const move = client.move.bind(client);
  let corrupted = false;
  client.move = async (operation, targetId) => {
    await move(operation, targetId);
    const target = client.data.get(targetId);
    if (!corrupted && target.title === 'UP聚合' && target.items.length === 1000) {
      // Only the final batch is corrupted, beyond the sampled 20-item head.
      [target.items[25], target.items[26]] = [target.items[26], target.items[25]];
      corrupted = true;
    }
  };
  return { items, client };
}

test('late full-target corruption rebuilds only the incorrect prefix and leaves the exact suffix in place', async () => {
  const { items, client } = lateCorruptionClient();
  const result = await executePlan(client, buildPlan(items, { group: false, keep: false }));
  assert.equal(result.verified, 1000);
  assert.deepEqual(client.data.get(result.created[0].id).items.map(item => item.id), Array.from({ length: 1000 }, (_, i) => String(1000 - i)));
  assert.equal(client.data.get('10').items.length, 0);
  assert.equal(client.data.get(result.buffer.id).items.length, 0);
  assert(result.moveRequests < 60, 'a 27-item damaged prefix must not replay the 973-item exact suffix');
  const returned = client.events.filter(event => event.type === 'move' && event.sourceId === result.created[0].id).flatMap(event => event.ids);
  assert.equal(returned.length, 27);
  assert(returned.every(id => Number(id) >= 974));
});

for (const failure of ['rateLimited', 'ambiguousWrite']) test(`${failure} during prefix correction preserves the verified suffix and stops immediately`, async () => {
  const { items, client } = lateCorruptionClient(), move = client.move.bind(client);
  client.move = async (operation, targetId) => {
    if (client.data.get(operation.sourceId).title.startsWith('整理中转-') && client.data.get(targetId).title === 'UP聚合') {
      client.requests++; client.moves++;
      client.events.push({ type: 'move', sourceId: operation.sourceId, targetId, ids: operation.items.map(item => item.id) });
      throw Object.assign(new Error('correction stopped'), { [failure]: true });
    }
    return move(operation, targetId);
  };
  await assert.rejects(executePlan(client, buildPlan(items, { group: false, keep: false })), error => {
    assert(error.cause[failure]);
    assert.equal(error.state.pending, 1);
    assert.deepEqual(client.data.get(error.state.created[0].id).items.map(item => item.id), Array.from({ length: 973 }, (_, i) => String(973 - i)));
    return true;
  });
  assert.equal(client.events.at(-1).type, 'move');
  assert.equal(client.events.at(-1).ids.length, 1);
});
