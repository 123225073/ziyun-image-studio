import { planImageImport } from '../shared/image-import-selection.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import ExcelJS from 'exceljs';
import {parseImageBatchWorkbook,writeImageBatchTemplate} from '../electron/image-batch-import.mjs';
import {IMAGE_BATCH_COLUMNS,normalizeImageBatchRow} from '../shared/image-batch-import.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bWQAAAAASUVORK5CYII=','base64');
const settings={templates:[{id:'project',name:'当前项目'},{id:'other',name:'另一项目'}],defaultTemplateId:'project'};
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ziyun-excel-parse-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(path.join(dir,'素材'));await fs.writeFile(path.join(dir,'素材','图1.png'),png);await fs.writeFile(path.join(dir,'素材','图2.png'),png);
 return {dir,file:path.join(dir,'tasks.xlsx')};
}
async function book(file,rows,configure=()=>{}){
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('任务');
 sheet.columns=IMAGE_BATCH_COLUMNS.map(({key,title})=>({key,header:title}));
 rows.forEach(row=>sheet.addRow(row));configure(workbook,sheet);await workbook.xlsx.writeFile(file);
}

test('downloaded template has an empty task sheet, separate examples and actual current defaults',async t=>{
 const {file}=await fixture(t);await writeImageBatchTemplate(file,{settings});
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(file);
 assert.deepEqual(workbook.worksheets.map(sheet=>sheet.name),['任务','说明','示例']);
 assert.equal(workbook.getWorksheet('任务').actualRowCount,1);
 assert.equal(workbook.getWorksheet('示例').actualRowCount,4);
 const guide=JSON.stringify(workbook.getWorksheet('说明').getSheetValues());assert.match(guide,/当前项目/);assert.match(guide,/500 行/);
 const parsed=await parseImageBatchWorkbook(file,{settings});assert.equal(parsed.rowCount,0);assert.equal(parsed.reverseCount,0);assert.deepEqual(parsed.errors,[]);
});

test('rows resolve local relative files and folders, preview defaults, increment codes and preserve manual text',async t=>{
 const {dir,file}=await fixture(t),existingRows=[{code:'B01',referencePrompt:'原内容'}],before=structuredClone(existingRows);
 await book(file,[
  {name:'手工',sourceInput:'素材/图1.png',referencePrompt:'原文\n第二行',autoDescribe:'X',userPrompt:'保留布局'},
  {name:'自动',sourceInput:'素材',autoDescribe:'x',describeInstructions:'只描述布局',count:3,ratio:'3：4',resolution:'2k',template:'另一项目',folderName:'子目录'},
  {name:'稍后补素材',template:'不使用模板'},
 ]);
 const parsed=await parseImageBatchWorkbook(file,{existingRows,settings});
 assert.equal(parsed.rowCount,3);assert.equal(parsed.validCount,3);assert.equal(parsed.reverseCount,1);assert.deepEqual(parsed.errors,[]);
 assert.deepEqual(parsed.rows.map(row=>row.values.code),['B02','B03','B04']);
 assert.equal(parsed.rows[0].values.referencePrompt,'原文\n第二行');assert.equal(parsed.rows[0].autoDescribe,false);assert.equal(parsed.rows[0].warnings.length,1);
 assert.equal(parsed.rows[0].values.count,1);assert.equal(parsed.rows[0].values.ratio,'source');assert.equal(parsed.rows[0].values.resolution,'1K');assert.equal(parsed.rows[0].values.templateId,'project');
 assert.deepEqual(parsed.rows[0].values.sourcePaths,[path.join(dir,'素材','图1.png')]);
 assert.equal(parsed.rows[1].values.sourceMode,'folder');assert.equal(parsed.rows[1].values.sourcePaths.length,2);assert.equal(parsed.rows[1].values.templateId,'other');assert.equal(parsed.rows[1].values.ratio,'3:4');assert.equal(parsed.rows[1].values.resolution,'2K');
 assert.equal(parsed.rows[2].values.templateId,'');assert.deepEqual(parsed.rows[2].values.sourcePaths,[]);assert.deepEqual(existingRows,before);
});

test('invalid values and missing images remain row errors while code aliases can be renamed',async t=>{
 const {dir,file}=await fixture(t);await fs.writeFile(path.join(dir,'false.png'),'not an image');
 await book(file,[{code:'A1.',name:'重复编号'},{name:'坏参数',count:1.5,ratio:'2:3',resolution:'8K',template:'不存在',folderName:'../上层'},{name:'无图反推',autoDescribe:'X'},{name:'不存在',sourceInput:'missing.png',autoDescribe:'X'},{name:'假图片',sourceInput:'false.png'},{name:'非法标志',autoDescribe:'YES'}]);
 const parsed=await parseImageBatchWorkbook(file,{existingRows:[{code:'a01'}],settings});
 assert.equal(parsed.invalidCount,5);assert.equal(parsed.reverseCount,0);assert.equal(planImageImport(parsed.rows,[{code:'A01'}])[0].finalCode,'A1_2');
 assert.match(parsed.rows[1].errors.join(' '),/生成数量/);assert.match(parsed.rows[1].errors.join(' '),/图片比例/);assert.match(parsed.rows[1].errors.join(' '),/分辨率/);assert.match(parsed.rows[1].errors.join(' '),/项目规范/);assert.match(parsed.rows[1].errors.join(' '),/子目录/);
 assert.match(parsed.rows[2].errors.join(' '),/需要填写/);assert.match(parsed.rows[3].errors.join(' '),/不存在/);assert.ok(parsed.rows[4].errors.length);assert.match(parsed.rows[5].errors.join(' '),/仅填写 X/);
});

test('formula cells and hyperlinks are rejected without using cached results or reading sources',async t=>{
 const {file}=await fixture(t);let resolved=0;
 await book(file,[{name:'公式',sourceInput:'素材/图1.png',referencePrompt:{formula:'"cached text"',result:'cached text'}},{name:'链接',sourceInput:{text:'素材/图1.png',hyperlink:'https://example.invalid/image.png'}}]);
 const parsed=await parseImageBatchWorkbook(file,{settings,resolveSource:async()=>{resolved++;throw new Error('must not read')}});
 assert.equal(parsed.invalidCount,2);assert.equal(resolved,0);assert.equal(parsed.rows[0].values.referencePrompt,'');assert.match(parsed.rows[0].errors.join(' '),/公式/);assert.match(parsed.rows[1].errors.join(' '),/超链接/);
});

test('network shares, device paths and quoted variants are refused before source resolution',async t=>{
 const {file}=await fixture(t);let resolved=0;
 await book(file,['\\\\server\\share\\img.png','\\\\?\\C:\\img.png','\\\\.\\pipe\\object','//server/share/image.png','"\\\\server\\share\\img.png"','https://example.invalid/a.png'].map(sourceInput=>({name:'不支持的路径',sourceInput})));
 const parsed=await parseImageBatchWorkbook(file,{settings,resolveSource:async()=>{resolved++;return {sourcePaths:['unexpected']}}});
 assert.equal(parsed.invalidCount,6);assert.equal(resolved,0);
});

test('malformed headers, excessive sheets, rows, columns and cell content are bounded',async t=>{
 const {file}=await fixture(t);
 await book(file,[{name:'文本过长',referencePrompt:'字'.repeat(12001)}]);assert.equal((await parseImageBatchWorkbook(file,{settings})).invalidCount,1);
 await book(file,[{name:'标题问题'}],(_,sheet)=>{sheet.getCell('B1').value='未知列'});assert.match((await parseImageBatchWorkbook(file,{settings})).errors.join(' '),/不在模板/);
 await book(file,[],workbook=>{for(let i=0;i<5;i++)workbook.addWorksheet(`多余${i}`)});await assert.rejects(parseImageBatchWorkbook(file),/最多保留 5/);
 await book(file,Array.from({length:501},(_,index)=>({name:`行${index}`})));await assert.rejects(parseImageBatchWorkbook(file),/最多导入 500/);
 await book(file,[],(_,sheet)=>{sheet.getCell('N1').value='额外列'});await assert.rejects(parseImageBatchWorkbook(file),/最多 13 列/);
});

test('compressed oversized content is rejected before ExcelJS loads any worksheet',async t=>{
 const {file}=await fixture(t);const require=createRequire(import.meta.url),JSZip=createRequire(require.resolve('exceljs'))('jszip');
 const zip=new JSZip();zip.file('xl/worksheets/sheet1.xml','a'.repeat(33*1024*1024));
 await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
 assert.ok((await fs.stat(file)).size<10*1024*1024);await assert.rejects(parseImageBatchWorkbook(file),/解压内容超过 32 MiB/);
});

test('ambiguous project names require an ID, while an explicit ID is accepted',()=>{
 const duplicate={templates:[{id:'one',name:'同名'},{id:'two',name:'同名'}],defaultTemplateId:'one'};
 assert.match(normalizeImageBatchRow({name:'任务',template:'同名'},{settings:duplicate}).errors.join(' '),/名称重复/);
 assert.deepEqual(normalizeImageBatchRow({name:'任务',template:'two'},{settings:duplicate}).errors,[]);
});

test('optional export location maps a type folder to its mother and child output, while old 12-column sheets stay ordinary',async t=>{
 const {dir,file}=await fixture(t),typeDir=path.join(dir,'C01-素材类型');await fs.mkdir(path.join(typeDir,'子图'),{recursive:true});
 await fs.writeFile(path.join(typeDir,'母图.png'),png);await fs.writeFile(path.join(typeDir,'母图2.png'),png);await fs.writeFile(path.join(typeDir,'其他.png'),png);await fs.writeFile(path.join(typeDir,'子图','旧结果.png'),png);
 await book(file,[{name:'母图行',sourceInput:'C01-素材类型',outputLocation:'原目录子图',autoDescribe:'X'}]);
 const parsed=await parseImageBatchWorkbook(file,{settings});assert.equal(parsed.validCount,1);assert.equal(parsed.reverseCount,1);
 const row=parsed.rows[0],realTypeDir=await fs.realpath(typeDir);assert.equal(row.outputLocation,'原目录子图');assert.equal(row.outputMapping.outputMode,'source-children');assert.equal(row.outputMapping.outputPath,path.join(realTypeDir,'子图'));assert.equal(row.values.sourceMode,'single');assert.deepEqual([...row.values.sourcePaths].sort(),['母图.png','母图2.png'].map(name=>path.join(realTypeDir,name)).sort());assert.equal(row.values.referenceMode,'all');assert.equal(row.values.folderName,row.outputMapping.outputPath);
 assert.equal('outputMode' in row.values,false,'映射不混入普通行字段');
 const duplicate=await parseImageBatchWorkbook(file,{settings,existingRows:[{code:'Z99',outputMode:'source-children',sourceFolder:realTypeDir}]});assert.equal(duplicate.invalidCount,0);assert.equal(planImageImport(duplicate.rows,[{code:'Z99',folderKey:duplicate.rows[0].folderKey}])[0].action,'skip');
 await book(file,[{name:'旧12列',sourceInput:'C01-素材类型'}],(_,sheet)=>{sheet.spliceColumns(13,1)});
 const legacy=await parseImageBatchWorkbook(file,{settings});assert.equal(legacy.validCount,1);assert.equal(legacy.rows[0].outputMapping,undefined);assert.equal(legacy.rows[0].values.sourcePaths.length,3);assert.equal(legacy.rows[0].values.referenceMode,'rotate');
});

test('source-child export requires a valid type directory and rejects competing output fields',async t=>{
 const {file}=await fixture(t);
 await book(file,[{name:'错误导出位置',outputLocation:'任意外部位置'},{name:'需要目录',outputLocation:'原目录子图'},{name:'不能是图',sourceInput:'素材/图1.png',outputLocation:'原目录子图'},{name:'不自动任选',sourceInput:'素材',outputLocation:'原目录子图'},{name:'冲突子目录',sourceInput:'素材',outputLocation:'原目录子图',folderName:'另一个地方'}]);
 const parsed=await parseImageBatchWorkbook(file,{settings});assert.equal(parsed.invalidCount,4);assert.equal(parsed.reverseCount,0);assert.equal(parsed.rows[3].values.sourcePaths.length,2);assert.equal(parsed.rows[3].values.referenceMode,'all');
 assert.match(parsed.rows[0].errors.join(' '),/导出位置/);assert.match(parsed.rows[1].errors.join(' '),/需要填写/);assert.match(parsed.rows[4].errors.join(' '),/清空保存子目录/);
});
