import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StudioService } from '../electron/service.mjs';
import { StudioStore } from '../electron/store.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(20)]);
const provider = { id: 'fake', name: '测试服务', protocol: 'openai-images', baseUrl: 'https://example.invalid/v1', model: 'test-image', hasKey: true, timeoutMs: 1000 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, runner, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-service-'));
  const dataDir = path.join(root, 'data');
  const service = await StudioService.create({ dataDir, providerRunner: runner, ...extra });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  await service.updateSettings({ providers: [provider], bindings: { image: 'fake', vision: 'fake', video: 'fake', tts: 'fake' }, autoExport: false, defaultTemplateId: '' });
  return { root, dataDir, service };
}

async function waitFor(service, predicate, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const state = await service.getState();
    if (predicate(state)) return state;
    await delay(10);
  }
  const state = await service.getState();
  throw new Error(`等待任务超时：${JSON.stringify(state.jobs.map(job => ({ status: job.status, error: job.error })))}`);
}

test('首次状态为空，持久化为 SQLite，关闭重开保留设置、行、素材和公式', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let service = await StudioService.create({ dataDir: root });
  assert.deepEqual((await service.getState()).settings.providers, []);
  assert.equal((await service.getState()).settings.concurrency, 10);
  assert.deepEqual((await service.getState()).jobs, []);
  const preset = { id: 'layout', name: '保留布局', text: '保持界面布局。\n修改衣服颜色。' };
  await service.updateSettings({ panelOpen: false, projectName: '真实项目', imageRequestPresets: [preset] });
  const row = await service.saveRow({ name: '原稿', referencePrompt: '人工润色描述', userPrompt: '保留主体', count: 2 });
  const source = path.join(root, 'original.png'); await fs.writeFile(source, PNG);
  const assets = await service.importFiles([source], 'image', '产品');
  await service.saveFormula({ name: 'ABCD', text: '文案公式', sections: { A: '开场' }, voice: 'nova', ratio: '16:9', subtitle: false, openingPath: source, combinations: 4 });
  await service.close();
  assert.equal((await fs.readFile(path.join(root, 'studio.sqlite'))).subarray(0, 16).toString(), 'SQLite format 3\0');
  service = await StudioService.create({ dataDir: root });
  const state = await service.getState();
  assert.deepEqual(state.settings.imageRequestPresets, [preset]);
  assert.equal(state.settings.panelOpen, false); assert.equal(state.settings.projectName, '真实项目');
  assert.equal(state.rows[0].id, row.id); assert.equal(state.assets[0].id, assets[0].id); assert.equal(state.formulas[0].sections.A, '开场');
  assert.equal(state.formulas[0].voice, 'nova'); assert.equal(state.formulas[0].ratio, '16:9'); assert.equal(state.formulas[0].subtitle, false); assert.equal(state.formulas[0].openingPath, source); assert.equal(state.formulas[0].combinations, 4);
  assert.deepEqual(await fs.readFile(source), PNG);
  await service.close();
});

test('差异模型空回复时保留原要求并继续逐张生图', async t => {
  const prompts = [];
  let plans = 0;
  const planGate = Promise.withResolvers();
  const secondImage = Promise.withResolvers();
  const { service } = await fixture(t, async (operation, payload) => {
    if (operation === 'plan') {
      plans++;
      await planGate.promise;
      throw new Error('语言模型没有返回可用文字。');
    }
    prompts.push(payload.prompt);
    if (prompts.length === 2) await secondImage.promise;
    return { images: [{ bytes: PNG }] };
  });
  t.after(() => { planGate.resolve(); secondImage.resolve(); });
  await service.updateSettings({ providers: [provider, { ...provider, id: 'language', protocol: 'openai-chat' }], bindings: { vision: 'language' } });
  const row = await service.saveRow({ name: '空回复回归', count: 2, userPrompt: '只改数字，其他不变' });
  const jobs = await service.enqueueImages([row.id]);
  assert.equal(jobs.length, 2);
  const planning = await waitFor(service, state => state.jobs.every(job => job.status === 'planning'));
  assert.ok(planning.jobs.every(job => job.startedAt && !job.finishedAt));
  planGate.resolve();
  const partial = await waitFor(service, state => state.jobs[0].status === 'succeeded' && state.jobs[1].status === 'running');
  assert.ok(partial.jobs[0].finishedAt);
  assert.match(partial.jobs[0].planningNote, /按原始要求/);
  assert.deepEqual(await fs.readFile(partial.jobs[0].localPath), PNG);
  secondImage.resolve();
  await waitFor(service, state => state.jobs.every(job => job.status === 'succeeded'));
  assert.deepEqual(prompts, ['只改数字，其他不变', '只改数字，其他不变']);
  assert.equal(plans, 1);
});

test('127 个独立槽位和并行的两批提交共享默认全局 10 并发', async t => {
  let running = 0; let maximum = 0; let calls = 0;
  const { service } = await fixture(t, async (operation, payload) => {
    assert.equal(operation, 'image'); assert.equal(payload.count, 1);
    calls++; running++; maximum = Math.max(maximum, running);
    await delay(5); running--; return { images: [{ bytes: PNG, mime: 'image/png' }] };
  });
  const a = await service.saveRow({ name: '批次A', userPrompt: '画红色产品', count: 63 });
  const b = await service.saveRow({ name: '批次B', userPrompt: '画蓝色产品', count: 64 });
  const results = await Promise.all([service.enqueueImages([a.id]), service.enqueueImages([b.id]), service.enqueueImages([a.id])]);
  assert.equal(results[2].length, 0);
  const state = await waitFor(service, state => state.jobs.length === 127 && state.jobs.every(job => job.status === 'succeeded'), 25000);
  assert.equal(calls, 127); assert.ok(maximum <= 10); assert.equal(maximum, 10);
  assert.equal(new Set(state.jobs.map(job => `${job.rowId}:${job.slot}`)).size, 127);
  assert.equal(new Set(state.jobs.map(job => job.localPath)).size, 127);
});

test('提交先验证所有行，拒绝后不会部分入队；暂停可持久化', async t => {
  let calls = 0;
  const { service, dataDir } = await fixture(t, async () => { calls++; return { images: [{ bytes: PNG }] }; });
  await service.setPaused(true);
  const valid = await service.saveRow({ userPrompt: '可用' });
  const invalid = await service.saveRow({ name: '缺提示词' });
  await assert.rejects(service.enqueueImages([valid.id, invalid.id]), /提示词/);
  assert.equal((await service.getState()).jobs.length, 0);
  await service.enqueueImages([valid.id]); await delay(30); assert.equal(calls, 0);
  await service.close();
  const restored = await StudioService.create({ dataDir, providerRunner: async () => { calls++; return { images: [{ bytes: PNG }] }; } });
  assert.equal((await restored.getState()).settings.paused, true);
  await restored.setPaused(false);
  await waitFor(restored, state => state.jobs[0].status === 'succeeded');
  assert.equal(calls, 1); await restored.close();
});

test('只重试失败任务，归档后生成下一批并保留旧成功文件', async t => {
  let calls = 0;
  const { service, dataDir } = await fixture(t, async () => {
    calls++; if (calls === 2) throw new Error('明确的模型参数错误'); return { images: [{ bytes: PNG }] };
  });
  const row = await service.saveRow({ userPrompt: '商品照片', count: 3 });
  await service.enqueueImages([row.id]);
  let state = await waitFor(service, state => state.jobs.length === 3 && state.jobs.every(job => ['succeeded', 'failed'].includes(job.status)));
  const successes = state.jobs.filter(job => job.status === 'succeeded');
  const failed = state.jobs.find(job => job.status === 'failed');
  await service.retryJobs(state.jobs.map(job => job.id));
  state = await waitFor(service, state => state.jobs.length === 4 && state.jobs.every(job => ['succeeded', 'failed'].includes(job.status)));
  assert.equal(calls, 4); assert.equal(state.jobs.find(job => job.id === failed.id).status, 'failed');
  assert.equal(state.jobs.find(job => job.slot === failed.slot && job.id !== failed.id).attempt, 2);
  await Promise.all([service.retryJobs([successes[0].id], { regenerate: true }), service.retryJobs([successes[0].id], { regenerate: true })]);
  assert.equal((await service.enqueueImages([row.id])).length,0);
  await service.archiveImages(row.id);
  const next=await service.enqueueImages([row.id]);
  assert.deepEqual(next.map(job=>job.slot),[0,1,2]);
  state = await waitFor(service, state => state.jobs.length === 7 && state.jobs.at(-1).status === 'succeeded');
  assert.equal(calls, 7); assert.notEqual(state.jobs.at(-1).localPath, successes[0].localPath);
  assert.deepEqual(await fs.readFile(successes[0].localPath), PNG);
  await service.close();
  const reopened=await StudioService.create({dataDir});
  try{
    const archived=(await reopened.getState()).jobs.filter(job=>job.archivedAt);
    assert.equal(archived.length,4);
    assert.equal(new Set(archived.map(job=>job.archiveId)).size,1);
    assert.equal((await reopened.retryJobs([failed.id])).length,0);
  }finally{await reopened.close();}
});

test('失败占位计入数量，重试沿用原参数，删除才以新参数补同一空位', async t=>{
  const requests=[];
  const {service}=await fixture(t,async(_op,payload)=>{
    requests.push(payload.ratio);
    if(payload.ratio==='9:16')throw new Error('明确失败');
    return {images:[{bytes:PNG}]};
  });
  const row=await service.saveRow({name:'补位验证',count:2,ratio:'9:16',userPrompt:'原始要求'});
  const original=await service.enqueueImages([row.id]);
  await waitFor(service,s=>s.jobs.every(job=>job.status==='failed'));
  await service.saveRow({...row,ratio:'3:4'});
  assert.deepEqual(await service.enqueueImages([row.id]),[]);
  const [retry]=await service.retryJobs([original[0].id]);
  assert.equal(retry.snapshot.row.ratio,'9:16');
  await waitFor(service,s=>s.jobs.every(job=>job.status==='failed'));
  await service.deleteFailedImages([retry.id]);
  const [replacement]=await service.enqueueImages([row.id]);
  assert.equal(replacement.slot,original[0].slot);
  assert.equal(replacement.snapshot.row.ratio,'3:4');
  assert.deepEqual(await service.enqueueImages([row.id]),[]);
  await waitFor(service,s=>s.jobs.some(job=>job.id===replacement.id&&job.status==='succeeded'));
  assert.deepEqual(requests,['9:16','9:16','9:16','3:4']);
  await assert.rejects(service.deleteFailedImages([replacement.id]),/明确失败/);
});

test('反推仅返回候选，提示词组合保留人工描述、用户要求、规范和授权槽位变化；文件夹快照不递归', async t => {
  const payloads = [];
  const { root, service } = await fixture(t, async (operation, payload) => {
    if (operation === 'describe') return { text: '模型候选描述' };
    payloads.push(payload); return { images: [{ bytes: PNG }] };
  });
  const folder = path.join(root, 'source'); await fs.mkdir(path.join(folder, 'nested'), { recursive: true });
  await fs.writeFile(path.join(folder, 'a.png'), PNG); await fs.writeFile(path.join(folder, 'b.png'), PNG);
  await fs.writeFile(path.join(folder, 'fake.png'), '<html>not an image</html>'); await fs.writeFile(path.join(folder, 'nested', 'c.png'), PNG);
  assert.equal((await service.scanFolder(folder)).length, 2);
  await service.updateSettings({ templates: [{ id: 'brand', name: '品牌规范', text: '保持商标准确' }] });
  const row = await service.saveRow({ sourceMode: 'folder', sourcePaths: [folder], name: '商品', referencePrompt: '我人工润色的原图描述', userPrompt: '换成暖色背景', templateId: 'brand', variations: ['侧面光', '正面光'], count: 3 });
  assert.equal(await service.describe(row.id), '模型候选描述');
  assert.equal((await service.getState()).rows[0].referencePrompt, '我人工润色的原图描述');
  await service.enqueueImages([row.id]);
  const state = await waitFor(service, state => state.jobs.length === 3 && state.jobs.every(job => job.status === 'succeeded'));
  for (const payload of payloads) { assert.match(payload.prompt, /我人工润色的原图描述/); assert.match(payload.prompt, /换成暖色背景/); assert.match(payload.prompt, /保持商标准确/); }
  assert.match(payloads[0].prompt, /侧面光/); assert.match(payloads[1].prompt, /正面光/); assert.doesNotMatch(payloads[2].prompt, /侧面光|正面光/);
  assert.equal(state.jobs[0].snapshot.sourcePool.length, 2);
  assert.equal(payloads[0].referencePaths[0], payloads[2].referencePaths[0]);
});

test('下载失败重试只下载，重启后仍可恢复，成功不会再次生成', async t => {
  let generations = 0; let downloads = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { downloads++; return downloads === 1 ? new Response('offline', { status: 503 }) : new Response(PNG, { headers: { 'Content-Type': 'image/png' } }); };
  const runner = async () => { generations++; return { images: [{ url: 'https://example.invalid/result.png' }] }; };
  const { service, dataDir } = await fixture(t, runner);
  const row = await service.saveRow({ userPrompt: '照片' }); await service.enqueueImages([row.id]);
  let state = await waitFor(service, state => state.jobs[0]?.status === 'failed');
  assert.equal(generations, 1); assert.match(state.jobs[0].error, /下载失败/);
  const id = state.jobs[0].id; await service.close();
  const restored = await StudioService.create({ dataDir, providerRunner: runner });
  await restored.retryJobs([id]);
  state = await waitFor(restored, state => state.jobs[0].status === 'succeeded');
  assert.equal(generations, 1); assert.equal(downloads, 2); assert.deepEqual(await fs.readFile(state.jobs[0].localPath), PNG);
  await restored.retryJobs([id]); await delay(30); assert.equal(generations, 1); await restored.close();
});

test('关闭进行中的图片不会重提，未知任务普通重试被阻止，明确重新生成才新建尝试', async t => {
  let calls = 0; let release;
  const { service, dataDir } = await fixture(t, async () => { calls++; await new Promise(resolve => { release = resolve; }); return { images: [{ bytes: PNG }] }; });
  const row = await service.saveRow({ userPrompt: '远端可能计费' }); await service.enqueueImages([row.id]);
  await waitFor(service, state => state.jobs[0]?.status === 'running'); await delay(5);
  await service.close(); release();
  const restored = await StudioService.create({ dataDir, providerRunner: async () => { calls++; return { images: [{ bytes: PNG }] }; } });
  let state = await restored.getState(); assert.equal(state.jobs[0].status, 'unknown');
  await restored.enqueueImages([row.id]); await delay(30); assert.equal(calls, 1);
  await assert.rejects(restored.retryJobs([state.jobs[0].id]), /核对服务商/);
  await restored.retryJobs([state.jobs[0].id], { regenerate: true });
  state = await waitFor(restored, state => state.jobs.length === 2 && state.jobs[1].status === 'succeeded');
  assert.equal(calls, 2); assert.equal(state.jobs[0].status, 'unknown'); await restored.close();
});

test('远端视频 ID 在提交回调时立即写盘，重启只查询不会重新提交', async t => {
  let submissions = 0; let polls = 0;
  const { service, dataDir } = await fixture(t, async (operation, payload, context) => {
    if (operation === 'videoSubmit') {
      submissions++; context.onRemoteId('remote-123');
      return new Promise(() => {});
    }
    polls++; return { status: 'succeeded', url: 'https://example.invalid/video.mp4' };
  });
  await service.enqueueVideo({ mode: 'text', prompt: '风景' });
  await waitFor(service, state => state.jobs[0]?.remoteId === 'remote-123');
  const store = await StudioStore.create(dataDir); assert.equal(store.read().jobs[0].remoteId, 'remote-123'); store.close();
  await service.close();
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(MP4);
  t.after(() => { globalThis.fetch = originalFetch; });
  const restored = await StudioService.create({ dataDir, providerRunner: async (operation, payload) => { assert.equal(operation, 'videoPoll'); assert.equal(payload.remoteId, 'remote-123'); polls++; return { status: 'succeeded', url: 'https://example.invalid/video.mp4' }; } });
  await waitFor(restored, state => state.jobs[0].status === 'succeeded');
  assert.equal(submissions, 1); assert.equal(polls, 1); await restored.close();
});

test('导出清理文件名、限制目录并保护已有不同内容，原图不被修改', async t => {
  const { root, service } = await fixture(t, async () => ({ images: [{ bytes: PNG }] }));
  const row = await service.saveRow({ code: '../CON:<bad>', name: '../../逃逸', folderName: '..\\..\\逃逸', userPrompt: '图' });
  await service.enqueueImages([row.id]);
  const state = await waitFor(service, state => state.jobs[0]?.status === 'succeeded');
  const outputDir = path.join(root, 'export');
  const [first] = await service.exportJobs([state.jobs[0].id], outputDir);
  assert.ok(!path.relative(outputDir, first.path).startsWith('..'));
  assert.doesNotMatch(path.basename(first.path), /[<>:"|?*]/);
  await fs.writeFile(first.path, '用户已有文件');
  const [second] = await service.exportJobs([state.jobs[0].id], outputDir);
  assert.notEqual(first.path, second.path); assert.equal(await fs.readFile(first.path, 'utf8'), '用户已有文件');
  assert.deepEqual(await fs.readFile(second.path), PNG);
  assert.equal((await service.exportJobs([state.jobs[0].id], outputDir))[0].path, second.path);
});

test('图片按类型及批次分目录，追加空位沿用批次，归档后新建流水', async t => {
  const {root,service}=await fixture(t,async()=>({images:[{bytes:PNG}]}));
  const output=path.join(root,'export');
  const a=await service.saveRow({code:'01',name:'主页截图',userPrompt:'保留布局'});
  const b=await service.saveRow({code:'01',name:'主页截图',userPrompt:'保留布局'});
  const first=await service.enqueueImages([a.id,b.id]);
  await service.saveRow({...a,count:2,name:'更新名称'});
  const [added]=await service.enqueueImages([a.id]);
  assert.deepEqual(added.snapshot.imageBatch,first[0].snapshot.imageBatch);
  assert.match(first[0].snapshot.imageBatch.folder,/_0001$/);
  assert.match(first[1].snapshot.imageBatch.folder,/_0002$/);
  let state=await waitFor(service,s=>s.jobs.length===3&&s.jobs.every(job=>job.status==='succeeded'));
  const exported=await service.exportJobs([...first.map(job=>job.id),added.id],output);
  for(const {id,path:exportedPath} of exported){
    const local=state.jobs.find(job=>job.id===id).localPath;
    assert.match(local,/results[\\/]01_主页截图_\d{4}-\d{2}-\d{2}_000[12][\\/]000[12]\.png$/);
    assert.equal(path.relative(output,exportedPath),path.relative(path.join(root,'data','results'),local));
  }
  await service.archiveImages(a.id);
  const second=await service.enqueueImages([a.id]);
  assert.match(second[0].snapshot.imageBatch.folder,/^01_更新名称_\d{4}-\d{2}-\d{2}_0002$/);
  state=await waitFor(service,s=>s.jobs.length===5&&s.jobs.every(job=>job.status==='succeeded'));
  assert.ok(state.jobs.find(job=>job.id===first[0].id).archivedAt);
  assert.deepEqual(await fs.readFile(state.jobs[0].localPath),PNG);
});

test('服务配置和错误不保存密钥；连接测试不隐式生成；事件更新可用', async t => {
  let calls = 0; let changes = 0; let modelCalls = 0;
  const { service, dataDir } = await fixture(t, async (operation, payload, context) => { if (operation === 'models') { modelCalls++; assert.equal(context.provider.key, undefined); return { text: '连接成功，生成能力仍需实际任务验证。', models: ['test-image'] }; } calls++; throw new Error('Authorization=super-private-value api_key=private-url-secret Bearer bearer-private-secret sk-abcdefghijk'); }, { onChange: () => { changes++; } });
  await service.updateSettings({ providers: [{ ...provider, key: 'do-not-store-this-secret', apiKey: 'another-secret' }] });
  const tested = await service.testProvider({ ...provider, key: 'do-not-store-this-secret' }); assert.match(tested.message, /仍需实际任务验证/); assert.equal(calls, 0); assert.equal(modelCalls, 1); assert.deepEqual(tested.models, ['test-image']);
  const row = await service.saveRow({ userPrompt: '测试' }); await service.enqueueImages([row.id]);
  await waitFor(service, state => state.jobs[0]?.status === 'failed');
  const serialized = JSON.stringify(await service.getState());
  for (const secret of ['super-private-value', 'private-url-secret', 'bearer-private-secret', 'sk-abcdefghijk', 'do-not-store-this-secret', 'another-secret']) assert.ok(!serialized.includes(secret));
  const store = await StudioStore.create(dataDir); const stored = JSON.stringify(store.read()); store.close();
  assert.ok(!stored.includes('do-not-store-this-secret')); assert.ok(!stored.includes('super-private-value')); assert.ok(changes > 3);
  await assert.rejects(service.updateSettings({ providers: [{ ...provider, baseUrl: 'https://secret:password@example.com' }] }), /不含密码/);
});

test('用户可配置并发；拒绝零、负数和小数，不把所有批次分别计算额度', async t => {
  let running = 0; let maximum = 0;
  const { service } = await fixture(t, async () => { running++; maximum = Math.max(maximum, running); await delay(15); running--; return { images: [{ bytes: PNG }] }; });
  for (const concurrency of [0, -1, 1.5, 101]) await assert.rejects(service.updateSettings({ concurrency }), /整数/);
  await service.updateSettings({ concurrency: 14 });
  const row = await service.saveRow({ userPrompt: '可配置批量生成', count: 14 });
  await service.enqueueImages([row.id]);
  await waitFor(service, state => state.jobs.length === 14 && state.jobs.every(job => job.status === 'succeeded'));
  assert.equal(maximum, 14);
});

test('合成阶段失败重试复用已付费 TTS 和 renderer 检查点，不重新配音', async t => {
  let ttsCalls = 0; let renderCalls = 0;
  const { root, service } = await fixture(t, async operation => { assert.equal(operation, 'tts'); ttsCalls++; return { bytes: Buffer.from('ID3paid-audio'), mime: 'audio/mpeg' }; }, {
    renderRunner: async (config, context) => {
      renderCalls++;
      const audio = await context.providerRunner('tts', { prompt: config.segments[0].text, voice: config.voice });
      assert.equal(audio.bytes.toString(), 'ID3paid-audio');
      if (renderCalls === 1) { context.onCheckpoint({ phase: 'audio-ready' }); throw new Error('模拟 FFmpeg 合成失败'); }
      assert.equal(context.checkpoint.phase, 'audio-ready');
      const output = path.join(root, 'actual-render.mp4'); await fs.writeFile(output, MP4); return { localPath: output };
    },
  });
  const source = path.join(root, 'photo.png'); await fs.writeFile(source, PNG);
  const job = await service.enqueueMontage({ name: '真实合成', voice: 'alloy', segments: [{ text: '产品介绍', paths: [source] }] });
  await waitFor(service, state => state.jobs[0]?.status === 'failed');
  await service.retryJobs([job.id]);
  const state = await waitFor(service, state => state.jobs.length === 2 && state.jobs[1].status === 'succeeded');
  assert.equal(ttsCalls, 1); assert.equal(renderCalls, 2);
  assert.equal(state.jobs[0].status, 'failed'); assert.deepEqual(await fs.readFile(state.jobs[1].localPath), MP4);
});

test('关闭不合作的合成器有界等待；重启安全恢复合成且复用配音', async t => {
  let ttsCalls = 0; let checkpointReady;
  const ready = new Promise(resolve => { checkpointReady = resolve; });
  const { root, service, dataDir } = await fixture(t, async () => { ttsCalls++; return { bytes: Buffer.from('ID3one-paid-call'), mime: 'audio/mpeg' }; }, {
    renderRunner: async (config, context) => {
      await context.providerRunner('tts', { prompt: config.segments[0].text });
      context.onCheckpoint({ phase: 'rendering' }); checkpointReady();
      return new Promise(() => {});
    },
  });
  const source = path.join(root, 'photo.png'); await fs.writeFile(source, PNG);
  await service.enqueueMontage({ segments: [{ text: '安全恢复', paths: [source] }] }); await ready;
  const started = Date.now(); await service.close(); assert.ok(Date.now() - started < 2500);
  const restored = await StudioService.create({ dataDir, providerRunner: async () => { ttsCalls++; throw new Error('不应重复配音'); }, renderRunner: async (config, context) => {
    assert.equal(context.checkpoint.phase, 'rendering');
    const cached = await context.providerRunner('tts', { prompt: config.segments[0].text }); assert.equal(cached.bytes.toString(), 'ID3one-paid-call');
    const output = path.join(root, 'resumed.mp4'); await fs.writeFile(output, MP4); return { localPath: output };
  } });
  await waitFor(restored, state => state.jobs[0].status === 'succeeded'); assert.equal(ttsCalls, 1); await restored.close();
});

test('新行采用当前默认规范，保留原行选择与明确停用，重启后记住默认值', async t => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'ziyun-template-'));
  let service=await StudioService.create({dataDir});
  t.after(async()=>{await service.close();await fs.rm(dataDir,{recursive:true,force:true})});
  const settings=(await service.getState()).settings;
  assert.equal(settings.defaultTemplateId,'beauty-screenshot');
  const original=await service.saveRow({name:'默认规范'});
  assert.equal(original.templateId,'beauty-screenshot');
  const optedOut=await service.saveRow({name:'无需规范',templateId:''});
  assert.equal(optedOut.templateId,'');
  await service.updateSettings({templates:[...settings.templates,{id:'second',name:'第二规范',text:'规范文本'}],defaultTemplateId:'second'});
  await service.close();
  service=await StudioService.create({dataDir});
  assert.equal((await service.getState()).settings.defaultTemplateId,'second');
  assert.equal((await service.saveRow({name:'采用第二规范'})).templateId,'second');
  assert.equal((await service.saveRow({...original,name:'保留原选择'})).templateId,'beauty-screenshot');
  await service.updateSettings({templates:[]});
  assert.equal((await service.getState()).settings.defaultTemplateId,'');
});

test('升级旧项目补入默认规范，保留原行停用选择', async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'ziyun-old-template-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const store=await StudioStore.create(dataDir);
  store.write({settings:{templates:[{id:'old-rule',name:'既有规范',text:'保持布局'}],templateRevision:1},
    rows:[{id:'legacy',name:'旧行',templateId:''}],jobs:[],assets:[],formulas:[]});
  await store.close();
  const service=await StudioService.create({dataDir});
  try{
    const state=await service.getState();
    assert.equal(state.settings.defaultTemplateId,'old-rule');
    assert.equal(state.rows[0].templateId,'');
    assert.equal((await service.saveRow({name:'新行'})).templateId,'old-rule');
  }finally{await service.close()}
});

test('分类和选图目录重启后保留，修改预设不改已保存类型', async t=>{
  const {service,dataDir,root}=await fixture(t,async()=>{});
  assert.deepEqual((await service.getState()).settings.imageTypeNames,['转账截图','笔记爆款截图','妆容素材截图']);
  const row=await service.saveRow({name:'笔记爆款截图'});
  await assert.rejects(service.updateSettings({imageTypeNames:['自定义',' 自定义 ']}),/已存在/);
  await service.updateSettings({imageTypeNames:[],lastImageDirectory:root});
  await service.close();
  const restored=await StudioService.create({dataDir});
  try{
    const state=await restored.getState();
    assert.deepEqual(state.settings.imageTypeNames,[]);
    assert.equal(state.settings.lastImageDirectory,root);
    assert.equal(state.rows[0].name,row.name);
  }finally{await restored.close()}
});

test('只改数字的批量先规划一次且严格锁定其他字段；双击不重复规划，失败重试保留快照', async t => {
  let plans = 0; let images = 0; const payloads = [];
  const { service } = await fixture(t, async (operation, payload) => {
    if (operation === 'plan') {
      plans++; assert.match(payload.prompt, /只改数字，人物、人脸、背景和UI均不变/); assert.match(payload.prompt, /字段枚举：\["数字"\]/);
      await delay(20); return { text: JSON.stringify([10, 20, 30].map(number => ({ changes: [{ field: '数字', value: String(number) }] }))) };
    }
    assert.equal(operation, 'image'); images++; payloads.push(payload);
    if (images === 2) throw new Error('明确参数失败');
    return { images: [{ bytes: PNG }] };
  });
  await service.updateSettings({ providers: [provider, { ...provider, id: 'language', protocol: 'openai-chat' }], bindings: { vision: 'language' } });
  const row = await service.saveRow({ referencePrompt: '人工润色原稿：原图是一位成年女性，页面布局固定。', userPrompt: '只改数字，人物、人脸、背景和UI均不变', count: 3, templateId: 'beauty-screenshot' });
  const [first, duplicate] = await Promise.all([service.enqueueImages([row.id]), service.enqueueImages([row.id])]);
  assert.equal(first.length, 3); assert.equal(duplicate.length, 0);
  let state = await waitFor(service, state => state.jobs.length === 3 && state.jobs.every(job => ['succeeded', 'failed'].includes(job.status)));
  assert.equal(plans, 1); assert.equal(images, 3);
  for (const job of state.jobs) {
    assert.deepEqual(job.snapshot.variationPlan.allowedFields, ['数字']); assert.equal(job.snapshot.variationPlan.changes[0].field, '数字');
    assert.match(job.prompt, /人工润色原稿/); assert.match(job.prompt, /只改数字/); assert.match(job.prompt, /锁定规则/); assert.doesNotMatch(job.prompt, /人脸目标值|背景目标值/);
  }
  assert.equal(state.rows[0].referencePrompt, row.referencePrompt); assert.equal(state.rows[0].userPrompt, row.userPrompt);
  const failed = state.jobs.find(job => job.status === 'failed');
  await service.retryJobs([failed.id]);
  state = await waitFor(service, state => state.jobs.length === 4 && state.jobs[3].status === 'succeeded');
  assert.equal(plans, 1); assert.equal(images, 4); assert.deepEqual(state.jobs[3].snapshot.variationPlan, failed.snapshot.variationPlan); assert.equal(state.jobs[3].prompt, failed.prompt);
});

test('越权差异和缺少语言连接都按原始要求生成，无效行仍阻止提交', async t => {
  let plans = 0;
  const prompts = [];
  const { service } = await fixture(t, async (operation, payload) => {
    if (operation === 'plan') {
      plans++;
      return { text: JSON.stringify([{ changes: [{ field: '数字', value: '10' }] }, { changes: [{ field: '人脸', value: '另一张脸' }] }]) };
    }
    prompts.push(payload.prompt);
    return { images: [{ bytes: PNG }] };
  });
  const a = await service.saveRow({ userPrompt: '只改数字，其他不变', count: 2 });
  await service.updateSettings({ bindings: { vision: '' } });
  await service.enqueueImages([a.id]);
  await waitFor(service, state => state.jobs.every(job => job.status === 'succeeded'));
  assert.equal(plans, 0);
  await service.updateSettings({ providers: [provider, { ...provider, id: 'language', protocol: 'openai-chat' }], bindings: { vision: 'language' } });
  const b = await service.saveRow({ userPrompt: a.userPrompt, count: 2 });
  const bad = await service.saveRow({ name: '缺失提示词' });
  await assert.rejects(service.enqueueImages([b.id, bad.id]), /提示词/);
  assert.equal(plans, 0);
  await service.enqueueImages([b.id]);
  const state = await waitFor(service, state => state.jobs.length === 4 && state.jobs.every(job => job.status === 'succeeded'));
  assert.equal(plans, 1);
  assert.deepEqual(prompts, Array(4).fill(a.userPrompt));
  assert.ok(state.jobs.every(job => !job.snapshot.variationPlan && job.planningNote));
});

test('固定目标与无用户要求不擅自造差异；明确槽位方案优先且不需要语言调用', async t => {
  let plans = 0; let images = 0;
  const { service } = await fixture(t, async operation => { if (operation === 'plan') { plans++; throw new Error('不应规划'); } images++; return { images: [{ bytes: PNG }] }; });
  await service.updateSettings({ bindings: { vision: '' } });
  const fixed = await service.saveRow({ userPrompt: '仅改数字为10，其他不变', count: 2 });
  const unchanged = await service.saveRow({ referencePrompt: '原样保持', count: 2, templateId: 'beauty-screenshot' });
  const explicit = await service.saveRow({ userPrompt: '只改数字，其他不变', variations: ['数字10', '数字20'], count: 2 });
  await service.enqueueImages([fixed.id, unchanged.id, explicit.id]);
  await waitFor(service, state => state.jobs.length === 6 && state.jobs.every(job => job.status === 'succeeded'));
  assert.equal(plans, 0); assert.equal(images, 6);
});

test('服务返回像素尺寸不同仍保留计费结果并警告，字节和 URL 两条路径都复核', async t => {
  let calls = 0;
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(PNG); t.after(() => { globalThis.fetch = originalFetch; });
  const { service, dataDir } = await fixture(t, async () => { calls++; return { images: [{ ...(calls === 1 ? { bytes: PNG } : { url: 'https://example.invalid/image.png' }), mime: 'image/png', requestedSize: '1024x1024' }] }; });
  const a = await service.saveRow({ userPrompt: '照片A' }); const b = await service.saveRow({ userPrompt: '照片B' });
  await service.enqueueImages([a.id, b.id]);
  let state = await waitFor(service, state => state.jobs.length === 2 && state.jobs.every(job => job.status === 'succeeded'));
  for (const job of state.jobs) { assert.match(job.warning, /1x1.*1024x1024/); assert.equal(job.result.images[0].width, 1); assert.equal(job.result.images[0].height, 1); assert.equal(job.result.images[0].requestedSize, '1024x1024'); assert.deepEqual(await fs.readFile(job.localPath), PNG); }
  await service.close(); const restored = await StudioService.create({ dataDir }); state = await restored.getState(); assert.match(state.jobs[0].warning, /复核/); assert.equal(state.jobs[0].result.images[0].actualSize, '1x1'); await restored.close(); assert.equal(calls, 2);
});

test('无 remoteId 的已计费字节响应遇到 staging ENOSPC 必须未知，普通重试及重启均不重复提交', async t => {
  let generations = 0;
  const runner = async () => { generations++; return { images: [{ bytes: PNG, mime: 'image/png' }] }; };
  const { service, dataDir } = await fixture(t, runner);
  const originalWrite = fs.writeFile;
  fs.writeFile = async (file, ...args) => { if (String(file).includes(`${path.sep}staging${path.sep}`)) throw Object.assign(new Error('磁盘空间不足 staging'), { code: 'ENOSPC' }); return originalWrite(file, ...args); };
  t.after(() => { fs.writeFile = originalWrite; });
  const row = await service.saveRow({ userPrompt: '已经计费的原图' }); await service.enqueueImages([row.id]);
  let state = await waitFor(service, state => state.jobs[0]?.status === 'unknown');
  assert.equal(generations, 1); assert.equal(state.jobs[0].remoteId, ''); assert.match(state.jobs[0].error, /远端已返回图片/);
  const id = state.jobs[0].id;
  await assert.rejects(service.retryJobs([id]), /核对服务商/);
  await service.enqueueImages([row.id]); assert.equal(generations, 1);
  fs.writeFile = originalWrite; await service.close();
  const restored = await StudioService.create({ dataDir, providerRunner: runner });
  state = await restored.getState(); assert.equal(state.jobs[0].status, 'unknown'); await delay(25); assert.equal(generations, 1);
  await assert.rejects(restored.retryJobs([id]), /核对服务商/); assert.equal(generations, 1); await restored.close();
});

test('视频 URL 成功响应后数据库首次保存失败，普通重试只恢复保存，不再次提交视频', async t => {
  let submissions = 0; let downloads = 0;
  const { service } = await fixture(t, async operation => { assert.equal(operation, 'videoSubmit'); submissions++; return { url: 'https://example.invalid/paid-video.mp4' }; });
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { downloads++; return new Response(MP4); }; t.after(() => { globalThis.fetch = originalFetch; });
  const write = service.store.write.bind(service.store); let failedOnce = false;
  service.store.write = state => { if (!failedOnce && state.jobs.some(job => job.kind === 'video' && job.status === 'saving')) { failedOnce = true; throw Object.assign(new Error('模拟 SQLite 保存 ENOSPC'), { code: 'ENOSPC' }); } return write(state); };
  await service.enqueueVideo({ mode: 'text', prompt: '远端已完成视频' });
  let state = await waitFor(service, state => state.jobs[0]?.status === 'failed');
  assert.equal(submissions, 1); assert.equal(state.jobs[0].result.url, 'https://example.invalid/paid-video.mp4'); assert.equal(downloads, 0);
  await service.retryJobs([state.jobs[0].id]); state = await waitFor(service, state => state.jobs[0].status === 'succeeded');
  assert.equal(submissions, 1); assert.equal(downloads, 1); assert.deepEqual(await fs.readFile(state.jobs[0].localPath), MP4);
});

test('图片、视频、混剪旧失败记录已有成功后继时，重复点旧失败不再建立付费尝试', async t => {
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(MP4); t.after(() => { globalThis.fetch = originalFetch; });
  for (const kind of ['image', 'video', 'montage']) await t.test(kind, async t => {
    let calls = 0;
    const { root, service } = await fixture(t, async operation => {
      calls++; if (calls === 1) throw new Error('明确参数拒绝');
      return operation === 'image' ? { images: [{ bytes: PNG }] } : { url: 'https://example.invalid/success.mp4' };
    }, { renderRunner: async () => { calls++; if (calls === 1) throw new Error('明确本地渲染失败'); const output = path.join(root, 'completed.mp4'); await fs.writeFile(output, MP4); return { localPath: output }; } });
    let original;
    if (kind === 'image') { const row = await service.saveRow({ userPrompt: '原槽位' }); [original] = await service.enqueueImages([row.id]); }
    else if (kind === 'video') [original] = await service.enqueueVideo({ mode: 'text', prompt: '原视频' });
    else {
      const photo = path.join(root, 'photo.png'); const audio = path.join(root, 'audio.mp3'); await fs.writeFile(photo, PNG); await fs.writeFile(audio, 'ID3audio');
      original = await service.enqueueMontage({ segments: [{ paths: [photo], audioPath: audio }] });
    }
    await waitFor(service, state => state.jobs[0].status === 'failed');
    await service.retryJobs([original.id]);
    let state = await waitFor(service, state => state.jobs.length === 2 && state.jobs[1].status === 'succeeded');
    assert.equal(calls, 2); assert.equal(state.jobs[1].attempt, 2);
    assert.deepEqual(await service.retryJobs([original.id]), []);
    assert.deepEqual(await service.retryJobs([original.id, state.jobs[1].id]), []);
    await delay(25); state = await service.getState(); assert.equal(calls, 2); assert.equal(state.jobs.length, 2); assert.equal(state.jobs[0].status, 'failed');
  });
});

test('视频远端明确失败可新建补位请求；远端结果未知仍只查询原编号', async t => {
  let submits = 0; const polls = new Map();
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(MP4); t.after(() => { globalThis.fetch = originalFetch; });
  const { service } = await fixture(t, async (operation, payload) => {
    if (operation === 'videoSubmit') { submits++; return { remoteId: `remote-${submits}` }; }
    assert.equal(operation, 'videoPoll'); const count = (polls.get(payload.remoteId) || 0) + 1; polls.set(payload.remoteId, count);
    if (payload.remoteId === 'remote-1') return { status: 'failed', error: '已确认远端终止失败' };
    if (payload.remoteId === 'remote-3' && count === 1) throw Object.assign(new Error('远端查询暂时超时'), { unknown: true });
    return { status: 'succeeded', url: 'https://example.invalid/video.mp4' };
  });
  const [original] = await service.enqueueVideo({ mode: 'text', prompt: '允许失败补位' });
  let state = await waitFor(service, state => state.jobs[0]?.status === 'failed');
  assert.equal(state.jobs[0].remoteId, 'remote-1'); assert.equal(state.jobs[0].remoteFailed, true);
  const [replacement] = await service.retryJobs([original.id]); assert.notEqual(replacement.id, original.id); assert.equal(replacement.remoteId, '');
  state = await waitFor(service, state => state.jobs.length === 2 && state.jobs[1].status === 'succeeded');
  assert.equal(submits, 2); assert.equal(state.jobs[1].remoteId, 'remote-2'); assert.equal(polls.get('remote-1'), 1);
  await service.retryJobs([original.id]); assert.equal(submits, 2);
  const [unknown] = await service.enqueueVideo({ mode: 'text', prompt: '只恢复查询' });
  state = await waitFor(service, state => state.jobs.find(job => job.id === unknown.id)?.status === 'unknown');
  assert.equal(state.jobs.find(job => job.id === unknown.id).remoteId, 'remote-3');
  await service.retryJobs([unknown.id]);
  state = await waitFor(service, state => state.jobs.find(job => job.id === unknown.id).status === 'succeeded');
  assert.equal(submits, 3); assert.equal(polls.get('remote-3'), 2); assert.equal(state.jobs.length, 3); assert.equal(state.jobs[2].attempt, 1);
});
