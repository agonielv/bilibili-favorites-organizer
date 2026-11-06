import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../extension/lib/planner.js';
import { makeItem, MemoryClient } from './memory-client.mjs';
import { executePlan } from '../extension/lib/runner.js';
import { ApiError } from '../extension/lib/request.js';
import { RequestQueue } from '../extension/lib/request.js';
import { BiliClient } from '../extension/lib/client.js';

test('equal target/source counts inherit left-list names and preview old-name changes', () => {
  const sources = [{ id: '10', title: '电影' }, { id: '11', title: '纪录片' }];
  const items = [makeItem(1), makeItem(2, '11')];
  const plan = buildPlan(items, { group: false, keep: false, capacity: 1, naming: 'inherit' }, sources, sources);
  assert.deepEqual(plan.chunks.map(chunk => chunk.name), ['电影','纪录片']);
  assert.deepEqual(plan.sourceRenames, [{ id: '10', from: '电影', to: '电影旧' }, { id: '11', from: '纪录片', to: '纪录片旧' }]);
});
test('fewer targets inherit the first names without renaming any old source', () => {
  const sources = [{ id: '11', title: '先选来源' }, { id: '10', title: '后选来源' }, { id: '12', title: '空夹' }];
  const plan = buildPlan([makeItem(1), makeItem(2, '11')], { group: false, capacity: 1000, naming: 'inherit' }, sources, sources);
  assert.deepEqual(plan.chunks.map(chunk => [chunk.name,chunk.inheritedFrom]), [['先选来源','11']]);
  assert.deepEqual(plan.sourceRenames, []);
});
test('extra targets use configured names after the inherited prefix', () => {
  const sources = [{ id: '10', title: '动画' }];
  const plan = buildPlan([makeItem(1),makeItem(2),makeItem(3)], { capacity: 1, keep: false, naming: 'inherit', base: '新收藏' }, sources, sources);
  assert.deepEqual(plan.chunks.map(chunk => chunk.name), ['动画','新收藏-2','新收藏-3']);
  assert.deepEqual(plan.sourceRenames, [{ id:'10',from:'动画',to:'动画旧' }]);
});
test('old-name markers fit limits, avoid collisions and remain visible in the plan', () => {
  const title = '长'.repeat(20), sources = [{id:'10',title}], existing = [...sources,{id:'11',title:'长'.repeat(19)+'旧'}];
  const plan = buildPlan([makeItem(1)], { naming:'inherit' }, sources, existing);
  assert.equal(plan.chunks[0].name, title);
  assert.equal(plan.sourceRenames[0].to, '长'.repeat(17)+'旧-2');
  assert.equal(Array.from(plan.sourceRenames[0].to).length,20);
});
test('custom naming preserves the previous behavior and rejects unknown naming rules', () => {
  const plan = buildPlan([makeItem(1)], {}, [{id:'10',title:'来源'}], [{id:'11',title:'UP聚合'}]);
  assert.equal(plan.chunks[0].name,'UP聚合-2'); assert.deepEqual(plan.sourceRenames,[]);
  assert.throws(()=>buildPlan([makeItem(1)],{naming:'unknown'}),/规则无效/);
});
test('invalid inherited names are rejected during the read-only preview', () => {
  for (const title of ['', '长'.repeat(21), '名称\u0001']) {
    assert.throws(()=>buildPlan([makeItem(1)],{naming:'inherit'},[{id:'10',title}]),/来源收藏夹名称/);
  }
});
test('confirmed inheritance renames the old folders and preserves all editable settings', async () => {
  const sources=[{id:'10',title:'电影'},{id:'11',title:'纪录片'}],items=[makeItem(1),makeItem(2,'11')],client=new MemoryClient(items);
  sources.forEach((source,index)=>Object.assign(client.data.get(source.id),{title:source.title,intro:'保留简介'+index,cover:'https://image.example/'+index,privacy:index?'public':'private'}));
  const plan=buildPlan(items,{capacity:1,keep:false,naming:'inherit'},sources,sources);
  const result=await executePlan(client,plan);
  assert.equal(result.verified,2); assert.equal(result.sourceRenamed.length,2);
  assert.deepEqual(result.created.map(folder=>folder.title),['电影','纪录片']);
  sources.forEach((source,index)=>{
    const actual=client.data.get(source.id);
    assert.equal(actual.title,source.title+'旧'); assert.equal(actual.intro,'保留简介'+index);
    assert.equal(actual.cover,'https://image.example/'+index); assert.equal(actual.privacy,index?'public':'private');
    assert.equal(actual.items.length,0);
  });
});
test('fewer inherited targets leave source names and retained duplicates untouched', async () => {
  const sources=[{id:'10',title:'甲'},{id:'11',title:'乙'}],items=[makeItem(1),makeItem(1,'11')],client=new MemoryClient(items);
  sources.forEach(source=>{client.data.get(source.id).title=source.title;});
  const result=await executePlan(client,buildPlan(items,{naming:'inherit'},sources,sources));
  assert.equal(result.created[0].title,'甲'); assert.equal(result.verified,1);
  assert.equal(client.data.get('10').title,'甲'); assert.equal(client.data.get('11').title,'乙');
  assert.deepEqual(client.data.get('11').items.map(item=>item.id),['1']);
  assert(!client.events.some(event=>event.type==='rename'));
});
test('a source name changed since preview blocks inheritance before any write', async () => {
  const sources=[{id:'10',title:'原名'}],items=[makeItem(1)],client=new MemoryClient(items);
  client.data.get('10').title='手动改过';
  await assert.rejects(executePlan(client,buildPlan(items,{naming:'inherit'},sources,sources)),/名称已变化/);
  assert(!client.events.some(event=>['create','move','rename'].includes(event.type)));
});
test('a new collision with an approved old-folder name blocks every write', async () => {
  const sources=[{id:'10',title:'电影'}],items=[makeItem(1)],client=new MemoryClient(items);
  client.data.get('10').title='电影';
  const plan=buildPlan(items,{naming:'inherit'},sources,sources);
  client.data.set('99',{id:'99',title:'电影旧',items:[]});
  await assert.rejects(executePlan(client,plan),/名称.*已被占用/);
  assert(!client.events.some(event=>['create','move','rename'].includes(event.type)));
});
test('an ambiguous rename is recorded and never retried or followed by movement', async () => {
  const sources=[{id:'10',title:'电影'}],items=[makeItem(1)],client=new MemoryClient(items),rename=client.rename.bind(client);
  client.data.get('10').title='电影';
  client.rename=async(...args)=>{await rename(...args);throw new ApiError('模拟超时',{ambiguousWrite:true});};
  await assert.rejects(executePlan(client,buildPlan(items,{naming:'inherit'},sources,sources)),error=>{
    assert.equal(error.state.pendingRename.id,'10'); assert.equal(error.state.sourceRenamed.length,0);
    assert.match(error.message,/实际结果待核对/); return error.cause.ambiguousWrite;
  });
  assert.equal(client.events.at(-1).type,'rename');
  assert.equal(client.events.filter(event=>event.type==='rename').length,1);
  assert(!client.events.some(event=>['create','move'].includes(event.type)));
});
test('all source settings are read before renaming and a later metadata failure causes zero writes', async () => {
  const sources=[{id:'10',title:'甲'},{id:'11',title:'乙'}],items=[makeItem(1),makeItem(2,'11')],client=new MemoryClient(items),info=client.folderInfo.bind(client);
  sources.forEach(source=>{client.data.get(source.id).title=source.title;});
  client.folderInfo=folder=>folder.id==='11'?Promise.reject(new Error('设置不完整')):info(folder);
  await assert.rejects(executePlan(client,buildPlan(items,{naming:'inherit',capacity:1,keep:false},sources,sources)),/设置不完整/);
  assert(!client.events.some(event=>['create','move','rename'].includes(event.type)));
});
test('a failure after an earlier verified rename reports exactly which source already changed', async () => {
  const sources=[{id:'10',title:'甲'},{id:'11',title:'乙'}],items=[makeItem(1),makeItem(2,'11')],client=new MemoryClient(items),rename=client.rename.bind(client);
  sources.forEach(source=>{client.data.get(source.id).title=source.title;});
  client.rename=async(folder,...args)=>{if(folder.id==='11')throw new Error('第二次改名拒绝');return rename(folder,...args);};
  await assert.rejects(executePlan(client,buildPlan(items,{naming:'inherit',capacity:1,keep:false},sources,sources)),error=>{
    assert.deepEqual(error.state.sourceRenamed,[{id:'10',from:'甲',to:'甲旧'}]);
    return /不会自动撤销/.test(error.message)&&error.state.pendingRename.id==='11';
  });
  assert.equal(client.data.get('10').title,'甲旧'); assert.equal(client.data.get('11').title,'乙');
  assert(!client.events.some(event=>['create','move'].includes(event.type)));
});
test('real client rename sends original privacy, intro and cover with no payload retries', async () => {
  const calls=[],saved=new Map();let now=1000;
  const queue=new RequestQueue({now:()=>now,sleep:async ms=>{now+=ms;},storage:{get:async key=>saved.get(key),set:async(key,value)=>saved.set(key,value)},fetcher:async(url,init)=>{
    calls.push({url,init});return {ok:true,status:200,headers:{get:()=>null},json:async()=>({code:0,data:init.method==='GET'?{id:10,title:'电影',attr:3,intro:'简介原文',cover:'https://image.example/cover'}:null})};
  }});
  const client=new BiliClient(queue,async()=>({uid:'123',csrf:'test-only'}));
  const metadata=await client.folderInfo({id:'10',title:'电影'});
  await client.rename({id:'10',title:'电影'},'电影旧',metadata);
  const form=new URLSearchParams(calls[1].init.body);
  assert.equal(new URL(calls[1].url).pathname,'/x/v3/fav/folder/edit');
  assert.equal(form.get('title'),'电影旧');assert.equal(form.get('privacy'),'1');assert.equal(form.get('intro'),'简介原文');assert.equal(form.get('cover'),'https://image.example/cover');assert.equal(form.get('csrf'),'test-only');
  assert.equal(calls.length,2);
});
test('incomplete or conflicting source metadata cannot be submitted for renaming', async () => {
  const original={id:10,title:'电影',intro:'',cover:'',attr:0};
  for (const info of [{...original,id:11},{...original,title:''},{...original,intro:null},{...original,cover:null},{...original,attr:undefined},{...original,privacy:'1'}]) {
    const client=new BiliClient(null,null); client.request=async()=>info;
    await assert.rejects(client.folderInfo({id:'10',title:'电影'}),/返回不完整/);
  }
});
test('a rename with changed settings stops before creating or moving any target', async () => {
  const items=[makeItem(1)],source={id:'10',title:'电影'},client=new MemoryClient(items),rename=client.rename.bind(client);
  Object.assign(client.data.get('10'),{title:'电影',privacy:'private'});
  client.rename=async(...args)=>{await rename(...args);client.data.get('10').privacy='public';};
  await assert.rejects(executePlan(client,buildPlan(items,{naming:'inherit'},[source],[source])),error=>{
    assert.equal(error.state.sourceRenamed.length,0); assert.equal(error.state.pendingRename.id,'10');
    return /设置核对未通过/.test(error.message);
  });
  assert(!client.events.some(event=>['create','move'].includes(event.type)));
});
