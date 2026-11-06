import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { resolveFfmpeg, runMedia, mediaDuration } from '../electron/render.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = path.join(root, 'test-output', `speech-montage-${randomUUID().slice(0, 8)}`);
const dataDir = path.join(fixture, 'data');
const materialDir = path.join(fixture, '素材', '红色收纳箱');
await fs.mkdir(materialDir, { recursive: true });
const ffmpeg = await resolveFfmpeg(root);
const audioPath = path.join(fixture, 'fixture.wav');
const openingPath = path.join(materialDir, '固定片头.mp4');
await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.4', '-ar', '24000', '-ac', '1', audioPath]);
for (const [color, filename] of [['red', '收纳箱展开.png'], ['blue', '透明面板取物.png']]) {
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x480`, '-frames:v', '1', path.join(materialDir, filename)]);
}
await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x480:d=0.8', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', openingPath]);
const wav = await fs.readFile(audioPath);
const calls = [];
const text = '红色收纳箱展开。透明面板方便取物。';
let baseUrl;
const server = http.createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url === '/captions.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([{ text: '红色收纳箱展开。', time_begin: 0, time_end: 1200 }, { text: '透明面板方便取物。', time_begin: 1200, time_end: 2400 }]));
      return;
    }
    if (request.url === '/api/v3/tts/unidirectional') {
      assert.equal(request.headers['x-api-key'], 'isolated-doubao-key');
      assert.equal(body.req_params.audio_params.format, 'wav');
      calls.push({ protocol: 'doubao', text: body.req_params.text });
      response.setHeader('Content-Type', 'application/json');
      const chunks = [
        { code: 0, data: wav.subarray(0, 500).toString('base64') },
        { code: 0, data: wav.subarray(500).toString('base64'), sentence: { words: [{ word: '红色收纳箱展开。', startTime: 0, endTime: 1.2 }, { word: '透明面板方便取物。', startTime: 1.2, endTime: 2.4 }] } },
        { code: 20000000 },
      ];
      for (const chunk of chunks) response.write(JSON.stringify(chunk) + '\n');
      response.end();
      return;
    }
    if (request.url === '/v1/t2a_v2') {
      assert.equal(request.headers.authorization, 'Bearer isolated-minimax-key');
      assert.equal(body.audio_setting.format, 'wav');
      calls.push({ protocol: 'minimax', text: body.text });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { status: 2, audio: wav.toString('hex'), subtitle_file: `${baseUrl}/captions.json` }, extra_info: { audio_length: 2400 } }));
      return;
    }
    response.writeHead(404); response.end();
  } catch {
    response.writeHead(500); response.end('Isolated verification request failed');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
baseUrl = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, ZIYUN_DATA_DIR: dataDir, ZIYUN_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.ZIYUN_TEST_EXE || require('electron');
let application;
const errors = [];
async function launch() {
  application = await electron.launch({ executablePath, args: process.env.ZIYUN_TEST_EXE ? [] : [root], env, timeout: 60000 });
  const page = await application.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('settings-nav').waitFor();
  await page.setViewportSize({ width: 1513, height: 1035 });
  return page;
}
async function closeFixture() {
  if (!application) return;
  try { await application.evaluate(({ app }) => app.exit(0)); } catch {}
  await Promise.race([application.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
  application = undefined;
}
async function waitState(page, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.studio.call('getState'));
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated workflow state did not reach its expected result.');
}
async function screenshot(page, filename) {
  await page.bringToFront();
  await page.screenshot({ path: path.join(fixture, filename), animations: 'disabled', timeout: 60000 });
}
try {
  let page = await launch();
  await page.getByTestId('settings-nav').click();
  await page.getByRole('tab', {name:/语音合成/}).click();
  for (const [protocol, label, key, model] of [
    ['doubao-tts', '隔离豆包配音', 'isolated-doubao-key', 'seed-tts-2.0'],
    ['minimax-tts', '隔离MiniMax配音', 'isolated-minimax-key', 'speech-2.8-hd'],
  ]) {
    await page.getByRole('button', { name: '添加语音合成服务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加语音合成服务' });
    await dialog.getByLabel('服务平台', { exact: true }).selectOption(protocol === 'doubao-tts' ? 'doubao' : 'minimax-speech');
    await dialog.getByText('高级设置 · 名称、服务地址与等待时间', {exact:true}).click();
    await dialog.getByLabel('连接名称', { exact: true }).fill(label);
    await dialog.getByLabel('接口基础地址', { exact: true }).fill(baseUrl);
    await dialog.getByLabel('API Key', { exact: true }).fill(key);
    await dialog.getByLabel('模型名称', { exact: true }).fill(model);
    await dialog.getByRole('button', { name: '保存服务', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await page.getByRole('button', { name: '配音预设', exact: true }).click();
  const settings = page.getByTestId('speech-settings');
  for (const [label, protocol] of [['豆包验收声音', 'doubao-tts'], ['MiniMax验收声音', 'minimax-tts']]) {
    await settings.getByRole('button', { name: '新增配音预设', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '配音预设', exact: true });
    const providerId = await page.evaluate(async protocol => (await window.studio.call('getState')).settings.providers.find(provider => provider.protocol === protocol).id, protocol);
    await dialog.getByLabel('配音预设名称', { exact: true }).fill(label);
    await dialog.getByLabel('配音预设语音服务', { exact: true }).selectOption(providerId);
    await dialog.getByLabel('预设输出格式', { exact: true }).selectOption('wav');
    await dialog.getByRole('button', { name: '保存配音预设', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await screenshot(page, 'speech-settings.png');
  await page.getByTestId('speech-nav').click();
  const speech = page.getByTestId('speech-workspace');
  const ids = await page.evaluate(async () => (await window.studio.call('getState')).settings.speechPresets.map(preset => preset.id));
  for (const [index, presetId] of ids.entries()) {
    await speech.getByLabel('本次配音预设', { exact: true }).selectOption(presetId);
    await speech.getByLabel('配音名称', { exact: true }).fill(`真实UI配音 ${index + 1}`);
    await speech.getByLabel('配音文案', { exact: true }).fill(text);
    await speech.getByRole('button', { name: '生成配音', exact: true }).click();
    await waitState(page, state => state.jobs.filter(job => job.kind === 'speech' && job.status === 'succeeded').length === index + 1);
  }
  assert.equal(calls.filter(call => call.protocol === 'doubao').length, 1);
  assert.equal(calls.filter(call => call.protocol === 'minimax').length, 1);
  await speech.locator('audio').nth(1).waitFor({ state: 'visible' });
  assert.equal(await speech.locator('audio').count(), 2);
  await screenshot(page, 'speech-composer.png');
  await speech.locator('.speech-history').scrollIntoViewIfNeeded();
  await screenshot(page, 'speech-results.png');
  await speech.getByRole('button', { name: '用于混剪', exact: true }).first().click();
  const montage = page.getByTestId('montage-workspace');
  await montage.waitFor({ state: 'visible' });
  assert.equal(await montage.getByLabel('混剪完整旁白', { exact: true }).inputValue(), text);
  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, materialDir);
  await montage.getByRole('button', { name: '选择素材文件夹', exact: true }).first().click();
  await waitState(page, state => state.montageAssets.length >= 3);
  await page.evaluate(async () => {
    const state = await window.studio.call('getState');
    for (const asset of state.montageAssets) for (const shot of asset.shots) await window.studio.call('editMontageShot', { assetId: asset.id, shotId: shot.id, description: '红色收纳箱展开，透明面板方便取物。', tags: ['红色收纳箱', '展开', '透明面板', '取物'], speaking: false });
  });
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, openingPath);
  await montage.getByRole('button', { name: '添加开头视频（可选）', exact: true }).click();
  await montage.getByLabel('片头声音策略', { exact: true }).selectOption('original');
  await montage.getByLabel('混剪任务名称', { exact: true }).fill('原声片头验收');
  await montage.getByTestId('generate-montage-drafts').click();
  await page.getByRole('dialog', { name: '成片时间轴' }).waitFor({ timeout: 60000 });
  const preparedState = await page.evaluate(() => window.studio.call('getState'));
  assert(preparedState.montageDrafts[0].timeline.clips.filter(clip => clip.track === 'picture').length >= 2);
  await screenshot(page, 'montage-plan.png');
  await page.getByRole('button', { name: '导出编辑版', exact: true }).click();
  const state = await waitState(page, state => state.jobs.some(job => job.kind === 'montage' && ['succeeded', 'failed'].includes(job.status)), 120000);
  const exported = state.jobs.find(job => job.kind === 'montage');
  assert.equal(exported.status, 'succeeded', exported.error);
  const duration = await mediaDuration(ffmpeg, exported.localPath);
  assert(Math.abs(duration - 3.2) < .2, `Expected original opening plus voice duration, received ${duration}`);
  assert.equal(calls.length, 2, 'Existing narration must not synthesize again for montage');
  await montage.getByRole('button', { name: '编辑成片', exact: true }).first().click();
  await page.getByRole('dialog', { name: '成片时间轴' }).waitFor();
  await screenshot(page, 'montage-timeline.png');
  await closeFixture();
  page = await launch();
  const restored = await page.evaluate(() => window.studio.call('getState'));
  assert.equal(restored.settings.speechPresets.length, 2);
  assert.equal(restored.jobs.filter(job => job.kind === 'speech' && job.status === 'succeeded').length, 2);
  assert(restored.jobs.some(job => job.id === exported.id && job.status === 'succeeded'));
  await page.setViewportSize({ width: 1050, height: 800 });
  const navigationFits = await page.locator('.main-nav').evaluate(element => element.scrollWidth <= element.clientWidth);
  assert(navigationFits, 'The navigation should fit the minimum supported desktop width.');
  await page.getByRole('button', { name: '01 图片素材', exact: true }).click();
  await page.getByTestId('add-row').click();
  await page.getByRole('button', { name: '02 视频开头', exact: true }).click();
  await page.getByRole('button', { name: '加入视频生成队列', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ passed: true, fixture, providerRequests: calls.length, voiceJobs: 2, montageDuration: duration, errors }, null, 2));
  console.log(`SPEECH_MONTAGE_UI_PASS ${fixture}`);
} finally {
  await closeFixture();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
