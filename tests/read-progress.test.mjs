import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadProgress } from '../extension/lib/read-progress.js';
import { buildPlan } from '../extension/lib/planner.js';
import { executePlan } from '../extension/lib/runner.js';
import { MemoryClient, makeItem } from './memory-client.mjs';
import { formatDuration } from '../extension/lib/duration.js';
const sources = [{ id: '10', title: '大来源', count: 1000 }, { id: '11', title: '小来源', count: 1 }];
test('current folder counts and equal-source overall progress are distinct', () => {
  const progress = new ReadProgress(sources);
  progress.update({ folder: sources[0], read: 200, expected: 1000, page: 10 });
  assert.equal(progress.view().current.percent, 20); assert.equal(progress.view().percent, 10);
  assert.equal(progress.view().completed, 0); assert.equal(progress.view().current.page, 10);
  progress.update({ source: sources[0], read: 1000, step: 'complete' });
  assert.equal(progress.view().completed, 1); assert.equal(progress.view().percent, 50);
});
test('receiving all pages never reports the stage complete until source checks pass', () => {
  const progress = new ReadProgress([sources[0]]);
  progress.update({ source: sources[0], read: 1000, expected: 1000 });
  assert.equal(progress.view().percent, 99); assert.equal(progress.view().completed, 0);
  progress.update({ source: sources[0], read: 1000, step: 'complete' });
  assert.equal(progress.view().percent, 100); assert.equal(progress.view().completed, 1);
});
test('cached sources count as complete without pretending they were read again', () => {
  const progress = new ReadProgress(sources, new Map([['10', 997]]));
  assert.equal(progress.view().percent, 50); assert.equal(progress.view().completed, 1);
  assert.equal(progress.view().current.id, '11');
  progress.update({ source: sources[1], read: 1, step: 'complete' });
  assert.equal(progress.view().percent, 100);
});
test('empty and unknown totals remain truthful and accept actual page totals', () => {
  const empty = { id: '1', title: '空夹', count: 0 }, progress = new ReadProgress([empty]);
  assert.equal(progress.view().percent, 0);
  progress.update({ source: empty, read: 0, expected: 0 });
  assert.equal(progress.view().percent, 99);
  progress.update({ source: empty, read: 0, step: 'complete' });
  assert.equal(progress.view().percent, 100);
  const unknown = new ReadProgress([{ id: '1', title: '未知' }]);
  assert.equal(unknown.view().current.percent, null);
  unknown.update({ source: empty, read: 20, expected: 100 });
  assert.equal(unknown.view().percent, 20);
});
test('execution emits distinct source-reading stages without adding any writes', async () => {
  const items = [makeItem(1), makeItem(2, '11')], client = new MemoryClient(items), events = [];
  await executePlan(client, buildPlan(items, {}), { onProgress: state => { if (state.reading) events.push(structuredClone(state.reading)); } });
  for (const kind of ['preflight', 'sources']) {
    assert.deepEqual(events.filter(event => event.kind === kind && event.step === 'complete').map(event => event.source.id), ['10','11']);
    assert.equal(events.filter(event => event.kind === kind && event.step === 'start').length, 2);
  }
  assert.equal(client.events.filter(event => event.type === 'create').length, 1);
  assert.equal(client.events.filter(event => event.type === 'move').length, 2);
});
test('a mismatched source never emits a completed preflight source', async () => {
  const items = [makeItem(1)], client = new MemoryClient(items), events = [];
  client.data.get('10').items[0].publishedAt++;
  await assert.rejects(executePlan(client, buildPlan(items, {}), { onProgress: state => { if (state.reading) events.push(state.reading); } }), /已变化/);
  assert(events.some(event => event.step === 'start'));
  assert(!events.some(event => event.step === 'complete'));
  assert(!client.events.some(event => event.type === 'create' || event.type === 'move'));
});
test('elapsed time changes units at minute/hour boundaries and includes the remaining seconds', () => {
  for (const [seconds, expected] of [[0,'0 秒'],[59,'59 秒'],[60,'1 分 0 秒'],[61,'1 分 1 秒'],
    [1327,'22 分 7 秒'],[3599,'59 分 59 秒'],[3600,'1 小时 0 分 0 秒'],[3661,'1 小时 1 分 1 秒'],[86400,'24 小时 0 分 0 秒']]) {
    assert.equal(formatDuration(seconds), expected);
  }
});
test('elapsed time floors fractional seconds and handles invalid or negative values', () => {
  assert.equal(formatDuration(61.9), '1 分 1 秒');
  for (const value of [-1, NaN, Infinity, undefined]) assert.equal(formatDuration(value), '0 秒');
});
test('repeated reads restart the current folder instead of leaving a previous 100% displayed', () => {
  const progress = new ReadProgress([sources[0]]);
  progress.update({ source: sources[0], read: 1000, step: 'complete' });
  progress.update({ source: sources[0], read: 0, expected: null, step: 'start' });
  assert.equal(progress.view().completed, 0); assert.equal(progress.view().percent, 0);
  assert.equal(progress.view().current.page, 0); assert.equal(progress.view().current.percent, null);
});
test('every target verification page reports progress and only exact matches complete a target', async () => {
  const items = Array.from({ length: 400 }, (_, i) => makeItem(i + 1)), client = new MemoryClient(items);
  const plan = buildPlan(items, { capacity: 200, keep: false }), resources = client.resources.bind(client), events = [];
  client.resources = async (folder, onPage = () => {}) => {
    const actual = await resources(folder);
    for (let offset = 0; offset < actual.length; offset += 20) onPage({ folder, page: offset / 20 + 1, read: Math.min(offset + 20, actual.length), expected: actual.length });
    return actual;
  };
  const result = await executePlan(client, plan, { onProgress(state) {
    if (state.reading?.kind !== 'targets') return;
    events.push(state.reading);
    if (state.reading.step === 'complete') {
      const index = state.created.findIndex(folder => folder.id === state.reading.source.id);
      assert.deepEqual(client.data.get(state.reading.source.id).items.map(item => item.id), plan.chunks[index].items.map(item => item.id));
    }
  } });
  assert.equal(result.verified, 400);
  for (const target of result.created) {
    const pages = events.filter(event => event.source.id === target.id && event.step === 'page');
    assert.deepEqual(pages.map(event => event.page), Array.from({ length: 10 }, (_, i) => i + 1));
    assert.deepEqual(pages.map(event => event.read), Array.from({ length: 10 }, (_, i) => (i + 1) * 20));
    assert.equal(events.filter(event => event.source.id === target.id && event.step === 'complete').length, 1);
  }
});
test('failed target reads retain page progress and never emit successful target completion', async () => {
  const items = Array.from({ length: 80 }, (_, i) => makeItem(i + 1)), client = new MemoryClient(items);
  const resources = client.resources.bind(client), events = [];
  client.resources = async (folder, onPage = () => {}) => {
    if (folder.id !== '10') {
      onPage({ folder, page: 1, read: 20, expected: 80 });
      throw new Error('模拟核对分页中断');
    }
    return resources(folder);
  };
  await assert.rejects(executePlan(client, buildPlan(items, {}), { onProgress: state => { if (state.reading?.kind === 'targets') events.push(state.reading); } }), /分页中断/);
  assert(events.some(event => event.step === 'page' && event.read === 20));
  assert(!events.some(event => event.step === 'complete'));
});
