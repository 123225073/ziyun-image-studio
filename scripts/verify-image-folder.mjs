import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright';
import ExcelJS from 'exceljs';
import {IMAGE_BATCH_COLUMNS} from '../shared/image-batch-import.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const fixture=path.join(root,'test-output','image-folders-'+randomUUID().slice(0,8));
const sourceRoot=path.join(fixture,'批量素材'),normalOutput=path.join(fixture,'普通输出'),dataDir=path.join(fixture,'data');
const folders=['A01-第一类','B01_第二类','C01-待补母图','D01-多张母图'].map(name=>path.join(sourceRoot,name));
for(const directory of [sourceRoot,normalOutput,...folders])await fs.mkdir(directory,{recursive:true});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bWQAAAAASUVORK5CYII=','base64');
await fs.writeFile(path.join(folders[0],'母图.png'),png);await fs.writeFile(path.join(folders[0],'其他参考.png'),png);await fs.mkdir(path.join(folders[0],'子图'));const oldChild=path.join(folders[0],'子图','旧成果.png');await fs.writeFile(oldChild,png);
await fs.writeFile(path.join(folders[1],'唯一图片.png'),png);
await fs.writeFile(path.join(folders[3],'母图.png'),png);await fs.writeFile(path.join(folders[3],'母图.jpg'),png);
const extraType=path.join(fixture,'Excel类型');await fs.mkdir(extraType);await fs.writeFile(path.join(extraType,'母图.png'),png);
const excelFile=path.join(fixture,'指定原目录子图.xlsx'),workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('任务');sheet.columns=IMAGE_BATCH_COLUMNS.map(({key,title})=>({key,header:title}));sheet.addRow({code:'E01',name:'Excel配置母图',sourceInput:'Excel类型',outputLocation:'原目录子图',userPrompt:'按母图处理',count:2,ratio:'1:1',resolution:'1K',template:'不使用模板'});await workbook.xlsx.writeFile(excelFile);
const requests=[];let holdNext=false,releaseResponse;
const server=http.createServer(async(req,res)=>{let body=Buffer.alloc(0);for await(const part of req)body=Buffer.concat([body,part]);requests.push({path:req.url,body:body.toString('utf8')});if(holdNext){holdNext=false;await new Promise(resolve=>{releaseResponse=resolve})}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}))});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const env={...process.env,ZIYUN_DATA_DIR:dataDir,ZIYUN_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;
let application,page;const errors=[];
const call=(method,...args)=>page.evaluate(({method,args})=>window.studio.call(method,...args),{method,args});
const folderDialog=()=>page.getByRole('dialog',{name:'按文件夹批量导入图片任务',exact:true});
const select=file=>application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},file);
async function launch(){application=await electron.launch({executablePath:process.env.ZIYUN_TEST_EXE||createRequire(import.meta.url)('electron'),args:process.env.ZIYUN_TEST_EXE?[]:[root],env,timeout:60000});page=await application.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));await page.getByTestId('image-folder-import').waitFor();await page.setViewportSize({width:1450,height:1000})}
async function close(){if(!application)return;try{await application.evaluate(({app})=>app.exit(0))}catch{}await Promise.race([application.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);application=null}
async function waitState(predicate){const deadline=Date.now()+30000;while(Date.now()<deadline){const state=await call('getState');if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,70))}throw new Error('状态等待超时')}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 await launch();await call('updateSettings',{outputDir:normalOutput,autoExport:false});await call('saveRow',{code:'Z01',name:'原有任务',userPrompt:'保留内容'});
 await page.getByLabel('用户要求',{exact:true}).fill('未保存内容也要保留');
 await select(sourceRoot);await page.getByTestId('image-folder-import').click();await folderDialog().getByRole('button',{name:'选择大文件夹',exact:true}).click();await folderDialog().locator('.folder-import-table tbody tr').first().waitFor();
 assert.equal(await folderDialog().locator('tbody tr').count(),4);assert.equal(await folderDialog().locator('tbody tr.invalid').count(),2);assert.equal(await folderDialog().getByRole('button',{name:/^确认导入/}).isDisabled(),true);assert.equal((await call('getState')).rows.length,1);assert.equal(requests.length,0);
 await page.screenshot({path:path.join(fixture,'folder-errors.png')});
 await fs.writeFile(path.join(folders[2],'母图.png'),png);await fs.unlink(path.join(folders[3],'母图.jpg'));
 await folderDialog().getByRole('button',{name:'重新选择大文件夹',exact:true}).click();await folderDialog().getByRole('button',{name:'确认导入 4 行',exact:true}).waitFor();
 assert.equal(await folderDialog().locator('tbody tr.invalid').count(),0);assert.equal(await folderDialog().locator('.image-import-table-scroll').evaluate(element=>element.scrollWidth<=element.clientWidth),true);
 await page.screenshot({path:path.join(fixture,'folder-preview.png')});await folderDialog().getByRole('button',{name:'确认导入 4 行',exact:true}).click();await folderDialog().getByRole('heading',{name:'已新增 4 行任务',exact:true}).waitFor();await folderDialog().getByRole('button',{name:'完成',exact:true}).click();
 assert.equal(await page.getByLabel('用户要求',{exact:true}).inputValue(),'未保存内容也要保留');assert.equal(requests.length,0);let state=await call('getState');assert.equal(state.jobs.length,0);assert.equal(state.rows.length,5);
 const imported=state.rows.filter(row=>row.outputMode==='source-children');assert.deepEqual(imported.map(row=>row.code),['A01','B01','C01','D01']);for(const row of imported)assert.deepEqual(row.sourcePaths,[row.motherPath]);assert.equal(imported[0].motherPath,path.join(folders[0],'母图.png'));assert.equal(state.settings.outputDir,normalOutput);
 await page.getByRole('button',{name:'保存本行',exact:true}).click();await waitState(current=>current.rows[0].userPrompt==='未保存内容也要保留');
 // Existing source selector also routes a structured root to the same preview.
 await page.getByRole('button',{name:'文件夹',exact:true}).click();await select(sourceRoot);await page.getByRole('button',{name:'选择文件夹',exact:true}).click();await folderDialog().locator('tbody tr').first().waitFor();assert.equal(await folderDialog().getByRole('button',{name:/^确认导入/}).isDisabled(),true);await folderDialog().getByRole('button',{name:'取消',exact:true}).click();assert.equal((await call('getState')).rows.length,5);await page.getByRole('button',{name:'保存本行',exact:true}).click();
 // Import the same mapping mode explicitly from the optional Excel column.
 await page.getByTestId('image-excel-import').click();await select(excelFile);const excelDialog=page.getByRole('dialog',{name:'Excel 批量导入图片任务',exact:true});await excelDialog.getByRole('button',{name:'选择 Excel 文件',exact:true}).click();await excelDialog.getByText(`原目录子图：${path.join(extraType,'子图')}`,{exact:true}).waitFor();await excelDialog.getByRole('button',{name:'确认导入 1 行',exact:true}).click();await excelDialog.getByRole('heading',{name:'已新增 1 行任务',exact:true}).waitFor();await excelDialog.getByRole('button',{name:'完成',exact:true}).click();
 state=await call('getState');const excelRow=state.rows.find(row=>row.code==='E01');assert.equal(excelRow.outputMode,'source-children');assert.equal(excelRow.count,2);assert.equal(excelRow.templateId,'');assert.equal(state.jobs.length,0);assert.equal(requests.length,0);
 await page.getByLabel('编辑 第一类',{exact:true}).click();await page.getByTestId('row-source-output').getByText(path.join(folders[0],'子图'),{exact:true}).waitFor();assert.match(await page.getByTestId('row-source-output').innerText(),/自动导出已关闭/);assert.equal(await page.getByRole('button',{name:'上传图片',exact:true}).count(),0);assert.equal(await page.getByLabel('本行保存子目录',{exact:true}).count(),0);
 await page.getByLabel('用户要求',{exact:true}).fill('只改变颜色');await page.getByRole('button',{name:'保存本行',exact:true}).click();await waitState(current=>current.rows.find(row=>row.code==='A01')?.userPrompt==='只改变颜色');
 await page.screenshot({path:path.join(fixture,'bound-row-output.png')});
 await call('saveProvider',{id:'folder-test-image',name:'本机图片验收',protocol:'openai-images',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'gpt-image-2',key:'fake-local-key'});await call('updateSettings',{bindings:{image:'folder-test-image'}});
 await call('enqueueImages',[imported[0].id]);state=await waitState(current=>current.jobs.some(job=>job.rowId===imported[0].id&&job.status==='succeeded'));let firstJob=state.jobs.find(job=>job.rowId===imported[0].id);assert.equal(firstJob.exportedPath,undefined);assert.deepEqual(await fs.readdir(path.join(folders[0],'子图')),['旧成果.png']);
 await page.getByRole('button',{name:'下载全部成功文件',exact:true}).first().click();state=await waitState(current=>current.jobs.find(job=>job.id===firstJob.id)?.exportedPath);firstJob=state.jobs.find(job=>job.id===firstJob.id);assert.equal(path.dirname(firstJob.exportedPath),path.join(folders[0],'子图'));assert.equal(hash(await fs.readFile(oldChild)),hash(png));assert.equal(hash(await fs.readFile(imported[0].motherPath)),hash(png));
 // Simulate a destination becoming unavailable only after provider submission.
 const second=state.rows.find(row=>row.code==='B01');await call('saveRow',{...second,userPrompt:'第二类生成'});await call('updateSettings',{autoExport:true});await page.getByLabel('编辑 第二类',{exact:true}).click();holdNext=true;await call('enqueueImages',[second.id]);const responseDeadline=Date.now()+20000;while(!releaseResponse&&Date.now()<responseDeadline)await new Promise(resolve=>setTimeout(resolve,30));assert.ok(releaseResponse,'图片请求应到达本机模拟服务');const failedOutput=path.join(folders[1],'子图');await fs.writeFile(failedOutput,'isolated output conflict');releaseResponse();
 state=await waitState(current=>current.jobs.some(job=>job.rowId===second.id&&job.exportError));assert.equal(state.jobs.find(job=>job.rowId===second.id).status,'succeeded');await page.locator('.job-export-error').waitFor();await fs.unlink(failedOutput);await page.getByRole('button',{name:'重试导出',exact:true}).click();state=await waitState(current=>current.jobs.find(job=>job.rowId===second.id)?.exportedPath);assert.equal(state.jobs.find(job=>job.rowId===second.id).exportError,'');assert.equal(path.dirname(state.jobs.find(job=>job.rowId===second.id).exportedPath),failedOutput);
 assert.equal(requests.length,2,'重试导出不得再次生图');assert.ok(requests.every(request=>request.path==='/v1/images/edits'));assert.equal(state.jobs.length,2);assert.deepEqual(await fs.readdir(normalOutput),[]);
 await close();await launch();state=await call('getState');assert.equal(state.rows.filter(row=>row.outputMode==='source-children').length,5);assert.equal(state.settings.outputDir,normalOutput);assert.equal(requests.length,2);assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(fixture,'result.json'),JSON.stringify({passed:true,importedTypes:5,providerCalls:requests.length,exported:state.jobs.map(job=>job.exportedPath),normalOutputUnchanged:true,errors},null,2));console.log(`IMAGE_FOLDER_UI_PASS ${fixture}`);
}finally{releaseResponse?.();await close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
