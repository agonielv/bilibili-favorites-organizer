import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../extension/lib/planner.js';
import { executePlan } from '../extension/lib/runner.js';
import { shouldStage } from '../extension/lib/transfer.js';
import { MemoryClient, makeItem } from './memory-client.mjs';
function dataset(n=180,interleaved=false){return Array.from({length:n},(_,i)=>makeItem(i+1,interleaved?(i%3+10):10,7,((i*37)%n)+1));}
async function run(items,options={},rules={}){
  const plan=buildPlan(items,rules),client=new MemoryClient(items,options);
  const result=await executePlan(client,plan);
  assert.equal(result.verified,items.length);
  for(let i=0;i<plan.chunks.length;i++)assert.deepEqual(client.data.get(result.created[i].id).items.map(i=>i.id),plan.chunks[i].items.map(i=>i.id));
  for(const id of new Set(items.map(i=>i.sourceId)))assert.equal(client.data.get(id).items.length,0);
  if(result.buffer){assert.equal(client.data.get(result.buffer.id).items.length,0);assert.equal(client.data.get(result.buffer.id).privacy,'private');}
  return {result,client,plan};
}
test('batch grows 2 → 20 → 100 after observed prefix/count checks',async()=>{
  const {client,result}=await run(dataset());
  assert.deepEqual(client.events.filter(e=>e.type==='move').slice(0,3).map(e=>e.ids.length),[2,20,100]);
  assert(result.moveRequests<10);assert.equal(result.buffer,null);
});
test('display-order backend is calibrated and retried only after observed resources return to buffer',async()=>{
  const {client,result}=await run(dataset(),{order:'display'});
  assert(result.buffer);assert(result.batchRequests>2);assert(result.moveRequests<30);
  assert(client.events.some(e=>e.type==='move'&&e.targetId===result.buffer.id));
});
test('arbitrary batch ordering is repaired through the buffer and falls back to exact singles',async()=>{
  const {result}=await run(dataset(),{order:'arbitrary'});
  assert(result.buffer);assert(result.moveRequests>=180);
});
test('corruption beyond the sampled head is caught by full pagination and repaired',async()=>{
  const {result}=await run(dataset(),{hiddenTail:true});assert(result.buffer);
});
test('runtime batch limit reduces without repeating already moved resources',async()=>{
  const {result,client}=await run(dataset(),{maxBatch:5});
  assert(result.verified===180);assert(result.moveRequests<100);
  const moves=client.events.filter(e=>e.type==='move');assert(moves.some(e=>e.ids.length===5));
});
test('partial explicit rejection reconciles actual locations before lowering the limit',async()=>{
  await run(dataset(),{maxBatch:5,partialReject:true});
});
test('success with partial application is reconciled without replaying present IDs',async()=>{
  await run(dataset(),{partialSuccess:true});
});
test('interleaved sources use a single shared private buffer across targets',async()=>{
  const items=dataset(360,true);assert(shouldStage(items));
  const {result}=await run(items,{}, {capacity:120,keep:false,privacy:'public'});
  assert(result.buffer);assert(result.created.length===3);assert(result.moveRequests<60);
});
test('unsupported first staging probe is reconciled and abandoned instead of doubling all moves',async()=>{
  const {result}=await run(dataset(180,true),{maxBatch:1});assert(result.moveRequests<200);
});
test('partially applied rejected staging probe returns only observed IDs then abandons staging',async()=>{
  const {result}=await run(dataset(180,true),{maxBatch:1,partialReject:true});assert(result.moveRequests<205);
});
test('ascending and descending stay exact through source mixing, batching and splitting',async()=>{
  for(const time of ['asc','desc'])await run(dataset(240,true),{}, {time,capacity:80,keep:false});
});
for(const riskAt of [1,3,8])test(`risk on request ${riskAt} stops without reconciliation or later API calls`,async()=>{
  const items=dataset(180,true),client=new MemoryClient(items,{riskAt});
  await assert.rejects(executePlan(client,buildPlan(items,{})),e=>e.cause.rateLimited);
  assert.equal(client.events.at(-1).type,'move');assert.equal(client.moves,riskAt);
});
test('ambiguous batch failure is not retried or reconciled automatically',async()=>{
  const items=dataset(),client=new MemoryClient(items,{failMoveAt:3});
  await assert.rejects(executePlan(client,buildPlan(items,{})),e=>e.cause.ambiguousWrite&&e.state.pending>0);
  assert.equal(client.events.at(-1).type,'move');assert.equal(client.moves,3);
});
test('foreign target content is never swept into a repair buffer',async()=>{
  const items=dataset(),client=new MemoryClient(items,{order:'arbitrary'});
  const original=client.inspect.bind(client);let injected=false;
  client.inspect=async folder=>{if(!injected){injected=true;client.data.get(folder.id).items.push(makeItem(99999));}return original(folder)};
  await assert.rejects(executePlan(client,buildPlan(items,{})),/计划外/);
  assert(!client.events.some(e=>e.type==='move'&&e.ids.includes('99999')));
});
test('permanently inconsistent single-item order never reports completion',async()=>{
  const items=dataset(8),client=new MemoryClient(items);
  const original=client.resources.bind(client);
  client.resources=async folder=>{const result=await original(folder);return folder.title==='UP聚合'?[...result].reverse():result};
  await assert.rejects(executePlan(client,buildPlan(items,{})),/顺序仍不一致/);
});

for(const maxBatch of [2,3,4,7,12,37])test(`nested batch-limit negotiation at ${maxBatch} never repeats a consumed segment`,async()=>{
  await run(dataset(180,true),{maxBatch,partialReject:true});
});
test('a copy-like response is not mistaken for a successful move',async()=>{
  const items=dataset(12),client=new MemoryClient(items);
  const original=client.move.bind(client);
  client.move=async(op,id)=>{const before=client.data.get(op.sourceId).items.filter(i=>op.items.some(candidate=>candidate.id===i.id)).map(i=>({...i}));await original(op,id);client.data.get(op.sourceId).items.push(...before);};
  await assert.rejects(executePlan(client,buildPlan(items,{})),/仍在原收藏夹/);
});
for (const staged of [false, true]) test(`duplicates keep their other source memberships (${staged ? 'staged' : 'direct'} transfer)`, async () => {
  const unique = dataset(staged ? 180 : 8, true);
  const duplicates = unique.filter((_, i) => i % 3 === 0).map(item => ({ ...item, sourceId: '11' }));
  const onlyRetained = unique.slice(0, 4).map(item => ({ ...item, sourceId: '99' }));
  const items = [...unique, ...duplicates, ...onlyRetained], plan = buildPlan(items, { capacity: 60, keep: false });
  const client = new MemoryClient(items), result = await executePlan(client, plan);
  assert.equal(result.verified, unique.length);
  for (const { id } of plan.sources) {
    assert.deepEqual(client.data.get(id).items.map(item => item.id), plan.retainedItems.filter(item => item.sourceId === id).map(item => item.id));
  }
  for (let i = 0; i < plan.chunks.length; i++) assert.deepEqual(client.data.get(result.created[i].id).items.map(item => item.id), plan.chunks[i].items.map(item => item.id));
  assert(!client.events.some(event => event.type === 'move' && event.sourceId === '99'));
  if (staged) assert(result.buffer);
});
test('retained-only source count changes stop execution before creating anything', async () => {
  const items = [makeItem(1), makeItem(1, '11')], client = new MemoryClient(items), plan = buildPlan(items, {});
  client.data.get('11').items = [];
  await assert.rejects(executePlan(client, plan), /数量已变化/);
  assert(!client.events.some(event => event.type === 'create' || event.type === 'move'));
});
test('missing retained duplicates are detected during final source verification', async () => {
  const items = [makeItem(1), makeItem(2, '11'), makeItem(1, '11')], client = new MemoryClient(items);
  const original = client.move.bind(client);
  client.move = async (operation, target) => { await original(operation, target); client.data.get('11').items = client.data.get('11').items.filter(item => item.id !== '1'); };
  await assert.rejects(executePlan(client, buildPlan(items, {})), /应保留在来源/);
});
test('a copy-like response is still rejected when the same video is intentionally retained in another source', async () => {
  const items = [makeItem(1), makeItem(2, '11'), makeItem(1, '11')], client = new MemoryClient(items);
  const original = client.move.bind(client);
  client.move = async (operation, target) => {
    const copies = operation.items.map(item => ({ ...item })); await original(operation, target);
    client.data.get(operation.sourceId).items.push(...copies);
  };
  await assert.rejects(executePlan(client, buildPlan(items, {})), /仍在原收藏夹/);
});
test('risk during verification halts after a successful write and reports the pending batch',async()=>{
  const items=dataset(12),client=new MemoryClient(items);
  client.inspect=async()=>{throw Object.assign(new Error('限流'),{rateLimited:true})};
  await assert.rejects(executePlan(client,buildPlan(items,{})),e=>e.cause.rateLimited&&e.state.confirmed===2&&e.state.pending===2);
  assert.equal(client.events.at(-1).type,'move');assert.equal(client.moves,1);
});
test('seeded mixed-source/rule/backend scenarios preserve exact output without losing source records',async()=>{
  let seed=84931;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};
  for(let scenario=0;scenario<100;scenario++){
    const n=10+Math.floor(random()*140),sources=1+Math.floor(random()*5);
    const items=Array.from({length:n},(_,i)=>makeItem(i+1,10+Math.floor(random()*sources),1+Math.floor(random()*8),Math.floor(random()*100)));
    const order=['write','display','arbitrary'][Math.floor(random()*3)];
    await run(items,{order,maxBatch:[1,3,7,13,100][Math.floor(random()*5)],partialReject:random()>.5,hiddenTail:random()>.8},
      {group:random()>.3,keep:false,capacity:1+Math.floor(random()*80),time:random()>.5?'asc':'desc',groupOrder:random()>.5?'count-desc':'count-asc'});
  }
});
