import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { resolveFfmpeg, runMedia } from '../electron/render.mjs';

// Real Electron IPC and rendering, isolated files, local mock AI/TTS only.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = path.join(root, 'test-output', `montage-bindings-${randomUUID().slice(0, 8)}`);
const dataDir = path.join(fixture, 'data'), library = path.join(fixture, '素材大目录');
const product = path.join(library, '01 产品外观'), scene = path.join(library, '02 出行场景'), nested = path.join(product, '子目录');
for (const folder of [product, scene, nested]) await fs.mkdir(folder, { recursive: true });
const ffmpeg = await resolveFfmpeg(root);
for (const [folder, color] of [[product, 'red'], [scene, 'blue'], [nested, 'green']]) await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=160x240`, '-frames:v', '1', path.join(folder, '画面.png')]);
const audio = path.join(fixture, 'voice.mp3');
await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ar', '24000', '-ac', '1', audio]);
const mp3 = await fs.readFile(audio), requests = [], speech = [], errors = [];
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === '/v1/audio/speech') { speech.push(body.input); res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(mp3); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    const system = body.messages.find(message => message.role === 'system')?.content || '';
    const userContent = body.messages.find(message => message.role === 'user').content;
    const input = Array.isArray(userContent) ? userContent : JSON.parse(userContent);
    let kind, output;
    if (Array.isArray(userContent) && userContent.some(part => part.type === 'image_url')) {
      kind = 'describe';
      assert(userContent.filter(part => part.type === 'image_url').every(part => /^data:image\//.test(part.image_url?.url) && part.image_url.url.length > 100), '素材复核必须收到实际图片数据');
      output = { description: '本地模拟识别：可见单色测试画面，用于验证实际图片证据通路。', tags: ['本地验收画面'], speaking: false };
    } else if (system.includes('bindingMatches')) {
      kind = 'bindings';
      assert.equal(input.bindings.length, 1, '每次语义复核只处理一个绑定');
      assert.equal(input.bindings[0].segmentIndex, 0, '分页请求使用局部段落索引');
      assert.equal(input.materialEvidence.length, 1);
      const evidence = input.materialEvidence[0];
      assert.equal(evidence.evidenceComplete, true);
      assert.equal(evidence.page, 1); assert.equal(evidence.pages, 1); assert.equal(evidence.totalImageCount, 1);
      assert.equal(evidence.images.length, 1); assert.match(evidence.images[0].fingerprint, /^[a-f0-9]{64}$/);
      assert.equal(evidence.files, undefined, '模型仅接收当前页图片识别证据，完整文件清单留在本机');
      output = { bindingMatches: input.bindings.map(binding => binding.originalQuote.includes('每天出门') ? { segmentIndex: binding.segmentIndex, bindingId: binding.bindingId, status: 'unresolved', reason: '本地验收：此范围需要人工确认对应场景。' } : { segmentIndex: binding.segmentIndex, bindingId: binding.bindingId, status: 'matched', start: 0, end: binding.rewrittenText.indexOf('。') + 1, quote: binding.rewrittenText.slice(0, binding.rewrittenText.indexOf('。') + 1), reason: '本地验收：外观描述与原目录语义一致。' }) };
    } else if (system.includes('修正后的该段全文')) {
      kind = 'rewrite';
      output = { segments: input.current.segments.map((segment, index) => ({ section: segment.section, text: index ? segment.text : segment.text.replace('这是一款', '这款') })), reason: '精简开场措辞，保留原文案信息。' };
    } else {
      kind = 'review'; output = { status: 'pass', summary: '本地验收：完整文案逻辑衔接正常。', issues: [] };
    }
    requests.push({ kind, input }); res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(output) } }] }));
  } catch (error) { errors.push(`mock: ${error.message}`); res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
// The isolated userData has no installed runtime. Pass the same verified local
// FFmpeg used to create these fixtures to packaged and source Electron runs.
const env = { ...process.env, ZIYUN_DATA_DIR: dataDir, ZIYUN_SMOKE: '1', ZIYUN_FFMPEG_PATH: ffmpeg }; delete env.ELECTRON_RUN_AS_NODE;
let application, page;
const call = (method, ...args) => page.evaluate(({ method, args }) => window.studio.call(method, ...args), { method, args });
const waitState = async (predicate, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { const state = await call('getState'); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error('等待文字绑定状态超时'); };
const panel = () => page.getByRole('region', { name: 'AI 文案逻辑校对', exact: true });
const reviewButton = name => panel().getByRole('button', { name, exact: true });
const idle = () => panel().locator('.review-progress').waitFor({ state: 'hidden' });
const begin = () => page.getByTestId('generate-montage-drafts');
const records = state => Object.values(state.montageReviews?.at(-1)?.items || {});
const nativePick = file => application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
async function launch() {
  application = await electron.launch({ executablePath: process.env.ZIYUN_TEST_EXE || createRequire(import.meta.url)('electron'), args: process.env.ZIYUN_TEST_EXE ? [] : [root], env, timeout: 60000 });
  page = await application.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('add-row').waitFor(); await page.setViewportSize({ width: 1513, height: 1035 });
  await page.getByRole('button', { name: '03 混剪成片', exact: true }).click();
}
async function close() { if (!application) return; try { await application.evaluate(({ app }) => app.exit(0)); } catch {} await Promise.race([application.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]); application = null; }
async function fill(section, values) {
  const editor = page.getByTestId(`candidates-${section}`);
  for (let index = 0; index < values.length; index++) { await editor.getByRole('button', { name: index ? '新增文案' : '添加第一条候选文案', exact: true }).click(); await page.getByLabel(`${section} 段候选文案 ${index + 1}`, { exact: true }).fill(values[index]); }
}
async function bind(label, quote, folder, scope = page) {
  const input = scope.getByLabel(label, { exact: true });
  await input.evaluate((element, quote) => { const start = element.value.indexOf(quote); if (start < 0) throw new Error('测试选区不在文案中'); element.focus(); element.setSelectionRange(start, start + quote.length); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); }, quote);
  const editor = input.locator('..'); await editor.getByLabel(`${label} 素材目录`, { exact: true }).selectOption(folder);
  await editor.getByRole('button', { name: '绑定选中文字', exact: true }).click();
}
try {
  await launch();
  await call('saveProvider', { id: 'binding-review', name: '本地素材校对', protocol: 'openai-chat', baseUrl, model: 'fixture-model', key: 'local-only-fixture' });
  await call('saveProvider', { id: 'binding-tts', name: '本地完整配音', protocol: 'openai-tts', baseUrl, model: 'tts-1', key: 'local-only-fixture' });
  await call('updateSettings', { bindings: { rewrite: 'binding-review', montageVision: 'binding-review', tts: 'binding-tts' }, autoExport: false });
  await nativePick(library); await page.getByRole('button', { name: '导入素材大目录', exact: true }).click();
  let state = await waitState(state => state.montageBindingLibrary?.mediaCount === 3);
  assert.equal(state.montageBindingLibrary.folders.find(folder => folder.path === product).paths.length, 1, '父目录不串入孙目录素材');
  assert.equal(await page.locator('.binding-folder-grid>div').count(), 4);
  const original = [['这是一款轻便水杯。每天出门都能随身携带。', '外观简洁的水杯，方便外出携带。'], ['适合喜欢轻装出行的人。']];
  await fill('A', original[0]); await fill('B', original[1]);
  await bind('A 段候选文案 1', '这是一款轻便水杯。', product);
  await bind('A 段候选文案 1', '每天出门都能随身携带。', scene);
  await bind('A 段候选文案 2', original[0][1], product);
  await bind('B 段候选文案 1', original[1][0], scene);
  state = await waitState(state => state.montageSetup?.sections[0]?.candidateBindings?.[0]?.bindings?.length === 2);
  assert.equal(await begin().isDisabled(), true, '未校对不得开始配音'); assert.equal(speech.length, 0);
  await page.getByLabel('A 段候选文案 1', { exact: true }).fill(`${original[0][0]}已编辑。`);
  await page.getByText('候选文案已修改，请先处理第 1 步的红色标注，再校对完整组合。', { exact: true }).waitFor();
  assert.equal(await reviewButton('开始 AI 校对').isDisabled(), true, '改字后旧选区不能继续校对');
  await page.getByLabel('A 段候选文案 1', { exact: true }).fill(original[0][0]);
  await page.getByLabel('A 段候选文案 1 标注 1 文件夹', { exact: true }).selectOption(scene);
  await page.getByLabel('A 段候选文案 1 标注 1 文件夹', { exact: true }).selectOption(product);
  await page.locator('.montage-workspace').evaluate(element => element.scrollTop = 0);
  await page.screenshot({ path: path.join(fixture, 'range-bindings-wide.png') });
  await reviewButton('开始 AI 校对').click(); await waitState(state => records(state).length === 2 && records(state).every(record => record.status === 'pass')); await idle();
  assert.equal(await begin().isDisabled(), false); assert.equal(speech.length, 0, '校对不调用配音');
  await reviewButton('已通过').click(); await reviewButton('轻度改写').first().click();
  state = await waitState(state => records(state)[0]?.proposal); await idle();
  const proposal = records(state)[0].proposal;
  assert.equal(proposal.segments[0].bindings[0].status, 'ready');
  assert.equal(proposal.segments[0].bindings[0].materialEvidence.files.length, 1, '自动重定位保留实际图片的内容指纹');
  assert(proposal.segments[0].bindings.some(binding => binding.status === 'needs-review'));
  assert.equal(requests.filter(item => item.kind === 'describe').length, 2, '改写语义复核前检查两个绑定目录的实际图片');
  const semanticRequests = requests.filter(item => item.kind === 'bindings');
  assert.equal(semanticRequests.length, 2, '两个绑定分别进行语义复核，不能依赖批内下标判断结果');
  assert.deepEqual(new Set(semanticRequests.map(item => item.input.bindings[0].bindingId)), new Set(proposal.segments[0].bindings.map(binding => binding.id)), '每个请求保留原绑定编号');
  assert.equal(records(state)[0].accepted, undefined, '未采纳建议不覆盖原组合');
  await reviewButton('检查并采纳这条建议').click();
  await page.getByRole('dialog', { name: '采纳文案建议', exact: true }).getByRole('button', { name: '确认采纳 1 条', exact: true }).click(); await idle();
  state = await waitState(state => records(state)[0]?.accepted && records(state)[0]?.status === 'unchecked');
  assert.deepEqual(state.montageSetup.sections.map(section => section.candidates), original);
  await reviewButton('开始 AI 校对').click(); await idle();
  await reviewButton('有问题').click();
  assert.equal(await panel().locator('.review-item').count(), 1, '文字校对通过但素材待确认仍进入问题列表');
  assert.equal(await begin().isDisabled(), true, '素材未确认不能启动配音');
  await reviewButton('检查素材对应').click();
  const dialog = page.getByRole('dialog', { name: '检查组合素材对应', exact: true });
  assert.equal(await dialog.getByRole('button', { name: '保存素材对应', exact: true }).isDisabled(), true);
  await dialog.getByLabel('组合 1 A 段素材对应 标注 1 文件夹', { exact: true }).selectOption(scene);
  await dialog.getByLabel('组合 1 A 段素材对应 标注 1 文件夹', { exact: true }).selectOption(product);
  const pending = dialog.locator('.binding-review-segment').first().locator('li.binding-unresolved');
  await pending.getByRole('button').click();
  await bind('组合 1 A 段素材对应', '每天出门都能随身携带。', scene, dialog);
  await page.setViewportSize({ width: 1050, height: 800 });
  await dialog.getByRole('button', { name: '保存素材对应', exact: true }).scrollIntoViewIfNeeded();
  const dialogBox = await dialog.boundingBox();
  assert(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= 1050 && dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= 800, '窄窗口素材检查弹窗完整留在视口内');
  await page.screenshot({ path: path.join(fixture, 'binding-resolution-narrow.png') });
  await dialog.getByRole('button', { name: '保存素材对应', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); await idle();
  state = await waitState(state => records(state)[0]?.status === 'unchecked');
  assert(records(state)[0].accepted.segments.every(segment => segment.bindings.every(binding => binding.status === 'ready')));
  assert.equal(records(state)[0].accepted.segments[0].bindings[0].materialEvidence, undefined, '用户手动更换目录不会沿用旧目录的 AI 指纹');
  await reviewButton('开始 AI 校对').click(); await idle(); await waitState(state => records(state).every(record => record.status === 'pass'));
  assert.equal(await begin().isDisabled(), false);
  await reviewButton('已通过').click();
  await page.setViewportSize({ width: 1050, height: 800 }); await panel().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(fixture, 'bindings-review-narrow.png') });
  const geometry = await page.locator('.montage-workspace').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  assert(geometry.scroll <= geometry.width + 1, '窄窗口不出现整页横向溢出');
  await close(); await launch();
  state = await call('getState'); assert.deepEqual(state.montageSetup.sections.map(section => section.candidates), original);
  assert.equal(records(state)[0].accepted.segments[0].bindings.length, 2, '重新启动恢复人工重绑结果');
  assert.equal(await begin().isDisabled(), false, '重新启动恢复有效校对状态');
  await begin().click(); await waitState(state => state.montageDrafts?.length === 2, 90000);
  await page.locator('.batch-progress').waitFor({ state: 'hidden', timeout: 90000 });
  assert.equal(await page.locator('.batch-failures').count(), 0);
  state = await call('getState'); assert.equal(speech.length, 2); assert(speech.every(text => text.includes('\n')));
  for (const draft of state.montageDrafts) {
    const pictures = draft.timeline.clips.filter(clip => clip.track === 'picture');
    assert(pictures.some(clip => clip.path === path.join(product, '画面.png')));
    assert(pictures.some(clip => clip.path === path.join(scene, '画面.png')));
    assert(!pictures.some(clip => clip.path === path.join(nested, '画面.png')));
    assert.equal(draft.timeline.clips.filter(clip => clip.track === 'voice').length, 1, '每条全文只合成一个完整配音轨');
  }
  await page.getByLabel('本次混剪范围', { exact: true }).selectOption('limited');
  await page.getByLabel('混剪组合数量', { exact: true }).fill('1');
  await page.getByTestId('generate-montage-drafts').click();
  const timeline = page.getByRole('dialog', { name: '成片时间轴', exact: true }); await timeline.waitFor();
  await timeline.getByRole('button', { name: '返回成片', exact: true }).click();
  state = await call('getState');
  assert.equal(state.montageDrafts.length, 2, '只改变处理范围时复用同一已完成草稿');
  assert.equal(speech.length, 2, '复用草稿不增加配音调用');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ passed: true, packaged: Boolean(process.env.ZIYUN_TEST_EXE), ffmpeg, reviewCalls: requests.filter(item => item.kind === 'review').length, imageEvidenceCalls: requests.filter(item => item.kind === 'describe').length, semanticReviewCalls: requests.filter(item => item.kind === 'bindings').length, speechCalls: speech.length, drafts: state.montageDrafts.length, errors }, null, 2));
  console.log(`MONTAGE_BINDINGS_UI_PASS ${fixture}`);
} catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(fixture, 'failure.png') }).catch(() => {}); throw error; }
finally { await close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
