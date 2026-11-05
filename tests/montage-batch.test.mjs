import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StudioService } from '../electron/service.mjs';
import { batchCapacity, batchCombinations, batchCombinationAt, alignSections } from '../shared/montage-batch.mjs';
import { buildJianyingDraft } from '../electron/jianying.mjs';

test('A四条乘B三条完整覆盖12个独立组合，未启用段落不参与', () => {
  const rows = [{ section:'A', candidates:'A1\nA2\nA3\nA4',paths:['A.png'] },{ section:'B', candidates:'B1\nB2\nB3',paths:['B.png'] },{ section:'C',enabled:false,candidates:'' }];
  assert.equal(batchCapacity(rows),12);
  const values=batchCombinations(rows);
  assert.equal(values.length,12);assert.equal(new Set(values.map(value=>value.masterText)).size,12);
  assert(values.every(value=>value.segments.length===2&&value.segments[0].paths[0]==='A.png'&&value.segments[1].paths[0]==='B.png'));
  assert.equal(batchCapacity([{section:'A',candidates:'x\nx'},{section:'B',candidates:''}]),0);
  assert.equal(batchCapacity([]),0);
});

test('任意启用段落动态相乘，四段240种和更多段落均无固定AB限制',()=>{
  const sections=[4,3,4,5].map((count,index)=>({section:String.fromCharCode(65+index),candidates:Array.from({length:count},(_,i)=>`第${index+1}段文案${i+1}`).join('\n')}));
  assert.equal(batchCapacity(sections),240);
  const combinations=batchCombinations(sections,240);assert.equal(combinations.length,240);assert.equal(new Set(combinations.map(item=>item.masterText)).size,240);
  assert.deepEqual(batchCombinationAt(sections,239),combinations.at(-1));
  sections.push({section:'E',candidates:'第五段一\n第五段二'});assert.equal(batchCapacity(sections),480);
  sections[1].enabled=false;assert.equal(batchCapacity(sections),160);
});

test('固定文案按素材文件组合，数量动态相乘，旁白相同但画面各不相同',()=>{
  const rows=[{section:'A',candidateMode:'files',candidates:'固定开场',paths:['a1.png','a2.png','a3.png','a4.png']},{section:'B',candidateMode:'files',candidates:'固定正文',paths:['b1.png','b2.png','b3.png']}];
  const values=batchCombinations(rows);
  assert.equal(values.length,12);assert.equal(new Set(values.map(value=>value.masterText)).size,1);
  assert.equal(new Set(values.map(value=>JSON.stringify(value.segments.map(segment=>segment.paths)))).size,12);
  rows[0].candidates='第一条\n第二条';assert.equal(batchCapacity(rows),0,'多文案不可猜测和文件的对应关系');
});

test('完整旁白按真实词句时间拆分素材范围，缺时间戳才按字数估算',()=>{
  const sections=[{section:'A',text:'打开书。'},{section:'B',text:'翻到目录。'}];
  const result=alignSections(sections,5,[{text:'打开书。',start:0,end:1},{text:'翻到目录。',start:1,end:5}]);
  assert.equal(result.estimated,false);assert.deepEqual(result.segments.map(item=>item.duration),[1,4]);
  assert.equal(result.segments[1].audioCues[0].start,0);
  const fallback=alignSections(sections,5,[{text:'无关文字',start:0,end:5}]);assert.equal(fallback.estimated,true);
  assert.equal(fallback.segments.reduce((sum,item)=>sum+item.duration,0),5);
  const crossing=alignSections(sections,5,[{text:'打开书。翻到目录。',start:0,end:5}]);
  assert(crossing.segments.every(item=>item.audioCues.length===0),'跨段的时间戳不能只留下部分句子');
});

test('整行重排只改变顺序，保留自定义编号，配置、生成记录和未保存标识关联不变，重启保留',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ziyun-reorder-'));let service=await StudioService.create({dataDir:root});
  t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true})});
  for(let i=1;i<=3;i++)await service.saveRow({id:`row${i}`,code:`0${i}`,name:`类型${i}`,count:i,sourceMode:'folder',sourcePaths:[`image${i}.png`],userPrompt:`保留要求${i}`,referencePrompt:`参考${i}`,ratio:'3:4',resolution:'2K',folderName:`目录${i}`,variations:['真实配置']});
  service.state.jobs.push({id:'history',kind:'image',rowId:'row3',status:'succeeded',snapshot:{row:structuredClone(service.state.rows[2])}});service.changed();
  const original=structuredClone(service.state);await service.reorderRows(['row1','row3','row2']);
  await assert.rejects(service.reorderRows(['row1','row1','row2']),/已变化/);
  await service.close();service=await StudioService.create({dataDir:root});
  assert.deepEqual(service.state.rows.map(item=>item.id),['row1','row3','row2']);
  assert.deepEqual(service.state.rows.map(item=>item.code),['01','03','02']);
  for(const row of service.state.rows){const previous=original.rows.find(item=>item.id===row.id);assert.deepEqual({...row,code:previous.code},previous)}
  assert.deepEqual(service.state.jobs,original.jobs);
});

test('剪映保留画面、配音、音乐、字幕及裁切时间，重叠音频分轨',()=>{
  const timeline={ratio:'9:16',fontSize:30,clips:[{id:'v',track:'picture',start:0,duration:3,sourceIn:1,path:'video.mp4'},{id:'a',track:'voice',start:0,duration:2,sourceIn:.4,path:'voice.wav',volume:.7},{id:'b',track:'voice',start:1,duration:1,sourceIn:0,path:'voice.wav'},{id:'m',track:'music',start:0,duration:3,sourceIn:0,path:'music.wav',volume:.2},{id:'s',track:'subtitle',start:.2,duration:1.2,text:'完整保留字幕'}]};
  const media=Object.fromEntries(['video.mp4','voice.wav','music.wav'].map(file=>[file,{path:`D:/草稿/materials/${file}`,duration:4,width:640,height:480}]));
  const draft=buildJianyingDraft(timeline,media);
  assert.equal(draft.duration,3000000);assert.equal(draft.tracks.length,5);
  const picture=draft.tracks[0].segments[0];assert.equal(picture.source_timerange.start,1000000);assert.equal(picture.volume,0);
  const voice=draft.tracks[1].segments[0];assert.equal(voice.source_timerange.start,400000);assert.equal(voice.volume,.7);
  assert.equal(JSON.parse(draft.materials.texts[0].content).text,'完整保留字幕');
  assert(draft.tracks.every((track,index)=>track.segments.every(segment=>segment.render_index===index)));
});
