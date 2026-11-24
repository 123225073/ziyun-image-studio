import { createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';

const repository = '123225073/ziyun-image-studio';
const releaseApi = `https://api.github.com/repos/${repository}/releases`;
const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function macUpdateArch(arch, runningUnderARM64Translation = false) {
  if (arch === 'arm64' || (arch === 'x64' && runningUnderARM64Translation)) return 'arm64';
  if (arch === 'x64') return 'x64';
  throw new Error('暂不支持此 Mac 芯片的一键更新。');
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function packageIdentity(version, arch) {
  if (!versionPattern.test(version) || !['arm64', 'x64'].includes(arch)) throw new Error('Mac 安装包标识无效。');
  const name = `ZiyunStudio-${version}-mac-${arch}.dmg`;
  return { name, url: `https://github.com/${repository}/releases/download/v${version}/${name}` };
}

function validateAsset(asset) {
  const expected = packageIdentity(asset.version, asset.arch);
  if (asset.name !== expected.name || asset.url !== expected.url ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error('GitHub 安装包地址、大小或 SHA-256 校验信息无效，请查看正式发布页。');
  }
}

function deadline(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function resolveMacUpdate({ version, arch, fetchImpl = fetch, signal }) {
  packageIdentity(version, arch);
  const options = {
    credentials: 'omit', redirect: 'error', headers: { Accept: 'application/vnd.github+json' },
    signal: deadline(signal, 20000), cache: 'no-store',
  };
  let latest;
  let latestAssets;
  // A Mac-only release may be newer than GitHub's cross-platform "latest".
  // Read all public pages; GitHub orders by creation time, not version.
  for (let page = 1; ; page++) {
    const response = await fetchImpl(`${releaseApi}?per_page=100&page=${page}`, options);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`暂时无法读取 GitHub 的 Mac 发布列表（HTTP ${response.status}），请稍后重试。`);
    }
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error('GitHub 返回的 Mac 发布列表无效。');
    for (const release of releases) {
      const tag = release?.tag_name;
      if (release?.draft !== false || release.prerelease !== false || typeof tag !== 'string' || !tag.startsWith('v')) continue;
      const candidate = tag.slice(1);
      if (!versionPattern.test(candidate) || (latest && compareVersions(candidate, latest) <= 0)) continue;
      const { name } = packageIdentity(candidate, arch);
      const matches = Array.isArray(release.assets) ? release.assets.filter(asset => asset?.name === name) : [];
      if (matches.length) {
        latest = candidate;
        latestAssets = matches;
      }
    }
    if (releases.length < 100) break;
  }
  if (!latest) throw new Error('GitHub 上没有适用于此 Mac 芯片的正式版安装包。');
  const difference = compareVersions(latest, version);
  if (difference <= 0) return { latest, comparison: difference ? 'ahead' : 'current' };
  if (latestAssets.length !== 1 || latestAssets[0].state !== 'uploaded') {
    throw new Error('GitHub 发布中的 Mac 安装包尚未就绪，请稍后重试。');
  }
  const item = latestAssets[0];
  const digest = /^sha256:([a-f0-9]{64})$/.exec(item.digest);
  const asset = { version: latest, arch, name: item.name, url: item.browser_download_url, size: item.size, sha256: digest?.[1] };
  validateAsset(asset);
  return { latest, comparison: 'update', asset };
}

function isReleaseResponse(url, expected) {
  // Electron's net.fetch may expose no final URL. Its initial URL is fixed
  // above; followed redirects carry no credentials and the digest is pinned.
  if (!url || url === expected) return true;
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port &&
    ['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(parsed.hostname);
}

export async function downloadMacUpdate({ asset, directory, fetchImpl = fetch, signal, onProgress }) {
  validateAsset(asset);
  const file = path.resolve(directory, asset.name);
  const downloadSignal = deadline(signal, 30 * 60 * 1000);
  // Exclusive creation keeps a retried or concurrent download from replacing
  // a completed file in the staging directory.
  const output = await open(file, 'wx', 0o600);
  let verified = false;
  try {
    const response = await fetchImpl(asset.url, {
      credentials: 'omit', redirect: 'follow', signal: downloadSignal, cache: 'no-store',
    });
    if (response.status !== 200 || !response.body || !isReleaseResponse(response.url, asset.url)) {
      await response.body?.cancel();
      throw new Error(`无法从 GitHub 下载正式版 Mac 安装包（HTTP ${response.status}）。`);
    }
    const hash = createHash('sha256');
    let received = 0;
    let nextProgress = 0;
    for await (const chunk of response.body) {
      downloadSignal.throwIfAborted();
      received += chunk.byteLength;
      if (received > asset.size) throw new Error('下载的安装包超出发布大小，请重试。');
      hash.update(chunk);
      await output.writeFile(chunk);
      const now = Date.now();
      if (now >= nextProgress || received === asset.size) {
        onProgress?.({ received, total: asset.size });
        nextProgress = now + 200;
      }
    }
    downloadSignal.throwIfAborted();
    if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
      throw new Error('安装包下载不完整或 SHA-256 校验失败，请重新下载。');
    }
    await output.close();
    verified = true;
    return file;
  } finally {
    if (!verified) {
      try { await output.close(); } finally { await unlink(file); }
    }
  }
}
