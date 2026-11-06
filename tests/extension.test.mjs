import { MemoryClient } from './memory-client.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, normalizeMedia, moveOperations, DEFAULT_RULES } from '../extension/lib/planner.js';
import { RequestQueue, COOLDOWN_KEY } from '../extension/lib/request.js';
import { BiliClient } from '../extension/lib/client.js';
import { executePlan } from '../extension/lib/runner.js';

const item = (id, up = 7, pub = id, source = '10') => ({ id: String(id), type: 2, title: '视频'+id, sourceId: source, sourceTitle: '源'+source, uploaderId: String(up), uploaderName: 'UP'+up, publishedAt: pub, favoredAt: id });
const ids = chunk => chunk.items.map(i => i.id);
const response = (data = {}, options = {}) => ({ ok: !options.status || options.status === 200, status: options.status || 200,
  headers: { get: () => options.retryAfter ?? null }, json: async () => ({ code: options.code || 0, message: options.message || '', data }) });
function transport(respond, shared = new Map()) {
  let now = 1000000;
  const calls = [];
  const storage = { get: async key => shared.get(key), set: async (key, value) => { shared.set(key, value); } };
  const queue = new RequestQueue({ storage, now: () => now, sleep: async ms => { now += ms; }, fetcher: async (url, init) => {
    const call = { url: new URL(url), init, at: now }; calls.push(call); return respond(call, calls);
  } });
  const client = new BiliClient(queue, async () => ({ uid: '123', csrf: 'test-only' }));
  return { queue, client, calls, storage, shared, advance(ms) { now += ms; } };
}

test('default plan groups uploaders by count and sorts publication descending without mutating inputs', () => {
  const input = [item(1), item(2, 8), item(3), item(4)];
  const plan = buildPlan(input, {});
  assert.deepEqual(ids(plan.chunks[0]), ['4', '3', '1', '2']);
  assert.deepEqual(input.map(i => i.id), ['1', '2', '3', '4']);
  assert.equal(plan.rules.privacy, 'private');
});
test('ascending, uploader ascending, flat mode and splitting all change actual output', () => {
  const input = [item(1), item(2, 8), item(3), item(4)];
  assert.deepEqual(ids(buildPlan(input, { time: 'asc' }).chunks[0]), ['1', '3', '4', '2']);
  assert.deepEqual(ids(buildPlan(input, { groupOrder: 'count-asc' }).chunks[0]), ['2', '4', '3', '1']);
  assert.deepEqual(ids(buildPlan(input, { group: false }).chunks[0]), ['4', '3', '2', '1']);
  assert.throws(() => buildPlan(input, { capacity: 2 }), /不拆分/);
  assert.deepEqual(buildPlan(input, { capacity: 2, keep: false }).chunks.map(ids), [['4','3'],['1','2']]);
});
test('unknown dates stay last in both directions, ties fall back deterministically', () => {
  const input = [item(1, 7, 0), item(2), item(3, 7, 0)];
  assert.deepEqual(ids(buildPlan(input, { time: 'desc' }).chunks[0]), ['2','3','1']);
  assert.deepEqual(ids(buildPlan(input, { time: 'asc' }).chunks[0]), ['2','1','3']);
});
test('invalid rules, duplicate source references, and non-video resources are rejected', () => {
  for (const capacity of [0, 1001, 1.5, NaN]) assert.throws(() => buildPlan([item(1)], { capacity }));
  assert.throws(() => buildPlan([item(1)], { privacy: 'bad' }));
  assert.throws(() => buildPlan([item(1), item(1, 7, 1, '11')]), /同一视频/);
  assert.throws(() => normalizeMedia({ id: 1, type: 12 }, { id: 10, title: '源' }), /非视频/);
});
test('6000-item planner honors capacity and uploader boundaries', () => {
  const input = Array.from({ length: 6000 }, (_, n) => item(n + 1, Math.floor(n / 500)));
  const plan = buildPlan(input, {});
  assert.equal(plan.itemCount, 6000); assert.equal(plan.chunks.length, 6);
  assert(plan.chunks.every(c => c.items.length === 1000));
  assert.equal(new Set(plan.chunks.flatMap(c => c.items.map(i => i.id))).size, 6000);
});
test('candidate batch planner preserves reverse write order and never coalesces nonadjacent sources', () => {
  const input = [item(1,7,1,'10'), item(2,7,2,'11'), item(3,7,3,'10'), item(4,7,4,'10')];
  assert.deepEqual(moveOperations(input, 20).map(o => o.items.map(i => i.id)), [['4','3'],['2'],['1']]);
});
test('shared request queue serializes concurrent callers and spaces starts by 1200ms', async () => {
  const t = transport(() => response());
  await Promise.all([1,2,3].map(n => t.queue.request('https://api.bilibili.com/'+n, async () => ({method:'GET'}))));
  assert.deepEqual(t.calls.map(c => c.at), [1000000,1001200,1002400]);
});
test('default fetch adapter invokes the browser global receiver instead of the queue object', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = function () { assert.equal(this, globalThis); called = true; return Promise.resolve(response()); };
  try {
    const queue = new RequestQueue({ storage: { get: async () => undefined, set: async () => {} } });
    await queue.request('https://api.bilibili.com/test', async () => ({ method: 'GET' }));
    assert(called);
  } finally { globalThis.fetch = original; }
});
for (const status of [412,429]) test(`HTTP ${status} stops queued requests and persists Retry-After cooldown`, async () => {
  const t = transport(() => response({}, { status, retryAfter: '120' }));
  const results = await Promise.allSettled([1,2].map(() => t.client.folders('123')));
  assert(results.every(r => r.status === 'rejected' && r.reason.rateLimited)); assert.equal(t.calls.length, 1);
  const restored = transport(() => response({list:[]}), t.shared);
  await assert.rejects(restored.client.folders('123'), /120 秒/); assert.equal(restored.calls.length, 0);
  restored.advance(120000); await restored.client.folders('123'); assert.equal(restored.calls.length, 1);
});
for (const code of [-352,-412,-509]) test(`API risk code ${code} halts without retry`, async () => {
  const t = transport(() => response({}, { code })); await assert.rejects(t.client.folders('123'), e => e.rateLimited); assert.equal(t.calls.length,1);
});
test('only the failed page is retried; CSRF is added to write forms in memory', async () => {
  let attempts = 0;
  const t = transport(call => {
    if (call.url.pathname.endsWith('resource/move')) { assert.equal(new URLSearchParams(call.init.body).get('csrf'),'test-only'); return response(); }
    const pn = call.url.searchParams.get('pn');
    if (pn === '2' && attempts++ === 0) return response({}, {status:503});
    return response({info:{media_count:2},has_more:pn==='1',medias:[{id:Number(pn),upper:{mid:7}}]});
  });
  const items = await t.client.resources({id:'10',title:'源'});
  assert.equal(items.length,2);assert.deepEqual(t.calls.map(c=>c.url.searchParams.get('pn')),['1','2','2']);
  await t.client.move({sourceId:'10',items:[item(1)]},'20');
});
test('network/HTTP write failures are not retried or sent through alternate creation payloads', async () => {
  for (const responder of [() => {throw new Error('timeout')}, () => response({}, {status:503})]) {
    const t = transport(responder);
    await assert.rejects(t.client.create('目标','private'), e => e.ambiguousWrite);
    assert.equal(t.calls.length,1);
  }
});
test('malformed pagination and repeated pages stop before a plan is produced', async () => {
  const t = transport(() => response({info:{media_count:3},has_more:true,medias:[{id:1}]}));
  await assert.rejects(t.client.resources({id:'10',title:'源'}), /分页重复/);assert.equal(t.calls.length,2);
});
test('creation compatibility only retries explicit rejections and honors public/private', async () => {
  let n = 0;
  const t = transport(call => {assert.equal(new URLSearchParams(call.init.body).get('privacy'),'0'); return ++n < 2 ? response({}, {code:-112}) : response({id:20});});
  assert.equal((await t.client.create('新','public')).id,'20'); assert.equal(t.calls.length,2);
});
test('runner prepares targets before moves and verifies default order', async () => {
  const items=[item(1),item(2),item(3),item(4)], client=new MemoryClient(items);
  const result=await executePlan(client,buildPlan(items,{capacity:2,keep:false}));
  assert.equal(result.verified,4);assert.equal(client.events[0].type,'read');
  const firstMove=client.events.findIndex(e=>e.type==='move');
  assert.deepEqual(client.events.slice(0,firstMove).filter(e=>e.type==='create').map(e=>e.type),['create','create']);
  assert(client.events.some(e=>e.type==='move'&&e.ids.length>1));
});
test('runner halts immediately on ambiguous writes and retains pending batch information', async () => {
  const items=[item(1),item(2),item(3),item(4)], client=new MemoryClient(items,{failMoveAt:2});
  await assert.rejects(executePlan(client,buildPlan(items,{})),e=>e.state.confirmed===2&&e.state.pending===2);
  assert.equal(client.events.at(-1).type,'move');
});
test('runner refuses changed sources and existing destinations before writing', async () => {
  for(const collision of [true,false]){
    const items=[item(1),item(2),item(3),item(4)],client=new MemoryClient(items);
    if(collision)client.data.set('99',{id:'99',title:'UP聚合-1',items:[]});else client.data.get('10').items.pop();
    await assert.rejects(executePlan(client,buildPlan(items,{capacity:2,keep:false})),/已存在|数量已变化/);
    assert(!client.events.some(e=>e.type==='create'||e.type==='move'));
  }
});
test('session changes stop before creating destinations', async () => {
  const client=new MemoryClient([item(1)]);
  await assert.rejects(executePlan(client,buildPlan([item(1)],{}),{assertFresh:async()=>{throw Error('account changed')}}),/account changed/);
  assert.equal(client.events.length,0);
});
test('same-count source replacements or availability/sort changes stop before all writes', async () => {
  for (const change of [
    entry => { entry.id = '999'; },
    entry => { entry.unavailable = true; },
    entry => { entry.publishedAt = 999; },
    entry => { entry.uploaderId = '999'; },
  ]) {
    const input = [item(1), item(2)], client = new MemoryClient(input);
    change(client.data.get('10').items[0]);
    await assert.rejects(executePlan(client,buildPlan(input,{})), /内容或视频状态已变化/);
    assert(!client.events.some(event => event.type === 'create' || event.type === 'move'));
  }
});
test('failure or risk in execution preflight never creates targets or writes', async () => {
  const input = [item(1)], client = new MemoryClient(input);
  client.resources = async () => { throw Object.assign(new Error('preflight rate limit'), { rateLimited: true }); };
  await assert.rejects(executePlan(client, buildPlan(input, {})), error => error.cause.rateLimited && error.state.created.length === 0 && error.state.pending === 0);
  assert.equal(client.moves, 0);
});
test('only explicit unavailable markers skip a video; missing metadata remains sortable', () => {
  const folder = { id:'10',title:'源' };
  for (const media of [{id:1,attr:1}, {id:2,attr:'9',upper:null}, {id:3,title:'已失效视频'}, {id:4,title:'视频已删除'}]) {
    assert.equal(normalizeMedia(media,folder).unavailable,true);
  }
  for (const attr of [undefined,0,2,8]) {
    const video = normalizeMedia({id:5,attr,upper:null},folder);
    assert.equal(video.unavailable,false); assert.equal(buildPlan([video],{}).itemCount,1);
  }
  assert.throws(() => normalizeMedia({id:0,attr:9},folder), /无效的视频 ID/);
});
test('unavailable videos do not affect grouping, duplicate checks, capacity or source validation', async () => {
  const valid = item(1), skipped = [
    {...item(2),unavailable:true,uploaderId:'0'},
    {...item(1,0,0,'11'),unavailable:true},
    {...item(3,0,0,'11'),unavailable:true},
  ];
  const input = [valid,...skipped], plan = buildPlan(input,{capacity:1}), client = new MemoryClient(input);
  assert.equal(plan.recordCount,4); assert.equal(plan.itemCount,1); assert.equal(plan.uploaderCount,1);
  assert.equal(plan.skippedItems.length,3); assert.equal(plan.sources.length,2);
  const result = await executePlan(client,plan);
  assert.equal(result.verified,1); assert.equal(result.skipped,3);
  assert.deepEqual(client.data.get('10').items.map(entry=>entry.id),['2']);
  assert.deepEqual(client.data.get('11').items.map(entry=>entry.id),['1','3']);
  assert(client.events.filter(event=>event.type==='move').every(event=>event.ids.length===1 && event.sourceId==='10' && event.ids[0]==='1'));
});
test('a page containing only unavailable videos has a read-only preview and cannot execute', async () => {
  const input = [{...item(1),unavailable:true}], plan = buildPlan(input,{}), client = new MemoryClient(input);
  assert.equal(plan.recordCount,1); assert.equal(plan.itemCount,0); assert.equal(plan.chunks.length,0);
  assert.equal(plan.skippedItems.length,1);
  await assert.rejects(executePlan(client,plan), /没有可移动的视频/);
  assert.equal(client.requests,0);
});
test('a skipped video becoming available invalidates the plan before targets are created', async () => {
  const input = [item(1),{...item(2),unavailable:true}], client = new MemoryClient(input);
  client.data.get('10').items[1].unavailable = false;
  await assert.rejects(executePlan(client,buildPlan(input,{})), /内容或视频状态已变化/);
  assert(!client.events.some(event=>event.type==='create' || event.type==='move'));
});
test('an empty selected source is also revalidated before writes', async () => {
  const input = [item(1)], client = new MemoryClient(input);
  client.data.set('11',{id:'11',title:'空来源',items:[]});
  const folders = await client.folders(), plan = buildPlan(input,{},folders);
  assert.equal(plan.sources.length,2);
  client.data.get('11').items.push(item(2,7,2,'11'));
  await assert.rejects(executePlan(client,plan), /数量已变化/);
  assert(!client.events.some(event=>event.type==='create' || event.type==='move'));
});
for (const cap of [20,100]) test(`page-size negotiation at server cap ${cap} never skips records`, async () => {
  const all=Array.from({length:241},(_,n)=>({id:n+1,upper:{mid:7}}));
  const t=transport(call=>{const pn=Number(call.url.searchParams.get('pn')),ps=Math.min(cap,Number(call.url.searchParams.get('ps')));return response({info:{media_count:all.length},has_more:pn*ps<all.length,medias:all.slice((pn-1)*ps,pn*ps)});});
  const result=await t.client.resources({id:'10',title:'源'});
  assert.deepEqual(result.map(i=>i.id),all.map(i=>String(i.id)));
  assert.equal(t.calls.length,Math.ceil(all.length/cap));
  assert.equal(t.calls[0].url.searchParams.get('ps'),'100');
  if(cap===20)assert(t.calls.slice(1).every(c=>c.url.searchParams.get('ps')==='20'));
});
test('explicitly rejected large read page falls back once; risk never falls back',async()=>{
  const t=transport(call=>call.url.searchParams.get('ps')==='100'?response({},{code:-400}):response({info:{media_count:0},medias:[],has_more:false}));
  assert.deepEqual(await t.client.resources({id:'10',title:'源'}),[]);assert.equal(t.calls.length,2);
  const limited=transport(()=>response({},{status:429}));await assert.rejects(limited.client.resources({id:'10',title:'源'}),e=>e.rateLimited);assert.equal(limited.calls.length,1);
});
test('a changing page size or count aborts instead of silently producing an incomplete plan',async()=>{
  const t=transport(call=>{const pn=Number(call.url.searchParams.get('pn'));return response({info:{media_count:300},has_more:true,medias:Array.from({length:pn===1?100:20},(_,n)=>({id:(pn-1)*100+n+1}))});});
  await assert.rejects(t.client.resources({id:'10',title:'源'}),/分页大小/);
});
