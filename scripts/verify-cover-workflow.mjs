import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
import {expect} from '@playwright/test';
import {resolveFfmpeg,runMedia} from '../electron/render.mjs';

const root=path.resolve('.');
const reports=path.join(root,'test-output');
await fs.mkdir(reports,{recursive:true});
const dir=await fs.mkdtemp(path.join(reports,'cover-workflow-'));
const ffmpeg=await resolveFfmpeg(root);
const fixtures={};
for (const [name,color] of Object.entries({'原版封面':'blue','人物甲':'red','人物乙':'green','后台咨询截图':'purple','流量统计':'orange','返回图片':'yellow'})){
  fixtures[name]=path.join(dir,name+'.png');
  await runMedia(ffmpeg,['-loglevel','error','-f','lavfi','-i','color=c='+color+':s=240x320','-frames:v','1',fixtures[name]]);
}
// Exercise the same EXIF-normalized immutable identity used by historic phone portraits.
const phone=path.join(dir,'人物甲手机原片.jpg');
await runMedia(ffmpeg,['-loglevel','error','-i',fixtures['人物甲'],'-frames:v','1',phone]);
const phoneBytes=await fs.readFile(phone);
const portraitExif=Buffer.from('ffe100224578696600004d4d002a00000008000101120003000000010006000000000000','hex');
await fs.writeFile(phone,Buffer.concat([phoneBytes.subarray(0,2),portraitExif,phoneBytes.subarray(2)]));
fixtures['人物甲']=phone;
const result=await fs.readFile(fixtures['返回图片']);
const revisedBytes=await fs.readFile(fixtures['流量统计']);
const calls=[];
const server=http.createServer(async(req,res)=>{
  const body=await new Response(req,{headers:req.headers}).formData();
  const files=body.getAll('image').concat(body.getAll('image[]'));
  calls.push({path:req.url,prompt:body.get('prompt'),files:await Promise.all(files.map(async v=>Buffer.from(await v.arrayBuffer())))});
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({data:[{b64_json:(body.get('prompt')?.includes('仅对此成品修订文字')?revisedBytes:result).toString('base64')}]}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const env={...process.env,ZIYUN_DATA_DIR:path.join(dir,'data'),ZIYUN_SMOKE:'1'};
delete env.ELECTRON_RUN_AS_NODE;
let app,page;
const errors=[];
async function launch(){
  const exe=process.env.ZIYUN_TEST_EXE;
  app=await electron.launch({executablePath:exe||createRequire(import.meta.url)('electron'),args:exe?[]:[root],env});
  page=await app.firstWindow();
  page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.getByTestId('add-row').waitFor();
}
const button=name=>page.getByRole('button',{name,exact:true});
const call=(method,...args)=>page.evaluate(({method,args})=>window.studio.call(method,...args),{method,args});
const select=files=>app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files});},files);
try{
  await launch();
  await call('saveProvider',{id:'local-cover-test',name:'本机验收',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',protocol:'openai-images',model:'fixture-image',key:'isolated-local-only'});
  await call('updateSettings',{bindings:{image:'local-cover-test'},autoExport:false});
  await page.setViewportSize({width:1050,height:770});
  const collision=await page.locator('.main-nav').evaluate(nav=>{
    const blocks=[...nav.querySelectorAll('button')].map(b=>b.getBoundingClientRect());
    return blocks.some((b,i)=>b.right>window.innerWidth+1||blocks.some((v,j)=>j<i&&Math.min(b.right,v.right)-Math.max(b.left,v.left)>1&&Math.min(b.bottom,v.bottom)-Math.max(b.top,v.top)>1));
  });
  if(collision) console.log(await page.locator('.main-nav button').evaluateAll(els=>els.map(e=>[e.textContent,e.offsetWidth,e.getBoundingClientRect().left,e.getBoundingClientRect().right,window.innerWidth])));
  assert.equal(collision,false,'最小窗口导航需完整可点击');
  await button('02 模板调试').click();
  await select([fixtures['原版封面']]);await button('选择底图').click();
  await page.getByRole('textbox',{name:'整体修改意见',exact:true}).fill('调整标题颜色');
  await button('生成整图修改').click();
  await button('用此模板批量替换').click();
  await page.getByRole('img',{name:'固定模板'}).waitFor();
  await page.getByLabel('封面标题').fill('同城获客（配图：后台咨询截图）\n曝光增长（配图：流量统计）');
  await page.getByLabel('替换人物',{exact:true}).check();
  await select([fixtures['人物甲'],fixtures['人物乙']]);
  await page.getByRole('group',{name:'替换人物'}).getByText('添加候选图片').click();
  await page.getByLabel('替换配图位 1',{exact:true}).check();
  await select([fixtures['后台咨询截图'],fixtures['流量统计']]);
  await page.getByRole('group',{name:'替换配图位 1'}).getByText('添加候选图片').click();
  await page.getByLabel('生成张数').fill('2');
  await button('预览组合').click();await button('生成 2 张').waitFor();
  const preview=(await call('getState')).batchReplacePreview;
  const records=preview.items;
  assert.equal(records[0].person.path,phone);assert.notEqual(records[0].person.id,records[0].person.referenceId);
  assert.equal(path.parse(records[0].referencePaths[2]).name,records[0].person.referenceId);
  assert.equal(records.length,2);assert.equal(calls.length,1,'本地制作组合参考图不提交模型');
  const board=page.getByRole('img',{name:'组合参考图 · 同城获客',exact:true});
  await expect.poll(()=>board.evaluate(img=>img.complete&&img.naturalWidth)).toBe(1440);
  await page.screenshot({path:path.join(dir,'03-组合实图与提示词.png')});
  const sample=await app.evaluate(({nativeImage},file)=>{
    const img=nativeImage.createFromPath(file),pixels=img.toBitmap(),width=img.getSize().width;
    return [[340,500],[868,500],[1230,500]].map(([x,y])=>{const off=4*(y*width+x);return [pixels[off+2],pixels[off+1],pixels[off]];});
  },records[0].boardPath);
  assert.ok(sample[0][0]>200&&sample[0][1]>200&&sample[0][2]<30,'素材板应包含调试后的黄色模板');
  assert.ok(sample[1][0]>200&&sample[1][1]<30,'素材板应含红色人物甲');
  assert.ok(sample[2][0]>90&&sample[2][2]>90&&sample[2][1]<30,'素材板应含紫色咨询截图');
  const promptField=page.getByLabel('本张完整提示词');
  const editedPrompt=(await promptField.inputValue())+'\n只将标题描边加宽。';
  await promptField.fill(editedPrompt);
  await button('去 02 标注这张').click();
  await expect(page.getByLabel('当前组合生成提示词')).toHaveValue(editedPrompt);
  const changedPrompt=editedPrompt+'\n两行标题左边对齐。';
  await page.getByLabel('当前组合生成提示词').fill(changedPrompt);
  // Hold the actual IPC, then close the real main window while the revision is pending.
  await app.evaluate(({ipcMain,BrowserWindow})=>{
    const original=ipcMain._invokeHandlers.get('studio:call');
    ipcMain.removeHandler('studio:call');
    ipcMain.handle('studio:call',async(event,method,...args)=>{
      if(method==='applyBatchEdit') {
        setImmediate(()=>BrowserWindow.fromWebContents(event.sender)?.close());
        await new Promise(resolve=>setTimeout(resolve,450));
      }
      return original(event,method,...args);
    });
  });
  const closed=app.waitForEvent('close');
  await button('应用到当前组合').click();
  await closed;app=null;await launch();
  const afterReturn=(await call('getState')).batchReplacePreview;
  assert.equal(afterReturn.items[0].prompt,changedPrompt,'关窗须等待已经发出的回填保存');
  assert.equal(afterReturn.id,preview.id);assert.deepEqual(afterReturn.items[1],records[1]);
  assert.equal(calls.length,1,'仅修改提示词并回填不能调用模型');
  await button('03 批量替换').click();
  await button('继续核对已保存组合').click();
  await expect(page.getByLabel('本张完整提示词')).toHaveValue(changedPrompt);
  await button('生成 2 张').click();
  await button('导出已完成（2）').waitFor();
  const first=(await call('getState')).jobs.filter(j=>j.snapshot.feature==='batch-replace');
  assert.equal(first.length,2);
  const tuned=(await call('getState')).jobs.find(v=>v.snapshot.feature==='template-edit').localPath;
  assert.notEqual(tuned,fixtures['原版封面']);
  for(const [i,j] of first.entries()) {
    const req=calls.find(v=>v.prompt.replaceAll("\r\n","\n")===j.prompt);
    assert.deepEqual(j.referencePaths,records[i].referencePaths);
    assert.equal(j.prompt,i===0?changedPrompt:records[i].prompt);
    for(const [n,file] of j.referencePaths.entries()) assert.deepEqual(req.files[n],await fs.readFile(file),'HTTP 载荷须等于核对过的实际素材');
    assert.equal(j.status,'succeeded');assert.deepEqual(await fs.readFile(j.referencePaths[0]),await fs.readFile(tuned));
    assert.ok((await fs.stat(j.localPath)).size>0);
    assert.ok(j.snapshot.replacement.note.includes(path.parse(j.snapshot.replacement.pictures[0].path).name));
  }
  const dest=path.join(dir,'导出');await fs.mkdir(dest);await select([dest]);await button('导出已完成（2）').click();
  await expect.poll(async()=> (await call('getState')).jobs.filter(j=>j.snapshot.feature==='batch-replace'&&j.exportedPath).length).toBe(2);
  for(const j of (await call('getState')).jobs.filter(j=>j.snapshot.feature==='batch-replace'))assert.ok(path.relative(dest,j.exportedPath).split(path.sep)[0]!=='..' && (await fs.stat(j.exportedPath)).size>0);
  await app.close();app=null;await launch();await button('03 批量替换').click();
  await page.getByRole('img',{name:'固定模板'}).waitFor();
  assert.match(await page.getByLabel('封面标题').inputValue(),/同城获客/);
  const unavailable=path.join(dir,'选择后变为不可写的分类');
  const categoryRow=await call('saveRow',{code:'E01',name:'分类示例',userPrompt:'分类目录验证'});
  await fs.mkdir(unavailable);await select([unavailable]);
  await page.evaluate(()=>window.studio.chooseFolder('image-output'));
  await call('updateSettings',{autoExport:true,imageCategoryDirectory:{category:'E',directory:unavailable}});
  await page.getByLabel('输出分类').selectOption('E');
  await fs.rmdir(unavailable);await fs.writeFile(unavailable,'模拟分类目录被同名文件占用');
  await button('预览组合').click();await button('生成 2 张').click();
  await expect.poll(async()=> (await call('getState')).jobs.filter(j=>j.snapshot.feature==='batch-replace'&&j.status==='succeeded').length).toBe(4);
  const recover=button('另选目录导出失败项（2）');
  await recover.waitFor();
  const beforeRecovery=calls.length;
  await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
  await recover.click();
  await expect(recover).toBeEnabled();
  const recoverable=()=>call('getState').then(s=>s.jobs.filter(j=>j.snapshot?.replacement?.outputCategory==='E'));
  assert.ok((await recoverable()).every(j=>j.exportError && !j.exportedPath));
  const recoveredDir=path.join(dir,'混批恢复导出');await fs.mkdir(recoveredDir);
  await select([recoveredDir]);await recover.click();
  await expect.poll(async()=> (await recoverable()).filter(j=>j.exportedPath&&!j.exportError).length).toBe(2);
  for(const job of await recoverable()){
    assert.equal(path.dirname(path.dirname(job.exportedPath)),recoveredDir);
    assert.deepEqual(await fs.readFile(job.localPath),await fs.readFile(job.exportedPath));
    assert.equal(job.snapshot.outputDir,unavailable);
  }
  assert.equal(calls.length,beforeRecovery,'取消和另选目录均只处理已有文件');
  const done=(await call('getState')).jobs.filter(j=>j.snapshot.feature==='batch-replace');
  assert.equal(new Set(done.map(j=>j.snapshot.replacement.key)).size,4);
  assert.equal(calls.length,5);assert.ok(calls.every(c=>c.path.endsWith('/images/edits')));
  assert.deepEqual(calls.slice(1).map(c=>c.files.length),[4,4,4,4]);
  for(const req of calls.slice(1))assert.equal(req.files[0].equals(result),true,'混批收到已调好模板的原始字节');
  await button('预览组合').click();await page.getByRole('dialog',{name:'混批组合预览'}).waitFor();
  assert.equal((await call('getState')).batchReplacePreview.items.length,0);
  await expect(button('生成 2 张')).not.toBeVisible();await button('关闭').click();
  assert.equal(calls.length,5);
  await page.getByTestId('image-tasks-nav').click();await page.getByText('共 5 条',{exact:false}).first().waitFor();
  await button('01 图片素材').click();
  assert.deepEqual(await page.locator('.task-table tbody tr').evaluateAll(rows=>rows.map(row=>row.dataset.rowId)),[categoryRow.id]);
  await button('03 批量替换').click();
  await button('去 02 编辑成品').first().click();
  await page.getByLabel('当前组合生成提示词').fill('仅对此成品修订文字');
  await expect(button('应用到当前组合')).not.toBeVisible();
  await button('生成整图修改').click();
  await button('将此图应用到当前组合').click();
  await button('另存修订成品').waitFor();
  assert.equal(calls.length,6);
  const revisionDir=path.join(dir,'成品修订');await fs.mkdir(revisionDir);
  await select([revisionDir]);await button('另存修订成品').click();
  await expect.poll(async()=>(await call('getState')).jobs.filter(j=>j.snapshot?.replacement?.revision?.exportedPath).length).toBe(1);
  const exportBoth=path.join(dir,'整批修订');await fs.mkdir(exportBoth);
  const [revisedJob,untouched]=await recoverable();
  await fs.rename(untouched.localPath,untouched.localPath+'.moved');
  await select([exportBoth]);await button('另选目录导出').click();
  await expect(page.getByText(/已导出 1 张，失败 1 张/)).toBeVisible();
  const partial=await recoverable();
  assert.equal(path.dirname(path.dirname(partial[0].exportedPath)),exportBoth);
  assert.deepEqual(await fs.readFile(partial[0].exportedPath),revisedBytes);assert.ok(partial[1].exportError);
  assert.deepEqual(await fs.readFile(revisedJob.localPath),result,'已生成原图须保留');
  await fs.rename(untouched.localPath+'.moved',untouched.localPath);
  await select([exportBoth]);await button('另选目录导出失败项（1）').click();
  await expect.poll(async()=>(await recoverable()).filter(j=>j.exportError).length).toBe(0);
  const repaired=await recoverable();assert.deepEqual(await fs.readFile(repaired[1].exportedPath),result);
  assert.equal(path.dirname(repaired[1].exportedPath),path.dirname(repaired[0].exportedPath));
  assert.equal(calls.length,6,'批量修订另存、部分失败与补导均不再次请求');
  await page.getByLabel('封面标题').fill('新方案一\n新方案二');
  await button('预览组合').click();
  await button('去 02 标注这张').click();
  await page.getByRole('textbox',{name:'整体修改意见',exact:true}).fill('仅将配图对齐，保留版式');
  await button('生成整图修改').click();
  await button('将此图应用到当前组合').click();
  await button('生成 2 张').waitFor();
  const revised=(await call('getState')).batchReplacePreview;
  assert.deepEqual(await fs.readFile(revised.items[0].boardPath),result,'修订结果应成为当前组合图2');
  assert.notEqual(revised.items[0].boardPath,revised.items[1].boardPath);
  const preJobs=(await call('getState')).jobs.length;
  await button('生成 2 张').click();
  await expect.poll(async()=>(await call('getState')).jobs.slice(preJobs).filter(j=>j.status==='succeeded').length).toBe(2);
  const recent=(await call('getState')).jobs.slice(preJobs);
  assert.deepEqual(recent.map(j=>j.referencePaths),revised.items.map(v=>v.referencePaths));
  assert.deepEqual(recent.map(j=>j.prompt),revised.items.map(v=>v.prompt));
  assert.equal(calls.length,9);
  await assert.rejects(call('applyBatchEdit',{id:'result:'+recent[0].id,path:path.join(dir,'未经选择.png'),prompt:'越界来源'}),/已登记/);
  assert.deepEqual(errors,[]);console.log('COVER_WORKFLOW_PASS',dir);
}finally{
 if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
