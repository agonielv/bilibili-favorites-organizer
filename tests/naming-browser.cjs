const { createRequire } = require('node:module');
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const assert = require('node:assert/strict');
const requireBrowser = process.env.BROWSER_TOOLS_DIR ? createRequire(path.join(path.resolve(process.env.BROWSER_TOOLS_DIR), 'package.json')) : require;
const { chromium } = requireBrowser('playwright');
const root = path.resolve(__dirname, '..', 'extension'), origin = 'https://bfo.test';
const media = id => ({ id, type: 2, title: `视频${id}`, pubtime: id, upper: { mid: 7, name: '示例UP' } });
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    for (const scenario of [{ name: 'equal', capacity: 2, expected: ['电影','纪录片'], rename: true },
      { name: 'fewer', capacity: 1000, expected: ['电影'], rename: false },
      { name: 'extra', capacity: 1, expected: ['电影','纪录片','新整理-3','新整理-4','新整理-5','新整理-6'], rename: true },
      { name: 'ambiguous', capacity: 2, expected: ['电影','纪录片'], rename: true, ambiguous: true }]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, timezoneId: 'Asia/Shanghai' });
      const saved = new Map(), writes = [], errors = [];
      const folders = new Map([['10', { id: 10, title: '电影', intro: '电影简介', cover: 'https://image.example/a', privacy: '1', medias: [media(1),media(2),{...media(99),attr:9,title:'已失效视频'}] }],
        ['11', { id: 11, title: '纪录片', intro: '纪录片简介', cover: 'https://image.example/b', privacy: '0', medias: [media(2),media(3),media(4)] }]]);
      if (scenario.name === 'extra') folders.get('11').medias.push(media(5),media(6));
      let nextId = 20;
      await context.exposeBinding('testExtension', async (_source, action, value) => {
        if (action === 'get') return { [value]: saved.get(value) };
        if (action === 'set') { for (const [key,item] of Object.entries(value)) saved.set(key,item); return; }
        if (action === 'cookie') return { value: value.name === 'DedeUserID' ? '123' : 'mock-only' };
        if (action === 'message') return { ok: true };
      });
      await context.addInitScript(() => {
        let clock = Date.now(); Date.now = () => clock; window.advanceNamingClock = () => { clock += 1500; };
        window.chrome = { storage: { local: { get: key => window.testExtension('get',key), set: value => window.testExtension('set',value) } },
          cookies: { get: value => window.testExtension('cookie',value), onChanged: { addListener() {} } }, runtime: { sendMessage: value => window.testExtension('message',value) }, tabs: { create: async () => ({id:1}) } };
      });
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === origin) {
          const file = path.join(root,url.pathname.slice(1)); assert(file.startsWith(root+path.sep));
          return route.fulfill({ contentType: file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(file) });
        }
        assert.equal(url.origin,'https://api.bilibili.com'); await req.frame().evaluate(()=>window.advanceNamingClock());
        let data;
        if (url.pathname.endsWith('list-all')) data = { list: [...folders.values()].map(folder=>({id:folder.id,title:folder.title,media_count:folder.medias.length})) };
        else if (url.pathname.endsWith('resource/list')) {
          const folder=folders.get(url.searchParams.get('media_id'));assert(folder);
          data={info:{media_count:folder.medias.length},has_more:false,medias:folder.medias};
        } else if (url.pathname.endsWith('folder/info')) {
          const folder=folders.get(url.searchParams.get('media_id'));assert(folder);
          data={id:folder.id,title:folder.title,intro:folder.intro,cover:folder.cover,privacy:folder.privacy};
        } else if (url.pathname.endsWith('folder/edit')) {
          const form=new URLSearchParams(req.postData()),folder=folders.get(form.get('media_id'));assert(folder);
          assert.equal(form.get('intro'),folder.intro);assert.equal(form.get('cover'),folder.cover);assert.equal(form.get('privacy'),folder.privacy);
          writes.push({type:'rename',id:folder.id,to:form.get('title')});folder.title=form.get('title');
          if(scenario.ambiguous)return route.abort('failed'); data=null;
        } else if(url.pathname.endsWith('folder/add')) {
          const form=new URLSearchParams(req.postData()),id=nextId++;writes.push({type:'create',id});
          folders.set(String(id),{id,title:form.get('title'),privacy:form.get('privacy'),intro:'',cover:'',medias:[]});data={id};
        } else if(url.pathname.endsWith('resource/move')) {
          const form=new URLSearchParams(req.postData()),source=folders.get(form.get('src_media_id')),target=folders.get(form.get('tar_media_id'));
          const ids=form.get('resources').split(',').map(resource=>Number(resource.split(':')[0]));
          for(const id of ids){const index=source.medias.findIndex(item=>item.id===id);assert(index>=0);target.medias.unshift(source.medias.splice(index,1)[0]);}
          writes.push({type:'move',ids});data=null;
        } else throw Error('Unexpected endpoint '+url.pathname);
        return route.fulfill({contentType:'application/json',body:JSON.stringify({code:0,data})});
      });
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/manager.html');
      await page.locator('#connect').click();await page.waitForFunction(()=>document.querySelectorAll('.folder-row').length===2);
      await page.locator('#select-all').click();await page.locator('#naming-mode').selectOption('inherit');
      await page.locator('#base-name').fill('新整理');await page.locator('#capacity').fill(String(scenario.capacity));await page.locator('#group-enabled').uncheck();
      await page.locator('#generate').click();await page.locator('#preview').waitFor({state:'visible'});
      assert.deepEqual(await page.locator('.plan-name h3').allTextContents(),scenario.expected);
      assert.equal(await page.locator('#source-rename-list li').count(),scenario.rename?2:0);
      assert.equal(writes.length,0,'Preview cannot rename or move');
      await page.locator('#review').click();assert.match(await page.locator('#confirm-naming-summary').innerText(),/继承/);
      assert.equal(await page.locator('#confirm-renames li').count(),scenario.rename?2:0);
      assert.deepEqual(await page.locator('#confirm-target-names li span:first-child').allTextContents(),scenario.expected.map((name,index)=>`${index+1}. ${name}`));
      await page.locator('#cancel').click();assert.equal(writes.length,0,'Cancelling cannot rename or move');
      if(scenario.name==='equal') {
        const output=process.env.BROWSER_ARTIFACTS_DIR||path.join(os.tmpdir(),'bfo-naming-artifacts');fs.mkdirSync(output,{recursive:true});
        await page.locator('.main-center').evaluate(element=>{element.scrollTop=0;});
        await page.screenshot({path:path.join(output,'naming-preview.png'),fullPage:true});
        await page.setViewportSize({width:390,height:844});await page.locator('#review').click();
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.locator('#confirm').evaluate(element=>{element.scrollTop=0;});
        await page.screenshot({path:path.join(output,'naming-confirm-mobile.png')});
        await page.locator('#cancel').click();await page.setViewportSize({width:1440,height:1080});
      }
      await page.locator('#review').click();await page.locator('#execute').click();
      if(scenario.ambiguous) {
        await page.waitForFunction(()=>document.querySelector('#execution-title').textContent==='任务已停止');
        assert.equal(writes.length,1);assert.equal(writes[0].type,'rename');assert.match(await page.locator('#error').innerText(),/实际结果待核对/);
      } else {
        await page.waitForFunction(()=>document.querySelector('#execution-title').textContent==='整理完成');
        assert.deepEqual([...folders.values()].filter(folder=>folder.id>=20).map(folder=>folder.title),scenario.expected);
        assert.equal(folders.get('10').title,scenario.rename?'电影旧':'电影');assert.equal(folders.get('11').title,scenario.rename?'纪录片旧':'纪录片');
        assert.equal(folders.get('10').intro,'电影简介');assert.equal(folders.get('11').privacy,'0');assert.equal(folders.get('10').cover,'https://image.example/a');
        assert.deepEqual(folders.get('10').medias.map(item=>item.id),[99]);assert.deepEqual(folders.get('11').medias.map(item=>item.id),[2]);
      }
      assert.deepEqual(errors,[]);await context.close();
    }
    console.log('PASS inherited naming: equal/fewer/extra target counts; exact mapping preview and confirmation; cancel zero writes; retained duplicates/unavailable; privacy/intro/cover preservation; ambiguous rename no replay; narrow confirmation.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1)});
