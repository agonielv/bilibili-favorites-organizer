import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceCache } from '../extension/lib/source-cache.js';
import { BiliClient } from '../extension/lib/client.js';
import { RequestQueue } from '../extension/lib/request.js';
import { buildPlan } from '../extension/lib/planner.js';
import { executePlan } from '../extension/lib/runner.js';

// Exercise real pagination, normalization, caching, planning and transfer with
// simulated time, including the server's silent ps=100 -> 20 clamp. No network.
function collection(size) {
  let now = 0, nextId = 1000;
  const events = [], folders = new Map(), shared = new Map();
  for (let index = 0; index < 13; index++) {
    const id = String(index + 10);
    folders.set(id, { id, title: `源 ${index + 1}`, medias: [] });
  }
  for (let index = 0; index < size; index++) {
    const unavailable = index % 7 === 0;
    const source = folders.get(String(Math.floor(index * 13 / size) + 10));
    source.medias.push({ id: index + 1, type: 2, attr: unavailable ? 9 : 0,
      title: unavailable ? '已失效视频' : `视频 ${index + 1}`,
      upper: unavailable ? null : { mid: Math.floor(index / 400) + 1, name: `UP ${Math.floor(index / 400) + 1}` },
      pubtime: unavailable ? 0 : index + 1, fav_time: size - index });
  }
  const queue = new RequestQueue({ now: () => now, sleep: async ms => { now += ms; },
    storage: { get: async key => shared.get(key), set: async (key, value) => { shared.set(key, value); } },
    fetcher: async (url, init) => {
      url = new URL(url);
      events.push({ path: url.pathname.split('/').at(-1), url, method: init.method, at: now });
      now += 200; // Response latency is in addition to the queue's 1.2s pacing.
      let data;
      if (url.pathname.endsWith('folder/created/list-all')) {
        data = { list: [...folders.values()].map(folder => ({ id: folder.id, title: folder.title, media_count: folder.medias.length })) };
      } else if (url.pathname.endsWith('resource/list')) {
        const folder = folders.get(url.searchParams.get('media_id'));
        assert(folder);
        const page = Number(url.searchParams.get('pn')), pageSize = Math.min(20, Number(url.searchParams.get('ps')));
        data = { info: { media_count: folder.medias.length }, has_more: page * pageSize < folder.medias.length,
          medias: folder.medias.slice((page - 1) * pageSize, page * pageSize) };
      } else {
        const form = new URLSearchParams(init.body);
        assert.equal(form.get('csrf'), 'simulation-only');
        if (url.pathname.endsWith('folder/add')) {
          const id = String(nextId++);
          folders.set(id, { id, title: form.get('title'), privacy: form.get('privacy'), medias: [] });
          data = { id };
        } else if (url.pathname.endsWith('resource/move')) {
          const source = folders.get(form.get('src_media_id')), target = folders.get(form.get('tar_media_id'));
          for (const resource of form.get('resources').split(',')) {
            const index = source.medias.findIndex(media => `${media.id}:${media.type}` === resource);
            assert(index >= 0, `Missing or repeated move: ${resource}`);
            assert.equal(source.medias[index].attr, 0, 'Unavailable videos must never be moved');
            target.medias.unshift(source.medias.splice(index, 1)[0]);
          }
          data = {};
        } else throw new Error(`Unexpected endpoint ${url.pathname}`);
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, data }) };
    } });
  return { client: new BiliClient(queue, async () => ({ uid: '123', csrf: 'simulation-only' })),
    cache: new SourceCache({ now: () => now }), events, folders, now: () => now, advance: ms => { now += ms; } };
}

for (const size of [11606, 50000]) test(`13-folder ${size}-record scan outlives ten minutes and retains every record`, async () => {
  const fixture = collection(size), { client, cache, events } = fixture;
  const sources = await client.folders();
  const snapshot = await cache.collect('123', sources, folder => client.resources(folder));
  assert(fixture.now() - snapshot.at > 10 * 60 * 1000, 'Must reproduce the original expiry condition');
  assert.equal(snapshot.items.length, size);
  assert.equal(new Set(snapshot.items.map(item => item.id)).size, size);
  assert.equal(snapshot.loaded, 13);
  const plan = buildPlan(snapshot.items, {}, snapshot.sources);
  assert.equal(plan.skippedItems.length, Math.ceil(size / 7));
  assert.equal(plan.itemCount + plan.skippedItems.length, size);
  assert(plan.chunks.every(chunk => chunk.items.length <= 1000 && chunk.items.every(item => !item.unavailable)));

  const reads = events.length;
  fixture.advance(24 * 60 * 60 * 1000);
  const reused = await cache.collect('123', [...sources].reverse(), folder => client.resources(folder));
  assert.equal(reused.loaded, 0); assert.equal(events.length, reads);
  assert.equal(reused.at, snapshot.at); assert.equal(reused.key, snapshot.key);
  assert.equal(buildPlan(reused.items, { time: 'asc' }).itemCount, plan.itemCount);

  if (size === 11606) {
    const result = await executePlan(client, plan);
    assert.equal(result.verified, plan.itemCount); assert.equal(result.skipped, plan.skippedItems.length);
    const firstWrite = events.findIndex(event => event.method === 'POST');
    const preflight = events.slice(reads, firstWrite).filter(event => event.url.pathname.endsWith('resource/list'));
    assert.equal(preflight.length, reads - 1, 'Every source page is checked again before any write');
    assert.equal(new Set(preflight.map(event => event.url.searchParams.get('media_id'))).size, 13);
    for (const [index, chunk] of plan.chunks.entries()) {
      assert.deepEqual(fixture.folders.get(result.created[index].id).medias.map(media => String(media.id)), chunk.items.map(item => item.id));
    }
    for (const source of sources) {
      assert.deepEqual(fixture.folders.get(source.id).medias.map(media => String(media.id)),
        plan.skippedItems.filter(item => item.sourceId === source.id).map(item => item.id));
    }
  }
  assert(events.every((event, index) => index === 0 || event.at - events[index - 1].at >= 1200), 'Large scans must preserve request pacing');
});
