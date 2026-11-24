import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadMacUpdate, macUpdateArch, resolveMacUpdate } from '../electron/mac-update-download.mjs';

const body = Buffer.from('release image fixture');
const digest = createHash('sha256').update(body).digest('hex');
const repo = '123225073/ziyun-image-studio';
function release(version, arch = 'arm64') {
  const name = `ZiyunStudio-${version}-mac-${arch}.dmg`;
  return {
    tag_name: 'v' + version, prerelease: false, draft: false,
    assets: [{ name, state: 'uploaded', size: body.length, digest: 'sha256:' + digest,
      browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${name}` }],
  };
}
async function query(releases, version = '0.8.0', arch = 'arm64') {
  return resolveMacUpdate({ version, arch, fetchImpl: async (url, options) => {
    assert.equal(url, `https://api.github.com/repos/${repo}/releases?per_page=100&page=1`);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return Response.json(releases);
  } });
}
async function directoryFor(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ziyun-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Mac native chip selection accounts for a translated Intel app', () => {
  assert.equal(macUpdateArch('arm64', false), 'arm64');
  assert.equal(macUpdateArch('x64', true), 'arm64');
  assert.equal(macUpdateArch('x64', false), 'x64');
  assert.throws(() => macUpdateArch('ia32'), /芯片/);
});

test('highest matching stable release wins irrespective of latest badge or order, without downgrades', async () => {
  const releases = [
    release('0.8.9'), release('0.9.0', 'x64'), { ...release('5.0.0'), prerelease: true },
    release('0.8.10'), { ...release('3.0.0'), draft: true }, release('4.0.0-beta'), release('00.9.9'),
  ];
  const result = await query(releases);
  assert.equal(result.comparison, 'update');
  assert.equal(result.latest, '0.8.10');
  assert.equal(result.asset.name, 'ZiyunStudio-0.8.10-mac-arm64.dmg');
  assert.equal(result.asset.sha256, digest);
  assert.deepEqual(await query(releases, '0.8.10'), { latest: '0.8.10', comparison: 'current' });
  assert.deepEqual(await query(releases, '1.0.0'), { latest: '0.8.10', comparison: 'ahead' });
  assert.equal((await query(releases, '0.8.0', 'x64')).latest, '0.9.0');
});

test('release selection inspects subsequent pages at fixed API endpoints', async () => {
  const visited = [];
  const result = await resolveMacUpdate({
    arch: 'arm64', version: '0.8.0', fetchImpl: async url => {
      visited.push(url);
      return Response.json(visited.length === 1 ? Array(100).fill(release('0.8.0')) : [release('0.8.1')]);
    },
  });
  assert.equal(result.latest, '0.8.1');
  assert.deepEqual(visited, [1, 2].map(page => `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`));
});

test('partial, duplicated, misdirected, or unverifiable releases cannot be installed', async () => {
  for (const patch of [{ digest: null }, { digest: digest }, { size: 0 }, { size: -1 }, { state: 'new' },
    { browser_download_url: 'https://example.com/asset' }, { browser_download_url: 'https://github.com/other/releases/download/file' }]) {
    const value = release('0.8.1');
    Object.assign(value.assets[0], patch);
    await assert.rejects(query([value]));
  }
  const duplicate = release('0.8.1');
  duplicate.assets.push(duplicate.assets[0]);
  await assert.rejects(query([duplicate]), /尚未就绪/);
  await assert.rejects(query([release('0.8.1', 'x64')]), /芯片/);
});

test('only the verified streamed disk image is returned and existing files are left intact', async t => {
  const directory = await directoryFor(t);
  const { asset } = await query([release('0.8.1')]);
  const progress = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url, asset.url);
    assert.equal(options.credentials, 'omit');
    const res = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(body.subarray(0, 7)); controller.enqueue(body.subarray(7)); controller.close();
    } }));
    Object.defineProperty(res, 'url', { value: 'https://release-assets.githubusercontent.com/path?ticket=github' });
    return res;
  };
  const file = await downloadMacUpdate({ directory, asset, fetchImpl, onProgress: event => progress.push(event) });
  assert.deepEqual(await readFile(file), body);
  assert.deepEqual(progress.at(-1), { received: body.length, total: body.length });
  assert.deepEqual(await readdir(directory), [asset.name]);
  await assert.rejects(downloadMacUpdate({ directory, asset, fetchImpl }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(file), body);
});

test('checksum mismatch, interrupted streams, size mismatch and bad source leave no partial image', async t => {
  const directory = await directoryFor(t);
  const { asset } = await query([release('0.8.1')]);
  const failedStream = new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } });
  const foreign = new Response(body);
  Object.defineProperty(foreign, 'url', { value: 'https://example.com/other.dmg' });
  for (const response of [new Response(Buffer.alloc(body.length)), new Response(body.subarray(1)),
    new Response(Buffer.concat([body, body])), new Response(failedStream), foreign, new Response(null, { status: 404 })]) {
    await assert.rejects(downloadMacUpdate({ directory, asset, fetchImpl: async () => response }));
    assert.deepEqual(await readdir(directory), []);
  }
  const controller = new AbortController();
  await assert.rejects(downloadMacUpdate({ directory, asset, signal: controller.signal,
    fetchImpl: async () => new Response(body), onProgress: () => controller.abort() }));
  assert.deepEqual(await readdir(directory), []);
});

test('invalid filenames and urls fail before creating files or making a request', async t => {
  const directory = await directoryFor(t);
  const { asset } = await query([release('0.8.1')]);
  await writeFile(path.join(directory, 'keep'), 'original');
  for (const patch of [{ name: '../keep' }, { arch: '../x64' }, { version: '../0.8.1' }, { url: 'file:///tmp/package.dmg' }]) {
    let requests = 0;
    await assert.rejects(downloadMacUpdate({ directory, asset: { ...asset, ...patch }, fetchImpl: async () => { requests++; } }));
    assert.equal(requests, 0);
  }
  assert.deepEqual(await readdir(directory), ['keep']);
  assert.equal(await readFile(path.join(directory, 'keep'), 'utf8'), 'original');
});
