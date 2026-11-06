const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const requireBrowser = process.env.BROWSER_TOOLS_DIR ? createRequire(path.join(path.resolve(process.env.BROWSER_TOOLS_DIR), 'package.json')) : require;
const { chromium } = requireBrowser('playwright');
const root = path.resolve(__dirname, '..', 'extension'), origin = 'https://bfo.test';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const shared = new Map(), errors = [], requests = [];
    let selectionWrites = 0, holdReads = false, releaseRead;
    const gate = new Promise(resolve => { releaseRead = resolve; });
    await context.exposeBinding('testExtension', async (_source, action, value) => {
      if (action === 'get') return value === null ? Object.fromEntries(shared) : { [value]: shared.get(value) };
      if (action === 'set') { for (const [key, entry] of Object.entries(value)) { shared.set(key, entry); if (key === 'selection:123') selectionWrites++; } return; }
      if (action === 'cookie') return { value: value.name === 'DedeUserID' ? '123' : 'mock-only' };
      if (action === 'message') return { ok: true };
    });
    await context.addInitScript(() => {
      window.chrome = { storage: { local: { get: key => window.testExtension('get', key), set: value => window.testExtension('set', value) } },
        cookies: { get: value => window.testExtension('cookie', value), onChanged: { addListener() {} } },
        runtime: { sendMessage: value => window.testExtension('message', value) }, tabs: { create: async () => ({ id: 1 }) } };
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) {
        const file = path.join(root, url.pathname.slice(1));
        assert(file.startsWith(root + path.sep));
        return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(file) });
      }
      assert.equal(url.origin, 'https://api.bilibili.com');
      requests.push(url.pathname); assert.equal(request.method(), 'GET', 'Selection must never write to Bilibili');
      let data;
      if (url.pathname.endsWith('list-all')) data = { list: Array.from({ length: 40 }, (_, index) => ({ id: index + 10, title: `来源 ${String(index + 1).padStart(2, '0')}`, media_count: 1 })) };
      else if (url.pathname.endsWith('resource/list')) {
        if (holdReads) await gate;
        data = { info: { media_count: 1 }, has_more: false, medias: [{ id: Number(url.searchParams.get('media_id')) + 1000, type: 2, title: '测试视频', pubtime: 1, upper: { mid: 7, name: '测试 UP' } }] };
      } else throw new Error(`Unexpected endpoint ${url.pathname}`);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data }) });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/manager.html');
    await page.locator('#connect').click();
    await page.waitForFunction(() => document.querySelectorAll('.folder-row').length === 40);
    const checked = () => page.locator('.folder-row input:checked').evaluateAll(inputs => inputs.map(input => input.closest('.folder-row').dataset.folderId));
    const clear = async () => {
      if (!(shared.get('selection:123') || []).length) return;
      await page.locator('#scope-menu summary').click(); await page.locator('#clear-entire').click();
      assert.equal((shared.get('selection:123') || []).length, 0);
    };
    const bounds = () => page.locator('#folders').evaluate(list => {
      const rect = list.getBoundingClientRect();
      return { x: rect.left + list.clientLeft, y: rect.top + list.clientTop, width: list.clientWidth, height: list.clientHeight };
    });
    const beginRange = async (first, last, modifier) => {
      const a = await page.locator('.folder-row').nth(first).boundingBox(), b = await page.locator('.folder-row').nth(last).boundingBox();
      if (modifier) await page.keyboard.down(modifier);
      await page.mouse.move(a.x + a.width - 15, a.y + 12); await page.mouse.down();
      await page.mouse.move(b.x + 5, b.y + b.height - 12, { steps: 8 });
    };
    const endRange = async modifier => { await page.mouse.up(); if (modifier) await page.keyboard.up(modifier); };

    // Clicks below the drag threshold and keyboard checkbox controls keep their meaning.
    await page.locator('.folder-name').nth(1).click(); assert.deepEqual(await checked(), []);
    await page.locator('.folder-row input').first().click(); assert.deepEqual(await checked(), ['10']);
    await page.locator('.folder-row input').first().press('Space'); assert.deepEqual(await checked(), []);
    const writesBefore = selectionWrites;
    await beginRange(0, 2); await endRange();
    assert.deepEqual(await checked(), ['10', '11', '12']);
    assert.equal(selectionWrites, writesBefore + 1, 'Persist once per completed gesture');
    assert.match(await page.locator('#active-title').innerText(), /来源 02/, 'Dragging must not activate a folder name');

    // Ctrl/Cmd use the initial selection, even when crossing the same rows again.
    await beginRange(0, 2, 'Control');
    const first = await page.locator('.folder-row').first().boundingBox();
    await page.mouse.move(first.x + 5, first.y + first.height - 12, { steps: 4 });
    await endRange('Control'); assert.deepEqual(await checked(), ['11', '12']);
    const saved = [...shared.get('selection:123')], beforeCancel = selectionWrites;
    await beginRange(0, 2); await page.keyboard.press('Escape'); await endRange();
    assert.deepEqual(await checked(), saved); assert.equal(selectionWrites, beforeCancel);
    assert.equal(await page.locator('.folder-selection-box').count(), 0);
    await beginRange(0, 2, 'Meta'); await endRange('Meta'); assert.deepEqual(await checked(), ['10']);

    // Hidden selections survive; the selected-only filter stays stable during dragging.
    await clear(); await page.locator('#search').fill('来源 40'); await page.locator('.folder-row input').check();
    await page.locator('#search').fill('来源 0'); await beginRange(0, 1); await endRange();
    assert.deepEqual(shared.get('selection:123').sort(), ['10', '11', '49']);
    assert.match(await page.locator('#hidden-selection-text').innerText(), /1 个/);
    await page.locator('#search').fill(''); await page.locator('[data-filter=selected]').click();
    await beginRange(0, 1, 'Control'); assert.equal(await page.locator('.folder-row').count(), 3);
    await endRange('Control'); assert.deepEqual(await checked(), ['49']); assert.equal(await page.locator('.folder-row').count(), 1);
    await clear(); await page.locator('[data-filter=all]').click();

    // Hold the pointer still at the bottom edge: off-screen rows must join the box.
    await page.locator('#folders').evaluate(list => { list.scrollTop = 0; });
    let view = await bounds();
    const initialVisible = Math.ceil(view.height / 81), windowY = await page.evaluate(() => scrollY);
    await page.mouse.move(view.x + view.width - 15, view.y + 12); await page.mouse.down();
    await page.mouse.move(view.x + 5, view.y + view.height - 2, { steps: 8 });
    await page.waitForFunction(() => document.querySelector('#folders').scrollTop > 500);
    assert((await checked()).length > initialVisible + 2);
    const output = process.env.BROWSER_ARTIFACTS_DIR;
    if (output) { fs.mkdirSync(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'folder-drag-autoscroll.png') }); }
    await endRange();
    const selectedIds = await checked();
    assert.deepEqual(selectedIds, Array.from({ length: selectedIds.length }, (_, index) => String(index + 10)));
    const stopped = await page.locator('#folders').evaluate(list => list.scrollTop);
    await page.waitForTimeout(150); assert.equal(await page.locator('#folders').evaluate(list => list.scrollTop), stopped);
    assert.equal(await page.evaluate(() => scrollY), windowY, 'Only the folder list should scroll');

    // At the real bottom the rectangle must not extend the scrollable content.
    await clear(); await page.locator('#folders').evaluate(list => { list.scrollTop = list.scrollHeight; });
    view = await bounds();
    const heightBefore = await page.locator('#folders').evaluate(list => list.scrollHeight);
    await page.mouse.move(view.x + view.width - 15, view.y + view.height - 50); await page.mouse.down();
    await page.mouse.move(view.x + 5, view.y + view.height + 10, { steps: 6 });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#folders').evaluate(list => list.scrollHeight), heightBefore);
    await page.keyboard.press('Escape'); await endRange();

    // Scroll upwards from the bottom, then cancel without persisting the draft.
    await clear(); await page.locator('#folders').evaluate(list => { list.scrollTop = list.scrollHeight; });
    view = await bounds(); const bottom = await page.locator('#folders').evaluate(list => list.scrollTop);
    await page.mouse.move(view.x + view.width - 15, view.y + view.height - 12); await page.mouse.down();
    await page.mouse.move(view.x + 5, view.y + 2, { steps: 8 });
    await page.waitForFunction(value => document.querySelector('#folders').scrollTop < value - 400, bottom);
    assert((await checked()).length > initialVisible);
    await page.keyboard.press('Escape'); await endRange(); assert.deepEqual(await checked(), []);

    // Native wheel scrolling while a rectangle is held also updates its content coordinates.
    await page.locator('#folders').evaluate(list => { list.scrollTop = 0; });
    view = await bounds();
    await page.mouse.move(view.x + view.width - 15, view.y + 12); await page.mouse.down();
    await page.mouse.move(view.x + 5, view.y + view.height / 2, { steps: 6 });
    const beforeWheel = (await checked()).length;
    await page.mouse.wheel(0, 320); await page.waitForTimeout(200);
    assert((await checked()).length > beforeWheel); await endRange();

    // The right-edge native scrollbar area is not a selection start target,
    // whether Chromium renders a classic gutter or an overlay scrollbar.
    await clear(); await page.locator('#folders').evaluate(list => { list.scrollTop = 0; });
    const gutter = await page.locator('#folders').evaluate(list => {
      const rect = list.getBoundingClientRect();
      return { x: rect.right - 2, y: rect.top };
    });
    await page.mouse.move(gutter.x, gutter.y + 10); await page.mouse.down();
    await page.mouse.move(gutter.x, gutter.y + 100, { steps: 5 }); await page.mouse.up();
    assert.deepEqual(await checked(), []); assert.equal(await page.locator('.folder-selection-box').count(), 0);

    // Pointer cancellation and lost focus roll back rather than committing a draft.
    await page.locator('#folders').evaluate(list => { list.scrollTop = 0; });
    const beforeInterrupted = selectionWrites;
    await beginRange(0, 2);
    await page.locator('#folders').evaluate(list => list.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
    await endRange(); assert.deepEqual(await checked(), []); assert.equal(selectionWrites, beforeInterrupted);
    await beginRange(0, 2); await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await endRange(); assert.deepEqual(await checked(), []); assert.equal(selectionWrites, beforeInterrupted);
    assert.equal(requests.length, 1, 'All selection/filter/scroll gestures are local');

    // A task locks selection, but the list remains available for read-only viewing.
    await clear(); await page.locator('#folders').evaluate(list => { list.scrollTop = 0; });
    await page.locator('.folder-row input').first().check(); holdReads = true;
    await page.locator('#generate').click(); await page.waitForFunction(() => document.querySelector('.folder-row input').disabled);
    await beginRange(0, 2); await endRange(); assert.deepEqual(await checked(), ['10']);
    assert.equal(await page.locator('.folder-selection-box').count(), 0);
    holdReads = false; releaseRead(); await page.locator('#preview').waitFor({ state: 'visible' });
    await beginRange(0, 2); await page.keyboard.press('Escape'); await endRange();
    assert(await page.locator('#review').isEnabled()); assert(await page.locator('#preview').isVisible());
    await beginRange(0, 2); await endRange(); assert(await page.locator('#selection').isVisible());
    assert.deepEqual(await checked(), ['10', '11', '12']);

    // The same component works inside the narrow-screen directory dialog.
    await clear(); await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#folders-open').click(); await page.locator('#directory-dialog').waitFor({ state: 'visible' });
    await page.locator('#folders').evaluate(list => { list.scrollTop = 0; });
    view = await bounds();
    await page.mouse.move(view.x + view.width - 15, view.y + 12); await page.mouse.down();
    await page.mouse.move(view.x + 5, view.y + view.height - 2, { steps: 8 });
    await page.waitForFunction(() => document.querySelector('#folders').scrollTop > 200);
    assert(await page.locator('.folder-selection-box').isVisible());
    const modalSelection = await checked(); await page.keyboard.press('Escape'); await endRange();
    assert(modalSelection.length > 2); assert(await page.locator('#directory-dialog').isVisible()); assert.deepEqual(await checked(), []);

    // A real touch scroll is ignored by the mouse rectangle handler.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await page.locator('#folders').evaluate(list => { list.scrollTop = 0; }); view = await bounds();
    const touch = (y) => [{ x: view.x + view.width / 2, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(view.y + view.height - 30) });
    for (let step = 1; step <= 5; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(view.y + view.height - 30 - step * 25) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => document.querySelector('#folders').scrollTop > 0);
    assert.deepEqual(await checked(), []); assert.equal(await page.locator('.folder-selection-box').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS folder selection: click/Space preserved; additive rectangle; Ctrl/Cmd toggle and reverse drag; Escape rollback; one save per gesture; hidden selections and stable filtering; stationary auto-scroll both directions; wheel coordinates; busy lock; preview invalidation; dialog selection; native touch scroll; no selection API requests.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
