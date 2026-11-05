import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDialogPaths } from '../electron/dialog-paths.mjs';

test('picker paths are independent, persist, and cancellation preserves successful selection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-picker-'));
  try {
    const dirs = ['image','audio','montage-root','excel-import','excel-template'].map(name => path.join(root,name));
    for (const dir of dirs) await fs.mkdir(dir);
    const calls=[]; let response;
    const options={file:path.join(root,'memory.json'),window:()=>null,dialog:{
      showOpenDialog:async (_win, input)=>{calls.push(input);return response;},
      showSaveDialog:async (_win, input)=>{calls.push(input);return response;},
    }};
    const memory=await createDialogPaths(options);
    for (const [i,key] of ['image','audio','montage-root','excel-import'].entries()) {
      response={canceled:false,filePaths:[i===2?dirs[i]:path.join(dirs[i],'素材.png')]};
      await memory.open(key,{properties:[i===2?'openDirectory':'openFile']});
    }
    response={canceled:false,filePath:path.join(dirs[4],'模板.xlsx')};
    await memory.save('excel-template',{defaultPath:'模板.xlsx'});
    const restored=await createDialogPaths(options);
    response={canceled:true,filePaths:[]};
    for (const [i,key] of ['image','audio','montage-root','excel-import'].entries()) {
      await restored.open(key,{properties:['openDirectory']});assert.equal(calls.at(-1).defaultPath,dirs[i]);
    }
    await restored.save('excel-template',{defaultPath:'新模板.xlsx'});
    assert.equal(calls.at(-1).defaultPath,path.join(dirs[4],'新模板.xlsx'));
    const saved=JSON.parse(await fs.readFile(options.file,'utf8'));
    assert.equal(saved['excel-template'],dirs[4]);assert.equal(saved.image,dirs[0]);
    await fs.rmdir(dirs[0]);await restored.open('image',{properties:['openFile']});
    assert.equal(calls.at(-1).defaultPath,root);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
