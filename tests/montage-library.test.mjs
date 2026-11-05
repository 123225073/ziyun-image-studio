import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanMontageFolder } from '../electron/montage-library.mjs';
import { resolveFfmpeg, runMedia } from '../electron/render.mjs';

test('递归导入图片视频，保存时间窗和识别结果，重复扫描及改名复用指纹', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-library-'));
  const ffmpegPath = await resolveFfmpeg(process.cwd());
  try {
    const folder = path.join(directory, 'sources');
    const nested = path.join(folder, '产品甲', '操作');
    const indexDir = path.join(directory, 'index');
    await fs.mkdir(nested, { recursive: true });
    const picture = path.join(nested, 'panel.png');
    const video = path.join(nested, 'fold.mp4');
    await runMedia(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x96', '-frames:v', '1', picture]);
    await runMedia(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x96:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    let calls = 0;
    const options = { ffmpegPath, indexDir, describeFrames: async paths => {
      calls++;
      assert.ok((await fs.stat(paths[0])).size > 0);
      return { description: '收纳箱透明面板', tags: ['收纳箱'], speaking: false };
    } };
    const first = await scanMontageFolder(folder, options);
    assert.equal(first.length, 2);
    assert.equal(calls, 2);
    assert.ok(first.every(asset => asset.category === '产品甲 / 操作'));
    const clip = first.find(asset => asset.kind === 'video');
    assert.equal(clip.shots[0].sourceIn, 0);
    assert.ok(clip.shots[0].duration > .9);
    const second = await scanMontageFolder(folder, { ...options, previousAssets: first });
    assert.equal(calls, 2);
    assert.deepEqual(second.map(asset => asset.fingerprint), first.map(asset => asset.fingerprint));
    await fs.rename(video, path.join(nested, 'renamed.mp4'));
    const renamed = await scanMontageFolder(folder, { ...options, previousAssets: second });
    assert.equal(calls, 2);
    assert.equal(renamed.find(asset => asset.kind === 'video').id, clip.id);
    assert.match(renamed.find(asset => asset.kind === 'video').shots[0].path, /renamed\.mp4$/);
    const selected = await scanMontageFolder(folder, { ...options, previousAssets: renamed, assetPaths: [picture] });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].path, picture);
    await assert.rejects(scanMontageFolder(folder, { ...options, assetPaths: [path.join(directory, 'outside.png')] }), /不在指定文件夹/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
