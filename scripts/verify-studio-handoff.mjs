import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const fixture=await fs.mkdtemp(path.join(root,'test-output','studio-handoff-'));
const executablePath=process.env.ZIYUN_TEST_EXE||process.argv[2];
const env={...process.env,ZIYUN_SMOKE:'1',ZIYUN_DATA_DIR:fixture};
delete env.ELECTRON_RUN_AS_NODE;
let app,page,png;
const errors=[],routes=[];
const server=http.createServer(async(req,res)=>{
  for await(const ignored of req){} // Consume multipart edits before responding.
  routes.push(req.url);
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({data:[{b64_json:png}]}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const call=(method,...args)=>page.evaluate(({method,args})=>window.studio.call(method,...args),{method,args});
async function start(){
  app=await electron.launch({executablePath:executablePath||createRequire(import.meta.url)('electron'),args:executablePath?[]:[root],env,timeout:60000});
  page=await app.firstWindow();page.setDefaultTimeout(12000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.getByTestId('add-row').waitFor();
}
async function closeWindow(){
  const closed=app.waitForEvent('close',{timeout:10000});
  page.evaluate(()=>window.studio.window('close')).catch(()=>{});
  await closed;app=null;
}
async function completed(predicate){
  const deadline=Date.now()+15000;
  let state;
  while(Date.now()<deadline){
    state=await call('getState');
    if(predicate(state))return state;
    await new Promise(resolve=>setTimeout(resolve,60));
  }
  throw Error('等待跨工作区结果超时：'+JSON.stringify(state.jobs.map(j=>[j.status,j.error])));
}
const nav=label=>page.getByRole('navigation',{name:'工作流程'}).getByRole('button',{name:label,exact:true}).click();
try{
  await start();
  png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=64;canvas.height=96;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#a74238';ctx.fillRect(0,0,64,96);return canvas.toDataURL('image/png').split(',')[1];});
  await call('saveProvider',{id:'local-studio',name:'隔离测试图像服务',protocol:'openai-images',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'gpt-image-2',key:'fixture-only'});
  await call('updateSettings',{bindings:{image:'local-studio'},autoExport:false,defaultTemplateId:''});
  const row=await call('saveRow',{code:'A01',name:'原图片任务',userPrompt:'一张封面',count:1});
  await page.locator(`tr[data-row-id="${row.id}"]`).getByRole('button',{name:'生成',exact:true}).click();
  let state=await completed(s=>s.jobs[0]?.status==='succeeded');
  const original=state.jobs[0];
  await nav('02 模板调试');
  await page.getByLabel('从生成结果选择底图').selectOption(original.localPath);
  await page.getByLabel('整体修改意见').fill('标题上移');
  await page.getByRole('button',{name:'生成整图修改',exact:true}).click();
  state=await completed(s=>s.jobs.some(j=>j.snapshot.feature==='template-edit'&&j.status==='succeeded'));
  const template=state.jobs.find(j=>j.snapshot.feature==='template-edit');
  await page.getByRole('button',{name:'用此模板批量替换',exact:true}).click();
  await page.getByLabel('封面标题').fill('同城日记');
  await page.getByLabel('生成张数').fill('1');
  await page.getByRole('button',{name:'预览组合'}).click();
  await page.getByRole('dialog',{name:'混批组合预览'}).getByRole('button',{name:'生成 1 张',exact:true}).click();
  state=await completed(s=>s.jobs.some(j=>j.snapshot.feature==='batch-replace'&&j.status==='succeeded'));
  assert.equal(state.batchReplaceDraft.templatePath,template.localPath);
  assert.equal(state.rows.length,1);
  assert.deepEqual(routes,['/v1/images/generations','/v1/images/edits','/v1/images/edits']);

  await nav('01 图片素材');
  assert.equal(await page.locator('.task-table tbody tr').count(),1);
  assert.equal(await page.locator('.result-card:visible').count(),1);
  await page.getByRole('button',{name:'归档记录（0）',exact:true}).waitFor();
  await page.getByRole('button',{name:'归档当前批次'}).click();
  await page.getByRole('button',{name:'确认归档',exact:true}).click();
  state=await completed(s=>s.jobs.find(j=>j.id===original.id)?.archivedAt);
  assert(!state.jobs.some(j=>j.snapshot.feature&&j.archivedAt));
  await nav('任务中心');
  assert.equal(await page.locator('.image-task-filters button').first().locator('strong').innerText(),'2');

  await nav('02 模板调试');await page.getByLabel('整体修改意见').fill('关窗前最后一笔模板修改');
  await closeWindow();await start();state=await call('getState');
  assert.equal(state.templateDraft?.instruction,'关窗前最后一笔模板修改','立即关闭后应恢复模板输入');
  await nav('03 批量替换');await page.getByLabel('封面标题').fill('关窗前最后一条标题');
  await closeWindow();await start();state=await call('getState');
  assert.equal(state.batchReplaceDraft?.titles,'关窗前最后一条标题','立即关闭后应恢复混批输入');
  assert.equal(state.jobs.length,3);assert.deepEqual(errors,[]);
  console.log('STUDIO_HANDOFF_AND_HOST_ISOLATION_PASS',JSON.stringify({fixture,routes,normalClose:true,errors}));
}finally{
  if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}
  await new Promise(resolve=>server.close(resolve));
}

