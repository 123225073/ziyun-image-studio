import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const root=path.resolve(import.meta.dirname,'..');
const output=await fs.mkdtemp(path.join(root,'test-output','dialog-paths-'));
const env={...process.env,ZIYUN_DATA_DIR:path.join(output,'workspace'),ZIYUN_SMOKE:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.env.ZIYUN_TEST_EXE||createRequire(import.meta.url)('electron');
let app,page;
async function launch(){
  app=await electron.launch({executablePath,args:process.env.ZIYUN_TEST_EXE?[]:[root],env,timeout:60000});
  page=await app.firstWindow();await page.getByTestId('settings-nav').waitFor();
  await app.evaluate(({dialog})=>{
    globalThis.pickerCalls=[];globalThis.pickerResult={canceled:true,filePaths:[]};
    dialog.showOpenDialog=async (_window,options)=>{globalThis.pickerCalls.push(options);return globalThis.pickerResult;};
    dialog.showSaveDialog=async (_window,options)=>{globalThis.pickerCalls.push(options);return globalThis.pickerResult;};
  });
}
const invoke=([method,arg])=>page.evaluate(([method,arg])=>window.studio[method](arg),[method,arg]);
const response=value=>app.evaluate((_electron,value)=>{globalThis.pickerResult=value;},value);
const calls=()=>app.evaluate(()=>globalThis.pickerCalls);
const cases=[...['image','audio','video','media','h3-reference'].map(kind=>['chooseFiles',kind]),...['image','output','jianying','montage-root','montage-section'].map(purpose=>['chooseFolder',purpose])];
try{
  await launch();
  const expected=new Map();
  for(const [method,arg] of cases){
    const dir=path.join(output,method+'-'+arg);await fs.mkdir(dir);
    await response({canceled:false,filePaths:[method==='chooseFiles'?path.join(dir,'fixture.png'):dir]});
    await invoke([method,arg]);expected.set(arg,dir);
  }
  // Other specialized dialogs share the same remembered native mechanism.
  const typeRoot=path.join(output,'types');await fs.mkdir(typeRoot);
  await response({canceled:false,filePaths:[typeRoot]});
  await page.evaluate(()=>window.studio.call('previewImageFolderImport'));
  const templateDir=path.join(output,'templates');await fs.mkdir(templateDir);
  await response({canceled:false,filePath:path.join(templateDir,'图片任务批量导入模板.xlsx')});
  await page.evaluate(()=>window.studio.call('downloadImageBatchTemplate'));
  await app.close();await launch();
  await response({canceled:true,filePaths:[]});
  for(const entry of cases){await invoke(entry);assert.equal((await calls()).at(-1).defaultPath,expected.get(entry[1]));}
  await page.evaluate(()=>window.studio.call('previewImageFolderImport'));
  assert.equal((await calls()).at(-1).defaultPath,typeRoot);
  await page.evaluate(()=>window.studio.call('downloadImageBatchTemplate'));
  assert.equal(path.dirname((await calls()).at(-1).defaultPath),templateDir);
  const stored=JSON.parse(await fs.readFile(path.join(env.ZIYUN_DATA_DIR,'dialog-paths.json'),'utf8'));
  for(const [key,value] of expected)assert.equal(stored[key],value);
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,nativeDialogPurposes:expected.size+2,restartPreserved:true,cancelPreserved:true},null,2));
  console.log('DIALOG_PATHS_VERIFICATION_PASS',output);
}finally{await app?.close();}
