const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'bilibili_fav_auto_sort.user.js'), 'utf8');
const bootstrap = source.lastIndexOf('  try {\n    createControlPanel(runSortTask);');
assert(bootstrap > 0, 'Locate the userscript bootstrap for testing its unmodified functions');

// Expose the IIFE's functions only in this VM; no test hooks are shipped in the userscript.
function runtime(respond, storage = new Map()) {
  let now = 1_000_000;
  const calls = [];
  const dialogs = [];
  const progress = [];
  let active = 0;
  let maxActive = 0;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    URLSearchParams,
    Date: Clock,
    console: { log() {}, error() {} },
    setTimeout(callback, ms) { now += ms; callback(); },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: { cookie: 'bili_jct=test-only' },
    location: { pathname: '/123/favlist', reload() { assert.fail('Cancellation must never reload'); } },
    async fetch(url, init) {
      active++;
      maxActive = Math.max(maxActive, active);
      const call = { url: new URL(url), init, at: now };
      calls.push(call);
      try {
        await Promise.resolve();
        return await respond(call, calls);
      } finally { active--; }
    },
  });
  vm.runInContext(`${source.slice(0, bootstrap)}
    globalThis.api = { requestJson, withRetry, fetchFolderResources, runSortTask,
      setDialog(fn) { showMessageDialog = fn; } };
  })();`, context);
  context.api.setDialog(async options => { dialogs.push(options); return false; });
  return {
    api: context.api, calls, dialogs, progress, storage,
    advance(ms) { now += ms; },
    get maxActive() { return maxActive; },
    run(options = {}) {
      return context.api.runSortTask({ folderNames: ['源A', '源B'], newFolderBaseName: '整理',
        targetFolderSize: 1000, onProgress: p => progress.push(p), ...options });
    },
  };
}

function response(data = {}, { status = 200, retryAfter = null, code = 0, message = '' } = {}) {
  return { ok: status >= 200 && status < 300, status, statusText: 'mock',
    headers: { get: name => name === 'Retry-After' ? retryAfter : null },
    async json() { return { code, message, data }; } };
}

function media(id) { return { id, title: `视频${id}`, pubtime: id, upper: { mid: 7, name: 'UP' } }; }
function fixture(call) {
  if (call.url.pathname.endsWith('list-all')) return response({ list: [{ id: 10, title: '源A' }, { id: 11, title: '源B' }] });
  if (call.url.pathname.endsWith('resource/list')) {
    const folder = call.url.searchParams.get('media_id');
    const pn = call.url.searchParams.get('pn');
    const medias = folder === '11' ? [media(4)] : pn === '1' ? [media(1), media(2)] : [media(3)];
    return response({ info: { media_count: folder === '11' ? 1 : 3 }, has_more: folder === '10' && pn === '1', medias });
  }
  if (call.url.pathname.endsWith('folder/add')) return response({ id: 20 });
  if (call.url.pathname.endsWith('resource/move')) return response();
  assert.fail(`Unexpected request: ${call.url}`);
}

test('concurrent callers are serialized and all API starts are at least 1200ms apart', async () => {
  const r = runtime(() => response());
  await Promise.all([1, 2, 3].map(i => r.api.requestJson(`https://api.bilibili.com/${i}`)));
  assert.equal(r.maxActive, 1);
  assert.deepEqual(r.calls.map(c => c.at), [1_000_000, 1_001_200, 1_002_400]);
});

test('cancel after multi-folder paginated preview performs no writes, reload, or extra report', async () => {
  const r = runtime(fixture);
  const result = await r.run();
  assert.equal(result.cancelled, true);
  assert.equal(r.calls.length, 4);
  assert(r.calls.every(c => !c.init.method));
  assert.match(r.dialogs[0].message, /4 个视频移动到 1 个新收藏夹/);
  assert.equal(r.dialogs.length, 1);
  assert.equal(r.progress.at(-1).phase, '已取消');
  assert.deepEqual(r.calls.slice(1).map(c => c.url.searchParams.get('media_id')), ['10', '10', '11']);
  for (let i = 1; i < r.calls.length; i++) assert(r.calls[i].at - r.calls[i - 1].at >= 1200);
  await r.run();
  assert.equal(r.calls.length, 8, 'A cancelled task does not leave the queue stuck');
});

for (const status of [412, 429]) {
  test(`HTTP ${status} stops queued calls and retries; cooldown survives a page reload`, async () => {
    const r = runtime(() => response({}, { status, retryAfter: '120' }));
    const results = await Promise.allSettled([1, 2, 3].map(i =>
      r.api.withRetry(() => r.api.requestJson(`https://api.bilibili.com/${i}`), 'test')));
    assert(results.every(result => result.status === 'rejected' && result.reason.rateLimited));
    assert.equal(r.calls.length, 1);
    const reloaded = runtime(() => response(), r.storage);
    await assert.rejects(reloaded.api.requestJson('https://api.bilibili.com/test'), /120 秒/);
    assert.equal(reloaded.calls.length, 0);
    reloaded.advance(120_000);
    await reloaded.api.requestJson('https://api.bilibili.com/test');
    assert.equal(reloaded.calls.length, 1);
  });
}

test('Retry-After HTTP date is honored', async () => {
  const r = runtime(() => response({}, { status: 429, retryAfter: new Date(1_180_000).toUTCString() }));
  await assert.rejects(r.api.requestJson('https://api.bilibili.com/test'), /180 秒/);
});

for (const code of [-352, -412, -509, 429]) {
  test(`API risk code ${code} stops reading all remaining source folders`, async () => {
    const r = runtime(call => call.url.pathname.endsWith('resource/list') ? response({}, { code }) : fixture(call));
    await assert.rejects(r.run(), e => e.rateLimited && e.code === code);
    assert.equal(r.calls.length, 2);
    assert.equal(r.dialogs.length, 0);
  });
}

test('a transient failure retries only the failed page, not earlier pages', async () => {
  let secondPageAttempts = 0;
  const r = runtime(call => {
    if (call.url.searchParams.get('pn') === '2' && ++secondPageAttempts === 1) return response({}, { status: 503 });
    return fixture(call);
  });
  const result = await r.api.fetchFolderResources(10, '源A');
  assert.equal(result.medias.length, 3);
  assert.deepEqual(r.calls.map(c => c.url.searchParams.get('pn')), ['1', '2', '2']);
});

test('repeating or incomplete pages stop without creating a partial plan', async () => {
  for (const medias of [[media(1)], []]) {
    const r = runtime(call => call.url.pathname.endsWith('resource/list')
      ? response({ info: { media_count: 3 }, has_more: true, medias }) : fixture(call));
    await assert.rejects(r.run(), /分页未返回新视频|读取不完整/);
    assert(r.calls.length <= 3);
    assert.equal(r.dialogs.length, 0);
    assert(r.calls.every(c => !c.init.method));
  }
});

for (const endpoint of ['folder/add', 'resource/move']) {
  test(`rate limit during ${endpoint} stops the task without fallback or later writes`, async () => {
    const r = runtime(call => call.url.pathname.endsWith(endpoint) ? response({}, { status: 429 }) : fixture(call));
    r.api.setDialog(async () => true);
    await assert.rejects(r.run(), /已停止请求/);
    assert.equal(r.calls.filter(c => c.url.pathname.endsWith(endpoint)).length, 1);
    assert(r.calls.at(-1).url.pathname.endsWith(endpoint));
  });
}

test('HTTP permission errors do not retry', async () => {
  const r = runtime(() => response({}, { status: 403 }));
  await assert.rejects(r.api.withRetry(() => r.api.requestJson('https://api.bilibili.com/test'), 'test'), /HTTP 403/);
  assert.equal(r.calls.length, 1);
});

test('confirmed task still creates a private folder, moves in reverse display order, and reports success', async () => {
  const r = runtime(fixture);
  r.api.setDialog(async options => { r.dialogs.push(options); return true; });
  await r.run();
  const writes = r.calls.filter(c => c.init.method === 'POST');
  assert.equal(writes.length, 5);
  assert.equal(new URLSearchParams(writes[0].init.body).get('privacy'), '1');
  assert.deepEqual(writes.slice(1).map(c => new URLSearchParams(c.init.body).get('resources')), ['1:2', '2:2', '3:2', '4:2']);
  assert.match(r.dialogs.at(-1).message, /成功 4\/4，失败 0/);
});
