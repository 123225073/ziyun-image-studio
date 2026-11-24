import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {analyzeCoverLayout,findCoverLayout} from '../electron/cover-layout.mjs';

test('模板版式使用固定模板的真实快照，缓存按内容校验，异常响应不能代替识别结果',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'ziyun-cover-layout-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const file=path.join(dataDir,'模板.png');
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await fs.writeFile(file,bytes);
  const calls=[];let expected=bytes;
  let response=JSON.stringify({style:'海报',title:'顶部两行',person:'右侧主角',inserts:['左边卡片','中间卡片'],preserve:'底部标记'});
  const service={dataDir,state:{},assertOpen(){},changed(){},provider(){return {model:'fixture'};},
    imageCodec:{createFromBuffer:()=>({isEmpty:()=>false,getSize:()=>({width:1,height:1})})},
    async callProvider(op,input){calls.push(op);assert.match(input.describeInstructions,/嵌图内部/);
      assert.notEqual(input.referencePaths[0],file);
      assert.deepEqual(await fs.readFile(input.referencePaths[0]),expected);return {text:response};}};
  const report=await analyzeCoverLayout(service,file);
  assert.match(findCoverLayout(service.state,report.templateId),/嵌图 2：中间卡片/);
  assert.equal(findCoverLayout(service.state,'another'),'');
  const alias=path.join(dataDir,'别名.png');await fs.writeFile(alias,bytes);
  assert.equal((await analyzeCoverLayout(service,alias)).path,alias);
  assert.equal((await analyzeCoverLayout(service,alias,{cachedOnly:true})).text,report.text);
  assert.equal(calls.length,1);
  await fs.appendFile(alias,'changed');
  expected=await fs.readFile(alias);
  await assert.rejects(analyzeCoverLayout(service,alias,{cachedOnly:true}),/文件已变化/);
  assert.equal(calls.length,1);assert.equal(service.state.coverTemplateLayout,undefined);
  response='无法识别';
  await assert.rejects(analyzeCoverLayout(service,alias),/未返回完整/);
  assert.equal(calls.length,2);assert.equal(service.state.coverTemplateLayout,undefined);
});
