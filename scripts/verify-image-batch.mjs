import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright';
import ExcelJS from 'exceljs';
import {IMAGE_BATCH_COLUMNS} from '../shared/image-batch-import.mjs';

// Isolated data and local fixtures only. ZIYUN_TEST_EXE exercises a packaged build.
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const fixture=path.join(root,'test-output','image-excel-'+randomUUID().slice(0,8));
const dataDir=path.join(fixture,'data'),sourceDir=path.join(fixture,'素材');
await fs.mkdir(sourceDir,{recursive:true});
const image=path.join(sourceDir,'参考.png'),template=path.join(fixture,'下载模板.xlsx');
await fs.writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bWQAAAAASUVORK5CYII=','base64'));
const workbookPath=path.join(fixture,'导入任务.xlsx'),failedPath=path.join(fixture,'失败可重试.xlsx'),invalidPath=path.join(fixture,'公式禁止.xlsx');
async function writeBook(file,rows){const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('任务');sheet.columns=IMAGE_BATCH_COLUMNS.map(({key,title})=>({key,header:title}));for(const row of rows)sheet.addRow(row);await workbook.xlsx.writeFile(file)}
await writeBook(workbookPath,[
 {name:'手工提示优先',sourceInput:'素材/参考.png',referencePrompt:'手工完整描述\n保留原文换行',userPrompt:'手工要求',autoDescribe:'X'},
 {name:'授权自动反推',sourceInput:'素材',autoDescribe:'X',describeInstructions:'只描述布局，不解释用途',userPrompt:'自动行要求',count:3,ratio:'3:4',resolution:'2K',template:'不使用模板',folderName:'本次素材'},
 {name:'稍后选择参考'},
]);
await writeBook(failedPath,[{name:'失败后恢复',sourceInput:'素材/参考.png',autoDescribe:'X'}]);
await writeBook(invalidPath,[{name:'公式禁止',referencePrompt:{formula:'"禁止采用缓存"',result:'禁止采用缓存'}}]);
const mixedPath=path.join(fixture,'部分导入和编号冲突.xlsx');
await writeBook(mixedPath,[
 {code:'B01',name:'覆盖原行',userPrompt:'导入的新配置'},
 {code:'B02',name:'加后缀'},
 {code:'B03',name:'跳过反推行',sourceInput:'素材/参考.png',autoDescribe:'X'},
 {code:'B99',name:'无效路径',sourceInput:'找不到.png'},
]);
const requests=[],unexpected=[];let rejectNext=false;
const server=http.createServer(async(req,res)=>{
 let text='';for await(const part of req)text+=part;
 if(req.url!=='/v1/chat/completions'){unexpected.push(req.url);res.writeHead(404);res.end();return;}
 const input=JSON.parse(text);requests.push(input);
 const fail=rejectNext;rejectNext=false;
 await new Promise(resolve=>setTimeout(resolve,350));
 res.writeHead(fail?400:200,{'Content-Type':'application/json'});
 res.end(JSON.stringify(fail?{error:{message:'隔离验收：模拟反推失败'}}:{choices:[{message:{content:`本地模拟参考描述 ${requests.length}`}}]}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const env={...process.env,ZIYUN_DATA_DIR:dataDir,ZIYUN_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;
let application,page;const errors=[];
const call=(method,...args)=>page.evaluate(({method,args})=>window.studio.call(method,...args),{method,args});
const dialog=()=>page.getByRole('dialog',{name:'Excel 批量导入图片任务',exact:true});
async function launch(){application=await electron.launch({executablePath:process.env.ZIYUN_TEST_EXE||createRequire(import.meta.url)('electron'),args:process.env.ZIYUN_TEST_EXE?[]:[root],env,timeout:60000});page=await application.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.getByTestId('image-excel-import').waitFor();await page.setViewportSize({width:1450,height:1000})}
async function close(){if(!application)return;try{await application.evaluate(({app})=>app.exit(0))}catch{}await Promise.race([application.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);application=null}
async function openImporter(){await page.getByTestId('image-excel-import').click();await dialog().waitFor()}
async function choose(file){await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},file);await dialog().getByRole('button',{name:/^(选择 Excel 文件|重新选择 Excel)$/}).click();await dialog().locator('.image-import-table tbody tr').first().waitFor()}
async function waitState(predicate){const deadline=Date.now()+20000;while(Date.now()<deadline){const state=await call('getState');if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('状态等待超时')}
try{
 await launch();
 await call('saveProvider',{id:'local-excel-vision',name:'Excel 隔离验收',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-vision',key:'fake-local-only-key'});
 await call('updateSettings',{bindings:{vision:'local-excel-vision'},autoExport:false});
 await call('saveRow',{code:'B01',name:'原有任务',userPrompt:'原有要求'});
 const before=await call('getState'),original=before.rows[0];
 await page.getByLabel('用户要求',{exact:true}).fill('尚未保存的原有要求');
 await openImporter();
 await application.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},template);
 await dialog().getByRole('button',{name:'下载 Excel 模板',exact:true}).click();await dialog().getByText(`模板已保存：${template}`,{exact:true}).waitFor();
 const downloaded=new ExcelJS.Workbook();await downloaded.xlsx.readFile(template);assert.equal(downloaded.getWorksheet('任务').actualRowCount,1);assert.equal(downloaded.getWorksheet('示例').actualRowCount,4);
 await choose(workbookPath);
 assert.equal(await dialog().locator('.image-import-table tbody tr').count(),3);assert.equal(requests.length,0);
 assert.equal((await call('getState')).rows.length,1,'预览不新增任务');
 await dialog().getByText('1 张 · 跟随原图 · 1K',{exact:true}).first().waitFor();
 assert.match(await dialog().locator('.image-import-summary').innerText(),/1\s*次自动反推/);
 assert.ok(await dialog().evaluate(element=>element.getBoundingClientRect().width>=1100),'宽屏导入预览应展开，避免表格被通用弹窗宽度裁切');
 assert.equal(await dialog().locator('.image-import-table-scroll').evaluate(element=>element.scrollWidth<=element.clientWidth),true,'宽屏所有预览列应直接可见');
 await page.screenshot({path:path.join(fixture,'excel-preview.png')});
 await dialog().getByRole('button',{name:'确认导入 3 行（反推 1 次）',exact:true}).click();
 assert.equal(await dialog().getByLabel('关闭 Excel 导入',{exact:true}).isDisabled(),true);
 await dialog().getByRole('heading',{name:'已新增 3 行任务',exact:true}).waitFor();
 assert.equal(requests.length,1);assert.match(JSON.stringify(requests[0]),/只描述布局，不解释用途/);
 let current=await call('getState');assert.equal(current.rows.length,4);assert.equal(current.jobs.length,0);
 assert.deepEqual(current.rows.map(row=>row.code),['B01','B02','B03','B04']);
 assert.equal(current.rows[1].referencePrompt,'手工完整描述\n保留原文换行');assert.equal(current.rows[1].count,1);assert.equal(current.rows[1].ratio,'source');assert.equal(current.rows[1].resolution,'1K');assert.equal(current.rows[1].templateId,before.settings.defaultTemplateId);
 assert.equal(current.rows[2].referencePrompt,'本地模拟参考描述 1');assert.equal(current.rows[2].count,3);assert.equal(current.rows[2].folderName,'本次素材');assert.equal(current.rows[2].templateId,'');assert.equal(current.rows[2].sourceMode,'folder');
 assert.equal(current.rows[3].referencePrompt,'');assert.deepEqual(current.rows[3].sourcePaths,[]);assert.deepEqual(current.rows[0],original);
 await dialog().getByRole('button',{name:'完成',exact:true}).click();assert.equal(await page.getByLabel('用户要求',{exact:true}).inputValue(),'尚未保存的原有要求');
 await page.getByRole('button',{name:'保存本行',exact:true}).click();await waitState(state=>state.rows[0].userPrompt==='尚未保存的原有要求');
 await openImporter();await choose(invalidPath);assert.match(await dialog().locator('.image-import-row-errors').innerText(),/公式/);assert.equal(await dialog().getByRole('button',{name:/^确认导入/}).isDisabled(),true);assert.equal((await call('getState')).rows.length,4);assert.equal(requests.length,1);await dialog().getByRole('button',{name:'取消',exact:true}).click();
 rejectNext=true;await openImporter();await choose(failedPath);await dialog().getByRole('button',{name:'确认导入 1 行（反推 1 次）',exact:true}).click();
 await dialog().locator('.image-import-failures').waitFor();assert.equal(requests.length,2);current=await call('getState');assert.equal(current.rows.length,5);assert.equal(current.rows[4].batchImport.status,'error');assert.equal(current.rows[4].referencePrompt,'');assert.equal(current.jobs.length,0);
 await dialog().getByRole('button',{name:'完成',exact:true}).click();await close();await launch();
 assert.equal(requests.length,2,'重启不能自动重试付费接口');
 await openImporter();await dialog().getByText('上次导入有 1 行反推未完成',{exact:true}).waitFor();await page.screenshot({path:path.join(fixture,'excel-retry-restored.png')});
 await dialog().getByRole('button',{name:'重试 1 行反推',exact:true}).click();await dialog().getByRole('heading',{name:'先前导入的反推已处理',exact:true}).waitFor();
 assert.equal(requests.length,3);current=await call('getState');assert.equal(current.rows.length,5);assert.equal(current.rows[4].referencePrompt,'本地模拟参考描述 3');assert.equal(current.rows[4].batchImport.status,'done');assert.equal(current.jobs.length,0);
 await dialog().getByRole('button',{name:'完成',exact:true}).click();await close();await launch();await openImporter();assert.equal(await dialog().locator('.image-import-saved-failures').count(),0);assert.equal((await call('getState')).rows.length,5);assert.equal(requests.length,3);
 await page.setViewportSize({width:1050,height:800});assert.equal(await dialog().evaluate(element=>{const box=element.getBoundingClientRect();return box.x>=0&&box.right<=innerWidth&&box.y>=0&&box.bottom<=innerHeight}),true);await page.screenshot({path:path.join(fixture,'excel-narrow.png')});
 await choose(mixedPath);
 assert.equal(await dialog().getByRole('checkbox',{name:'导入 B99 · 无效路径',exact:true}).isDisabled(),true);
 await dialog().getByRole('button',{name:'清空选择',exact:true}).click();
 assert.equal(await dialog().getByRole('button',{name:'确认导入',exact:true}).isDisabled(),true);
 await dialog().getByRole('button',{name:'全选可新增',exact:true}).click();
 await dialog().getByRole('combobox',{name:'处理 B01 · 覆盖原行',exact:true}).selectOption('overwrite');
 await dialog().getByRole('checkbox',{name:'导入 B03 · 跳过反推行',exact:true}).uncheck();
 await dialog().getByText('B02_2',{exact:true}).waitFor();
 await page.screenshot({path:path.join(fixture,'excel-selection.png')});
 await dialog().getByRole('button',{name:'确认导入 2 行',exact:true}).click();
 await dialog().getByRole('heading',{name:'已新增 1 行 · 已覆盖 1 行',exact:true}).waitFor();
 current=await call('getState');assert.equal(current.rows.length,6);assert.equal(current.rows[0].id,original.id);
 assert.equal(current.rows[0].userPrompt,'导入的新配置');assert.equal(current.rows.at(-1).code,'B02_2');assert.equal(requests.length,3);
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 await fs.writeFile(path.join(fixture,'result.json'),JSON.stringify({passed:true,providerCalls:requests.length,rows:current.rows.length,imageJobs:current.jobs.length,template,errors},null,2));
 console.log(`IMAGE_EXCEL_UI_PASS ${fixture}`);
}finally{await close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
