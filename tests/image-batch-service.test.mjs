import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioService } from '../electron/service.mjs';

async function fixture(t, runner) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-excel-service-'));
  const image = path.join(dir, 'reference.png');
  await fs.writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bWQAAAAASUVORK5CYII=', 'base64'));
  const service = await StudioService.create({ dataDir: dir, providerRunner: runner });
  await service.updateSettings({ paused: true, providers: [{ id: 'vision', name: 'fixture', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1', model: 'fixture' }], bindings: { vision: 'vision' } });
  t.after(async () => { await service.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const entry = (code, extra = {}) => ({ excelRow: 2, errors: [], values: { code, name: '导入行', sourceMode: 'single', sourcePaths: [image], count: 1, ratio: 'source', resolution: '1K', templateId: service.state.settings.defaultTemplateId }, ...extra });
  return { service, dir, entry };
}

test('Excel import preserves manual text, applies explicit reverse instructions, and never creates image jobs', async t => {
  const calls = [];
  const { service, entry, dir } = await fixture(t, async (operation, payload) => { calls.push({ operation, payload }); return { text: '第一张图片的参考描述' }; });
  const manual = entry('A01', { autoDescribe: true }); manual.values.referencePrompt = '手工内容\n保留换行';
  const result = await service.importImageBatch('test-import', [manual, entry('A02', { autoDescribe: true, describeInstructions: '只描述主体' }), entry('A03')]);
  assert.equal(result.importedCount, 3); assert.equal(result.describedCount, 1);
  assert.equal(calls.length, 1); assert.equal(calls[0].operation, 'describe'); assert.match(calls[0].payload.prompt, /只描述主体/);
  assert.equal(service.state.rows[0].referencePrompt, '手工内容\n保留换行');
  assert.equal(service.state.rows[2].referencePrompt, ''); assert.equal(service.state.jobs.length, 0);
  const again = await service.importImageBatch('test-import', []); assert.deepEqual(again, result); assert.equal(calls.length, 1);
  await service.close();
  const restored = await StudioService.create({ dataDir: dir, providerRunner: () => { throw new Error('must not call'); } });
  assert.equal(restored.state.rows.length, 3); assert.equal(restored.state.rows[1].referencePrompt, '第一张图片的参考描述');
  assert.deepEqual(await restored.importImageBatch('test-import', []), result); await restored.close();
});

test('Excel reverse failure saves rows and retries only eligible empty text without duplicate import', async t => {
  let calls = 0;
  const { service, entry } = await fixture(t, async () => { calls++; if (calls === 1) throw new Error('fixture unavailable'); return { text: '恢复后的描述' }; });
  const first = await service.importImageBatch('retry-import', [entry('B01', { autoDescribe: true }), entry('B02')]);
  assert.equal(first.importedCount, 2); assert.equal(first.reverseFailures.length, 1);
  assert.equal(service.state.rows.length, 2);
  await service.importImageBatch('retry-import', []); assert.equal(calls, 1);
  const retried = await service.retryImageBatchDescribe(first.importedIds);
  assert.equal(retried.describedCount, 1); assert.equal(calls, 2);
  await service.retryImageBatchDescribe(first.importedIds); assert.equal(calls, 2);
});

test('Excel import is atomic when numbering changes and concurrent confirmation is idempotent', async t => {
  let release; let calls = 0; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { service, entry } = await fixture(t, async () => { calls++; started(); await new Promise(resolve => { release = resolve; }); return { text: '描述' }; });
  await service.saveRow({ code: 'C01' });
  await assert.rejects(service.importImageBatch('collision', [entry('C02'), entry('C01')]), /已存在/);
  await assert.rejects(service.importImageBatch('alias-collision', [entry('C1.')]), /已存在/);
  assert.equal(service.state.rows.length, 1);
  const first = service.importImageBatch('double', [entry('C02', { autoDescribe: true })]);
  const second = service.importImageBatch('double', [entry('C02', { autoDescribe: true })]);
  await ready;
  const row = service.state.rows[1];
  await assert.rejects(service.retryImageBatchDescribe([row.id]), /正在反推/);
  await assert.rejects(service.deleteRows([row.id]), /正在自动反推/);
  release(); assert.deepEqual(await first, await second);
  assert.equal(calls, 1); assert.equal(service.state.rows.length, 2);
});

test('Blank automatic descriptions are errors and remain eligible for retry', async t => {
  let calls = 0;
  const { service, entry } = await fixture(t, async () => ({ text: ++calls === 1 ? ' \n ' : '真实返回的描述' }));
  const first = await service.importImageBatch('empty-description', [entry('E01', { autoDescribe: true })]);
  assert.equal(first.describedCount, 0); assert.equal(first.reverseFailures.length, 1);
  assert.equal(service.state.rows[0].referencePrompt, '');
  assert.equal((await service.retryImageBatchDescribe(first.importedIds)).describedCount, 1);
});

test('Manual edits during automatic reverse are preserved and interrupted work never auto-runs on startup', async t => {
  let release; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { service, entry, dir } = await fixture(t, async () => { started(); await new Promise(resolve => { release = resolve; }); return { text: '不能覆盖手工输入' }; });
  const pending = service.importImageBatch('manual-during', [entry('D01', { autoDescribe: true })]);
  await ready;
  await service.saveRow({ ...service.state.rows[0], referencePrompt: '手工新描述' });
  release(); await pending;
  assert.equal(service.state.rows[0].referencePrompt, '手工新描述');
  assert.equal(service.state.rows[0].batchImport.status, 'skipped');
  service.state.rows[0].batchImport.status = 'running'; service.changed(); await service.close();
  let unexpected = 0;
  const restored = await StudioService.create({ dataDir: dir, providerRunner: () => { unexpected++; } });
  assert.equal(restored.state.rows[0].batchImport.status, 'error'); assert.equal(unexpected, 0); await restored.close();
});
