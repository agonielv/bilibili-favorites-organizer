import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadProgress } from '../extension/lib/read-progress.js';
import { buildPlan } from '../extension/lib/planner.js';
import { executePlan } from '../extension/lib/runner.js';
import { MemoryClient, makeItem } from './memory-client.mjs';
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
