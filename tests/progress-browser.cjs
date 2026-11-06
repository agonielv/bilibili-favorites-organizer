// Uses actual runtime modules; API responses, clock and Chrome storage are mocked.
const { createRequire } = require('node:module');
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const assert = require('node:assert/strict');
const requireBrowser = process.env.BROWSER_TOOLS_DIR ? createRequire(path.join(path.resolve(process.env.BROWSER_TOOLS_DIR), 'package.json')) : require;
const { chromium } = requireBrowser('playwright');
const root = path.resolve(__dirname, '..', 'extension'), origin = 'https://bfo.test';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    const saved = new Map(), errors = [], requests = [];
    let gate = null, release, fail = false, writes = 0, targetGate = null, releaseTarget, nextId = 20;
    const hold = () => { gate = new Promise(resolve => { release = resolve; }); };
    await context.exposeBinding('testExtension', async (_source, action, value) => {
      if (action === 'get') return { [value]: saved.get(value) };
      if (action === 'set') { for (const [key, item] of Object.entries(value)) saved.set(key, item); return; }
      if (action === 'cookie') return { value: value.name === 'DedeUserID' ? '123' : 'mock-only' };
      if (action === 'message') return { ok: true };
    });
    await context.addInitScript(() => {
      let clock = Date.now();
      Date.now = () => clock; window.advanceProgressClock = (ms = 1500) => { clock += ms; };
      window.setProgressClock = value => { clock = value; };
      window.chrome = { storage: { local: { get: key => window.testExtension('get', key), set: value => window.testExtension('set', value) } },
        cookies: { get: value => window.testExtension('cookie', value), onChanged: { addListener() {} } },
        runtime: { sendMessage: value => window.testExtension('message', value) }, tabs: { create: async () => ({ id: 1 }) } };
    });
    const medias = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, type: 2, title: `视频 ${i + 1}`, pubtime: i + 1, upper: { mid: 7, name: '示例 UP' } }));
    let folders = new Map([['10', { id: 10, title: '拖影', medias: [...medias] }]]);
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === origin) {
        const file = path.join(root, url.pathname.slice(1)); assert(file.startsWith(root + path.sep));
        return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(file) });
      }
      assert.equal(url.origin, 'https://api.bilibili.com');
      requests.push(url.pathname); if (req.method() !== 'GET') writes++;
      await req.frame().evaluate(() => window.advanceProgressClock());
      let data;
      if (url.pathname.endsWith('list-all')) data = { list: [...folders.values()].map(folder => ({ id: folder.id, title: folder.title, media_count: folder.medias.length })) };
      else if (url.pathname.endsWith('resource/list')) {
        const pn = Number(url.searchParams.get('pn')), folder = folders.get(url.searchParams.get('media_id')); assert(folder);
        if (folder.id === 10 && pn === 11 && gate) await gate;
        if (folder.id === 21 && pn === 11 && targetGate) await targetGate;
        if (fail) return route.fulfill({ status: 429, headers: { 'Retry-After': '60' }, body: 'limited' });
        data = { info: { media_count: folder.medias.length }, has_more: pn * 20 < folder.medias.length, medias: folder.medias.slice((pn - 1) * 20, pn * 20) };
      } else if (url.pathname.endsWith('folder/add')) {
        const form = new URLSearchParams(req.postData()), id = nextId++;
        folders.set(String(id), { id, title: form.get('title'), medias: [] }); data = { id };
      } else if (url.pathname.endsWith('resource/move')) {
        const form = new URLSearchParams(req.postData()), source = folders.get(form.get('src_media_id')), target = folders.get(form.get('tar_media_id'));
        for (const resource of form.get('resources').split(',')) {
          const id = Number(resource.split(':')[0]), index = source.medias.findIndex(item => item.id === id); assert(index >= 0);
          target.medias.unshift(source.medias.splice(index, 1)[0]);
        }
        data = {};
      } else throw Error('Unexpected endpoint: ' + url.pathname);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/manager.html');
    assert.equal(await page.locator('#read-progress').isVisible(), false);
    await page.locator('#connect').click(); await page.waitForFunction(() => document.querySelectorAll('.folder-row').length === 1);
    await page.locator('#select-all').click(); hold(); await page.locator('#generate').click();
    await page.waitForFunction(() => document.querySelector('#read-folder-count').textContent === '200 / 1,000 条');
    assert.equal(await page.locator('#read-current').getAttribute('aria-valuenow'), '20');
    assert.equal(await page.locator('#read-overall').getAttribute('aria-valuenow'), '20');
    assert.match(await page.locator('#read-count').innerText(), /0 \/ 1/);
    assert.equal(await page.locator('#read-progress').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#read-folder').innerText(), '拖影');
    assert.match(await page.locator('#read-page').innerText(), /10 页/);
    assert.equal(writes, 0);
    const output = process.env.BROWSER_ARTIFACTS_DIR || path.join(os.tmpdir(), 'bfo-progress-artifacts'); fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'progress-preview.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.locator('#read-overall span').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    await page.locator('#read-progress').screenshot({ path: path.join(output, 'progress-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1080 });
    gate = null; release(); await page.locator('#preview').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#read-progress').getAttribute('data-state'), 'done');
    assert.equal(await page.locator('#read-overall').getAttribute('aria-valuenow'), '100');
    assert.match(await page.locator('#read-title').innerText(), /来源读取完成/);
    assert.equal(await page.locator('#read-progress').getAttribute('aria-busy'), 'false');
    // Cached replanning must not issue requests or flash a fake read progress.
    const beforeCached = requests.length;
    await page.locator('#back').click(); await page.locator('[name=time-order][value=asc]').check();
    await page.locator('#generate').click(); await page.locator('#preview').waitFor({ state: 'visible' });
    assert.equal(requests.length, beforeCached); assert.equal(await page.locator('#read-progress').isVisible(), false);
    hold(); await page.locator('#review').click(); await page.locator('#execute').click();
    await page.waitForFunction(() => document.querySelector('#read-folder-count').textContent === '200 / 1,000 条' && document.querySelector('#read-stage').textContent === '执行前核对');
    assert.equal(await page.locator('#read-current').getAttribute('aria-valuenow'), '20');
    assert.equal(await page.locator('#progress-text').innerText(), '0 / 1,000 条');
    assert.equal(writes, 0);
    await page.screenshot({ path: path.join(output, 'progress-preflight.png'), fullPage: true });
    fail = true; gate = null; release();
    await page.waitForFunction(() => document.querySelector('#execution-title').textContent === '任务已停止');
    assert.equal(await page.locator('#read-progress').getAttribute('data-state'), 'stopped');
    assert.equal(await page.locator('#read-current').getAttribute('aria-valuenow'), '20');
    assert.equal(await page.locator('#read-progress').getAttribute('aria-busy'), 'false');
    assert.match(await page.locator('#read-note').innerText(), /停止时/); assert.equal(writes, 0);
    await page.locator('#new-task').click(); assert.equal(await page.locator('#read-progress').isVisible(), false);
    // Exercise the formerly silent full target scan after actual mocked moves.
    saved.delete('apiCooldownUntil'); fail = false;
    folders = new Map([['10', { id: 10, title: '拖影', medias: [...medias] }], ['12', { id: 12, title: 'UP聚合', medias: [] }]]);
    const verifyPage = await context.newPage(); verifyPage.on('pageerror', error => errors.push(error.message));
    await verifyPage.goto(origin + '/manager.html'); await verifyPage.locator('#connect').click();
    await verifyPage.waitForFunction(() => document.querySelectorAll('.folder-row').length === 2);
    await verifyPage.locator('#capacity').fill('500'); await verifyPage.locator('#keep-uploader').uncheck();
    await verifyPage.locator('#generate').click(); await verifyPage.locator('#preview').waitFor({ state: 'visible' });
    await verifyPage.locator('#review').click();
    targetGate = new Promise(resolve => { releaseTarget = resolve; });
    const started = await verifyPage.evaluate(() => Date.now());
    await verifyPage.locator('#execute').click();
    await verifyPage.waitForFunction(() => document.querySelector('#read-stage').textContent === '目标顺序核对' && document.querySelector('#read-folder').textContent === 'UP聚合-2' && document.querySelector('#read-folder-count').textContent === '200 / 500 条');
    assert.equal(await verifyPage.locator('#read-folder').innerText(), 'UP聚合-2');
    assert.equal(await verifyPage.locator('#read-current').getAttribute('aria-valuenow'), '40');
    assert.equal(await verifyPage.locator('#read-overall').getAttribute('aria-valuenow'), '70');
    assert.match(await verifyPage.locator('#read-count').innerText(), /1 \/ 2/);
    assert.match(await verifyPage.locator('#read-page').innerText(), /10 页/);
    assert.equal(await verifyPage.locator('#verified-text').innerText(), '500 / 1,000 条');
    assert.equal(await verifyPage.locator('#progress-text').innerText(), '1,000 / 1,000 条');
    await verifyPage.evaluate(start => window.setProgressClock(start + 1327 * 1000), started);
    await verifyPage.waitForFunction(() => document.querySelector('#execution-meta').textContent.includes('已用时 22 分 7 秒'));
    await verifyPage.screenshot({ path: path.join(output, 'progress-target.png'), fullPage: true });
    await verifyPage.setViewportSize({ width: 390, height: 844 });
    assert(await verifyPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await verifyPage.locator('#read-progress').screenshot({ path: path.join(output, 'progress-target-mobile.png') });
    await verifyPage.evaluate(start => window.setProgressClock(start + 3661 * 1000), started);
    await verifyPage.waitForFunction(() => document.querySelector('#execution-meta').textContent.includes('已用时 1 小时 1 分 1 秒'));
    targetGate = null; releaseTarget();
    await verifyPage.waitForFunction(() => document.querySelector('#execution-title').textContent === '整理完成');
    assert.equal(await verifyPage.locator('#verified-text').innerText(), '1,000 / 1,000 条');
    assert.deepEqual([...folders.get('20').medias, ...folders.get('21').medias].map(item => item.id), medias.map(item => item.id));
    const finishedMeta = await verifyPage.locator('#execution-meta').innerText();
    await verifyPage.evaluate(() => window.advanceProgressClock(30000)); await verifyPage.waitForTimeout(1100);
    assert.equal(await verifyPage.locator('#execution-meta').innerText(), finishedMeta, 'Finished task elapsed time must stop ticking');
    await verifyPage.close();
    assert.deepEqual(errors, []);
    console.log('PASS read progress: preview/preflight 200/1000 = 20%; overall source denominator; complete vs submitted; cached replan zero requests; stopped progress retained; narrow screen; reduced motion; no writes.');
    console.log('PASS target verification: second target 200/500 = 40%, overall 70% with one of two complete; verification stays incomplete until comparison; minute/hour elapsed units tick during a held request and freeze on completion; all 1000 mocked moves preserve exact order.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
