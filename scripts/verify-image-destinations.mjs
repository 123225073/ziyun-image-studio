import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const executablePath = process.env.ZIYUN_TEST_EXE || process.env.ZIYUN_EXE || process.argv[2];
const fixture = await fs.mkdtemp(path.join(root,'test-output','image-destinations-'));
const profile = path.join(fixture,'隔离配置');
const [globalDir, categoryDir, rowDir, manualDir] = ['默认','档期记','本行专用','手动目标'].map(name => path.join(fixture,name));
for (const dir of [globalDir, categoryDir, rowDir, manualDir]) await fs.mkdir(dir);
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const reference = path.join(fixture,'旧参考图.png');
await fs.writeFile(reference,image);
const requests = [];
const server = http.createServer(async (request,response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push({url:request.url, text:Buffer.concat(chunks).toString('utf8')});
  response.writeHead(200, {'content-type':'application/json'});
  response.end(JSON.stringify({data:[{b64_json:image.toString('base64')}]}));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const env = {...process.env, ZIYUN_SMOKE:'1', ZIYUN_DATA_DIR:profile};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [];
const call = (method,...args) => page.evaluate(({method,args})=>window.studio.call(method,...args),{method,args});
const run = promisify(execFile);
async function start() {
  app = await electron.launch({executablePath:executablePath || createRequire(import.meta.url)('electron'), args:executablePath?[]:[root], env, timeout:60000});
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  try { await page.getByTestId('add-row').waitFor(); }
  catch (error) { throw new Error(`首页未加载：${page.url()} · ${errors.join(' / ')} · ${(await page.locator('body').innerText()).slice(0,500)}`, { cause:error }); }
}
async function waitState(check) {
  const limit = Date.now()+20000;
  while (Date.now()<limit) {
    const state = await call('getState');
    if (check(state)) return state;
    await new Promise(resolve=>setTimeout(resolve,70));
  }
  throw new Error('等待图片任务或导出结果超时');
}
async function nextPicker(directory) {
  await app.evaluate(({dialog}, directory)=>{
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async (_owner, options) => {
      dialog.showOpenDialog = original;
      if (!options.properties.includes('openDirectory')) throw new Error('预期文件夹选择器');
      return { canceled:!directory, filePaths:directory?[directory]:[] };
    };
  },directory);
}
async function cancelNativePicker() {
  // Windows can host the file picker in a separate process. Match the unique test dialog title.
  const pid = process.pid;
  const script = `Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PickerWindow {
  public delegate bool Callback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr state);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr w,StringBuilder text,int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr w,StringBuilder text,int length);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr w,uint msg,IntPtr wp,IntPtr lp);
  public static bool Cancel(uint pid) {
    bool found=false;
    EnumWindows((w,unused)=>{
      var title=new StringBuilder(150); var cls=new StringBuilder(100);
      GetWindowText(w,title,150);GetClassName(w,cls,100);
      if(title.ToString().Contains("子云目录验收")) Console.WriteLine("title "+title+" class "+cls+" expected "+pid);
      if(cls.ToString()=="#32770" && title.ToString()=="子云目录验收 "+pid) {
        found=PostMessage(w,0x10,IntPtr.Zero,IntPtr.Zero);
        return false;
      }
      return true;
    },IntPtr.Zero);
    return found;
  }
}
'@
$end=[DateTime]::UtcNow.AddSeconds(12)
while([DateTime]::UtcNow -lt $end){if([PickerWindow]::Cancel(${pid})){Write-Output NATIVE_CANCEL;exit 0};Start-Sleep -Milliseconds 100}
throw 'Native directory picker was not observed.'`;
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  const result=await run('powershell.exe',['-NoProfile','-EncodedCommand',encoded],{windowsHide:true,timeout:23000});
  assert.match(result.stdout,/NATIVE_CANCEL/);
}
const findRow = id => page.locator(`tr[data-row-id="${id}"]`);
const save = () => page.getByRole('button',{name:'保存本行',exact:true}).click();
const generate = id => findRow(id).getByRole('button',{name:'生成',exact:true}).click();
try {
  await start();
  await call('saveProvider',{id:'local-image',name:'本机验收服务',protocol:'openai-images',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'gpt-image-2',key:'fixture-only'});
  await call('updateSettings',{outputDir:globalDir,bindings:{image:'local-image'},autoExport:true,defaultTemplateId:''});
  const legacy=await call('saveRow',{code:'咨询截图_01',name:'旧任务',sourcePaths:[reference],referencePrompt:'旧参考图描述',userPrompt:'旧要求'});
  const manual=await call('saveRow',{code:'08',name:'无前缀下载',userPrompt:'一张风景图'});
  for(const code of ['A01','B-01','C_01']) await call('saveRow',{code,name:code});
  const filter=page.getByLabel('按编号分类筛选');
  await filter.selectOption('#');
  await findRow(manual.id).waitFor();
  await findRow(legacy.id).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'分类目录',exact:true}).click();
  const manager=page.getByRole('dialog',{name:'分类输出目录'});
  assert.deepEqual(new Set(await manager.locator('li strong').allTextContents()),new Set(['A 类','B 类','C 类','咨询截图 类']));
  await nextPicker(null);
  await manager.getByRole('button',{name:'设置咨询截图类目录'}).click();
  assert.ok(!(await call('getState')).settings.imageCategoryDirectories['咨询截图']);
  await nextPicker(categoryDir);
  await manager.getByRole('button',{name:'设置咨询截图类目录'}).click();
  await manager.getByText(categoryDir,{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await filter.selectOption('咨询截图');
  await findRow(legacy.id).waitFor();
  await findRow(manual.id).waitFor({state:'hidden'});
  await filter.selectOption('');
  await findRow(legacy.id).click();
  await page.getByRole('button',{name:'纯文生图',exact:true}).click();
  await page.getByLabel('生图描述',{exact:true}).fill('描绘一张冬日海报');
  await page.getByLabel('本行保存子目录',{exact:true}).fill('12月');
  await save();
  assert.equal(await page.getByTestId('row-source-output').getByRole('textbox').count(),1);
  assert.equal(await page.getByTestId('row-source-output').getByText(/类默认目录|设置.+类目录/).count(),0);
  await generate(legacy.id);
  let state = await waitState(s=>s.jobs.some(j=>j.rowId===legacy.id && j.exportedPath));
  const first=state.jobs.find(j=>j.rowId===legacy.id);
  assert.equal(path.dirname(first.exportedPath),path.join(categoryDir,'12月'));
  assert.deepEqual(await fs.readFile(first.exportedPath),image);
  assert.deepEqual(first.referencePaths,[]);
  assert.deepEqual(state.rows.find(r=>r.id===legacy.id).sourcePaths,[reference]);
  assert.match(requests[0].url,/images\/generations$/);
  assert.doesNotMatch(requests[0].text,/旧参考图描述/);
  await page.getByRole('button',{name:'图片',exact:true}).click();
  await page.getByRole('button',{name:'放大参考图片',exact:true}).waitFor();
  assert.equal(await page.getByLabel('参考提示词',{exact:true}).inputValue(),'旧参考图描述');
  await nextPicker(rowDir);
  await page.getByRole('button',{name:'选择本行保存目录',exact:true}).click();
  await page.getByLabel('生成数量',{exact:true}).fill('2');
  await save();
  await generate(legacy.id);
  state=await waitState(s=>s.jobs.some(j=>j.rowId===legacy.id&&j.slot===1&&j.exportedPath));
  assert.equal(path.dirname(state.jobs.find(j=>j.slot===1).exportedPath),rowDir);
  assert.match(requests[1].url,/images\/edits$/);

  await findRow(manual.id).click();
  await generate(manual.id);
  state=await waitState(s=>s.jobs.some(j=>j.rowId===manual.id&&j.exportedPath));
  const plain=state.jobs.find(j=>j.rowId===manual.id);
  assert.equal(path.dirname(path.dirname(plain.exportedPath)),globalDir);
  assert.deepEqual(await fs.readFile(plain.exportedPath),image);
  await call('updateSettings',{outputDir:''}); // An unset root still opens the download picker.
  const download=page.locator('.results:visible').getByLabel('下载全部成功文件',{exact:true});
  if(process.platform==='win32'){
    await app.evaluate(({dialog}, pid)=>{const show=dialog.showOpenDialog;
      dialog.showOpenDialog=(...args)=>{
        dialog.showOpenDialog=show;
        const options=args.at(-1);
        globalThis.lastFolderDialog=options.title;
        if(options.title!=='选择文件夹') throw new Error('预期手动下载选择目录');
        return show.call(dialog,args[0],{...options,title:'子云目录验收 '+pid});
      };},process.pid);
    try{await Promise.all([cancelNativePicker(),download.click()]);}
    catch(error){
      const title=await app.evaluate(()=>globalThis.lastFolderDialog||'未打开');
      const status=await page.locator('.toast').allTextContents();
      throw new Error(`未取消目录对话框：${title}，${status.join(' ')}；${String(error.stdout||'').slice(-600)}`);
    }
  }else{
    await nextPicker(null);
    await download.click();
  }
  assert.equal((await call('getState')).jobs.find(j=>j.id===plain.id).exportedPath,plain.exportedPath);
  await nextPicker(manualDir);
  await download.click();
  state=await waitState(s=>s.jobs.some(j=>j.id===plain.id&&j.exportedPath!==plain.exportedPath));
  const exported=state.jobs.find(j=>j.id===plain.id).exportedPath;
  assert(!path.relative(manualDir,exported).startsWith('..'));
  assert.deepEqual(await fs.readFile(exported),image);
  assert.equal(requests.length,3);
  await fs.writeFile(path.join(categoryDir,'被占用'),'已有同名文件');
  const conflict=await call('saveRow',{code:'咨询截图-09',name:'自动导出失败',folderName:'被占用',userPrompt:'只生成一次'});
  await findRow(conflict.id).click();
  await generate(conflict.id);
  await waitState(s=>s.jobs.some(j=>j.rowId===conflict.id&&j.exportError));
  await nextPicker(null);
  await page.getByRole('button',{name:'另选目录保存'}).click();
  state=await call('getState');
  assert.ok(state.jobs.find(j=>j.rowId===conflict.id).exportError);
  await nextPicker(manualDir);
  await page.getByRole('button',{name:'另选目录保存'}).click();
  state=await waitState(s=>s.jobs.some(j=>j.rowId===conflict.id&&j.exportedPath&&!j.exportError));
  const recovered=state.jobs.find(j=>j.rowId===conflict.id);
  assert.equal(path.dirname(recovered.exportedPath),manualDir);
  assert.deepEqual(await fs.readFile(recovered.exportedPath),image);
  assert.equal(state.jobs.find(j=>j.id===first.id).exportedPath,first.exportedPath);
  assert.equal(state.rows.find(r=>r.id===conflict.id).folderName,'被占用');
  assert.equal(await fs.readFile(path.join(categoryDir,'被占用'),'utf8'),'已有同名文件');
  assert.equal(requests.length,4,'另存不应重新生图');
  await call('updateSettings',{autoExport:false});
  const offline=await call('saveRow',{code:'咨询截图12',name:'关闭自动导出',folderName:'被占用',userPrompt:'保留本机图片'});
  await findRow(offline.id).click();
  await generate(offline.id);
  state=await waitState(s=>s.jobs.some(j=>j.rowId===offline.id&&j.status==='succeeded'));
  const localOnly=state.jobs.find(j=>j.rowId===offline.id);
  assert.ok(!localOnly.exportError&&!localOnly.exportedPath);
  await download.click(); // First manual export targets the unavailable subdirectory.
  await page.locator('.toast.error').filter({hasText:/输出子目录/}).waitFor();
  await nextPicker(manualDir);
  await page.getByRole('button',{name:'另选目录保存'}).click();
  state=await waitState(s=>s.jobs.some(j=>j.id===localOnly.id&&j.exportedPath));
  const manuallySaved=state.jobs.find(j=>j.id===localOnly.id);
  assert.equal(path.dirname(manuallySaved.exportedPath),manualDir);
  assert.deepEqual(await fs.readFile(manuallySaved.exportedPath),image);
  assert.equal(state.settings.autoExport,false);
  assert.equal(state.settings.imageCategoryDirectories['咨询截图'],categoryDir);
  assert.equal(state.rows.find(r=>r.id===offline.id).folderName,'被占用');
  assert.equal(requests.length,5,'首次手动导出失败后另存不应重新生图');
  await app.close(); app=null;
  await start();
  state=await call('getState');
  assert.equal(state.settings.imageCategoryDirectories['咨询截图'],categoryDir);
  assert.equal(state.rows.find(r=>r.id===legacy.id).rowOutputDir,rowDir);
  assert.deepEqual(state.rows.find(r=>r.id===legacy.id).sourcePaths,[reference]);
  assert.equal(state.jobs.filter(j=>j.status==='succeeded').length,5);
  const directoryField=page.getByLabel('本行保存子目录',{exact:true});
  async function pasteOriginal(id,displayedPath) {
    await findRow(id).click();
    assert.equal(await directoryField.inputValue(),displayedPath);
    await directoryField.fill('');await directoryField.fill(displayedPath);await save();
    await page.getByRole('button',{name:'保存本行',disabled:true}).waitFor();
    return (await call('getState')).rows.find(row=>row.id===id);
  }
  assert.equal((await pasteOriginal(legacy.id,rowDir)).rowOutputDir,rowDir);
  const boundPath=path.join(fixture,'旧绑定','A04','子图');await fs.mkdir(boundPath,{recursive:true});
  await findRow(manual.id).click();await nextPicker(boundPath);
  await page.getByRole('button',{name:'选择本行保存目录'}).click();
  await save();await waitState(s=>s.rows.find(row=>row.id===manual.id).outputMode==='source-children');
  const rebound=await pasteOriginal(manual.id,boundPath);
  assert.equal(rebound.outputMode,'source-children');assert.equal(rebound.sourceFolder,path.dirname(boundPath));
  assert.equal(rebound.folderName,boundPath);assert.equal(requests.length,5);
  assert.deepEqual(errors,[]);
  console.log('IMAGE_DESTINATIONS_UI_PASS',JSON.stringify({fixture,nativeCancel:process.platform==='win32',requests:requests.map(r=>r.url),jobs:5}));
} finally {
  if(app)await app.close().catch(()=>{});
  await new Promise(resolve=>server.close(resolve));
}

