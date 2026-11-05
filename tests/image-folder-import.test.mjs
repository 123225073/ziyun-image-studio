import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioService } from '../electron/service.mjs';
import { scanImageFolderImport, inspectImageTypeFolder, inspectImageOutputFolder, validateImageFolderMapping } from '../electron/image-folder-import.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const provider = { id: 'local', name: '隔离测试', protocol: 'openai-images', baseUrl: 'http://127.0.0.1:1', model: 'fixture' };
test('multi-file drops stay image references and over-limit batches create no partial jobs', async t => {
  const { root, service } = await fixture(t);
  const paths = [];
  for (let index = 0; index < 17; index++) { const file = path.join(root, `${index}.png`); await fs.writeFile(file, PNG); paths.push(file); }
  assert.deepEqual(await service.prepareReferenceDrop(paths.slice(0, 2)), { sourcePaths: paths.slice(0, 2), sourceMode: 'single' });
  const valid = await service.saveRow({ name: '正常行', userPrompt: '保持构图', referenceMode: 'all', sourcePaths: [paths[0]] });
  const invalid = await service.saveRow({ name: '超限行', userPrompt: '保持构图', referenceMode: 'all', sourcePaths: paths });
  await assert.rejects(service.enqueueImages([valid.id, invalid.id]), /最多 16/);
  assert.equal(service.state.jobs.length, 0);
  assert.equal(service.state.rows[0].imageBatch, null);
});
async function fixture(t, runner = async () => ({ images: [{ bytes: PNG }] })) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-folder-')));
  const sourceRoot = path.join(root, '素材根目录'); await fs.mkdir(sourceRoot);
  const dataDir = path.join(root, 'data');
  const service = await StudioService.create({ dataDir, providerRunner: runner });
  await service.updateSettings({ providers: [provider], bindings: { image: 'local' }, paused: true, autoExport: false, defaultTemplateId: '' });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, sourceRoot, dataDir, service };
}
async function typeFolder(root, name, pictures = ['母图.png'], children = false) {
  const folder = path.join(root, name); await fs.mkdir(folder);
  for (const picture of pictures) await fs.writeFile(path.join(folder, picture), PNG);
  if (children) { await fs.mkdir(path.join(folder, '子图')); await fs.writeFile(path.join(folder, '子图', '已有结果.png'), PNG); }
  return folder;
}
async function importRoot(service, root, id = 'directory-preview') {
  const plan = await scanImageFolderImport(root, { existingRows: service.state.rows, settings: service.state.settings });
  assert.equal(plan.invalidCount, 0, JSON.stringify(plan.rows));
  return service.importImageFolderBatch(id, plan.rows);
}
async function waitFor(service, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (predicate(service.state)) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(JSON.stringify(service.state.jobs.map(job => ({ status: job.status, error: job.error, exportError: job.exportError }))));
}

test('扫描只读取直接母图，目录编号解析且预览不创建子图或任务', async t => {
  const { sourceRoot, service } = await fixture(t);
  const a = await typeFolder(sourceRoot, 'A01-商品', ['母图.png', '旁边.png'], true);
  const b = await typeFolder(sourceRoot, 'B02_场景', ['任意参考.png']);
  const c = await typeFolder(sourceRoot, '无编号类型', ['一张图.png']);
  const plan = await scanImageFolderImport(sourceRoot, { settings: service.state.settings });
  assert.equal(plan.validCount, 3); assert.deepEqual(plan.rows.map(row => row.code), ['A01', 'B02', 'B03']);
  assert.deepEqual(plan.rows.map(row => row.name), ['商品', '场景', '无编号类型']);
  assert.deepEqual(plan.rows.map(row => row.values.sourcePaths), [[path.join(a, '母图.png')], [path.join(b, '任意参考.png')], [path.join(c, '一张图.png')]]);
  assert(plan.rows[0].warnings.length); assert.equal(service.state.rows.length, 0);
  assert.equal(await fs.stat(path.join(b, '子图')).catch(() => null), null);
  assert.deepEqual(await fs.readdir(path.join(a, '子图')), ['已有结果.png']);
});

test('多母图和未命名多图可一起使用，零图、无效图片、冲突输出与超过16张逐行拒绝', async t => {
  const { sourceRoot } = await fixture(t);
  await typeFolder(sourceRoot, 'A01-只有子图', [], true);
  await typeFolder(sourceRoot, 'A02-多图', ['甲.png', '乙.jpg']);
  await typeFolder(sourceRoot, 'A03-两个母图', ['母图.png', '母图.jpg']);
  const invalid = await typeFolder(sourceRoot, 'A04-伪图片'); await fs.writeFile(path.join(invalid, '母图.png'), 'not an image');
  const blocked = await typeFolder(sourceRoot, 'A05-目录冲突'); await fs.writeFile(path.join(blocked, '子图'), 'preserve');
  await typeFolder(sourceRoot, 'A06-太多母图', Array.from({length:17},(_,i)=>`母图${i+1}.png`));
  const plan = await scanImageFolderImport(sourceRoot);
  assert.equal(plan.invalidCount, 4); assert.equal(plan.validCount, 2);
  assert.match(plan.rows[0].errors.join(), /子图目录不会/);
  for(const row of plan.rows.slice(1,3)){assert.equal(row.motherPaths.length,2);assert.deepEqual(row.values.sourcePaths,row.motherPaths);assert.equal(row.values.referenceMode,'all');assert.equal(row.values.folderName,row.outputPath)}
  assert.match(plan.rows[3].errors.join(), /不是有效图片/);
  assert.match(plan.rows[5].errors.join(), /最多.*16/);
  assert.equal(await fs.readFile(path.join(blocked, '子图'), 'utf8'), 'preserve');
});

test('可信导入幂等且持久化，普通保存不能注入或改写原目录映射', async t => {
  const { sourceRoot, service, dataDir } = await fixture(t);
  const folder = await typeFolder(sourceRoot, 'A01-类型');
  const imported = await importRoot(service, sourceRoot);
  assert.deepEqual(await service.importImageFolderBatch('directory-preview', []), imported);
  assert.equal(service.state.jobs.length, 0); assert.equal(service.state.rows.length, 1);
  const row = service.state.rows[0]; assert.equal(row.outputMode, 'source-children');
  await service.saveRow({ ...row, name: '改名', count: 3, outputMode: '', sourceFolder: path.join(sourceRoot, 'fake') });
  assert.equal(service.state.rows[0].sourceFolder, folder); assert.equal(service.state.rows[0].count, 3);
  const replacement=path.join(sourceRoot,'替换参考.png');await fs.writeFile(replacement,PNG);
  await service.saveRow({ ...service.state.rows[0], sourcePaths: [replacement] });
  assert.deepEqual(service.state.rows[0].sourcePaths,[replacement]);assert.equal(service.state.rows[0].sourceFolder,folder);assert.equal(service.state.rows[0].folderName,path.join(folder,'子图'));
  const ordinary = await service.saveRow({ code: 'B01', outputMode: 'source-children', sourceRoot, sourceFolder: folder, motherPath: row.motherPath });
  assert.equal(ordinary.outputMode, undefined);
  const again = await scanImageFolderImport(sourceRoot, { existingRows: service.state.rows }); assert.equal(again.invalidCount, 1);
  await service.close();
  const restored = await StudioService.create({ dataDir });
  assert.equal(restored.state.rows[0].sourceFolder, folder); assert.deepEqual(await restored.importImageFolderBatch('directory-preview', []), imported);
  await restored.close();
});

test('输出定位可独立选择无母图目录或现有子图，旧映射也不依赖后来替换的参考',async t=>{
  const {sourceRoot}=await fixture(t),folder=await typeFolder(sourceRoot,'A01-保存位置',[],true);
  const mapping=await inspectImageOutputFolder(folder);
  assert.equal(mapping.sourceFolder,folder);assert.equal(mapping.outputPath,path.join(folder,'子图'));
  assert.deepEqual(await inspectImageOutputFolder(path.join(folder,'子图')),mapping);
  assert.equal(await validateImageFolderMapping({...mapping,motherPath:path.join(folder,'已移走母图.png'),sourceMode:'folder',sourcePaths:[path.join(sourceRoot,'新参考.png')]}),mapping.outputPath);
  assert.deepEqual(await fs.readdir(path.join(folder,'子图')),['已有结果.png']);
});

test('母图系列全部传给每次生成，改参考保留独立输出且已保存旧任务不漂移',async t=>{
  const references=[];
  const {sourceRoot,service}=await fixture(t,async(operation,payload)=>{references.push([...payload.referencePaths]);return {images:[{bytes:PNG}]}});
  const folder=await typeFolder(sourceRoot,'A01-多母图',['母图.png','母图2.jpg','母图_3.png','母图 (4).png','旁边.png'],true);
  const result=await importRoot(service,sourceRoot),row=service.state.rows[0];
  assert.equal(row.sourcePaths.length,4);assert.equal(row.referenceMode,'all');assert.equal(row.folderName,path.join(folder,'子图'));
  await service.saveRow({...row,count:2,userPrompt:'所有参考一起处理'});
  const jobs=await service.enqueueImages(result.importedIds);await service.setPaused(false);
  await waitFor(service,state=>state.jobs.every(job=>job.status==='succeeded'));
  assert.equal(references.length,2);assert(references.every(refs=>JSON.stringify(refs)===JSON.stringify(row.sourcePaths)));
  const replacement=path.join(sourceRoot,'新参考.png');await fs.writeFile(replacement,PNG);
  await service.saveRow({...service.state.rows[0],sourceMode:'single',sourcePaths:[replacement]});
  const exported=await service.exportJobs(jobs.map(job=>job.id));assert(exported.every(item=>path.dirname(item.path)===path.join(folder,'子图')));
  assert.deepEqual(service.state.jobs[0].snapshot.row.sourcePaths,row.sourcePaths);
});

test('自动导出无全局目录仍回各自子图，保留母图及同名旧文件，重复导出不新增副本', async t => {
  const references = [];
  const { sourceRoot, root, service } = await fixture(t, async (operation, payload) => { assert.equal(operation, 'image'); references.push(payload.referencePaths); return { images: [{ bytes: PNG }] }; });
  const a = await typeFolder(sourceRoot, 'A01-类型甲', ['母图.png'], true), b = await typeFolder(sourceRoot, 'B01-类型乙');
  const result = await importRoot(service, sourceRoot);
  for (const row of service.state.rows) await service.saveRow({ ...row, referencePrompt: '原描述', userPrompt: '原样保留', count: 2 });
  await service.updateSettings({ autoExport: true, outputDir: '' });
  const jobs = await service.enqueueImages(result.importedIds);
  const conflict = path.join(a, '子图', `A01_0001_${jobs[0].id.slice(0, 8)}.png`); await fs.writeFile(conflict, 'existing bytes');
  await service.setPaused(false);
  await waitFor(service, state => state.jobs.length === 4 && state.jobs.every(job => job.status === 'succeeded' && job.exportedPath));
  assert.deepEqual(references.flat().sort(), [path.join(a, '母图.png'), path.join(a, '母图.png'), path.join(b, '母图.png'), path.join(b, '母图.png')].sort());
  for (const job of service.state.jobs) assert.equal(path.dirname(job.exportedPath), path.join(job.snapshot.row.sourceFolder, '子图'));
  assert.equal(await fs.readFile(conflict, 'utf8'), 'existing bytes'); assert.deepEqual(await fs.readFile(path.join(a, '母图.png')), PNG);
  assert.equal((await fs.readdir(path.join(a, '子图'))).length, 4); assert.equal((await fs.readdir(path.join(b, '子图'))).length, 2);
  const paths = service.state.jobs.map(job => job.exportedPath);
  const exported = await service.exportJobs(jobs.map(job => job.id), path.join(root, '不应使用的全局目录'));
  assert.deepEqual(exported.map(item => item.path), paths); assert.equal(await fs.stat(path.join(root, '不应使用的全局目录')).catch(() => null), null);
});

test('自动导出关闭时等待手动操作，混合普通行缺根目录预先拒绝整批', async t => {
  const { sourceRoot, root, service } = await fixture(t);
  const folder = await typeFolder(sourceRoot, 'A01-类型'); await importRoot(service, sourceRoot);
  await service.saveRow({ ...service.state.rows[0], userPrompt: '保留原图' });
  const ordinary = await service.saveRow({ code: 'B01', userPrompt: '普通任务' });
  const jobs = await service.enqueueImages(service.state.rows.map(row => row.id)); await service.setPaused(false);
  await waitFor(service, state => state.jobs.every(job => job.status === 'succeeded'));
  assert.equal(await fs.stat(path.join(folder, '子图')).catch(() => null), null);
  await assert.rejects(service.exportJobs(jobs.map(job => job.id)), /普通任务需要/);
  assert.equal(await fs.stat(path.join(folder, '子图')).catch(() => null), null);
  const result = await service.exportJobs(jobs.map(job => job.id), path.join(root, '常规输出'));
  assert.equal(path.dirname(result[0].path), path.join(folder, '子图'));
  assert(result[1].path.startsWith(path.join(root, '常规输出'))); assert.equal(jobs[1].rowId, ordinary.id);
});

test('链接类型/子图预览拒绝，生成后目录被替换也不外写，恢复后只重试导出', async t => {
  const { root, sourceRoot, service } = await fixture(t);
  const outside = path.join(root, '外部'); await fs.mkdir(outside);
  const linkedType = path.join(sourceRoot, 'A00-链接'); await fs.symlink(outside, linkedType, 'junction');
  const folder = await typeFolder(sourceRoot, 'A01-类型');
  await fs.symlink(outside, path.join(folder, '子图'), 'junction');
  let plan = await scanImageFolderImport(sourceRoot); assert.equal(plan.invalidCount, 2);
  await fs.unlink(linkedType); await fs.unlink(path.join(folder, '子图'));
  await importRoot(service, sourceRoot); await service.saveRow({ ...service.state.rows[0], userPrompt: '原样保留' });
  const jobs = await service.enqueueImages([service.state.rows[0].id]); await service.setPaused(false);
  await waitFor(service, state => state.jobs[0].status === 'succeeded');
  await fs.symlink(outside, path.join(folder, '子图'), 'junction');
  await assert.rejects(service.exportJobs([jobs[0].id]), /链接/); assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(folder, '子图'));
  const saved = await service.exportJobs([jobs[0].id]); assert.equal(path.dirname(saved[0].path), path.join(folder, '子图'));
  assert.equal(service.state.jobs.length, 1);
});

test('Excel单类型目录使用同一母图映射，单纯values字段不能偷渡输出地址', async t => {
  const { sourceRoot, service } = await fixture(t);
  const folder = await typeFolder(sourceRoot, 'A01-类型', ['参考.png']);
  const mapping = await inspectImageTypeFolder(folder);
  const entry = { errors: [], values: { code: 'A01', name: '类型', sourceMode: 'single', sourcePaths: mapping.sourcePaths }, outputMapping: mapping };
  await service.importImageBatch('excel-mother', [entry]);
  assert.equal(service.state.rows[0].motherPath, path.join(folder, '参考.png')); assert.equal(service.state.rows[0].sourceFolder, folder);
  await service.importImageBatch('excel-forged-values', [{ errors: [], values: { code: 'B01', ...mapping } }]);
  assert.equal(service.state.rows[1].outputMode, undefined);
  assert.equal(service.state.jobs.length, 0);
});

test('自动导出目录中途变成链接时仍保留已计费本地结果，修复后导出不重新生图', async t => {
  let calls = 0, folder, outside;
  const { root, sourceRoot, service } = await fixture(t, async () => {
    calls++; await fs.symlink(outside, path.join(folder, '子图'), 'junction');
    return { images: [{ bytes: PNG }] };
  });
  outside = path.join(root, '不能写入'); await fs.mkdir(outside);
  folder = await typeFolder(sourceRoot, 'A01-类型'); await importRoot(service, sourceRoot);
  await service.saveRow({ ...service.state.rows[0], userPrompt: '保留原图' }); await service.updateSettings({ autoExport: true });
  const jobs = await service.enqueueImages([service.state.rows[0].id]); await service.setPaused(false);
  await waitFor(service, state => state.jobs[0].status === 'succeeded' && state.jobs[0].exportError);
  assert.deepEqual(await fs.readFile(service.state.jobs[0].localPath), PNG);
  assert.deepEqual(await fs.readdir(outside), []); assert.equal(calls, 1);
  await fs.unlink(path.join(folder, '子图')); await service.exportJobs([jobs[0].id]);
  assert.equal(service.state.jobs[0].exportError, ''); assert.equal(calls, 1);
  assert.equal(path.dirname(service.state.jobs[0].exportedPath), path.join(folder, '子图'));
});

test('生成失败后重试保留母图/子图映射，不读已有子图且不重复提交成功结果', async t => {
  let calls = 0;
  const { sourceRoot, service } = await fixture(t, async (operation, payload) => { calls++; if (calls === 1) throw new Error('local fixture failed'); assert.equal(path.basename(payload.referencePaths[0]), '母图.png'); return { images: [{ bytes: PNG }] }; });
  const folder = await typeFolder(sourceRoot, 'A01-类型', ['母图.png'], true);
  await importRoot(service, sourceRoot); await service.saveRow({ ...service.state.rows[0], userPrompt: '原样保留' });
  await service.updateSettings({ autoExport: true }); const jobs = await service.enqueueImages([service.state.rows[0].id]); await service.setPaused(false);
  await waitFor(service, state => state.jobs[0].status === 'failed'); await service.retryJobs([jobs[0].id]);
  await waitFor(service, state => state.jobs.length === 2 && state.jobs[1].exportedPath);
  assert.equal(path.dirname(service.state.jobs[1].exportedPath), path.join(folder, '子图')); assert.equal(calls, 2);
  await service.retryJobs([jobs[0].id]); assert.equal(service.state.jobs.length, 2); assert.equal(calls, 2);
});
