import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StudioService} from '../electron/service.mjs';
import {assertReplacementRetry} from '../electron/batch-replace.mjs';
import {readCoverTitles} from '../shared/batch-replace.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const fixtureCodec={createFromBuffer(bytes){return {isEmpty:()=>!bytes.includes(Buffer.from('IEND')),getSize:()=>({width:1,height:1})};}};
async function setup(t,runner=async()=>({images:[{bytes:png,mime:'image/png'}]})) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ziyun-cover-')));
  const dataDir=path.join(root,'data');
  let service=await StudioService.create({dataDir,providerRunner:runner});
  service.imageCodec=fixtureCodec;service.renderCoverBoard=async(title,sources)=>Buffer.concat([png,Buffer.from(JSON.stringify([title,sources]))]);
  t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true});});
  await service.updateSettings({paused:true,autoExport:false,providers:[{id:'test',name:'test',protocol:'openai-images',baseUrl:'https://fixture.invalid',model:'fixture',hasKey:true}],bindings:{image:'test'}});
  const assets=[];
  for (const name of ['模板','人物一','人物二','咨询','播放','收入']) {
    const file=path.join(root,name+'.png');await fs.writeFile(file,Buffer.concat([png,Buffer.from(name)]));assets.push({path:file,tag:name});
  }
  const [template,p1,p2,a,b,c]=assets;
  return {root,service,draft:{templatePath:template.path,titlesEnabled:true,titles:'1. 标题甲（配图：后台咨询截图）\n2. 标题乙（配图：流量数据截图）',peopleEnabled:true,people:[p1,p2],
    slots:[{name:'手机插图',enabled:true,assets:[a,b]},{name:'右边示例',enabled:true,assets:[c]}],count:2,resolution:'1K'},restart:async()=>{
    await service.close();service=await StudioService.create({dataDir,providerRunner:runner});service.imageCodec=fixtureCodec;service.renderCoverBoard=async(title,sources)=>Buffer.concat([png,Buffer.from(JSON.stringify([title,sources]))]);return service;
  }};
}
async function wait(service,predicate) {
  for(let i=0;i<500;i++){if(predicate(service.state.jobs))return;await new Promise(r=>setTimeout(r,10));}
  throw Error(JSON.stringify(service.state.jobs.map(j=>({status:j.status,error:j.error}))));
}

test('同一固定模板按标题备注选图、分散人物与标题，成功后跨重启去重，用剩余新组合生成，耗尽后不再重复',async t=>{
  const payloads=[];
  const f=await setup(t,async(op,payload)=>{payloads.push(payload);return {images:[{bytes:png,mime:'image/png'}]};});
  const {draft,service}=f;
  const preview=await service.previewBatchReplace(draft);
  assert.equal(preview.freshCount,2); assert.equal(preview.repeatCount,0);
  assert.deepEqual(preview.items.map(i=>i.pictures[0].tag),['咨询','播放']);
  assert.equal(new Set(preview.items.map(i=>i.person.id)).size,2);
  const result=await service.enqueueBatchReplace(draft,{requestId:'first',token:preview.token});
  assert.equal(result.jobIds.length,2);
  assert.deepEqual((await service.enqueueBatchReplace(draft,{requestId:'first'})).jobIds,result.jobIds);
  await assert.rejects(service.enqueueBatchReplace(draft,{requestId:'stale',token:preview.token}),/重新预览/);
  const active=await service.previewBatchReplace({...draft,count:4});
  assert.equal(active.freshCount,2); assert.equal(active.shortageCount,2);assert.equal(active.items.length,2);
  assert.ok(active.items.every(item=>!preview.items.some(old=>old.key===item.key)));
  await service.setPaused(false);
  await wait(service,jobs=>jobs.every(j=>j.status==='succeeded'));
  assert.equal(payloads.length,2);
  assert.ok(payloads.every(p=>p.count===1 && p.referencePaths.length===5 && p.referencePaths[0].includes('cover-inputs')));
  for(const j of service.state.jobs){assert.deepEqual(await fs.readFile(j.localPath),png);assert.ok(!j.snapshot.replacement.title.includes('配图：'));}
  await service.setPaused(true);
  const reopened=await f.restart();assert.equal(reopened.state.batchReplaceDraft.templatePath,draft.templatePath);
  const p2=await reopened.previewBatchReplace({...draft,count:5});
  assert.equal(p2.freshCount,2);assert.equal(p2.shortageCount,3);assert.equal(p2.items.length,2);
  const left=await reopened.enqueueBatchReplace({...draft,count:5},{requestId:'remaining',mode:'remaining',token:p2.token});
  assert.equal(left.jobIds.length,2);
  await assert.rejects(reopened.enqueueBatchReplace({...draft,count:5},{requestId:'extra',mode:'reuse'}),/只生成未使用/);
  assert.equal((await reopened.previewBatchReplace(draft)).items.length,0);
  await assert.rejects(reopened.enqueueBatchReplace(draft,{requestId:'exhausted'}),/没有可提交/);
  assert.equal(reopened.state.jobs.length,4);assert.equal(reopened.state.rows.length,0);
});

test('无关素材备注按可用候选回退，显式关闭替换项可沿用原模板，只指定一种素材也可生成',async t=>{
  const {service,draft}=await setup(t);
  const fallback=await service.previewBatchReplace({...draft,titles:'标题（配图：婚纱戒指）'});
  assert.equal(fallback.items.length,2);assert.ok(fallback.items.every(item=>item.noteFallback && !item.prompt.includes('婚纱戒指')));
  await assert.rejects(service.previewBatchReplace({...draft,people:[]}),/人物/);
  const alone={...draft,peopleEnabled:false,slots:[],titles:'标题',count:3};
  const p=await service.previewBatchReplace(alone);
  assert.equal(p.freshCount,1);assert.equal(p.shortageCount,2);assert.equal(p.items.length,1);
  const jobs=await service.enqueueBatchReplace(alone,{requestId:'alone',mode:'fresh'});
  assert.equal(jobs.reusedCount,0);assert.equal(jobs.jobIds.length,1);assert.equal(service.state.jobs[0].referencePaths.length,2);
  assert.deepEqual(readCoverTitles('1. 只显示我（配图：流量）\n2. 只显示我（配图：流量）'),[{title:'只显示我',note:'流量'}]);
  assert.equal((await service.previewBatchReplace({...draft,titlesEnabled:false,count:1})).items[0].title,'');
});

test('确认失败可从原槽重试；待确认或已成功的同一槽不会重复提交',async t=>{
  let requests=0;
  const {service,draft}=await setup(t,async()=>{if(++requests===1)throw Error('明确失败');return {images:[{bytes:png,mime:'image/png'}]};});
  const one={...draft,count:1,titles:'独立封面',peopleEnabled:false,slots:[]};
  const {jobIds}=await service.enqueueBatchReplace(one,{requestId:'retry'});
  await service.setPaused(false);await wait(service,jobs=>jobs[0].status==='failed');
  assert.equal((await service.previewBatchReplace(one)).freshCount,1);
  const retried=await service.retryJobs(jobIds);assert.equal(retried.length,1);
  await wait(service,jobs=>jobs.some(j=>j.status==='succeeded'));
  assert.equal((await service.previewBatchReplace(one)).freshCount,0);
  assert.equal((await service.retryJobs(jobIds)).length,0);
});


test('明确的素材用途优先于组名，标题中的同城修饰词不能误配档期，生成后修改原图不改变队列参考',async t=>{
  const {service,draft}=await setup(t);
  const [consult,traffic]=draft.slots[0].assets;
  const d={...draft,titles:'同城获客（配图：同城咨询截图）',slots:[{enabled:true,name:'后台咨询',assets:[{...consult,tag:'同城档期日历'},traffic]}],count:1};
  assert.equal((await service.previewBatchReplace(d)).items[0].noteFallback,true);
  d.slots[0].assets[0].tag='后台咨询';
  const preview=await service.previewBatchReplace(d);
  assert.equal(preview.items[0].pictures[0].path,consult.path);assert.equal(preview.items[0].noteFallback,false);
  const photo=preview.items[0].person.path, original=await fs.readFile(photo);
  await service.enqueueBatchReplace(d,{requestId:'freeze',token:preview.token});
  await fs.writeFile(photo,Buffer.concat([png,Buffer.from('changed-portrait')]));
  assert.deepEqual(await fs.readFile(service.state.jobs[0].referencePaths[2]),original);
  const malformed=path.join(path.dirname(photo),'bad.png');await fs.writeFile(malformed,png.subarray(0,24));
  await assert.rejects(service.previewBatchReplace({...d,templatePath:malformed}),/解码|损坏|图片/);
});

test('混批使用显式选中的分类，未选择时不继承全局；跨批同组合在途/完成阻止普通旧槽重试',async t=>{
  const {service,draft,root}=await setup(t);
  const cat=path.join(root,'封面');await fs.mkdir(cat);
  await service.updateSettings({outputDir:path.join(root,'普通素材'),autoExport:true,imageCategoryDirectory:{category:'E',directory:cat}});
  const d={...draft,count:1,peopleEnabled:false,titles:'同一标题',slots:[]};
  await service.enqueueBatchReplace(d,{requestId:'first'});
  const first=service.state.jobs[0];
  assert.equal(first.snapshot.autoExport,false);first.status='failed';
  await service.enqueueBatchReplace({...d,outputCategory:'E'},{requestId:'second'});
  const second=service.state.jobs[1];
  assert.equal(second.snapshot.outputDir,cat);assert.equal(second.snapshot.autoExport,true);
  assert.throws(()=>assertReplacementRetry(service.state.jobs, first),/其他槽位/);
  await service.setPaused(false);await wait(service,jobs=>Boolean(jobs[1].exportedPath));
  assert.equal(path.dirname(path.dirname(second.exportedPath)),cat);
  assert.throws(()=>assertReplacementRetry(service.state.jobs, first),/其他槽位/);
  assert.throws(()=>assertReplacementRetry(service.state.jobs,{...first,snapshot:{...first.snapshot,replacement:{...first.snapshot.replacement,repeated:true}}}),/其他槽位/);
});

test('混批选择中文编号分类，分类目录留空时沿用输出根目录',async t=>{
  const {service,draft,root}=await setup(t);
  await service.saveRow({code:'咨询截图_01',name:'咨询截图'});
  const globalDir=path.join(root,'普通素材'), categoryDir=path.join(root,'指定的分类目录');
  await service.updateSettings({outputDir:globalDir,autoExport:true});
  const d={...draft,count:1,peopleEnabled:false,titles:'首组',slots:[],outputCategory:'咨询截图'};
  await service.enqueueBatchReplace(d,{requestId:'global-fallback'});
  assert.equal(service.state.jobs[0].snapshot.outputDir,globalDir);
  await service.updateSettings({imageCategoryDirectory:{category:'咨询截图',directory:categoryDir}});
  await service.enqueueBatchReplace({...d,titles:'次组'},{requestId:'category'});
  assert.equal(service.state.jobs[1].snapshot.outputDir,categoryDir);
});

test('不同新组合各自保留调试；重启后按已确认的图和提示词提交，源文件移动不影响冻结结果',async t=>{
  const f=await setup(t), d={...f.draft,count:2,titles:'第一标题\n第二标题',peopleEnabled:false,slots:[]};
  const before=structuredClone(await f.service.previewBatchReplace(d));
  assert.notEqual(before.items[0].key,before.items[1].key);
  assert.notEqual(before.items[0].id,before.items[1].id);
  assert.ok(before.items.every(i=>i.prompt.includes('图1')&&i.prompt.includes('图2')));
  await f.service.saveBatchPreviewPrompt(before.items[0].id,'单独调整第一张');
  const from02=f.draft.people[0].path;
  await f.service.applyBatchEdit({id:before.items[1].id,path:from02,prompt:'第二张采用调试结果'});
  const reopened=await f.restart();
  const review=reopened.state.batchReplacePreview;
  assert.equal(review.requestId,before.requestId);
  assert.deepEqual(review.items[0].referencePaths,before.items[0].referencePaths);
  assert.notEqual(review.items[1].boardPath,before.items[1].boardPath);
  assert.equal(review.items[1].referencePaths[0],before.items[1].referencePaths[0]);
  assert.deepEqual(await fs.readFile(review.items[1].referencePaths[1]),await fs.readFile(from02));
  await fs.rename(d.templatePath,d.templatePath+'.moved');
  const options={mode:'remaining',requestId:review.requestId,token:review.token};
  const [first,again]=await Promise.all([reopened.enqueueBatchReplace(d,options),reopened.enqueueBatchReplace(d,options)]);
  assert.deepEqual(first,again);
  assert.deepEqual(reopened.state.jobs.map(j=>j.prompt),['单独调整第一张','第二张采用调试结果']);
  assert.deepEqual(reopened.state.jobs.map(j=>j.referencePaths),review.items.map(i=>i.referencePaths));
  await assert.rejects(reopened.applyBatchEdit({id:before.items[1].id,path:from02,prompt:'过期修订'}),/未找到/);
});

test('成品只接受当前02生成的修订，批量导出使用最新图且保存部分成功记录以便补导',async t=>{
  let calls=0;
  const f=await setup(t,async()=>{calls++;return {images:[{bytes:png,mime:'image/png'}]};});
  const review=await f.service.previewBatchReplace(f.draft);
  await f.service.enqueueBatchReplace(review.draft,{token:review.token,requestId:review.requestId});
  await f.service.setPaused(false);await wait(f.service,jobs=>jobs.every(j=>j.status==='succeeded'));
  const [job,other]=f.service.state.jobs,originalPrompt=job.prompt,originalPath=job.localPath;
  const unchanged={id:'result:'+job.id,path:originalPath,prompt:originalPrompt};
  await f.service.applyBatchEdit(unchanged);
  assert.equal(job.snapshot.replacement.revision,undefined);
  await assert.rejects(f.service.applyBatchEdit({...unchanged,prompt:'新修订说明'}),/生成本张修订图/);
  const revised=f.draft.people[0].path,bytes=await fs.readFile(revised);
  // Represents a successful 02 result associated with this exact product.
  f.service.state.jobs.push({id:'job02',status:'succeeded',localPath:revised,snapshot:{feature:'template-edit',templateEdit:{combinationId:unchanged.id,combinationPrompt:'新修订说明'}}});
  await f.service.applyBatchEdit({...unchanged,path:revised,prompt:'新修订说明'});
  const folder=path.join(f.root,'独立修订');await fs.mkdir(folder);
  const saved=await f.service.exportBatchRevision(job.id,folder);
  assert.deepEqual(await fs.readFile(saved),bytes);assert.equal(path.dirname(saved),folder);
  const batchDir=path.join(f.root,'整批导出');await fs.mkdir(batchDir);
  const otherSource=other.localPath;await fs.rename(otherSource,otherSource+'.moved');
  const result=await f.service.exportJobs([job.id,other.id],batchDir);
  assert.equal(result.length,2);assert.deepEqual(await fs.readFile(result[0].path),bytes);assert.match(result[1].error,/已被移动或删除/);
  const reopened=await f.restart(), [restored,missing]=reopened.state.jobs;
  assert.equal(restored.exportedPath,result[0].path);assert.equal(missing.exportError,result[1].error);
  await fs.rename(otherSource+'.moved',otherSource);
  const [retry]=await reopened.exportJobs([other.id],batchDir);
  assert.equal(missing.exportError,'');assert.deepEqual(await fs.readFile(retry.path),png);
  assert.equal(path.dirname(restored.exportedPath),path.dirname(missing.exportedPath));
  assert.equal(job.prompt,originalPrompt);assert.equal(job.localPath,originalPath);assert.deepEqual(await fs.readFile(originalPath),png);assert.equal(calls,2);
});

test('空白组合提示词阻止入队，失败后修正可继续，替换其他预览后拒绝过期回填',async t=>{
  const {service,draft}=await setup(t);
  const p=await service.previewBatchReplace(draft);
  await service.saveBatchPreviewPrompt(p.items[0].id,' ');
  await assert.rejects(service.enqueueBatchReplace(draft,{token:p.token,requestId:p.requestId}),/填写完整提示词/);
  assert.equal(service.state.jobs.length,0);
  await service.saveBatchPreviewPrompt(p.items[0].id,'已修正');
  const newer=await service.previewBatchReplace({...draft,count:1});
  await assert.rejects(service.applyBatchEdit({id:p.items[0].id,path:draft.templatePath,prompt:'旧批次'}),/未找到/);
  assert.equal(service.state.batchReplacePreview.items[0].prompt,newer.items[0].defaultPrompt);
});

test('0.7 未提交预览保留已编辑的新槽；同图改名或去掉禁用槽位都不能重复生成',async t=>{
  const fixture=await setup(t),{draft,service}=fixture;
  const slot={enabled:true,name:'手机中的截图',assets:[draft.slots[0].assets[0]]};
  const one={...draft,titles:'一个标题（配图：）',count:4,peopleEnabled:false,slots:[{enabled:false,name:'占位',assets:[]},slot]};
  const reviewed=await service.previewBatchReplace(one),item=reviewed.items[0];
  assert.deepEqual(readCoverTitles(one.titles),[{title:'一个标题',note:''}]);
  await service.saveBatchPreviewPrompt(item.id,'保留我的覆盖文案');
  delete reviewed.uniqueOnly;delete item.contentKey;
  reviewed.items.push({...item,id:item.id+'old',repeated:true});reviewed.repeatCount=1;service.changed();
  const restarted=await fixture.restart(),migrated=restarted.state.batchReplacePreview;
  assert.equal(migrated.items.length,1);assert.equal(migrated.shortageCount,3);
  assert.equal(migrated.items[0].id,item.id);assert.equal(migrated.items[0].prompt,'保留我的覆盖文案');
  const result=await restarted.enqueueBatchReplace(one,{requestId:migrated.requestId,token:migrated.token});
  assert.equal(result.jobIds.length,1);
  const legacy=restarted.state.jobs[0];delete legacy.snapshot.replacement.contentKey;
  legacy.status='succeeded';legacy.archivedAt='2026-01-01';
  const alias=path.join(fixture.root,'改名截图.png');await fs.copyFile(slot.assets[0].path,alias);
  const renamed={...one,slots:[{...slot,name:'重新命名的位置',assets:[{path:alias,tag:'改名'}]}],resolution:'4K'};
  const exhausted=await restarted.previewBatchReplace(renamed);
  assert.equal(exhausted.items.length,0);assert.equal(exhausted.shortageCount,4);assert.equal(exhausted.repeatCount,0);
  assert.equal((await restarted.enqueueBatchReplace(one,{requestId:migrated.requestId})).batchId,result.batchId);
});

test('同模板多位组合先解读各角色边界，再按实际图号替换，旧批处理中、状态未知和失败待保存均占用',async t=>{
  const {draft,service}=await setup(t),one={...draft,count:1};
  const preview=await service.previewBatchReplace(one),item=preview.items[0];
  for(const entry of ['主标题','副标题','角标','配图位','边框','主角','图3','图4','图5',draft.slots[0].name,draft.slots[1].name]) assert.ok(item.prompt.includes(entry),entry);
  await service.enqueueBatchReplace(one,{requestId:'tested',token:preview.token});
  const job=service.state.jobs[0];delete job.snapshot.replacement.contentKey;
  for(const status of ['queued','planning','running','saving','unknown','succeeded','failed']) {
    job.status=status;job.result=status==='failed'?{images:[{url:'mock'}]}:null;
    const next=await service.previewBatchReplace({...draft,count:10});
    assert.ok(next.items.every(candidate=>candidate.key!==item.key),status);
  }
  job.result=null;
  const released=await service.previewBatchReplace({...draft,count:10});
  assert.ok(released.items.some(candidate=>candidate.key===item.key),'明确失败且无结果的槽可再次挑选');
});

test('版式说明按模板内容绑定，刷新说明影响新预览，已核对的请求保持冻结',async t=>{
  const {service,draft}=await setup(t);
  const baseline=await service.previewBatchReplace(draft);
  service.state.coverTemplateLayout={templateId:'other-template',text:'不属于本图的布局'};
  const wrong=await service.previewBatchReplace(draft);
  assert.equal(wrong.id,baseline.id);
  assert.ok(!wrong.items[0].prompt.includes('不属于本图'));
  const layout='主标题两行靠左；主角位于右侧，手机嵌图在左下角。';
  service.state.coverTemplateLayout={templateId:baseline.templateId,text:layout};
  const analyzed=await service.previewBatchReplace(draft);
  assert.notEqual(analyzed.token,baseline.token);
  assert.deepEqual(analyzed.items.map(item=>item.key),baseline.items.map(item=>item.key));
  assert.ok(analyzed.items.every(item=>item.prompt.includes(layout)));
  service.state.coverTemplateLayout.text='随后更新的布局';
  await service.enqueueBatchReplace(draft,{requestId:'reviewed-layout',token:analyzed.token});
  assert.deepEqual(service.state.jobs.map(job=>job.prompt),analyzed.items.map(item=>item.prompt));
});

test('并发的新批不能占用相同组合，用户张数大于余量时整批只提交余量',async t=>{
  const {service,draft}=await setup(t);
  const d={...draft,count:3};
  const [a,b]=await Promise.all([service.enqueueBatchReplace(d,{requestId:'one-start'}),service.enqueueBatchReplace(d,{requestId:'another-start'})]);
  assert.equal(a.jobIds.length,3);assert.equal(b.jobIds.length,1);
  assert.equal(new Set(service.state.jobs.map(job=>job.snapshot.replacement.key)).size,4);
  assert.equal((await service.previewBatchReplace(d)).freshCount,0);
});

test('0.7 满16张输入：嵌在板内的最后一张移走、旧路径换图，去除禁用位后只保留真正的新搭配',async t=>{
  const {root,draft,service,restart}=await setup(t);
  const pics=[];
  for(let i=0;i<15;i++){
    const file=path.join(root,'配图-'+i+'.png');
    await fs.writeFile(file,Buffer.concat([png,Buffer.from('old-'+i)]));
    pics.push({name:'插图位置'+i,enabled:true,assets:[{path:file,tag:''}]});
  }
  const before={...draft,peopleEnabled:false,titles:'超多嵌图',count:1,slots:[
    {name:'前置未用',enabled:false,assets:[]},...pics.slice(0,6),{name:'中间未用',enabled:false,assets:[]},...pics.slice(6)]};
  const plan=await service.previewBatchReplace(before);
  await service.enqueueBatchReplace(before,{token:plan.token,requestId:plan.requestId});
  const old=service.state.jobs[0];delete old.snapshot.replacement.contentKey;old.status='succeeded';
  assert.equal(old.referencePaths.length,16);assert.equal(old.snapshot.replacement.pictures.length,15);
  const different=path.join(root,'另一份真实新素材.png');await fs.writeFile(different,Buffer.concat([png,Buffer.from('different-original')]));
  const onlyDifferent={...before,slots:[...pics.slice(0,-1),{...pics.at(-1),assets:[{path:different,tag:''}]}]};
  const clean=await service.previewBatchReplace(onlyDifferent);
  assert.equal(clean.freshCount,1);assert.equal(clean.unverified.length,0);
  assert.equal(old.snapshot.replacement.contentKey,plan.items[0].contentKey);
  delete old.snapshot.replacement.contentKey; // Restore a separate pristine 0.7 history before moving the source.
  const original=pics.at(-1).assets[0].path,moved=path.join(root,'搬走并重命名.png');
  await fs.rename(original,moved);
  await fs.writeFile(original,Buffer.concat([png,Buffer.from('different-source-at-same-path')]));
  // Same path and same decoded pixels in this fixture, but a distinct immutable file.
  const updated={...before,count:3,slots:[...pics.slice(0,-1),{...pics.at(-1),assets:[{path:original,tag:''},{path:moved,tag:''}]}]};
  const now=await service.previewBatchReplace(updated);
  assert.equal(now.items.length,1);assert.equal(now.items[0].pictures.at(-1).path,original);
  assert.notEqual(now.items[0].contentKey,plan.items[0].contentKey);
  assert.equal(old.snapshot.replacement.contentKey,plan.items[0].contentKey);
  const restored=await restart();
  await fs.unlink(original);
  const onlyOld={...updated,slots:[...updated.slots.slice(0,-1),{...pics.at(-1),assets:[{path:moved,tag:''}]}]};
  assert.equal((await restored.previewBatchReplace(onlyOld)).items.length,0);
  await assert.rejects(restored.enqueueBatchReplace(onlyOld,{requestId:'prevent-repeat'}),/没有可提交/);
});
test('旧模板预览制作期间收到新底图，旧结果不能覆盖草稿或误提交',async t=>{
  const {draft,service}=await setup(t);
  await service.saveBatchReplaceDraft(draft);
  const render=service.renderCoverBoard;
  let started,release;
  const rendering=new Promise(resolve=>{started=resolve;});
  const allowRender=new Promise(resolve=>{release=resolve;});
  service.renderCoverBoard=async(...args)=>{started();await allowRender;return render(...args);};
  const oldPreview=service.previewBatchReplace(draft,{requireCurrentDraft:true});
  await rendering;
  const next={...draft,templatePath:draft.people[0].path};
  await service.saveBatchReplaceDraft(next);
  release();
  assert.equal(await oldPreview,null);
  assert.equal(service.state.batchReplaceDraft.templatePath,next.templatePath);
  assert.ok(!service.state.batchReplacePreview);
  await assert.rejects(service.enqueueBatchReplace(draft,{requestId:'stale-preview',requireCurrentDraft:true}),/当前模板/);
  assert.equal(service.state.jobs.length,0);
  assert.equal((await service.previewBatchReplace(next,{requireCurrentDraft:true})).draft.templatePath,next.templatePath);
});

test('0.7满额原位证据缺失时单列历史待核对，不计作重复、不自动生成；无关的新配图组合正常提交',async t=>{
  const f=await setup(t),{root,draft,service}=f;
  const slots=[];
  for(let i=0;i<15;i++) {
    const file=path.join(root,'材料-'+i+'.png');
    await fs.writeFile(file,Buffer.concat([png,Buffer.from('slot-'+i)]));
    slots.push({enabled:true,name:'材料'+i,assets:[{path:file,tag:''}]});
  }
  const old={...draft,titles:'旧组合边界',peopleEnabled:false,count:1,
    slots:slots.flatMap((s,i)=>i%2===0?[{enabled:false,name:'旧未启用',assets:[]},s]:[s])};
  const preview=await service.previewBatchReplace(old);
  await service.enqueueBatchReplace(old,{token:preview.token,requestId:'legacy-many-gaps'});
  const historical=service.state.jobs[0];historical.status='succeeded';delete historical.snapshot.replacement.contentKey;
  await service.saveBatchReplaceDraft({...old,slots:[]});
  const raw=structuredClone(historical);
  const reopened=await f.restart();
  assert.deepEqual(reopened.state.jobs[0],raw,'升级不能静默更新旧任务的其他字段');
  const final=slots.at(-1),lastFile=final.assets[0].path,moved=lastFile+'.renamed.png';
  await fs.rename(lastFile,moved);
  const current={...old,slots:[...slots.slice(0,-1),{...final,assets:[{path:moved,tag:''}]}]};
  const held=await reopened.previewBatchReplace(current);
  assert.equal(held.items.length,0);assert.equal(held.unverified.length,1);
  assert.equal(held.unverified[0].history[0].batchId,historical.rowId);assert.equal(held.unverified[0].pictures.at(-1).path,moved);
  await assert.rejects(reopened.enqueueBatchReplace(current,{token:held.token,requestId:'uncertain'}),/历史待核对/);
  assert.deepEqual(reopened.state.jobs[0],raw);assert.equal(reopened.state.jobs.length,1);
  const clear={...current,count:2,slots:[{...slots[0],assets:[...slots[0].assets,draft.people[0]]},...current.slots.slice(1)]};
  const mixed=await reopened.previewBatchReplace(clear);
  assert.equal(mixed.unverified.length,1);assert.equal(mixed.freshCount,1);assert.equal(mixed.items[0].pictures[0].path,draft.people[0].path);
  const made=await reopened.enqueueBatchReplace(clear,{token:mixed.token,requestId:'clear-only'});
  assert.equal(made.jobIds.length,1);assert.equal(reopened.state.jobs.length,2);
  const knownJob=reopened.state.jobs.at(-1);
  assert.doesNotThrow(()=>assertReplacementRetry([knownJob],reopened.state.jobs[0]),'首14份输入有差别时不可误拦重试');
  const samePrefix={...knownJob,referencePaths:raw.referencePaths};
  assert.throws(()=>assertReplacementRetry([samePrefix],reopened.state.jobs[0]),/历史待核对/);

});
