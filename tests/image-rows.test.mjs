import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {visibleImageRows,reorderVisibleRows,rowCategory,nextImageRowCode} from '../shared/image-rows.mjs';
import {StudioService} from '../electron/service.mjs';
const rows=[{id:'a10',code:'A10',name:'十号'},{id:'b',code:'B01',name:'乙类'},{id:'a2',code:'a02',name:'二号'},{id:'n',code:'01',name:'数字'}];
test('新增编号沿用手动列表最后一行分类递增，并跳过已有号码',()=>{
  assert.equal(nextImageRowCode([]),'A01');
  assert.equal(nextImageRowCode([{code:'A01'}]),'A02');
  assert.equal(nextImageRowCode([{code:'A99'},{code:'B01'}]),'B02');
  assert.equal(nextImageRowCode([{code:'B02'},{code:'b3'},{code:'B01'}]),'B04');
  assert.equal(nextImageRowCode([{code:'AB009'}]),'AB010');
  assert.equal(nextImageRowCode([{code:'03'}]),'A04');
  assert.equal(nextImageRowCode([{code:'A01.'}]),'A02');
  assert.equal(nextImageRowCode([{code:'A01'},{code:'自定义名称'}]),'A02');
  const before=structuredClone(rows);
  assert.equal(nextImageRowCode(rows),'A03');
  assert.deepEqual(rows,before);
});
test('长编号递增不丢精度，溢出编号长度时明确报错',()=>{
  assert.equal(nextImageRowCode([{code:'B999999999999999999999'}]),'B1000000000000000000000');
  assert.throws(()=>nextImageRowCode([{code:'A'+'9'.repeat(39)}]),/编号过长/);
});
test('默认显示全部；按字母分类、自然编号正倒序、关键字和勾选筛选',()=>{
  assert.deepEqual(visibleImageRows(rows),rows);assert.equal(rowCategory('ab01'),'AB');
  assert.deepEqual(visibleImageRows(rows,{category:'A',order:'asc'}).map(row=>row.id),['a2','a10']);
  assert.deepEqual(visibleImageRows(rows,{category:'A',order:'desc'}).map(row=>row.id),['a10','a2']);
  assert.deepEqual(visibleImageRows(rows,{query:'乙类'}).map(row=>row.id),['b']);
  assert.deepEqual(visibleImageRows(rows,{category:'#'}).map(row=>row.id),['n']);
  assert.deepEqual(visibleImageRows(rows,{selectedOnly:true,selected:['b','n']}).map(row=>row.id),['b','n']);
  assert.deepEqual(rows.map(row=>row.id),['a10','b','a2','n']);
});
test('筛选后拖动只替换可见位置，隐藏行保持原位置且不改编号',()=>{
  assert.deepEqual(reorderVisibleRows(rows,['a10','a2'],'a2','a10'),['a2','b','a10','n']);
  assert.deepEqual(rows.map(row=>row.code),['A10','B01','a02','01']);
});
test('改编号仅保存编号；拖入有效图片或目录可准备多图，错误文件不改变原行',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ziyun-drop-'));const service=await StudioService.create({dataDir:path.join(root,'data')});
  t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true})});
  await service.saveRow({id:'row',code:'01',name:'原任务',count:5,userPrompt:'原要求',referencePrompt:'原参考',sourcePaths:[],ratio:'1:1'});
  const before=structuredClone(service.state.rows[0]);await service.saveRowCode('row','A01.');assert.deepEqual(service.state.rows[0],{...before,code:'A01.'});
  await assert.rejects(service.saveRowCode('row',''),/编号/);
  const file=path.join(root,'image.png');const image=Buffer.alloc(40);Buffer.from([137,80,78,71,13,10,26,10]).copy(image);image.write('IHDR',12);image.writeUInt32BE(10,16);image.writeUInt32BE(10,20);await fs.writeFile(file,image);
  assert.deepEqual(await service.prepareReferenceDrop([file]),{sourcePaths:[file],sourceMode:'single'});
  assert.deepEqual(await service.prepareReferenceDrop([root]),{sourcePaths:[file],sourceMode:'folder'});
  await fs.writeFile(path.join(root,'bad.png'),'invalid-image');await assert.rejects(service.prepareReferenceDrop([file,path.join(root,'bad.png')]));
  assert.deepEqual(service.state.rows[0],{...before,code:'A01.'});
});
