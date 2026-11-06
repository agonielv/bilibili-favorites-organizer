import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceCache } from '../extension/lib/source-cache.js';
const a = { id: '10' }, b = { id: '11' };
const media = source => [{ id: source.id, sourceId: source.id }];

test('removing and reselecting a source reuses its page data', async () => {
  const cache = new SourceCache(); let reads = 0;
  const load = async source => { reads++; return media(source); };
  await cache.collect('u', [a, b], load);
  await cache.collect('u', [b], load);
  const result = await cache.collect('u', [a, b], load);
  assert.equal(reads, 2); assert.equal(result.loaded, 0); assert.equal(result.items.length, 2);
});
test('adding a source reads only the missing source and preserves stable scope keys', async () => {
  const cache = new SourceCache(); const reads = [];
  const load = async source => { reads.push(source.id); return media(source); };
  await cache.collect('u', [a], load);
  const result = await cache.collect('u', [b, a], load);
  assert.deepEqual(reads, ['10', '11']); assert.equal(result.loaded, 1); assert.equal(result.key, '10,11');
});
test('replanning preserves the real oldest read time while tracking preview completion', async () => {
  let now = 0; const cache = new SourceCache({ now: () => now });
  await cache.collect('u', [a], async source => media(source)); now = 30;
  assert.equal((await cache.collect('u', [a, b], async source => media(source))).at, 0);
  now = 60; assert.equal((await cache.collect('u', [a, b], async source => media(source))).at, 0);
});
test('elapsed time never discards page data; explicit refresh still forces a fresh read', async () => {
  let now = 0, reads = 0; const cache = new SourceCache({ now: () => now });
  const load = async source => { reads++; return media(source); };
  await cache.collect('u', [a], load); now = 24 * 60 * 60 * 1000;
  assert(cache.peek('u', a.id));
  const reused = await cache.collect('u', [a], load);
  assert.equal(reads, 1); assert.equal(reused.at, 0); assert.equal(reused.completedAt, now);
  cache.clear('u'); await cache.collect('u', [a], load); assert.equal(reads, 2);
});
test('account changes never reuse another account source data', async () => {
  const cache = new SourceCache(); let reads = 0;
  const load = async source => { reads++; return media(source); };
  await cache.collect('u', [a], load); assert.equal(cache.peek('v', a.id), null);
  await cache.collect('v', [a], load); assert.equal(reads, 2); assert.equal(cache.peek('u', a.id), null);
});
test('explicit invalidation prevents an in-flight response from repopulating the cache', async () => {
  const cache = new SourceCache(); let release;
  const pending = cache.collect('u', [a], () => new Promise(resolve => { release = resolve; }));
  cache.clear(null); release(media(a));
  await assert.rejects(pending, /状态已变化/); assert.equal(cache.entries.size, 0);
});
test('a failed source cannot produce a partial snapshot and preserves valid earlier data', async () => {
  const cache = new SourceCache(); await cache.collect('u', [a], async source => media(source));
  await assert.rejects(cache.collect('u', [a, b], async () => { throw new Error('limited'); }), /limited/);
  assert(cache.peek('u', a.id)); assert.equal(cache.peek('u', b.id), null);
});
test('adding a slow source does not expire sources read earlier in the same page', async () => {
  let now = 0; const cache = new SourceCache({ now: () => now });
  await cache.collect('u', [a], async source => media(source));
  const result = await cache.collect('u', [a, b], async source => { now = 60 * 60 * 1000; return media(source); });
  assert.equal(result.items.length, 2); assert.equal(result.loaded, 1);
  assert.equal(result.at, 0); assert.equal(result.completedAt, now);
  assert(cache.peek('u', a.id));
});
