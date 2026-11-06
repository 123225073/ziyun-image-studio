import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { resolveFfmpeg, runMedia } from '../electron/render.mjs';

// Exercise the six visible steps in an isolated Electron workspace. Only the model
// responses and native file selections are replaced; IPC, drafts and media are real.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
await fs.mkdir(path.join(root, 'test-output'), { recursive: true });
const fixture = await fs.mkdtemp(path.join(root, 'test-output', 'montage-workflow-'));
const dataDir = path.join(fixture, 'data');
const ffmpeg = await resolveFfmpeg(root);
const voicePath = path.join(fixture, '旁白.mp3');
const textA = '这是一只轻便的水杯。', textB = '出门时可以随身携带。';
const folders = [path.join(fixture, '产品外观'), path.join(fixture, '使用场景')];
for (const [index, folder] of folders.entries()) {
  await fs.mkdir(folder);
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=${index ? 'green' : 'blue'}:s=160x240`, '-frames:v', '1', path.join(folder, '画面.png')]);
}
await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
  '-i', 'sine=frequency=440:duration=3', '-ar', '24000', '-ac', '1', voicePath]);
const audio = await fs.readFile(voicePath);
const events = [], errors = [], layout = [], navigationErrors = [];
const server = http.createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (request.url === '/v1/audio/speech') {
      events.push({ action: 'speech', text: body.input });
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' }); response.end(audio); return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    const content = JSON.parse(body.messages.find(message => message.role === 'user').content);
    events.push({ action: 'review', text: content.masterText });
    const result = { status: 'pass', summary: '测试文案衔接正常。', issues: [] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(result) } }] }));
  } catch (error) {
    errors.push(error.message); response.writeHead(500); response.end(error.message);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const env = { ...process.env, ZIYUN_DATA_DIR: dataDir, ZIYUN_SMOKE: '1', ZIYUN_FFMPEG_PATH: ffmpeg };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const call = (method, ...args) => page.evaluate(({ method, args }) => window.studio.call(method, ...args), { method, args });
const step = number => page.locator(`[data-workflow-step="${number}"]`);
const generate = () => page.getByTestId('generate-montage-drafts');
const reason = () => page.getByTestId('generation-block-reason');
const review = () => step(3).getByRole('button', { name: '开始 AI 校对', exact: true });
const nativePick = file => app.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] }); }, file);
async function assertReached(number) {
  await page.waitForFunction(n => document.activeElement?.id === `montage-step-${n}`, number);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const title = await step(number).getByRole('heading', { level: 2 }).boundingBox();
  const host = await page.getByTestId('montage-workspace').boundingBox();
  const nav = await page.getByRole('navigation', { name:'混剪步骤导航', exact:true }).boundingBox();
  assert(title.y >= nav.y + nav.height - 1 && title.y + title.height <= host.y + host.height + 1, `步骤 ${number} 标题未定位到导航下方`);
  const current = await page.locator('[data-workflow-jump][aria-current="step"]').getAttribute('data-workflow-jump');
  if (current !== String(number)) navigationErrors.push({ width:page.viewportSize().width, requested:number, highlighted:current });
}
async function jump(number) {
  await page.locator(`[data-workflow-jump="${number}"]`).click();
  await assertReached(number);
}
async function assertBlocked(pattern, destination) {
  await reason().filter({ hasText:pattern }).waitFor();
  assert(await generate().isDisabled(), '有待补项时仍可开始生成');
  await step(5).locator(`[data-workflow-target="${destination}"]`).click();
  await assertReached(destination);
  assert.equal(events.filter(event => event.action === 'speech').length, 0);
}
async function assertVisibleControl(locator, width) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1, '按钮横向超出视口');
  const exposed = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return Boolean(hit && (hit === element || element.contains(hit)));
  });
  assert(exposed, '按钮中心被其他固定元素遮挡');
}
async function checkLayout(width, height) {
  await page.setViewportSize({ width, height });
  await jump(3); await assertVisibleControl(review(), width);
  await page.screenshot({ path: path.join(fixture, `review-${width}.png`) });
  await jump(5); await assertVisibleControl(generate(), width);
  const geometry = await page.getByTestId('montage-workspace').evaluate(host => ({
    windowWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth,
    viewport: host.clientWidth, content: host.scrollWidth, right: host.getBoundingClientRect().right,
    navigation: Array.from(document.querySelectorAll('[data-workflow-jump]'), button => {
      const rect = button.getBoundingClientRect(); return { x: rect.x, right: rect.right };
    }),
  }));
  assert.equal(geometry.windowWidth, width);
  assert(geometry.documentWidth <= width + 1 && geometry.right <= width + 1 && geometry.content <= geometry.viewport + 1,
    `宽度 ${width} 出现页面或工作区横向溢出：${JSON.stringify(geometry)}`);
  assert(geometry.navigation.every(button => button.x >= -1 && button.right <= width + 1), '顶部步骤入口横向裁切');
  await page.screenshot({ path: path.join(fixture, `generate-${width}.png`) });
  layout.push({ width, height, ...geometry });
}
try {
  app = await electron.launch({ executablePath: process.env.ZIYUN_TEST_EXE || createRequire(import.meta.url)('electron'),
    args: process.env.ZIYUN_TEST_EXE ? [] : [root], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('add-row').waitFor();
  await page.setViewportSize({ width: 1513, height: 1035 });
  await call('updateSettings', { bindings: { rewrite: '', tts: '', montageVision: '' }, autoExport: false });
  await page.getByRole('button', { name: '03 混剪成片', exact: true }).click();
  await page.getByRole('navigation', { name: '混剪步骤导航', exact: true }).waitFor();
  assert.deepEqual(await page.locator('[data-workflow-step]').evaluateAll(nodes => nodes.map(n => n.dataset.workflowStep)), ['1','2','3','4','5','6']);
  assert.deepEqual(await page.locator('[data-workflow-jump]').evaluateAll(nodes => nodes.map(n => n.dataset.workflowJump)), ['1','2','3','4','5','6']);
  for (let number = 1; number <= 6; number++) await jump(number);
  assert.match(await step(2).innerText(), /自动/);
  assert.match(await step(4).innerText(), /第\s*5\s*步点击生成时才会执行|不会(?:立即)?(?:生成|开始|调用|合成|配音)/);
  assert.match(await step(5).innerText(), /自动/);
  assert.match(await step(6).innerText(), /编辑/); assert.match(await step(6).innerText(), /导出/);
  await assertBlocked(/填写.*候选文案/, 1);
  for (const [index, section] of ['A','B'].entries()) {
    await page.getByTestId(`candidates-${section}`).getByRole('button', { name: '添加第一条候选文案', exact: true }).click();
    await page.getByLabel(`${section} 段候选文案 1`, { exact: true }).fill(index ? textB : textA);
    await nativePick(folders[index]);
    await step(1).getByRole('button', { name: '选择素材文件夹', exact: true }).first().click();
    await step(1).getByText(folders[index], { exact: true }).waitFor();
  }
  assert.match(await page.getByTestId('combination-count').innerText(), /1\s*×\s*1\s*=\s*1/);
  const preview = step(2).getByLabel('查看完整文案预览', { exact: true });
  assert.equal(await preview.locator('..').getAttribute('open'), null);
  await preview.click();
  assert.match(await step(2).innerText(), new RegExp(textA + '\\s*' + textB));
  assert.deepEqual(events, [], '填写候选/预览组合不得发起模型调用');
  await assertBlocked(/需要校对|未校对/, 3);
  assert(await review().isDisabled(), '未配置校对连接仍可开始校对');
  await call('saveProvider', { id: 'workflow-review', name: '测试校对', protocol: 'openai-chat', baseUrl, model: 'fixture-review', key: 'local-test' });
  await step(3).getByLabel('文案校对AI连接', { exact: true }).selectOption('workflow-review');
  await review().click();
  await assertBlocked(/配音预设|绑定语音服务/, 4);
  assert.deepEqual(events, [{ action:'review', text:`${textA}\n${textB}` }]);
  await call('saveProvider', { id: 'workflow-tts', name: '测试配音', protocol: 'openai-tts', baseUrl, model: 'tts-1', key: 'local-test' });
  await call('updateSettings', { bindings: { tts: 'workflow-tts' } });
  await step(4).getByLabel('自动识别素材', { exact: true }).check();
  await assertBlocked(/绑定混剪素材识别服务|绑定.*识别/, 4);
  await step(4).getByLabel('自动识别素材', { exact: true }).uncheck();
  assert(await generate().isEnabled(), '补齐配置并通过校对后应可生成');
  for (const [width,height] of [[1513,1035],[1050,800],[800,800]]) await checkLayout(width,height);
  assert.equal(events.length, 1, '设置、跳转和查看草稿不应开始合成');
  await generate().click();
  const timeline = page.getByRole('dialog', { name: '成片时间轴', exact: true });
  await timeline.waitFor({ timeout: 90000 });
  await timeline.getByRole('button', { name: '返回成片', exact: true }).click();
  const state = await call('getState');
  assert.equal(state.montageDrafts.length, 1);
  assert.deepEqual(events.map(event => event.action), ['review','speech']);
  assert.equal(events[1].text, `${textA}\n${textB}`);
  assert.equal(state.montageDrafts[0].timeline.clips.filter(clip => clip.track === 'voice').length, 1);
  assert(state.montageDrafts[0].timeline.clips.some(clip => clip.track === 'picture'));
  await jump(6);
  await assertVisibleControl(step(6).getByRole('button', { name:'打开时间线', exact:true }), 800);
  await page.screenshot({ path:path.join(fixture,'draft-800.png') });
  // Check the existing-audio branch without rendering a second copy of the fixture.
  await page.setViewportSize({ width:1050, height:800 });
  await jump(1);
  await page.getByRole('button', { name:'整篇文案 / 已有配音', exact:true }).click();
  await page.getByLabel('混剪完整旁白', { exact:true }).fill('这段文案已经有完整旁白。');
  await nativePick(voicePath); await page.getByRole('button', { name:'导入完整旁白音频', exact:true }).click();
  await call('updateSettings', { bindings: { tts:'' } });
  await step(4).getByText(/复用|已有配音|已有音频/).first().waitFor();
  assert.match(await generate().innerText(), /使用已有配音生成时间线/);
  await jump(3); await review().click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="generate-montage-drafts"]').disabled);
  assert.equal(events.filter(event => event.action === 'speech').length, 1, '已有音频无需 TTS 连接，仍然只在显式点击后生成');
  assert.deepEqual(navigationErrors, [], '顶部高亮应跟随刚跳转的步骤');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(fixture,'result.json'), JSON.stringify({ passed:true, packaged:Boolean(process.env.ZIYUN_TEST_EXE), layout, events, drafts:state.montageDrafts.length, errors }, null, 2));
  console.log(`MONTAGE_WORKFLOW_UI_PASS ${fixture}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path:path.join(fixture,'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) { try { await app.evaluate(({ app }) => app.exit(0)); } catch {} await app.close().catch(() => {}); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
