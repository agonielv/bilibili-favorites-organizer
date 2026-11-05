import { ApiError } from '../extension/lib/request.js';
const key = item => `${item.id}:${item.type}`;
export class MemoryClient {
  constructor(items, options = {}) {
    this.options = options; this.data = new Map(); this.events = []; this.requests = 0; this.nextId = 100000; this.moves = 0;
    for (const item of items) {
      if (!this.data.has(item.sourceId)) this.data.set(item.sourceId, { id: item.sourceId, title: '源'+item.sourceId, items: [] });
      this.data.get(item.sourceId).items.push({ ...item });
    }
  }
  async folders() { this.requests++; return [...this.data.values()].map(f => ({ id:f.id,title:f.title,count:f.items.length })); }
  async create(title,privacy) {
    this.requests++; this.events.push({ type:'create',title,privacy });
    const folder = { id:String(this.nextId++),title,privacy,items:[] }; this.data.set(folder.id,folder); return {id:folder.id,title};
  }
  async resources(folder) {
    const f=this.data.get(folder.id); if(!f)throw Error('missing folder');
    this.requests+=Math.max(1,Math.ceil(f.items.length/(this.options.pageSize??100))); this.events.push({type:'read',id:f.id});
    return f.items.map(i=>({...i,sourceId:f.id,sourceTitle:f.title}));
  }
  async inspect(folder) {
    this.requests++; const f=this.data.get(folder.id);this.events.push({type:'head',id:f.id});
    return { count:f.items.length,items:f.items.slice(0,this.options.pageSize??100).map(i=>({...i,sourceId:f.id,sourceTitle:f.title})) };
  }
  async move(operation,targetId) {
    this.requests++;this.moves++;
    this.events.push({type:'move',sourceId:operation.sourceId,targetId,ids:operation.items.map(i=>i.id)});
    if(this.options.failMoveAt===this.moves)throw new ApiError('响应超时',{ambiguousWrite:true});
    if(this.options.riskAt===this.moves)throw new ApiError('限流',{rateLimited:true});
    const source=this.data.get(operation.sourceId),target=this.data.get(targetId);
    if(!source||!target)throw Error('missing source/target');
    let wanted=operation.items;
    const over=wanted.length>(this.options.maxBatch??100);
    if(over&&!this.options.partialReject)throw new ApiError('参数错误',{rejected:true,code:-400});
    if(over)wanted=wanted.slice(0,1);
    if(this.options.partialSuccess&&wanted.length>1)wanted=wanted.slice(0,Math.max(1,Math.floor(wanted.length/2)));
    const incoming=[];
    for(const item of wanted){const i=source.items.findIndex(candidate=>key(candidate)===key(item));if(i<0)throw Error('DUPLICATE OR MISSING MOVE '+key(item));incoming.push(source.items.splice(i,1)[0]);}
    if(this.options.order==='display'&&incoming.length>1)target.items.unshift(...incoming);
    else if(this.options.order==='arbitrary'&&incoming.length>1)target.items.unshift(...[...incoming].sort((a,b)=>Number(a.id)-Number(b.id)));
    else {for(const item of incoming)target.items.unshift(item);}
    if(this.options.hiddenTail&&incoming.length>20){const prefix=target.items.slice(0,20);target.items=[...prefix,...target.items.slice(20,incoming.length).reverse(),...target.items.slice(incoming.length)];}
    if(over)throw new ApiError('部分应用后拒绝',{rejected:true,code:-400});
    return {};
  }
}
export const makeItem=(id,source='10',up='7',pub=id)=>({id:String(id),type:2,title:'视频'+id,sourceId:String(source),sourceTitle:'源'+source,uploaderId:String(up),uploaderName:'UP'+up,publishedAt:pub,favoredAt:id});
