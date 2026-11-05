import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { StudioService } from '../electron/service.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = path.join(root, 'test-output', `timeline-working-${randomUUID().slice(0, 8)}`);
const dataDir = path.join(fixture, 'data'), picturePath = path.join(fixture, 'picture.png'), audioPath = path.join(fixture, 'sound.wav');
await fs.mkdir(fixture, { recursive: true });
await fs.writeFile(picturePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
const audio = Buffer.alloc(524); audio.write('RIFF'); audio.writeUInt32LE(516, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(480, 40);
await fs.writeFile(audioPath, audio);
const service = await StudioService.create({ dataDir });
service.state.montageDrafts.push({ id: 'working-fixture', name: '异步保存锁验证', createdAt: new Date().toISOString(), config: {}, timeline: { ratio: '9:16', fontSize: 30, clips: [{ id: 'picture', track: 'picture', path: picturePath, start: 0, duration: 3, sourceIn: 0, volume: 1 }] } });
await service.updateSettings({ jianyingDraftRoot: fixture });
service.changed(); await service.close();
const env = { ...process.env, ZIYUN_DATA_DIR: dataDir, ZIYUN_SMOKE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: process.env.ZIYUN_TEST_EXE || createRequire(import.meta.url)('electron'), args: process.env.ZIYUN_TEST_EXE ? [] : [root], env, timeout: 60000 });
const errors = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('add-row').waitFor();
  await page.setViewportSize({ width: 1513, height: 1035 });
  await page.getByRole('button', { name: '03 混剪成片', exact: true }).click();
  await page.getByRole('button', { name: '打开时间线', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '成片时间轴', exact: true });
  await editor.locator('.timeline-clip.picture').click();
  // Hold only fixture IPC requests; no production server or user data is touched.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('studio:call');
    ipcMain.removeHandler('studio:call');
    ipcMain.handle('studio:call', async (event, method, ...args) => {
      if (globalThis.timelineTestMethod === method) {
        globalThis.timelineTestMethod = null;
        globalThis.timelineTestPending = { method, args };
        await new Promise(resolve => { globalThis.timelineTestRelease = resolve; });
        globalThis.timelineTestPending = null;
        if (method === 'exportJianying') {
          await original(event, 'saveTimeline', ...args);
          return { ok: true, value: { directory: 'isolated-jianying-fixture' } };
        }
        if (method === 'timelineMediaDuration') return { ok: true, value: 2 };
      }
      return original(event, method, ...args);
    });
  });
  const arm = method => app.evaluate((_electron, method) => { globalThis.timelineTestMethod = method; }, method);
  const release = () => app.evaluate(() => { globalThis.timelineTestRelease(); globalThis.timelineTestRelease = null; });
  const duration = editor.getByLabel('时长（秒）', { exact: true });
  const frozen = async () => {
    await page.waitForFunction(() => document.querySelector('.timeline-tools [role="status"]')?.textContent.includes('正在处理'));
    for (const name of ['返回成片', '保存草稿', '导出剪映草稿', '导出编辑版', '撤销', '移除片段', '在播放头分割']) assert(await editor.getByRole('button', { name, exact: true }).isDisabled(), name);
    assert.equal(await editor.locator('.timeline-add>button:enabled').count(), 0, '添加入口冻结');
    assert.equal(await editor.locator('.timeline-inspector input:enabled').count(), 0, '属性入口冻结');
    assert.equal(await editor.locator('.timeline-clip:enabled').count(), 0, '片段拖动冻结');
    const prior = await duration.inputValue();
    const clip = editor.locator('.timeline-clip.picture'), box = await clip.boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 10, { steps: 4 }); await page.mouse.up();
    await page.keyboard.press('Escape');
    assert(await editor.isVisible(), '等待期间 Esc 不能关闭编辑器');
    assert.equal(await editor.locator('.timeline-confirm').count(), 0, '等待期间不弹退出确认');
    assert.equal(await duration.inputValue(), prior);
  };
  const changeDuration = async value => { await duration.fill(String(value)); await duration.press('Enter'); };
  const persistedDuration = () => page.evaluate(async () => (await window.studio.call('getState')).montageDrafts.find(item => item.id === 'working-fixture').timeline.clips[0].duration);

  await changeDuration(4);
  await arm('saveTimeline'); await editor.getByRole('button', { name: '保存草稿', exact: true }).click();
  await frozen(); assert.equal(await persistedDuration(), 3, '等待期间尚未保存');
  await release();
  await editor.getByRole('button', { name: '返回成片', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.timeline-header .actions button')?.disabled);
  assert.equal(await persistedDuration(), 4); assert.match(await editor.locator('.timeline-header small').innerText(), /已保存/);
  await changeDuration(5);
  await arm('exportJianying'); await editor.getByRole('button', { name: '导出剪映草稿', exact: true }).click();
  await frozen(); assert.equal(await persistedDuration(), 4);
  await release(); await editor.getByText(/已导出：isolated-jianying-fixture/).waitFor();
  assert.equal(await persistedDuration(), 5); assert.match(await editor.locator('.timeline-header small').innerText(), /已保存/);
  await changeDuration(6);
  assert.match(await editor.locator('.timeline-header small').innerText(), /有未保存修改/);
  assert(!(await editor.getByRole('button', { name: '保存草稿', exact: true }).isDisabled()), '等待结束后可以继续编辑保存');
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, audioPath);
  await arm('timelineMediaDuration'); await editor.getByRole('button', { name: '＋ 音乐 / 音效', exact: true }).click();
  await frozen();
  assert.equal(await editor.locator('.timeline-clip.music').count(), 0, '素材读取完成前不插入半完成片段');
  await release(); await editor.locator('.timeline-clip.music').waitFor();
  assert.match(await editor.locator('.timeline-header small').innerText(), /有未保存修改/);
  await editor.getByRole('button', { name: '移除片段', exact: true }).click();
  assert.equal(await editor.locator('.timeline-clip.music').count(), 0, '素材读取后恢复可编辑');
  await page.keyboard.press('Escape'); await editor.locator('.timeline-confirm').waitFor();
  await editor.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(fixture, 'result.json'), JSON.stringify({ passed: true, checks: ['save-lock', 'jianying-export-lock', 'media-import-lock', 'drag-blocked', 'properties-disabled', 'undo-add-disabled', 'escape-blocked', 'editing-restored'], errors }, null, 2));
  console.log(`TIMELINE_WORKING_UI_PASS ${fixture}`);
} finally {
  try { await app.evaluate(({ app }) => app.exit(0)); } catch {}
  await app.close().catch(() => {});
}
