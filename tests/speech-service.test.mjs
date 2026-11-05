import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { StudioService } from '../electron/service.mjs';
import { StudioStore } from '../electron/store.mjs';
import { speechCacheKey } from '../shared/speech.mjs';
import { withMontageReview, reviewAndPlan, reviewAndEnqueue } from './helpers/montage-review-fixture.mjs';

const MP3 = Buffer.from('ID3valid-speech-test-fixture');
const WAV = Buffer.alloc(48);
WAV.write('RIFF'); WAV.write('WAVE', 8);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(20)]);
const provider = { id: 'voice', name: '语音测试', protocol: 'minimax-tts', model: 'speech-2.8-hd', baseUrl: 'https://speech.example.invalid', hasKey: true, timeoutMs: 1000 };
const options = { voice: 'test-voice', speed: 1, format: 'mp3' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, runner, settings = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-speech-service-')));
  const dataDir = path.join(root, 'data');
  const extra = { inspectAudio: async () => 2, ...settings };
  let service = await StudioService.create({ dataDir, providerRunner: withMontageReview(runner), ...extra });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  await service.updateSettings({ providers: [provider], bindings: { tts: provider.id }, autoExport: false, defaultTemplateId: '' });
  return {
    root, dataDir,
    get service() { return service; },
    async restart(nextRunner = runner, nextSettings = {}) {
      await service.close();
      service = await StudioService.create({ dataDir, providerRunner: withMontageReview(nextRunner), ...extra, ...nextSettings });
      return service;
    },
  };
}

async function waitJobs(service, ids, status, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const jobs = (await service.getState()).jobs.filter(job => ids.includes(job.id));
    if (jobs.length === ids.length && jobs.every(job => job.status === status)) return jobs;
    await delay(10);
  }
  const jobs = (await service.getState()).jobs.filter(job => ids.includes(job.id));
  assert.fail(`任务未达到${status}: ${JSON.stringify(jobs.map(job => ({ status: job.status, error: job.error })))}`);
}

test('speech presets persist and queued jobs retain the submitted voice snapshot', async t => {
  const f = await fixture(t, async () => ({ bytes: MP3, mime: 'audio/mpeg', duration: 2 }));
  await f.service.updateSettings({ paused: true, speechPresets: [{ id: 'narrator', name: '讲解女声', providerId: 'voice', ...options }], defaultSpeechPresetId: 'narrator' });
  const [job] = await f.service.enqueueSpeech({ text: '原先的声音。' });
  await f.service.updateSettings({ speechPresets: [{ id: 'narrator', name: '新默认声音', providerId: 'voice', ...options, voice: 'other-voice', speed: 1.1 }] });
  await f.restart();
  const state = await f.service.getState();
  assert.equal(state.settings.speechPresets[0].voice, 'other-voice');
  assert.equal(state.settings.defaultSpeechPresetId, 'narrator');
  assert.equal(state.jobs.find(item => item.id === job.id).snapshot.config.voiceOptions.voice, 'test-voice');
  assert.equal(state.jobs.find(item => item.id === job.id).snapshot.config.voiceOptions.speed, 1);
});

test('undefined form fields preserve custom preset voice and speed in speech and montage planning', async t => {
  let calls = 0;
  const text = '收纳箱折叠后更省空间。';
  const f = await fixture(t, async (operation, payload) => {
    assert.equal(operation, 'tts'); calls++;
    assert.equal(payload.voice, 'custom-cloned-voice');
    assert.equal(payload.speed, 1.35);
    return { bytes: MP3, mime: 'audio/mpeg', duration: 2 };
  });
  await f.service.updateSettings({ speechPresets: [{ id: 'custom-preset', name: '自定义克隆声音', providerId: provider.id, voice: 'custom-cloned-voice', speed: 1.35 }] });
  const configured = f.service.speechConfiguration({ voicePresetId: 'custom-preset', voice: undefined, speed: undefined });
  assert.equal(configured.options.voice, 'custom-cloned-voice');
  assert.equal(configured.options.speed, 1.35);
  await assert.rejects(async () => f.service.speechConfiguration({ voicePresetId: 'custom-preset', providerId: 'other-provider' }), /不一致/);
  const asset = await addMontageAsset(f, { id: 'storage', description: '收纳箱折叠后更省空间的演示。' });
  const plan = await reviewAndPlan(f.service, { assetIds: [asset.id], voicePresetId: 'custom-preset', voice: undefined, segments: [{ section: 'A', text }] });
  assert.equal(plan.voiceOptions.voice, 'custom-cloned-voice');
  assert.equal(plan.voiceOptions.speed, 1.35);
  const [speech] = await f.service.enqueueSpeech({ text, voicePresetId: 'custom-preset', voice: undefined, speed: undefined });
  const [completed] = await waitJobs(f.service, [speech.id], 'succeeded');
  assert.equal(completed.snapshot.config.voiceOptions.voice, 'custom-cloned-voice');
  assert.equal(completed.snapshot.config.voiceOptions.speed, 1.35);
  assert.equal(calls, 1);
});

test('batch separator creates independent speech jobs while identical text shares a paid recording', async t => {
  const requests = [];
  const f = await fixture(t, async (op, payload) => {
    assert.equal(op, 'tts'); requests.push(payload.prompt);
    await delay(15);
    return { bytes: MP3, mime: 'audio/mpeg', duration: 2, segments: [{ text: payload.prompt, start: 0, end: 2 }] };
  });
  const jobs = await f.service.enqueueSpeech({ text: '第一篇。\n---\n第二篇。\n---\n第一篇。', ...options });
  assert.equal(jobs.length, 3);
  const completed = await waitJobs(f.service, jobs.map(job => job.id), 'succeeded');
  assert.deepEqual(requests.sort(), ['第一篇。', '第二篇。'].sort());
  assert.equal(completed[0].localPath, completed[2].localPath);
  assert.equal((await f.service.getState()).assets.filter(asset => asset.kind === 'audio').length, 2);
});

test('successful standalone speech is reused by montage without a second synthesis', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { bytes: MP3, mime: 'audio/mpeg', duration: 2 }; }, {
    renderRunner: async (config, context) => {
      const audio = await context.providerRunner('tts', { prompt: config.segments[0].text, ...config.voiceOptions });
      assert.deepEqual(audio.bytes, MP3);
      const output = path.join(config.outputDir, 'montage-test.mp4');
      await fs.mkdir(config.outputDir, { recursive: true }); await fs.writeFile(output, MP4);
      return { localPath: output };
    },
  });
  const [speech] = await f.service.enqueueSpeech({ text: '共享同一句文案。', ...options });
  await waitJobs(f.service, [speech.id], 'succeeded');
  const source = path.join(f.root, 'picture.png'); await fs.writeFile(source, Buffer.from('test-image'));
  const montage = await reviewAndEnqueue(f.service, { segments: [{ section: 'A', text: '共享同一句文案。', paths: [source] }], voiceOptions: options });
  await waitJobs(f.service, [montage.id], 'succeeded');
  assert.equal(calls, 1);
});

test('unknown speech cannot be normally retried or resubmitted, but explicit regeneration is possible', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('提交结果未知。'), { unknown: true });
    return { bytes: MP3, mime: 'audio/mpeg', duration: 2 };
  });
  const [job] = await f.service.enqueueSpeech({ text: '需要检查结果。', ...options });
  await waitJobs(f.service, [job.id], 'unknown');
  await assert.rejects(f.service.retryJobs([job.id]), /状态未知/);
  const [duplicate] = await f.service.enqueueSpeech({ text: '需要检查结果。', ...options });
  await waitJobs(f.service, [duplicate.id], 'unknown');
  assert.equal(calls, 1);
  const [regenerated] = await f.service.retryJobs([job.id], { regenerate: true });
  await waitJobs(f.service, [regenerated.id], 'succeeded');
  assert.equal(calls, 2);
});

test('explicit montage regeneration recovers an unknown TTS submission with a fresh recording revision', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('配音提交结果未知。'), { unknown: true });
    return { bytes: MP3, mime: 'audio/mpeg', duration: 2 };
  }, {
    renderRunner: async (config, context) => {
      await context.providerRunner('tts', { prompt: config.segments[0].text, ...config.voiceOptions });
      await fs.mkdir(config.outputDir, { recursive: true });
      const output = path.join(config.outputDir, `${config.jobId}.mp4`);
      await fs.writeFile(output, MP4);
      return { localPath: output };
    },
  });
  const source = path.join(f.root, 'picture.png'); await fs.writeFile(source, Buffer.from('test-image'));
  const job = await reviewAndEnqueue(f.service, { segments: [{ section: 'A', text: '混剪配音结果未知。', paths: [source] }], voiceOptions: options });
  await waitJobs(f.service, [job.id], 'unknown');
  await assert.rejects(f.service.retryJobs([job.id]), /状态未知/);
  const [retry] = await f.service.retryJobs([job.id], { regenerate: true });
  await waitJobs(f.service, [retry.id], 'succeeded');
  assert.equal(calls, 2);
});

test('speech cache isolates model, voice options and output format and saves WAV correctly', async t => {
  let calls = 0;
  const f = await fixture(t, async (_op, payload) => {
    calls++;
    return { bytes: payload.format === 'wav' ? WAV : MP3, mime: payload.format === 'wav' ? 'audio/wav' : 'audio/mpeg', duration: 2 };
  });
  const a = await f.service.speechAudio('一样的文字', provider, options);
  assert.equal((await f.service.speechAudio('一样的文字', provider, { ...options })).localPath, a.localPath);
  await f.service.speechAudio('一样的文字', { ...provider, model: 'speech-2.6-hd' }, options);
  await f.service.speechAudio('一样的文字', provider, { ...options, speed: 1.1 });
  const wav = await f.service.speechAudio('一样的文字', provider, { ...options, format: 'wav' });
  assert.equal(path.extname(wav.localPath), '.wav');
  assert.deepEqual(await fs.readFile(wav.localPath), WAV);
  assert.equal(calls, 4);
});

test('a saved audio file survives inspection failure and restart without repeating paid synthesis', async t => {
  let calls = 0;
  const runner = async () => { calls++; return { bytes: MP3, mime: 'audio/mpeg', duration: 2 }; };
  const f = await fixture(t, runner, { inspectAudio: async () => { throw new Error('合成器暂不可用'); } });
  const [job] = await f.service.enqueueSpeech({ text: '已生成但暂时无法读取时长。', ...options });
  await waitJobs(f.service, [job.id], 'failed');
  assert.equal(Object.values((await f.service.getState()).speechCache)[0].status, 'saved');
  await f.restart(runner, { inspectAudio: async () => 2 });
  const [retry] = await f.service.retryJobs([job.id]);
  await waitJobs(f.service, [retry.id], 'succeeded');
  assert.equal(calls, 1);
});

test('pending audio cache becomes unknown on restart and prevents an unrequested paid repeat', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return { bytes: MP3, mime: 'audio/mpeg', duration: 2 }; });
  await f.service.close();
  const store = await StudioStore.create(f.dataDir);
  const state = store.read();
  const key = createHash('sha256').update(speechCacheKey(provider, options, '中断的文案。')).digest('hex');
  state.speechCache[key] = { status: 'pending', providerId: 'voice', text: '中断的文案。' };
  store.write(state); store.close();
  await f.restart();
  assert.equal((await f.service.getState()).speechCache[key].status, 'unknown');
  const [job] = await f.service.enqueueSpeech({ text: '中断的文案。', ...options });
  await waitJobs(f.service, [job.id], 'unknown');
  assert.equal(calls, 0);
});

test('long text saves completed parts and retries failed concatenation without more speech requests', async t => {
  const texts = [];
  let concatCalls = 0;
  const f = await fixture(t, async (_op, payload) => {
    texts.push(payload.prompt);
    return { bytes: MP3, mime: 'audio/mpeg', duration: 2, segments: [{ text: payload.prompt, start: 0.1, end: 1.9 }] };
  }, {
    concatSpeech: async (files, output) => {
      concatCalls++;
      assert.equal(files.length, 2);
      for (const file of files) assert.deepEqual(await fs.readFile(file), MP3);
      if (concatCalls === 1) throw new Error('本地拼接失败');
      await fs.writeFile(output, Buffer.concat([MP3, Buffer.from('joined')]));
    },
    inspectAudio: async file => (await fs.readFile(file)).length > MP3.length ? 4 : 2,
  });
  const doubao = { ...provider, protocol: 'doubao-tts', model: 'seed-tts-2.0', resourceId: 'seed-tts-2.0' };
  await f.service.updateSettings({ providers: [doubao], bindings: { tts: 'voice' } });
  const text = '甲'.repeat(1199) + '。' + '乙'.repeat(800) + '。';
  const [job] = await f.service.enqueueSpeech({ text, voice: 'zh_female_vv_uranus_bigtts' });
  await waitJobs(f.service, [job.id], 'failed');
  assert.equal(texts.length, 2);
  assert.equal(texts.join(''), text);
  assert(texts.every(part => part.length <= 1500));
  await f.restart();
  const [retry] = await f.service.retryJobs([job.id]);
  const [done] = await waitJobs(f.service, [retry.id], 'succeeded');
  assert.equal(texts.length, 2);
  assert.equal(concatCalls, 2);
  assert.equal(done.duration, 4);
  assert.deepEqual(done.segments.map(cue => [cue.start, cue.end]), [[0.1, 1.9], [2.1, 3.9]]);
});

test('speech records retain subtitle warnings and exclude provider credentials from public state', async t => {
  const f = await fixture(t, async () => ({ bytes: MP3, mime: 'audio/mpeg', duration: 2, segments: [{ text: '合法字幕', start: 0.1, end: 1.8 }, { text: '越界字幕', start: 1, end: 20 }], subtitleWarning: '配音完成，部分字幕不可用。' }));
  await f.service.updateSettings({ providers: [{ ...provider, key: 'private-credential-not-for-ui' }] });
  const [job] = await f.service.enqueueSpeech({ text: '字幕测试。', ...options });
  const [done] = await waitJobs(f.service, [job.id], 'succeeded');
  assert.equal(done.warning, '配音完成，部分字幕不可用。');
  assert.deepEqual(done.segments, [{ text: '合法字幕', start: 0.1, end: 1.8 }]);
  assert(!JSON.stringify(await f.service.getState()).includes('private-credential-not-for-ui'));
});

async function addMontageAsset(f, { id, description, shotIds = [`${id}-shot`] }) {
  const filename = path.join(f.root, `${id}.mp4`);
  await fs.writeFile(filename, MP4);
  const asset = {
    id, path: filename, name: `${id}.mp4`, kind: 'video', category: '场景素材', duration: shotIds.length * 4,
    shots: shotIds.map((shotId, index) => ({ id: shotId, sourceIn: index * 4, duration: 4, description, tags: [], analysis: 'visual', speaking: false })),
  };
  f.service.state.montageAssets.push(asset);
  f.service.state.assets.push({ id, path: filename, name: asset.name, kind: 'video', category: asset.category });
  f.service.changed();
  return asset;
}

const visionProvider = { id: 'vision', name: '混剪语义测试', protocol: 'openai-chat', model: 'semantic-model', baseUrl: 'https://vision.example.invalid', hasKey: true, timeoutMs: 1000 };

test('automatic montage library IDs never become manual overrides for unrelated narration', async t => {
  let speechCalls = 0;
  const f = await fixture(t, async operation => {
    assert.equal(operation, 'tts'); speechCalls++;
    return { bytes: MP3, mime: 'audio/mpeg', duration: 2 };
  });
  const asset = await addMontageAsset(f, { id: 'storage', description: '透明收纳箱折叠动作特写。' });
  const plan = await reviewAndPlan(f.service, {
    assetIds: [asset.id], voiceOptions: options,
    segments: [{ section: 'A', text: '人工智能算法全面升级。', assetIds: [asset.id] }],
  });
  assert.equal(speechCalls, 1);
  assert.deepEqual(plan.segments[0].paths, []);
  assert.deepEqual(plan.segments[0].shots, []);
  assert.equal(plan.missing.length, 1);
  assert.match(plan.missing[0].reason, /没有找到/);
});

test('semantic montage matching handles paraphrases using real shot IDs and discards invented IDs', async t => {
  const narration = '出门碰上下雨也能从容应对。';
  const secondNarration = '骤雨来临的时候照样放心出行。';
  let planCalls = 0;
  const f = await fixture(t, async (operation, payload) => {
    if (operation === 'tts') return { bytes: MP3, mime: 'audio/mpeg', duration: 2 };
    assert.equal(operation, 'plan'); planCalls++;
    assert.match(payload.prompt, /umbrella-shot/);
    const text = planCalls === 1 ? narration : secondNarration;
    return { text: JSON.stringify([{ section: 'A', text, shotIds: planCalls === 1 ? ['invented-path-shot', 'umbrella-shot'] : ['invented-path-shot'] }]) };
  });
  await f.service.updateSettings({ providers: [provider, visionProvider], bindings: { montageVision: 'vision' } });
  const asset = await addMontageAsset(f, { id: 'umbrella', description: '成年人手持晴雨伞走出建筑。', shotIds: ['umbrella-shot'] });
  const plan = await reviewAndPlan(f.service, { assetIds: [asset.id], voiceOptions: options, segments: [{ section: 'A', text: narration }] });
  assert.deepEqual(plan.semanticMatches[0].shotIds, ['umbrella-shot']);
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.segments[0].shots[0].id, 'umbrella-shot');
  assert.equal(plan.segments[0].shots[0].path, asset.path);
  assert.match(plan.segments[0].shots[0].reason, /句意推荐/);
  const noRealMatch = await reviewAndPlan(f.service, { assetIds: [asset.id], voiceOptions: options, segments: [{ section: 'A', text: secondNarration }] });
  assert.deepEqual(noRealMatch.semanticMatches[0].shotIds, []);
  assert.deepEqual(noRealMatch.segments[0].shots, []);
  assert.equal(noRealMatch.missing.length, 1);
  assert.equal(planCalls, 2);
});

test('montage variants and restart reuse paid speech and semantic matches while an explicit empty selection stays empty', async t => {
  const text = '出门碰上下雨也能从容应对。';
  let speechCalls = 0, planCalls = 0;
  const f = await fixture(t, async operation => {
    if (operation === 'tts') { speechCalls++; return { bytes: MP3, mime: 'audio/mpeg', duration: 2 }; }
    assert.equal(operation, 'plan'); planCalls++;
    return { text: JSON.stringify([{ section: 'A', text, shotIds: ['umbrella-one', 'umbrella-two'] }]) };
  });
  await f.service.updateSettings({ providers: [provider, visionProvider], bindings: { montageVision: 'vision' } });
  const asset = await addMontageAsset(f, { id: 'umbrella', description: '成年人手持晴雨伞走出建筑。', shotIds: ['umbrella-one', 'umbrella-two'] });
  const config = { assetIds: [asset.id], voiceOptions: options, segments: [{ section: 'A', text }] };
  const first = await reviewAndPlan(f.service, { ...config, variant: 0 });
  const second = await reviewAndPlan(f.service, { ...config, variant: 1 });
  assert.equal(first.missing.length, 0);
  assert.equal(second.missing.length, 0);
  assert.notEqual(first.signature, second.signature);
  assert.equal(speechCalls, 1);
  assert.equal(planCalls, 1);
  await f.restart();
  await reviewAndPlan(f.service, { ...config, variant: 2 });
  assert.equal(speechCalls, 1);
  assert.equal(planCalls, 1);
  await assert.rejects(reviewAndPlan(f.service, { ...config, assetIds: [], segments: [{ section: 'A', text }] }), /请先选择/);
  assert.equal(speechCalls, 1);
  assert.equal(planCalls, 1);
});
