import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { StudioService } from '../electron/service.mjs';
import { batchCapacity, batchCombinationAt } from '../shared/montage-batch.mjs';
import { montageReviewCombination, montageReviewSignature } from '../shared/montage-review.mjs';
import { normalizeMontageBindings, montageVisualFragments } from '../shared/montage-bindings.mjs';
import { reviewSource, parseMontageSuggestion, applyMontageBindingReview } from '../electron/montage-review.mjs';

const pass = { status: 'pass', summary: '未发现明显逻辑问题', issues: [] };
const bind = (id, text, start, end, folderPath) => ({ id, start, end, quote: text.slice(start, end), folderPath, folderLabel: path.basename(folderPath) });
const sectionSetup = (text, bindings, paths = []) => ({ mode: 'sections', sections: [{ section: 'A', candidates: [text], paths, candidateBindings: [{ textSnapshot: text, bindings }] }] });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const mp3 = Buffer.from('ID3-local-fixture-audio');

async function fixture(t, responder) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-bindings-')));
  const material = path.join(root, '素材');
  const apples = path.join(material, '苹果'), bananas = path.join(material, '香蕉');
  for (const folder of [apples, bananas, path.join(apples, '其他')]) {
    await fs.mkdir(folder, { recursive: true });
    for (const name of ['一.png', '二.png']) await fs.writeFile(path.join(folder, name), png);
  }
  const events = [], calls = [];
  const create = async () => {
    const instance = await StudioService.create({
    dataDir: path.join(root, 'state'), inspectAudio: async () => 10,
    providerRunner: async (operation, payload) => {
      events.push(operation); calls.push({ operation, payload });
      if (operation === 'tts') return { bytes: mp3, mime: 'audio/mpeg', duration: 10, segments: [{ text: '苹果红。', start: 0, end: 2 }, { text: '香蕉黄。', start: 2, end: 6 }, { text: '苹果红。', start: 6, end: 10 }] };
      if (operation === 'describe') return { text: JSON.stringify({ description: '画面可见红色苹果和黄色香蕉。', tags: ['苹果', '香蕉'], speaking: false }) };
      if (operation === 'plan') return { text: '[]' };
      return responder ? responder(operation, payload) : { text: JSON.stringify(pass) };
    },
    montageScanner: async (folder, { assetPaths = [], previousAssets = [], describeFrames } = {}) => Promise.all(assetPaths.map(async file => {
      const fingerprint = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      const previous = previousAssets.find(asset => asset.path === file && asset.fingerprint === fingerprint);
      if (previous?.shots?.every(shot => ['visual', 'manual'].includes(shot.analysis))) return previous;
      const description = describeFrames ? await describeFrames([file], {}) : {};
      return { id: file, path: file, fingerprint, name: path.basename(file), kind: 'image', shots: [{ id: file + '-shot', sourceIn: 0, duration: 0, analysis: describeFrames ? 'visual' : 'unreviewed', ...description }] };
    })),
    });
    instance.prepareTimeline = async config => {
      events.push('prepare');
      return { timeline: { width: 720, height: 1280, clips: [
        ...config.segments.flatMap((segment, i) => segment.shots.map((shot, j) => ({ id: `p${i}-${j}`, track: 'picture', start: segment.start + segment.shots.slice(0, j).reduce((sum, item) => sum + item.duration, 0), duration: shot.duration, sourceIn: 0, path: shot.path }))),
        { id: 'voice', track: 'voice', start: 0, duration: 10, sourceIn: 0, path: config.masterAudioPath },
      ] } };
    };
    return instance;
  };
  let service = await create();
  await service.updateSettings({ autoExport: false, providers: [
    { id: 'review', protocol: 'openai-chat', model: 'local-review', baseUrl: 'http://127.0.0.1:1' },
    { id: 'voice', protocol: 'minimax-tts', model: 'local-voice', baseUrl: 'http://127.0.0.1:1' },
  ], bindings: { rewrite: 'review', tts: 'voice', montageVision: 'review' } });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, material, apples, bananas, events, calls, get service() { return service; }, restart: async () => { await service.close(); service = await create(); return service; } };
}

async function checkedConfig(service, setup) {
  const checked = await service.reviewMontageCombinations({ setup, indices: [0] });
  const accepted = service.state.montageReviews.find(item => item.sourceKey === checked.sourceKey).items[0].accepted;
  return { setup, ...accepted || montageReviewCombination(setup, 0), reviewSourceKey: checked.sourceKey, reviewIndex: 0, voice: 'local-voice', fullNarration: true, assetIds: [] };
}

test('相同文字按准确选区绑定，首尾空白可迁移且不同素材的重复候选不合并', () => {
  const raw = '  苹果红。苹果红。  ';
  const setup = sectionSetup(raw, [bind('first', raw, 2, 6, '/first'), bind('second', raw, 6, 10, '/second')]);
  const combo = montageReviewCombination(setup, 0);
  assert.deepEqual(combo.segments[0].bindings.map(binding => [binding.start, binding.end, binding.folderPath]), [[0, 4, '/first'], [4, 8, '/second']]);
  const duplicate = structuredClone(setup.sections[0]);
  duplicate.candidates.push(raw); duplicate.candidateBindings.push({ textSnapshot: raw, bindings: [bind('different', raw, 2, 10, '/third')] });
  assert.equal(batchCapacity([duplicate]), 2);
  assert.equal(batchCombinationAt([duplicate], 1).segments[0].bindings[0].folderPath, '/third');
  const stale = structuredClone(setup); stale.sections[0].candidates[0] = '改写。' + raw;
  assert.throws(() => reviewSource(stale), /已修改/);
  assert.notEqual(montageReviewSignature(setup), montageReviewSignature(stale));
  assert.throws(() => normalizeMontageBindings(raw, [bind('a', raw, 2, 7, '/a'), bind('b', raw, 6, 10, '/b')]), /重叠/);
  assert.throws(() => normalizeMontageBindings('😀苹果', [bind('emoji', '😀苹果', 1, 4, '/a')]), /范围/);
});

test('扫描总目录只读、直接目录图片隔离，映射保存重启仍在且拒绝越界目录', async t => {
  const f = await fixture(t);
  const library = await f.service.scanMontageBindingFolders(f.material);
  assert.equal(library.mediaCount, 6);
  assert.equal(library.folders.find(folder => folder.path === f.apples).mediaCount, 2);
  assert.deepEqual(await fs.readdir(f.material), ['苹果', '香蕉']);
  const text = '苹果红。', setup = sectionSetup(text, [bind('a', text, 0, text.length, f.apples)]);
  await f.service.saveMontageSetup(setup); await f.restart();
  assert.deepEqual(f.service.state.montageSetup, setup);
  assert.equal(f.service.state.montageBindingLibrary.folders.length, 4);
  const wrong = sectionSetup(text, [bind('a', text, 0, text.length, f.root)]);
  await assert.rejects(f.service.reviewMontageCombinations({ setup: wrong, indices: [0] }), /不在已选择/);
  assert.equal(f.calls.length, 0);
});

test('未校对、报错或有问题均不调用TTS；通过后完整语音一次，按三段真实时间绑定图片', async t => {
  let status = 'issue';
  const f = await fixture(t, async () => {
    if (status === 'error') throw new Error('mock-review-unavailable');
    return { text: JSON.stringify(status === 'pass' ? pass : { status: 'issue', summary: '需要处理转场', issues: [{ section: 'A', message: '转场需要核对' }] }) };
  });
  await f.service.scanMontageBindingFolders(f.material);
  const text = '苹果红。香蕉黄。苹果红。';
  const setup = sectionSetup(text, [bind('a', text, 0, 4, f.apples), bind('b', text, 4, 8, f.bananas), bind('c', text, 8, 12, f.apples)]);
  await assert.rejects(f.service.createMontageDraft(montageReviewCombination(setup, 0)), /先对完整组合/);
  let config = await checkedConfig(f.service, setup);
  await assert.rejects(f.service.createMontageDraft(config), /尚未通过/);
  await assert.rejects(f.service.planMontage(config), /尚未通过/);
  status = 'error'; await f.service.reviewMontageCombinations({ setup, indices: [0], force: true });
  await assert.rejects(f.service.createMontageDraft(config), /尚未通过/);
  assert(!f.events.includes('tts'));
  status = 'pass'; config = await checkedConfig(f.service, setup);
  const draft = await f.service.createMontageDraft({ ...config, requestKey: 'bound-three' });
  assert.equal(draft.config.setup, undefined); assert.equal(draft.config.requestKey, undefined); assert.equal(draft.requestKey.length, 64);
  assert.deepEqual(f.events.slice(-2), ['tts', 'prepare']);
  assert.equal(f.calls.filter(call => call.operation === 'tts').length, 1);
  assert.equal(f.calls.find(call => call.operation === 'tts').payload.prompt, text);
  assert.deepEqual(draft.config.segments.map(segment => [segment.start, segment.duration, path.dirname(segment.shots[0].path)]), [[0, 2, f.apples], [2, 4, f.bananas], [6, 4, f.apples]]);
  assert.equal(draft.timeline.clips.filter(clip => clip.track === 'voice').length, 1);
  assert.equal(draft.config.timingEstimated, false);
  await f.restart();
  assert.equal((await f.service.openTimeline(draft.id)).config.masterText, text);
  assert.equal((await f.service.createMontageDraft({ ...config, requestKey: 'bound-three' })).id, draft.id);
  assert.equal(f.calls.filter(call => call.operation === 'tts').length, 1);
  const changed = structuredClone(config); changed.setup.sections[0].candidateBindings[0].bindings[0].folderPath = f.bananas;
  await assert.rejects(f.service.createMontageDraft(changed), /已变化/);
});

test('改写必须单独语义复核，重复短句重定位失败会要求手工处理；确认后还需重新校对', async t => {
  let rewritten = '苹果红。香蕉黄。其实苹果红。';
  const f = await fixture(t, async (_operation, payload) => {
    if (payload.systemPrompt.includes('bindingMatches')) return { text: JSON.stringify({ bindingMatches: [
      { segmentIndex: 0, bindingId: 'last', status: 'unresolved', reason: '后一句加入转折，需核对是否仍展示同一类苹果。' },
    ] }) };
    if (payload.systemPrompt.includes('修正后的该段全文')) return { text: JSON.stringify({ segments: [{ section: 'A', text: rewritten }], reason: '增加衔接' }) };
    return { text: JSON.stringify(pass) };
  });
  await f.service.scanMontageBindingFolders(f.material);
  const text = '苹果红。香蕉黄。苹果红。';
  const setup = sectionSetup(text, [bind('last', text, 8, 12, f.apples)], [path.join(f.bananas, '一.png')]);
  const config = await checkedConfig(f.service, setup);
  const suggested = await f.service.suggestMontageCombination({ setup, index: 0, sourceKey: config.reviewSourceKey, mode: 'rewrite' });
  assert.equal(suggested.proposal.segments[0].bindings[0].status, 'needs-review');
  assert.equal(suggested.proposal.segments[0].bindings[0].start, 0);
  const semantic = JSON.parse(f.calls.find(call => call.payload.systemPrompt?.includes('bindingMatches')).payload.prompt);
  assert.equal(semantic.bindings[0].originalStart, 8);
  assert.equal(semantic.bindings[0].rewrittenText, rewritten);
  const accepted = await f.service.acceptMontageSuggestion({ setup, index: 0, sourceKey: config.reviewSourceKey, proposalId: suggested.proposal.id });
  let current = { ...config, ...accepted.accepted };
  await assert.rejects(f.service.createMontageDraft(current), /尚未通过/);
  await f.service.reviewMontageCombinations({ setup, indices: [0] });
  await assert.rejects(f.service.createMontageDraft(current), /素材目录还需确认/);
  assert(!f.events.includes('tts'));
  const repaired = await f.service.resolveMontageBindings({ setup, index: 0, sourceKey: config.reviewSourceKey, bindingsBySegment: [[bind('last', rewritten, 8, rewritten.length, f.apples)]] });
  current = { ...config, ...repaired.accepted };
  await assert.rejects(f.service.createMontageDraft(current), /尚未通过/);
  await f.service.reviewMontageCombinations({ setup, indices: [0] });
  const draft = await f.service.createMontageDraft(current);
  assert.equal(draft.config.masterText, rewritten);
  assert.equal(draft.config.reviewedSegments[0].bindings[0].quote, '其实苹果红。');
  assert.equal(f.calls.filter(call => call.operation === 'tts').length, 1);
});

test('语义重定位接受准确的新范围，幻觉范围、漏项或重复绑定不能沿用旧偏移', () => {
  const original = sectionSetup('苹果红。苹果红。', [bind('last', '苹果红。苹果红。', 4, 8, '/apples')]);
  const combo = montageReviewCombination(original, 0);
  const proposal = parseMontageSuggestion(JSON.stringify({ segments: [{ section: 'A', text: '这颗苹果红。苹果红。' }], reason: '补充指代' }), original, combo, 'rewrite');
  const match = { segmentIndex: 0, bindingId: 'last', status: 'matched', start: 6, end: 10, quote: '苹果红。', reason: '后一句仍指同样的苹果，目录适配。' };
  const evidence = [{ folderPath: '/apples', evidenceComplete: true, images: [{ description: '红苹果', fingerprint: 'a'.repeat(64) }], files: [{ path: '/apples/a.png', fingerprint: 'a'.repeat(64) }] }];
  const mapped = applyMontageBindingReview(JSON.stringify({ bindingMatches: [match] }), combo, proposal, evidence);
  assert.equal(mapped.segments[0].bindings[0].start, 6);
  assert.equal(mapped.segments[0].bindings[0].status, 'ready');
  assert.throws(() => applyMontageBindingReview(JSON.stringify({ bindingMatches: [{ ...match, start: 4 }] }), combo, proposal, evidence), /范围/);
  assert.throws(() => applyMontageBindingReview(JSON.stringify({ bindingMatches: [] }), combo, proposal), /数量/);
  assert.equal(applyMontageBindingReview(JSON.stringify({ bindingMatches: [match] }), combo, proposal).segments[0].bindings[0].status, 'needs-review', '模型matched不能替代真实图片内容依据');
});

test('未覆盖的正文无默认素材时在TTS前阻断，纯标点缝隙不额外拆轨', () => {
  const text = '苹果红。香蕉黄。';
  const combo = montageReviewCombination(sectionSetup(text, [bind('a', text, 0, 4, '/a')]), 0);
  assert.throws(() => montageVisualFragments(combo.segments, [{ path: '/a', paths: ['/a/a.png'] }]), /未绑定素材/);
  const spaced = '苹果红。  香蕉黄。';
  const complete = montageReviewCombination(sectionSetup(spaced, [bind('a', spaced, 0, 4, '/a'), bind('b', spaced, 6, 10, '/b')]), 0);
  const units = montageVisualFragments(complete.segments, [{ path: '/a', paths: ['/a/a.png'] }, { path: '/b', paths: ['/b/b.png'] }]);
  assert.equal(units.length, 2); assert.equal(units.map(unit => unit.text).join(''), spaced);
});

test('校对后目录被链接替换、图片失效或扫描期间复检不通过，均不会开始配音', async t => {
  const f = await fixture(t);
  await f.service.scanMontageBindingFolders(f.material);
  const text = '苹果红。', setup = sectionSetup(text, [bind('a', text, 0, 4, f.apples)]);
  const config = await checkedConfig(f.service, setup);
  const moved = path.join(f.root, '原苹果');
  await fs.rename(f.apples, moved);
  await fs.symlink(f.bananas, f.apples, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.createMontageDraft(config), /链接/);
  await fs.unlink(f.apples); await fs.rename(moved, f.apples);
  f.service.montageScanner = async (_folder, { assetPaths }) => assetPaths.map(file => ({ id: file, path: file, kind: 'image', shots: [] }));
  await assert.rejects(f.service.createMontageDraft(config), /无法解码/);
  f.service.state.montageAssets = [];
  f.service.montageScanner = async (_folder, { assetPaths }) => {
    f.service.state.montageReviews[0].items[0].status = 'issue';
    return assetPaths.map(file => ({ id: file, path: file, kind: 'image', shots: [{ id: file, duration: 0, sourceIn: 0 }] }));
  };
  await assert.rejects(f.service.createMontageDraft(config), /尚未通过/);
  assert(!f.events.includes('tts'));
});

test('改写绑定复核返回畸形结果不误记ready，保留建议并提示手工修复', async t => {
  const f = await fixture(t, async (_operation, payload) => {
    if (payload.systemPrompt.includes('bindingMatches')) return { text: '{"bindingMatches":[]}' };
    if (payload.systemPrompt.includes('修正后的该段全文')) return { text: JSON.stringify({ segments: [{ section: 'A', text: '这颗苹果红。' }], reason: '补充指代' }) };
    return { text: JSON.stringify(pass) };
  });
  await f.service.scanMontageBindingFolders(f.material);
  const text = '苹果红。', setup = sectionSetup(text, [bind('a', text, 0, 4, f.apples)]);
  const config = await checkedConfig(f.service, setup);
  const { proposal } = await f.service.suggestMontageCombination({ setup, index: 0, sourceKey: config.reviewSourceKey, mode: 'rewrite' });
  assert.match(proposal.bindingWarning, /复核未完成/);
  assert.equal(proposal.segments[0].bindings[0].status, 'needs-review');
  assert.equal(proposal.segments[0].bindings[0].quote, '');
  assert.equal(f.service.state.montageReviews[0].items[0].accepted, undefined);
  assert(!f.events.includes('tts'));
});

test('不同绑定目录中有相同图片内容，索引不能用相同哈希覆盖先前路径', async t => {
  const f = await fixture(t);
  await f.service.scanMontageBindingFolders(f.material);
  f.service.montageScanner = async (_folder, { assetPaths }) => assetPaths.map(file => ({ id: 'same-content-hash', path: file, kind: 'image', shots: [{ id: 'same-shot-hash', sourceIn: 0, duration: 0 }] }));
  const text = '苹果红。香蕉黄。';
  const setup = sectionSetup(text, [bind('a', text, 0, 4, f.apples), bind('b', text, 4, 8, f.bananas)]);
  const draft = await f.service.createMontageDraft(await checkedConfig(f.service, setup));
  assert.deepEqual(draft.config.segments.map(segment => path.dirname(segment.shots[0].path)), [f.apples, f.bananas]);
  assert.equal(new Set(draft.config.segments.map(segment => segment.shots[0].id)).size, 2);
});

test('已有索引的绑定图片原路径变为损坏文件，刷新选中素材并在配音前阻断', async t => {
  const f = await fixture(t);
  await f.service.scanMontageBindingFolders(f.material);
  for (const name of ['一.png', '二.png']) {
    const file = path.join(f.apples, name);
    f.service.state.montageAssets.push({ id: file, path: file, kind: 'image', shots: [{ id: file, duration: 0, sourceIn: 0 }] });
    await fs.writeFile(file, 'now corrupt image bytes');
  }
  let rescans = 0;
  f.service.montageScanner = async (_folder, { assetPaths }) => { rescans++; return assetPaths.map(file => ({ id: file, path: file, kind: 'image', shots: [], error: '媒体无法解码' })); };
  const text = '苹果红。', setup = sectionSetup(text, [bind('a', text, 0, 4, f.apples)]);
  await assert.rejects(f.service.createMontageDraft(await checkedConfig(f.service, setup)), /无法解码/);
  assert.equal(rescans, 1); assert(!f.events.includes('tts')); assert.equal(f.service.state.montageDrafts.length, 0);
});

test('配音进行中复检改为有问题时不保存草稿，已保存音频在重新通过后复用', async t => {
  const f = await fixture(t);
  await f.service.scanMontageBindingFolders(f.material);
  const text = '苹果红。', setup = sectionSetup(text, [bind('a', text, 0, 4, f.apples)]);
  const config = await checkedConfig(f.service, setup);
  const synthesize = f.service.speechAudio.bind(f.service);
  f.service.speechAudio = async (...args) => { const audio = await synthesize(...args); f.service.state.montageReviews[0].items[0].status = 'issue'; return audio; };
  await assert.rejects(f.service.createMontageDraft(config), /尚未通过/);
  assert.equal(f.service.state.montageDrafts.length, 0); assert(!f.events.includes('prepare'));
  assert.equal(f.calls.filter(call => call.operation === 'tts').length, 1);
  f.service.speechAudio = synthesize;
  await f.service.reviewMontageCombinations({ setup, indices: [0], force: true });
  await f.service.createMontageDraft(config);
  assert.equal(f.calls.filter(call => call.operation === 'tts').length, 1);
});

test('数字目录必须用全部实际图片描述复核，只识别受改写影响的目录且复用未变描述', async t => {
  const f = await fixture(t, async (_operation, payload) => {
    if (payload.systemPrompt.includes('bindingMatches')) {
      const data = JSON.parse(payload.prompt);
      assert.equal(data.materialEvidence.length, 1);
      assert.equal(data.materialEvidence[0].folderLabel, '1');
      assert.equal(data.materialEvidence[0].evidenceComplete, true);
      assert.equal(data.materialEvidence[0].images.length, 2);
      assert(data.materialEvidence[0].images.every(image => image.description.includes('画面可见') && /^[a-f0-9]{64}$/.test(image.fingerprint)));
      return { text: JSON.stringify({ bindingMatches: [{ segmentIndex: 0, bindingId: 'a', status: 'matched', start: 0, end: 6, quote: '这颗苹果红。', reason: '实际图片可见红苹果，支持新指代。' }] }) };
    }
    if (payload.systemPrompt.includes('修正后的该段全文')) return { text: JSON.stringify({ segments: [{ section: 'A', text: '这颗苹果红。' }, { section: 'B', text: '香蕉黄。' }], reason: '补充指代' }) };
    return { text: JSON.stringify(pass) };
  });
  const one = path.join(f.material, '1'), two = path.join(f.material, '2');
  await fs.rename(f.apples, one); await fs.rename(f.bananas, two);
  await f.service.scanMontageBindingFolders(f.material);
  const setup = { mode: 'sections', sections: [sectionSetup('苹果红。', [bind('a', '苹果红。', 0, 4, one)]).sections[0], { ...sectionSetup('香蕉黄。', [bind('b', '香蕉黄。', 0, 4, two)]).sections[0], section: 'B' }] };
  const config = await checkedConfig(f.service, setup);
  const request = { setup, index: 0, sourceKey: config.reviewSourceKey, mode: 'rewrite' };
  const { proposal } = await f.service.suggestMontageCombination(request);
  assert.equal(proposal.segments[0].bindings[0].status, 'ready');
  assert.equal(proposal.segments[0].bindings[0].materialEvidence.files.length, 2);
  assert.equal(proposal.segments[1].bindings[0].materialEvidence, undefined, '未改写段落不应产生多余识别费用');
  assert.equal(f.calls.filter(call => call.operation === 'describe').length, 2);
  assert(f.calls.filter(call => call.operation === 'describe').every(call => call.payload.referencePaths.every(file => path.dirname(file) === one)));
  await f.service.suggestMontageCombination(request);
  assert.equal(f.calls.filter(call => call.operation === 'describe').length, 2, '相同图片复用已识别描述');
});

test('无视觉配置不凭名称假通过，大目录自动分页复核全部图片而非固定张数阻断', async t => {
  let semanticCalls = 0, allowSemantic = false, covered = 0;
  const f = await fixture(t, async (_operation, payload) => {
    if (payload.systemPrompt.includes('bindingMatches')) {
      assert(allowSemantic, '不应对无图片依据调用语义复核'); semanticCalls++;
      const data = JSON.parse(payload.prompt); covered += data.materialEvidence[0].images.length;
      assert(payload.prompt.length < 48000);
      return { text: JSON.stringify({ bindingMatches: [{ segmentIndex: 0, bindingId: 'a', status: 'matched', start: 0, end: 6, quote: '这颗苹果红。', reason: '本页每张实际图片都支持红苹果文案。' }] }) };
    }
    if (payload.systemPrompt.includes('修正后的该段全文')) return { text: JSON.stringify({ segments: [{ section: 'A', text: '这颗苹果红。' }], reason: '补充指代' }) };
    return { text: JSON.stringify(pass) };
  });
  await f.service.scanMontageBindingFolders(f.material);
  await f.service.updateSettings({ bindings: { montageVision: '' } });
  const text = '苹果红。', setup = sectionSetup(text, [bind('a', text, 0, 4, f.apples)]);
  const config = await checkedConfig(f.service, setup), request = { setup, index: 0, sourceKey: config.reviewSourceKey, mode: 'rewrite' };
  const first = await f.service.suggestMontageCombination(request);
  assert.equal(first.proposal.segments[0].bindings[0].status, 'needs-review');
  assert.match(first.proposal.bindingWarning, /未配置混剪视觉模型/);
  assert.equal(semanticCalls, 0); assert.equal(f.calls.filter(call => call.operation === 'describe').length, 0);
  for (let i = 0; i < 100; i++) await fs.writeFile(path.join(f.apples, `更多${i}.png`), png);
  await f.service.updateSettings({ bindings: { montageVision: 'review' } });
  allowSemantic = true;
  const second = await f.service.suggestMontageCombination(request);
  assert.equal(second.proposal.segments[0].bindings[0].status, 'ready');
  assert.equal(second.proposal.segments[0].bindings[0].materialEvidence.files.length, 102);
  assert.equal(covered, 102); assert(semanticCalls > 1); assert.equal(f.calls.filter(call => call.operation === 'describe').length, 102);
});

test('匹配依据覆盖全部随机图片；采纳后图片增删改使视觉结论失效并阻止配音', async t => {
  const f = await fixture(t, async (_operation, payload) => {
    if (payload.systemPrompt.includes('bindingMatches')) return { text: JSON.stringify({ bindingMatches: [{ segmentIndex: 0, bindingId: 'a', status: 'matched', start: 0, end: 6, quote: '这颗苹果红。', reason: '每张实际图片的红苹果都适配。' }] }) };
    if (payload.systemPrompt.includes('修正后的该段全文')) return { text: JSON.stringify({ segments: [{ section: 'A', text: '这颗苹果红。' }], reason: '补充指代' }) };
    return { text: JSON.stringify(pass) };
  });
  await f.service.scanMontageBindingFolders(f.material);
  const setup = sectionSetup('苹果红。', [bind('a', '苹果红。', 0, 4, f.apples)]), config = await checkedConfig(f.service, setup);
  const { proposal } = await f.service.suggestMontageCombination({ setup, index: 0, sourceKey: config.reviewSourceKey, mode: 'rewrite' });
  const { accepted } = await f.service.acceptMontageSuggestion({ setup, index: 0, sourceKey: config.reviewSourceKey, proposalId: proposal.id });
  await f.service.reviewMontageCombinations({ setup, indices: [0] });
  const extra = path.join(f.apples, '新增.png'); await fs.writeFile(extra, png);
  await assert.rejects(f.service.createMontageDraft({ ...config, ...accepted }), /图片内容或目录文件已变化/);
  await fs.unlink(extra); await fs.writeFile(path.join(f.apples, '一.png'), Buffer.concat([png, Buffer.from('different-image-content')]));
  await assert.rejects(f.service.createMontageDraft({ ...config, ...accepted }), /图片内容或目录文件已变化/);
  assert(!f.events.includes('tts'));
});
