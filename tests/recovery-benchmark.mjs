import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPlan } from '../extension/lib/planner.js';
import { executePlan } from '../extension/lib/runner.js';
import { MemoryClient, makeItem } from './memory-client.mjs';

const versions = [['current', executePlan]];
if (process.env.BFO_BASELINE_LIB_DIR) {
  const baseline = await import(pathToFileURL(resolve(process.env.BFO_BASELINE_LIB_DIR, 'runner.js')));
  versions.unshift(['baseline', baseline.executePlan]);
}
const results = [];
for (const scenario of ['healthy', 'transient-partial', 'transient-order', 'staging-partial', 'single-only', 'arbitrary', 'partial-always', 'late-corruption']) {
  for (const [version, execute] of versions) {
    const count = scenario === 'late-corruption' ? 1000 : 6000;
    const items = Array.from({ length: count }, (_, index) => makeItem(index + 1, ['staging-partial','partial-always'].includes(scenario) ? 10 + index % 3 : 10));
    const options = { pageSize: scenario === 'late-corruption' ? 20 : 100,
      ...(scenario === 'single-only' ? { maxBatch: 1 } : {}), ...(scenario === 'arbitrary' ? { order: 'arbitrary' } : {}),
      ...(scenario === 'partial-always' ? { partialSuccess: true } : {}) };
    const client = new MemoryClient(items, options), move = client.move.bind(client);
    let targetRequests = 0, injected = false;
    client.move = async (operation, targetId) => {
      const isTarget = client.data.get(targetId).title.startsWith('UP聚合');
      if (isTarget) targetRequests++;
      const inject = !injected && ((scenario === 'staging-partial' && !isTarget) ||
        (['transient-partial', 'transient-order'].includes(scenario) && isTarget && targetRequests === 3));
      if (inject) { injected = true; options[scenario === 'transient-order' ? 'order' : 'partialSuccess'] = scenario === 'transient-order' ? 'arbitrary' : true; }
      try { await move(operation, targetId); }
      finally { if (inject) { delete options.partialSuccess; delete options.order; } }
      const target = client.data.get(targetId);
      if (!injected && scenario === 'late-corruption' && isTarget && target.items.length === count) {
        [target.items[25], target.items[26]] = [target.items[26], target.items[25]]; injected = true;
      }
    };
    const plan = buildPlan(items, { group: false, keep: false }), result = await execute(client, plan);
    assert.equal(result.verified, count);
    for (let index = 0; index < result.created.length; index++) {
      assert.deepEqual(client.data.get(result.created[index].id).items.map(item => item.id), plan.chunks[index].items.map(item => item.id));
    }
    for (const source of plan.sources) assert.equal(client.data.get(source.id).items.length, 0);
    if (result.buffer) assert.equal(client.data.get(result.buffer.id).items.length, 0);
    results.push({ scenario, version, videos: count, sources: plan.sources.length, pageSize: options.pageSize,
      moveRequests: result.moveRequests, executionRequests: client.requests,
      targetFirstBatchSizes: result.created.map(target => client.events.find(event => event.type === 'move' && event.targetId === target.id)?.ids.length),
      exactOrderAndMembershipVerified: true });
  }
}
console.log(JSON.stringify({ kind: 'deterministic mock; not live Bilibili; execution preflight included; preview scan and network latency excluded', intervalMs: 1200, results }, null, 2));
