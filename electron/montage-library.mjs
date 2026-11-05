import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runMedia } from './render.mjs';

const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const VIDEOS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);

function checkAbort(signal) {
  if (signal?.aborted) throw new Error('素材扫描已停止。');
}

async function fingerprint(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    checkAbort(signal);
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function listMedia(directory, signal, files = [], excludedDirectory = '') {
  checkAbort(signal);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    checkAbort(signal);
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (file === excludedDirectory) continue;
    if (entry.isDirectory()) await listMedia(file, signal, files, excludedDirectory);
    else if (entry.isFile() && (IMAGES.has(path.extname(entry.name).toLowerCase()) || VIDEOS.has(path.extname(entry.name).toLowerCase()))) {
      files.push(file);
      if (files.length > 5000) throw new Error('单次扫描最多支持 5000 个素材，请分目录导入。');
    }
  }
  return files;
}

function mediaInfo(stderr, image) {
  const size = stderr.match(/\b(\d{2,5})x(\d{2,5})(?:\b|\s)/);
  const time = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = image ? 0 : time && Number(time[1]) * 3600 + Number(time?.[2] || 0) * 60 + Number(time?.[3] || 0);
  if (!size || (!image && (!Number.isFinite(duration) || duration <= 0))) throw new Error('媒体无法解码或没有有效画面。');
  return { width: Number(size[1]), height: Number(size[2]), duration, hasAudio: /Stream .*Audio:/.test(stderr) };
}

function visualDescription(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch { parsed = { description: parsed }; }
  }
  return {
    description: String(parsed?.description || '').trim().slice(0, 1500),
    tags: Array.isArray(parsed?.tags) ? parsed.tags.map(String).filter(Boolean).slice(0, 30) : [],
    speaking: parsed?.speaking === true,
  };
}

// The scanner only reads the selected source tree. Generated previews live in
// the application's explicitly supplied index directory, never beside originals.
export async function scanMontageFolder(folder, {
  ffmpegPath, indexDir, previousAssets = [], signal, onProgress, describeFrames, assetPaths,
} = {}) {
  if (!ffmpegPath) throw new Error('请先配置可用的 FFmpeg。');
  const root = path.resolve(folder);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('请选择实际素材文件夹。');
  const indexDirectory = indexDir ? path.resolve(indexDir) : '';
  if (indexDirectory === root) throw new Error('素材索引目录必须与原素材目录分开。');
  if (indexDirectory) {
    await fs.mkdir(indexDirectory, { recursive: true });
    if ((await fs.lstat(indexDirectory)).isSymbolicLink()) throw new Error('索引目录不能是符号链接。');
  }
  let files;
  if (Array.isArray(assetPaths)) {
    files = [];
    const canonicalRoot = await fs.realpath(root);
    for (const selected of new Set(assetPaths)) {
      const file = path.resolve(selected);
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('已选素材不在指定文件夹内。');
      const canonical = await fs.realpath(file);
      const canonicalRelative = path.relative(canonicalRoot, canonical);
      if (canonicalRelative.startsWith(`..${path.sep}`) || canonicalRelative === '..' || path.isAbsolute(canonicalRelative) || !(await fs.lstat(file)).isFile()) throw new Error('已选素材不能指向文件夹外的链接。');
      const extension = path.extname(file).toLowerCase();
      if (!IMAGES.has(extension) && !VIDEOS.has(extension)) throw new Error('请选择可识别的图片或视频。');
      files.push(file);
    }
  } else files = await listMedia(root, signal, [], indexDirectory);
  const previousByPath = new Map(previousAssets.map(asset => [asset.path, asset]));
  const previousByHash = new Map(previousAssets.filter(asset => asset.fingerprint).map(asset => [asset.fingerprint, asset]));
  const assets = [];
  const hashes = new Set();
  for (const [position, file] of files.entries()) {
    checkAbort(signal);
    const stat = await fs.stat(file);
    const prior = previousByPath.get(file);
    const hash = prior?.fingerprint && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs ? prior.fingerprint : await fingerprint(file, signal);
    if (hashes.has(hash)) continue;
    hashes.add(hash);
    const unchanged = prior?.fingerprint === hash ? prior : previousByHash.get(hash);
    const category = path.relative(root, path.dirname(file)).split(path.sep).join(' / ');
    if (unchanged?.shots?.length) {
      const reusable = !indexDir || (await Promise.all(unchanged.shots.map(shot => shot.thumbnailPath ? fs.stat(shot.thumbnailPath).then(item => item.isFile()).catch(() => false) : false))).every(Boolean);
      if (reusable && (!describeFrames || unchanged.shots.every(shot => shot.analysis === 'visual' || shot.analysis === 'manual'))) {
        assets.push({ ...unchanged, path: file, name: path.basename(file), category, size: stat.size, mtimeMs: stat.mtimeMs, shots: unchanged.shots.map(shot => ({ ...shot, path: file })) });
        onProgress?.({ completed: position + 1, total: files.length, reused: true });
        continue;
      }
    }
    const image = IMAGES.has(path.extname(file).toLowerCase());
    const probe = await runMedia(ffmpegPath, ['-hide_banner', '-i', file], { signal, allowFailure: true });
    let info;
    try { info = mediaInfo(probe.stderr, image); }
    catch (error) {
      assets.push({ id: hash.slice(0, 24), path: file, name: path.basename(file), kind: image ? 'image' : 'video', category, fingerprint: hash, size: stat.size, mtimeMs: stat.mtimeMs, shots: [], error: error.message });
      onProgress?.({ completed: position + 1, total: files.length });
      continue;
    }
    const count = image ? 1 : Math.min(120, Math.max(1, Math.ceil(info.duration / 5)));
    const shots = [];
    for (let index = 0; index < count; index++) {
      checkAbort(signal);
      const sourceIn = image ? 0 : index * info.duration / count;
      const duration = image ? 0 : Math.min(info.duration - sourceIn, info.duration / count);
      const id = `${hash.slice(0, 24)}-${index}`;
      const previousShot = unchanged?.shots?.find(shot => shot.id === id);
      const thumbnailPath = indexDirectory ? path.join(indexDirectory, `${id}.jpg`) : '';
      if (thumbnailPath && !(await fs.stat(thumbnailPath).catch(() => null))?.isFile()) {
        const at = image ? [] : ['-ss', String(sourceIn + Math.min(duration / 2, 1))];
        await runMedia(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...at, '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', thumbnailPath], { signal });
      }
      let description = previousShot?.description || '';
      let tags = previousShot?.tags || [];
      let speaking = previousShot?.speaking === true;
      let analysis = previousShot?.analysis || 'unreviewed';
      let analysisError = '';
      if (describeFrames && thumbnailPath && analysis !== 'manual') {
        try {
          ({ description, tags, speaking } = visualDescription(await describeFrames([thumbnailPath], { assetPath: file, sourceIn, duration, signal })));
          analysis = description ? 'visual' : 'unreviewed';
        } catch (error) {
          checkAbort(signal);
          analysisError = '画面识别未完成，可重试或手工填写描述。';
        }
      }
      shots.push({ id, path: file, sourceIn, duration, thumbnailPath, description, tags, speaking, analysis, ...(analysisError ? { analysisError } : {}) });
    }
    assets.push({ id: hash.slice(0, 24), path: file, name: path.basename(file), kind: image ? 'image' : 'video', category, fingerprint: hash, size: stat.size, mtimeMs: stat.mtimeMs, ...info, shots });
    onProgress?.({ completed: position + 1, total: files.length, reused: false });
  }
  return assets;
}
