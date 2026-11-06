// Uses the shipped HTML/CSS/modules with a test-only chrome API shim.
// Managed cloud Chromium blocks unpacked installs; this is NOT an install test.
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const os = require('node:os');
const vm = require('node:vm');
const requireBrowser = process.env.BROWSER_TOOLS_DIR ? createRequire(path.join(path.resolve(process.env.BROWSER_TOOLS_DIR), 'package.json')) : require;
const { chromium } = requireBrowser('playwright');
const root = path.resolve(__dirname, '..', 'extension');
const origin = 'https://bfo.test';
const shared = new Map();
let session = { uid: '123', csrf: 'mock-only' }, openRequests = 0;
let backendDisplayOrder = false;
let simulateLongScan = false;
let holdReads=false, readGate, releaseRead, holdVerification=false, verificationGate, releaseVerification, targetFullReads=0;
let rateLimit = false, requests = [], writes = [], nextId = 20;
const initial = [
  { id: 101, title: '<img src=x onerror=alert(1)>', pubtime: 100, upper: { mid: 7, name: 'Alpha' } },
  { id: 102, title: 'Alpha 新', pubtime: 300, upper: { mid: 7, name: 'Alpha' } },
  { id: 103, title: 'Beta 中', pubtime: 200, upper: { mid: 8, name: 'Beta' } },
  { id: 104, title: 'Alpha 中', pubtime: 200, upper: { mid: 7, name: 'Alpha' } },
  { id: 105, title: 'Beta 新', pubtime: 400, upper: { mid: 8, name: 'Beta' } },
  { id: 106, title: 'Beta 旧', pubtime: 100, upper: { mid: 8, name: 'Beta' } },
];
const unavailable = { id: 107, type: 2, attr: 9, title: '已失效视频', upper: null, pubtime: 0 };
let folders = new Map();
function resetData() { folders = new Map([['10',{id:10,title:'源 A',medias:[initial[0],initial[1],initial[3],unavailable]}],['11',{id:11,title:'源 B',medias:[initial[2],initial[4],initial[5]]}]]); nextId = 20; }
resetData();
async function checkBackground() {
  let listener, onClick, created = 0, updated = 0, rules;
  const url = 'chrome-extension://testid/manager.html';
  const chrome = { runtime: { id:'testid',getURL:()=>url,getContexts:async()=>created?[{tabId:1,windowId:2}]:[],onMessage:{addListener:fn=>{listener=fn}} },
    tabs:{create:async()=>{created++},update:async()=>{updated++}},windows:{update:async()=>{}},action:{onClicked:{addListener:fn=>{onClick=fn}}},
    declarativeNetRequest:{updateSessionRules:async value=>{rules=value}} };
  vm.runInNewContext(fs.readFileSync(path.join(root,'background.js'),'utf8'), {chrome,URL,console});
  const message=(value,sender)=>new Promise(resolve=>{const held=listener(value,sender,resolve);if(!held)resolve(null)});
  assert.equal(await message({type:'OPEN_MANAGER'},{id:'foreign',url}),null);
  await message({type:'OPEN_MANAGER'},{id:'testid',url});
  await message({type:'OPEN_MANAGER'},{id:'testid',url:'https://space.bilibili.com/123/favlist'});
  assert.equal(created,1);assert.equal(updated,1);
  assert.equal((await message({type:'PREPARE_TRANSPORT'},{id:'testid',url})).ok,true);
  assert.equal(rules.addRules[0].condition.initiatorDomains[0],'testid');
  assert.equal(await message({type:'OPEN_MANAGER'},{id:'testid',url:'https://space.bilibili.com/123/video'}),null);
  assert.equal(typeof onClick,'function');
}
(async()=>{
await checkBackground();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try {
 const context=await browser.newContext({viewport:{width:1440,height:1050},timezoneId:'Asia/Shanghai'});
 await context.exposeBinding('testExtension', async (_source, action, value) => {
  if(action==='getStorage')return value===null?Object.fromEntries(shared):Object.fromEntries((typeof value==='string'?[value]:value).filter(k=>shared.has(k)).map(k=>[k,shared.get(k)]));
  if(action==='setStorage'){for(const [k,v]of Object.entries(value))shared.set(k,v);return;}
  if(action==='removeStorage'){for(const k of typeof value==='string'?[value]:value)shared.delete(k);return;}
  if(action==='cookie')return session?{name:value.name,value:value.name==='DedeUserID'?session.uid:session.csrf}:null;
  if(action==='message'){if(value.type==='OPEN_MANAGER')openRequests++;return {ok:true};}
  if(action==='tab')return {id:1};
 });
 await context.addInitScript(()=>{
  window.chrome={storage:{local:{get:key=>window.testExtension('getStorage',key),set:value=>window.testExtension('setStorage',value),remove:key=>window.testExtension('removeStorage',key)}},
   cookies:{get:value=>window.testExtension('cookie',value),onChanged:{addListener:fn=>{window.testCookieChanged=fn}}},
   runtime:{sendMessage:value=>window.testExtension('message',value)},tabs:{create:value=>window.testExtension('tab',value)}};
 });
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin===origin){
   const file=path.join(root,url.pathname.slice(1)||'manager.html');
   if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'not found'});
   const type=file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html';
   return route.fulfill({contentType:type,headers:{'Content-Security-Policy':"script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"},body:fs.readFileSync(file)});
  }
  if(url.origin==='https://space.bilibili.com')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><h1>模拟空间页</h1></body></html>'});
  if(url.origin!=='https://api.bilibili.com')return route.abort();
  if(simulateLongScan)await req.frame().evaluate(()=>window.advanceBfoTestClock(1200));
  requests.push({url:req.url(),at:Date.now(),method:req.method()});
  if(rateLimit&&url.pathname.endsWith('resource/list'))return route.fulfill({status:429,headers:{'Retry-After':'60'},body:'limited'});
  let data;
  if(url.pathname.endsWith('list-all'))data={list:[...folders.values()].map(f=>({id:f.id,title:f.title,media_count:f.medias.length}))};
  else if(url.pathname.endsWith('resource/list')){const f=folders.get(url.searchParams.get('media_id'));assert(f);const page=Number(url.searchParams.get('pn'));if(holdReads&&Number(f.id)<20)await readGate;if(holdVerification&&Number(f.id)>=20&&f.medias.length===6&&++targetFullReads===2)await verificationGate;data={info:{media_count:f.medias.length},has_more:page*20<f.medias.length,medias:f.medias.slice((page-1)*20,page*20)};}
  else if(url.pathname.endsWith('folder/add')){const form=new URLSearchParams(req.postData());assert.equal(form.get('csrf'),'mock-only');const id=nextId++;folders.set(String(id),{id,title:form.get('title'),privacy:form.get('privacy'),medias:[]});data={id};writes.push({type:'create',privacy:form.get('privacy')});}
  else if(url.pathname.endsWith('resource/move')){const form=new URLSearchParams(req.postData());const source=folders.get(form.get('src_media_id')),target=folders.get(form.get('tar_media_id'));assert(source&&target);const ids=form.get('resources').split(',').map(s=>Number(s.split(':')[0]));const incoming=[];for(const id of ids){const index=source.medias.findIndex(m=>m.id===id);assert(index>=0);incoming.push(source.medias.splice(index,1)[0]);}if(backendDisplayOrder)target.medias.unshift(...incoming);else for(const media of incoming)target.medias.unshift(media);writes.push({type:'move',ids});data={};}
  else throw new Error('Unexpected endpoint '+url.pathname);
  return route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':origin,'access-control-allow-credentials':'true'},body:JSON.stringify({code:0,data})});
 });
 const output=process.env.BROWSER_ARTIFACTS_DIR||path.join(os.tmpdir(),'bfo-browser-artifacts');fs.mkdirSync(output,{recursive:true});
 const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));if(process.env.DEBUG_BROWSER){page.on('console',m=>{if(m.type()==='error')console.log('browser:',m.text())});page.on('requestfailed',r=>console.log('failed:',r.url(),r.failure()?.errorText));}
 await page.goto(origin+'/manager.html');await page.waitForFunction(()=>document.querySelector('#account-label').textContent.includes('已登录'));
 assert.equal(requests.length,0,'Opening must not scan');
 await page.locator('#connect').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已读取 2') || document.querySelector('#error').textContent.length > 0);
 assert.equal(await page.locator('#error').innerText(),'');
 await page.locator('#search').fill('源 A');await page.locator('#select-all').click();assert.equal(await page.locator('#selection-count').innerText(),'已选 1 个','Filtered select-all must select the visible source only');
 const listReads=requests.length;
 await page.locator('#search').fill('');await page.locator('.folder-name').last().click();assert.equal(await page.locator('#selection-count').innerText(),'已选 1 个','Viewing is independent of selection');assert.equal(requests.length,listReads,'Viewing must not scan');
 const firstCheck=page.locator('.folder-row input').first();await firstCheck.focus();await page.keyboard.press('Space');assert.equal(await firstCheck.evaluate(el=>document.activeElement===el),true,'Selection must preserve keyboard focus');await page.keyboard.press('Space');
 await page.locator('#select-all').click();await page.locator('#search').fill('源 A');assert.match(await page.locator('#hidden-selection-text').innerText(),/1 个/);await page.locator('#bottom-scope').click();assert.match(await page.locator('#scope-list').innerText(),/源 B/);await page.locator('[data-close="scope-dialog"]').click();await page.locator('#clear-search').click();
 await page.screenshot({path:path.join(output,'extension-workspace.png'),fullPage:true});
 holdReads=true;readGate=new Promise(resolve=>releaseRead=resolve);await page.locator('#generate').click();await page.waitForFunction(()=>document.querySelector('#generate').disabled);
 assert(await page.locator('#search').isEnabled());assert(await page.locator('#nav-help').isEnabled());assert(await firstCheck.isDisabled());
 await page.locator('#nav-help').click();await page.locator('#help-back').click();holdReads=false;releaseRead();
 await page.locator('#preview').waitFor({state:'visible'});assert.equal(await page.locator('#video-total').innerText(),'6');
 assert.match(await page.locator('#unavailable-summary').innerText(),/共读取 7 条收藏.*6 条可移动.*1 条已失效/);
 await page.locator('#unavailable-details summary').click();
 assert.match(await page.locator('#unavailable-sources').innerText(),/源 A：1 条/);
 await page.screenshot({path:path.join(output,'extension-preview.png'),fullPage:true});
 const reads=requests.length;
 await page.locator('#review').click();assert.match(await page.locator('#confirm-sources').innerText(),/源 A/);assert.match(await page.locator('#confirm-sources').innerText(),/源 B/);await page.screenshot({path:path.join(output,'extension-confirmation.png'),fullPage:true});await page.locator('#cancel').click();assert.equal(writes.length,0);assert.equal(await page.locator('#preview').isVisible(),true);
 await page.locator('#back').click();await firstCheck.uncheck();await firstCheck.check();
 await page.locator('#capacity').fill('1001');await page.locator('#generate').click();assert.equal(await page.locator('#capacity').getAttribute('aria-invalid'),'true');assert.match(await page.locator('#capacity-error').innerText(),/1–1000/);await page.locator('#capacity').fill('1000');
 await page.locator('[name=time-order][value=asc]').check();await page.locator('#generate').click();await page.locator('#preview').waitFor({state:'visible'});assert.equal(requests.length,reads,'Rule changes reuse snapshot');
 const times=await page.locator('.plan-card').first().locator('.video-row').evaluateAll(es=>es.map(e=>Number(e.dataset.publishedAt)));assert.deepEqual(times,[100,200,300]);
 assert.equal(await page.locator('.plan-list img').count(),0,'API titles must be rendered as text');
 await page.locator('#review').click();await page.keyboard.press('Escape');assert.equal(writes.length,0);
 // Public visibility is explicit in confirmation; reset to private for the run.
 await page.locator('#back').click();await page.locator('#privacy').selectOption('public');await page.locator('#generate').click();await page.locator('#review').click();assert.match(await page.locator('#confirm-summary').innerText(),/公开/);await page.locator('#cancel').click();await page.locator('#back').click();await page.locator('#reset-rules').click();await page.locator('#generate').click();
 holdVerification=true;verificationGate=new Promise(resolve=>releaseVerification=resolve);
 await page.locator('#review').click();await page.locator('#execute').click();await page.waitForFunction(()=>document.querySelector('#execution-title').textContent==='核对完整展示顺序');
 assert.match(await page.locator('#progress-text').innerText(),/6 \/ 6/);assert.match(await page.locator('#verified-text').innerText(),/0 \/ 6/);assert(!((await page.locator('#status').innerText()).includes('尚未创建')));assert(await page.locator('#nav-help').isEnabled());assert(await page.locator('#search').isEnabled());
 await page.locator('.folder-name').first().click();await page.locator('#source-dialog').waitFor({state:'visible'});assert.match(await page.locator('#active-meta').innerText(),/任务前样本/);await page.locator('[data-close="source-dialog"]').click();
 await page.screenshot({path:path.join(output,'extension-moving.png'),fullPage:true});
 holdVerification=false;releaseVerification();await page.waitForFunction(()=>document.querySelector('#execution-title').textContent==='整理完成',{},{timeout:30000});
 assert.equal(writes.filter(w=>w.type==='move').length,3);assert(writes.some(w=>w.type==='move'&&w.ids.length>1));assert.equal(writes[0].privacy,'1');assert.deepEqual(folders.get('20').medias.map(m=>m.id),[102,104,101,105,103,106]);assert(await page.locator('#review').isDisabled());
 assert(requests.every((r,i)=>!i||r.at-requests[i-1].at>=1100),'Production queue must actually pace requests');
 assert.equal(await page.locator('#selection-total').innerText(),'1','Successful execution must synchronize counts including retained unavailable videos');
 assert.deepEqual(folders.get('10').medias.map(media=>media.id),[107]);
 assert.match(await page.locator('#execution-message').innerText(),/1 条失效收藏已保留在原夹/);
 await page.screenshot({path:path.join(output,'extension-execution.png'),fullPage:true});
 // Exercise staging + payload-direction calibration through the shipped page/modules.
 const staged=Array.from({length:48},(_,i)=>({id:1001+i,title:'批量示例 '+i,pubtime:(i*7)%48+1,upper:{mid:7,name:'Stage UP'}}));
 folders=new Map([['10',{id:10,title:'源 A',medias:staged.filter((_,i)=>i%2===0)}],['11',{id:11,title:'源 B',medias:staged.filter((_,i)=>i%2===1)}]]);nextId=20;backendDisplayOrder=true;
 await page.locator('#connect').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已读取 2'));
 await page.locator('#select-all').click();await page.locator('#privacy').selectOption('public');await page.locator('#generate').click();await page.locator('#preview').waitFor({state:'visible'});
 await page.locator('#review').click();assert.match(await page.locator('#confirm').innerText(),/私密中转夹/);await page.locator('#execute').click();
 await page.waitForFunction(()=>document.querySelector('#execution-title').textContent==='整理完成',{},{timeout:90000});
 const buffers=[...folders.values()].filter(f=>f.title.startsWith('整理中转-'));assert.equal(buffers.length,1);assert.equal(buffers[0].privacy,'1');assert.equal(buffers[0].medias.length,0);
 assert.equal(folders.get('20').privacy,'0');assert.deepEqual(folders.get('20').medias.map(m=>m.id),[...staged].sort((a,b)=>b.pubtime-a.pubtime).map(m=>m.id));
 assert.match(await page.locator('#execution-message').innerText(),/移动请求/);assert.match(await page.locator('#execution-message').innerText(),/中转夹/);
 backendDisplayOrder=false;
 // Account switch invalidates cached state and never moves.
 session={uid:'456',csrf:'different-test-only'};await page.evaluate(()=>window.testCookieChanged({cookie:{domain:'.bilibili.com',name:'DedeUserID'}}));assert(await page.locator('#review').isDisabled());assert.match(await page.locator('#account-label').innerText(),/变化/);
 session={uid:'123',csrf:'mock-only'};resetData();await page.locator('#connect').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已读取 2') || document.querySelector('#error').textContent.length > 0);
 await page.locator('#select-all').click();rateLimit=true;const before=requests.length;await page.locator('#generate').click();await page.waitForFunction(()=>document.querySelector('#error').textContent.includes('限流'));
 assert.equal(requests.length,before+1);const limited=requests.length;assert(await page.locator('#generate').isDisabled());assert(await page.locator('#cooldown-panel').isVisible());await page.locator('#generate').press('Enter');await page.waitForTimeout(100);assert.equal(requests.length,limited,'Cooldown blocks subsequent requests');assert(shared.get('apiCooldownUntil')>Date.now());
 // Native Web Locks in an ordinary secure page still exercise the production exclusive() path.
 shared.delete('apiCooldownUntil');rateLimit=false;
 await page.evaluate(()=>{window.held=new Promise(resolve=>window.releaseLock=resolve);navigator.locks.request('bfo-api-task',()=>window.held)});
 const other=await context.newPage();await other.goto(origin+'/manager.html');await other.locator('#connect').click();await other.waitForFunction(()=>document.querySelector('#error').textContent.includes('另一个管理页'));await page.evaluate(()=>window.releaseLock());await other.close();
 // Test the shipped content entry on an SPA transition, without actual Bilibili content/network.
 const space=await context.newPage();await space.goto('https://space.bilibili.com/123');await space.addScriptTag({path:path.join(root,'content-entry.js')});assert.equal(await space.locator('#bfo-extension-entry').count(),0);await space.evaluate(()=>history.pushState({},'', '/123/favlist'));await space.locator('#bfo-extension-entry').waitFor();const box=await space.locator('#bfo-extension-entry').boundingBox();await space.mouse.click(box.x+box.width/2,box.y+box.height/2);await page.waitForTimeout(100);assert.equal(openRequests,1);await space.evaluate(()=>history.pushState({},'', '/123/video'));await space.locator('#bfo-extension-entry').waitFor({state:'detached'});
 await page.setViewportSize({width:390,height:844});
 const uiReads=requests.length;await page.locator('#folders-open').click();await page.locator('#directory-dialog').waitFor({state:'visible'});await page.locator('#search').fill('源 A');await page.locator('[data-close="directory-dialog"]').click();await page.locator('#directory-slot #directory-panel').waitFor({state:'attached'});await page.locator('#folders-open').click();assert.equal(await page.locator('#search').inputValue(),'源 A');await page.locator('[data-close="directory-dialog"]').focus();await page.keyboard.press('Escape');await page.locator('#directory-slot #directory-panel').waitFor({state:'attached'});
 await page.locator('#rules-open').click();await page.locator('#privacy').selectOption('public');await page.locator('[data-close="rules-dialog"]').focus();await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement.id==='rules-open');await page.locator('#rules-open').click();assert.equal(await page.locator('#privacy').inputValue(),'public');await page.locator('[data-close="rules-dialog"]').focus();await page.keyboard.press('Escape');await page.locator('#rules-dialog').waitFor({state:'hidden'});assert.equal(requests.length,uiReads,'Local drawers and filters must not call APIs');

 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Management layout must fit a narrow screen');
 await page.screenshot({path:path.join(output,'extension-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.equal([...shared.values()].some(v=>JSON.stringify(v).includes('mock-only')),false,'Tokens must not be persisted');
 // Reproduce the reported 13-folder/11606-record workload through the shipped UI.
 // Advance only the browser's wall clock per simulated API response; request
 // timers and the production queue implementation are unchanged. The real-time
 // pacing assertion above still covers ordinary operation.
 shared.delete('rules'); shared.delete('apiCooldownUntil');
 folders=new Map(Array.from({length:13},(_,index)=>[String(index+10),{id:index+10,title:`大来源 ${index+1}`,medias:[]} ]));
 for(let index=0;index<11606;index++) {
   const lost=index%7===0;
   folders.get(String(Math.floor(index*13/11606)+10)).medias.push({id:20000+index,type:2,attr:lost?9:0,title:lost?'已失效视频':`大视频 ${index}`,pubtime:lost?0:index+1,upper:lost?null:{mid:Math.floor(index/400)+1,name:`UP ${Math.floor(index/400)+1}`}});
 }
 await context.addInitScript(()=>{
   const realNow=Date.now.bind(Date);let offset=0;
   window.advanceBfoTestClock=ms=>{offset+=ms;};Date.now=()=>realNow()+offset;
 });
 simulateLongScan=true;
 const large=await context.newPage();large.on('pageerror',error=>errors.push(error.message));
 await large.goto(origin+'/manager.html');
 await large.locator('#connect').click();await large.waitForFunction(()=>document.querySelector('#status').textContent.includes('已读取 13'));
 await large.locator('#select-all').click();
 const writesBeforeLarge=writes.length;
 await large.locator('#generate').click();await large.locator('#preview').waitFor({state:'visible',timeout:60000});
 assert.equal(await large.locator('#video-total').innerText(),'9,948');
 assert.match(await large.locator('#unavailable-summary').innerText(),/11,606 条收藏.*1,658 条已失效/);
 assert.equal(await large.locator('#unavailable-sources li').count(),13);
 assert.equal(await large.locator('#error').innerText(),'');
 const largeReads=requests.length;
 await large.evaluate(()=>window.advanceBfoTestClock(24*60*60*1000));await large.waitForTimeout(1100);
 assert(await large.locator('#review').isEnabled(),'Review remains available after a long scan and a day of waiting');
 await large.locator('#back').click();await large.locator('[name=time-order][value=asc]').check();
 await large.locator('#generate').click();await large.locator('#preview').waitFor({state:'visible'});
 assert.equal(requests.length,largeReads,'Large rule changes must reuse all cached sources');
 await large.locator('#review').click();assert.match(await large.locator('#confirm-summary').innerText(),/1,658 条失效收藏保留在原夹/);
 await large.locator('#cancel').click();assert.equal(writes.length,writesBeforeLarge);
 // A same-count edit in a cached source is caught before any creation or move.
 folders.get('10').medias[1].id=999999;
 await large.locator('#review').click();await large.locator('#execute').click();
 await large.waitForFunction(()=>document.querySelector('#execution-title').textContent==='任务已停止');
 assert.match(await large.locator('#error').innerText(),/内容或视频状态已变化/);
 assert.equal(writes.length,writesBeforeLarge);
 // An all-unavailable source is still readable; execution is disabled.
 folders=new Map([['10',{id:10,title:'失效来源',medias:[unavailable]}]]);
 await large.locator('#new-task').click();await large.locator('#connect').click();
 await large.waitForFunction(()=>document.querySelector('#status').textContent.includes('已读取 1'));
 await large.locator('#select-all').click();await large.locator('#generate').click();
 await large.locator('#preview').waitFor({state:'visible'});
 assert.equal(await large.locator('#video-total').innerText(),'0');
 assert(await large.locator('#review').isDisabled());assert(await large.locator('#execute').isDisabled());
 assert.match(await large.locator('#unavailable-summary').innerText(),/1 条已失效/);
 assert.equal(writes.length,writesBeforeLarge);assert.deepEqual(errors,[]);
 await large.close();
 console.log('PASS shipped-page integration: no auto-scan; login/list; per-source cache, filtered scope, independent viewing, focus preservation, field validation, read-only browsing, accurate progress, source count sync, responsive drawers and asc/desc; cancellation/Escape; public confirmation; private creation; ordered moves and verification; account invalidation; cooldown; native task lock; SPA entry; background sender validation/single manager; no stored credentials.');
 console.log('LIMITATION: chrome API calls are shimmed; admin policy prevented unpacked installation. Real Chrome/Edge and live Bilibili are not validated.');
 console.log('PASS large-collection UI: 13 sources/11606 records; long scan and 24-hour review without expiry; cached rule changes; unavailable counts/retention; same-count source change stops before writes; all-unavailable preview is read-only.');
} finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
