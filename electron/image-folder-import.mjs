import fs from 'node:fs/promises';
import path from 'node:path';
import { sniffMedia } from './providers.mjs';
import { isLocalImageBatchPath, normalizeImageBatchRow } from '../shared/image-batch-import.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
export const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const samePath = (a, b) => pathKey(a) === pathKey(b);
const missingStat = file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

async function checkedDirectory(file, label, allowMissing = false) {
  const stat = await missingStat(file);
  if (!stat && allowMissing) return false;
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}不存在、不是文件夹或包含链接，请检查原目录。`);
  if (!samePath(await fs.realpath(file), file)) throw new Error(`${label}的实际路径已变化或包含链接，已停止写入。`);
  return true;
}

async function checkedImage(file) {
  const stat = await missingStat(file);
  if (!stat?.isFile() || stat.isSymbolicLink() || !IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new Error('母图不存在、不是支持的图片或是链接文件。');
  if (!samePath(await fs.realpath(file), file)) throw new Error('母图的实际路径已变化，不能使用目录外的文件。');
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(64), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    let media; try { media = sniffMedia(bytes.subarray(0, bytesRead)); } catch { throw new Error('母图文件内容不是有效图片。'); }
    if (media?.kind !== 'image') throw new Error('母图文件内容不是有效图片。');
  } finally { await handle.close(); }
}

// Output authorization is independent of the current reference pictures. The
// historical field names remain readable for already saved rows and jobs.
export async function validateImageFolderMapping(row, { createOutput = false } = {}) {
  if (row?.outputMode !== 'source-children' || [row.sourceRoot, row.sourceFolder].some(file => typeof file !== 'string' || !path.isAbsolute(file) || !isLocalImageBatchPath(file))) throw new Error('子图保存位置无效，请重新选择类型目录。');
  const root = path.resolve(row.sourceRoot), folder = path.resolve(row.sourceFolder);
  if (!samePath(path.dirname(folder), root)) throw new Error('类型目录超出已选择的原目录。');
  await checkedDirectory(root, '已选择的根目录');
  await checkedDirectory(folder, '类型目录');
  const outputPath = path.join(folder, '子图');
  const exists = await checkedDirectory(outputPath, '子图目录', true);
  if (!exists && createOutput) {
    try { await fs.mkdir(outputPath); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await checkedDirectory(outputPath, '子图目录');
  }
  return outputPath;
}

function folderIdentity(folderName) {
  const match = folderName.match(/^([a-z]+\d+)(?:[\s._\-—–]+(.*))?$/i);
  return match ? { code: match[1].toUpperCase(), name: match[2]?.trim() || folderName } : { code: '', name: folderName };
}

export async function inspectImageOutputFolder(selectedFolder, { sourceRoot, allowChildSelection = true } = {}) {
  if (typeof selectedFolder !== 'string' || !path.isAbsolute(selectedFolder) || !isLocalImageBatchPath(selectedFolder)) throw new Error('原目录子图模式需要本机的单个类型文件夹。');
  const selectedStat = await missingStat(selectedFolder);
  if (!selectedStat?.isDirectory() || selectedStat.isSymbolicLink()) throw new Error('类型目录不是普通文件夹，请勿选择链接或图片文件。');
  const selectedPath = await fs.realpath(selectedFolder);
  const sourceFolder = allowChildSelection && path.basename(selectedPath) === '子图' ? path.dirname(selectedPath) : selectedPath;
  const root = sourceRoot || path.dirname(sourceFolder);
  if (typeof root !== 'string' || !path.isAbsolute(root) || !isLocalImageBatchPath(root)) throw new Error('类型目录的根目录无效。');
  await checkedDirectory(root, '已选择的根目录');
  if (!samePath(path.dirname(sourceFolder), root)) throw new Error('类型目录的实际路径超出已选择的根目录。');
  const mapping = { outputMode: 'source-children', sourceRoot: root, sourceFolder };
  const outputPath = await validateImageFolderMapping(mapping);
  return { ...mapping, outputPath };
}

export async function inspectImageTypeFolder(selectedFolder, options = {}) {
  const mapping = await inspectImageOutputFolder(selectedFolder, {...options, allowChildSelection: false});
  const { sourceFolder } = mapping;
  const children = await fs.readdir(sourceFolder, { withFileTypes: true });
  const images = children.filter(child => (child.isFile() || child.isSymbolicLink()) && IMAGE_EXTENSIONS.has(path.extname(child.name).toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  const named = images.filter(child => /^母图(?:[\s_\-]*(?:\d+|[（(]\d+[)）]))?$/u.test(path.parse(child.name).name.trim()));
  const mothers = named.length ? named : images;
  if (!mothers.length) throw new Error('类型目录本层没有图片；子图目录不会作为参考来源。');
  if (mothers.length > 16) throw new Error('每行最多同时使用 16 张母图，请拆分类型目录后导入。');
  const motherPaths = mothers.map(mother => path.join(sourceFolder, mother.name));
  for (const mother of motherPaths) await checkedImage(mother);
  return { ...mapping, motherPath: motherPaths[0], motherPaths, sourceMode: 'single', referenceMode: 'all', sourcePaths: motherPaths, warnings: images.length > mothers.length ? [`使用 ${mothers.length} 张母图，本层另外 ${images.length - mothers.length} 张图片不参与生成。`] : [] };
}

// Read only: this does not create 子图, save rows, or call any model.
export async function scanImageFolderImport(selectedRoot, { existingRows = [], settings = {} } = {}) {
  if (typeof selectedRoot !== 'string' || !path.isAbsolute(selectedRoot) || !isLocalImageBatchPath(selectedRoot)) throw new Error('请选择本机的素材根目录。');
  const selectedStat = await missingStat(selectedRoot);
  if (!selectedStat?.isDirectory() || selectedStat.isSymbolicLink()) throw new Error('所选根目录不是普通文件夹，请勿选择链接或快捷方式。');
  // Canonicalize the selected trust root, including macOS /var → /private/var.
  const rootPath = await fs.realpath(selectedRoot);
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const folders = entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).sort((a, b) => {
    const left = folderIdentity(a.name).code, right = folderIdentity(b.name).code;
    if (Boolean(left) !== Boolean(right)) return left ? -1 : 1;
    return (left || a.name).localeCompare(right || b.name, 'zh-CN', { numeric: true });
  });
  if (folders.length > 500) throw new Error('每次最多导入 500 个类型文件夹，请分批整理。');
  const rows = [], errors = [], warnings = [], occupied = existingRows.map(row => ({ code: row.code }));
  for (const entry of folders) {
    const folderPath = path.join(rootPath, entry.name), outputPath = path.join(folderPath, '子图');
    const normalized = normalizeImageBatchRow(folderIdentity(entry.name), { existingRows: occupied, settings });
    const row = { sourceRoot: rootPath, folderPath, folderKey: pathKey(folderPath), folderName: entry.name, code: normalized.values.code, name: normalized.values.name, motherPath: '', motherPaths: [], outputPath, values: normalized.values, errors: [...normalized.errors], warnings: [...normalized.warnings] };
    try {
      const mapping = await inspectImageTypeFolder(folderPath, { sourceRoot: rootPath });
      row.motherPath = mapping.motherPath;
      row.motherPaths = mapping.motherPaths;
      row.values.sourceMode = 'single'; row.values.referenceMode = 'all'; row.values.sourcePaths = mapping.motherPaths;
      row.values.folderName = mapping.outputPath;
      row.warnings.push(...mapping.warnings);
    } catch (error) { row.errors.push(error.message); }
    if (row.code && !row.errors.length) occupied.push({ code: row.code });
    rows.push(row);
  }
  if (!rows.length) errors.push('根目录中没有类型子文件夹。请按“根目录 / A01-类型名 / 母图.png”整理后重试。');
  if (entries.some(entry => entry.isFile())) warnings.push('根目录本层文件不导入，只读取各类型文件夹中的母图。');
  const validCount = rows.filter(row => !row.errors.length).length;
  return { rootPath, rows, rowCount: rows.length, validCount, invalidCount: rows.length - validCount, errors, warnings };
}
