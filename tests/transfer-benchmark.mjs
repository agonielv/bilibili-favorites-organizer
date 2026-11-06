import assert from 'node:assert/strict';
import { buildPlan } from '../extension/lib/planner.js';
import { executePlan } from '../extension/lib/runner.js';
import { MemoryClient, makeItem } from './memory-client.mjs';
const n=6000, output=[];
for(const pageSize of [100,20]) for(const mode of ['连续来源','六源交错']){
  const items=Array.from({length:n},(_,i)=>makeItem(i+1,mode==='连续来源'?Math.floor(i/1000)+10:i%6+10,Math.floor(i/500)+1,i+1));
  const plan=buildPlan(items,{}),client=new MemoryClient(items,{pageSize});
  const result=await executePlan(client,plan);
  for(let i=0;i<plan.chunks.length;i++)assert.deepEqual(client.data.get(result.created[i].id).items.map(i=>i.id),plan.chunks[i].items.map(i=>i.id));
  assert.equal(result.verified,n);
  const singleRequests=1+plan.sources.reduce((sum,source)=>sum+Math.max(1,Math.ceil(source.items.length/20)),0)+plan.chunks.length*2+n+plan.chunks.reduce((s,c)=>s+Math.ceil(c.items.length/20),0)+1+plan.sources.length;
  assert(client.requests<singleRequests/3,'Batching must materially reduce requests including verification');
  output.push({scenario:mode,acceptedPageSize:pageSize,videos:n,baselineMoveRequests:n,moveRequests:result.moveRequests,batchRequests:result.batchRequests,
    baselineExecutionRequests:singleRequests,executionRequests:client.requests,requestReduction:(singleRequests/client.requests).toFixed(2)+'x',
    pacingOnlyMinutes:((client.requests-1)*1.2/60).toFixed(2),buffer:!!result.buffer,exactOrderVerified:true});
}
console.log(JSON.stringify({kind:'deterministic simulator; not live Bilibili; includes execution preflight; excludes initial preview scan and network latency',intervalMs:1200,results:output},null,2));
