import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {H3_MODELS,OAIREGBOX_BASE,OAIREGBOX_CONSOLE} from '../shared/oairegbox.mjs';
import {H3_PROMPT_SECTIONS} from '../shared/prompt-rules.mjs';
import {runMedia} from '../electron/render.mjs';

const root=path.resolve('.');
const {version}=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const out=path.join(root,'test-output',`oairegbox-${version}`);
await fs.mkdir(out,{recursive:true});
const data=await fs.mkdtemp(path.join(out,'isolated-'));
const env={...process.env,ZIYUN_DATA_DIR:data,ZIYUN_SMOKE:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.ZIYUN_TEST_EXE||createRequire(import.meta.url)('electron');
const app=await electron.launch({executablePath:executable,args:process.env.ZIYUN_TEST_EXE?[]:[root],env,timeout:60000});
const videoKey='sk-oairegbox-fixture',pat='oairegbox-fixture-account';
const basePrompt='integrated_multimodal_description: [Shot 1] A green paper card turns slowly.\noverall_soundscape: A faint paper rustle.\nnon_diegetic_music: N/A';
const refPrompt=H3_PROMPT_SECTIONS.reference.map(section=>section+': Fixture for <Picture 1>, <Video 1> and <Audio 1>.').join('\n');
try{
 assert.equal(await app.evaluate(({app})=>app.getVersion()),version);
 await app.evaluate(({shell,dialog,net},{models,base,videoKey,pat,basePrompt,refPrompt})=>{
  globalThis.capture={urls:[],posts:[],rewrites:[]};
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:globalThis.capture.files||[]});
  shell.openExternal=async url=>{globalThis.capture.urls.push(url)};
  const replies={
   '/api/pricing':{data:models.map(m=>({model_name:m.id,billing_unit:'second',model_price:m.price})),group_ratio:{minimax:1}},
   '/v1/models':{data:models.map(m=>({id:m.id}))},
   '/api/usage/token/':{data:{total_available:1500000,total_used:250000,unlimited_quota:false}},
   '/api/user/self':{data:{username:'验收账号',quota:2750000,used_quota:750000,group:'minimax',id:1}},
   '/api/log/self':{data:{items:[{type:2,model_name:'minimax-h3-768p',quota:750000,created_at:1793664000,content:'fixture-content'}]}},
   '/v1/videos':{task_id:'fixture-video'},
   '/v1/videos/fixture-video':{status:'completed',video_url:base+'/fixture.mp4'},
  };
  globalThis.fetch=async(input,options={})=>{
   const url=new URL(input);
   if(url.origin!==base)return new Response('',{status:404});
   const auth=options.headers?.Authorization;
   const privateAccount=/^\/api\/(user|log)\//.test(url.pathname);
   if(url.pathname!=='/api/pricing'&&auth!=='Bearer '+(privateAccount?pat:videoKey))return new Response('',{status:401});
   if(url.pathname==='/v1/chat/completions'){
    const body=JSON.parse(options.body);
    globalThis.capture.rewrites.push(body);
    const input=JSON.parse(body.messages[1].content);
    const content=input.生成模式==='reference'?refPrompt:input.生成模式?basePrompt:input.补充方向?'将数字改为 800，其余保持原样。':'只调整指定的数字，保留其余内容。';
    return new Response(JSON.stringify({choices:[{message:{content}}]}));
   }
   if(options.method==='POST')globalThis.capture.posts.push(JSON.parse(options.body));
   return new Response(JSON.stringify(replies[url.pathname]||{}));
  };
  net.fetch=async(input,options={})=>{
   if(input!==base+'/fixture.mp4'||options.method!=='GET'||options.credentials!=='omit'||Object.keys(options.headers).length)return new Response('',{status:403});
   await new Promise(resolve=>setTimeout(resolve,2300));
   return new Response(Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,0,0,0,0,0,0,0,0]));
  };
 },{models:H3_MODELS,base:OAIREGBOX_BASE,videoKey,pat,basePrompt,refPrompt});
 const page=await app.firstWindow();
 const errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const button=name=>page.getByRole('button',{name,exact:true});
 const call=(method,...args)=>page.evaluate(([method,args])=>window.studio.call(method,...args),[method,args]);
 await button('全局设置').click();
 for(const label of ['OAIREGBOX 官网','注册账号','创建 API 令牌','充值中心'])await button(label).click();
 assert.deepEqual(await app.evaluate(()=>globalThis.capture.urls),['/','/register','/console/token','/console/topup'].map(route=>OAIREGBOX_CONSOLE+route));
 await button('新增连接').click();
 await page.getByLabel('连接名称',{exact:true}).fill('H3 验收连接');
 await page.getByLabel('接口协议',{exact:true}).selectOption('oairegbox-video');
 assert.equal(await page.getByLabel('接口基础地址',{exact:true}).inputValue(),OAIREGBOX_BASE);
 await page.getByLabel('API Key',{exact:true}).fill(videoKey);
 await page.getByLabel('OAIREGBOX 账号访问令牌',{exact:true}).fill(pat);
 await button('获取模型').click();
 await page.getByLabel('模型名称',{exact:true}).selectOption('minimax-h3-768p');
 await button('安全保存连接').click();
 await page.getByLabel('视频生成连接').selectOption({label:'H3 验收连接 · minimax-h3-768p'});
 await button('刷新账户与用量').click();
 await page.getByText('验收账号',{exact:true}).waitFor();
 await page.getByText('¥5.50',{exact:true}).waitFor();
 await page.getByRole('heading',{name:'最近消费记录'}).waitFor();
 await button('平台消费明细').click();
 assert.equal(await app.evaluate(()=>globalThis.capture.urls.at(-1)),OAIREGBOX_CONSOLE+'/console/log');
 await call('saveProvider',{id:'rewrite-fixture',name:'测试语言模型',protocol:'openai-chat',baseUrl:OAIREGBOX_BASE,model:'fixture-chat',key:videoKey});
 await page.getByLabel('提示词语言模型连接').selectOption('rewrite-fixture');
 await button('生图优化规则').click();
 await page.getByLabel('一键优化系统提示词',{exact:true}).fill('验收自定义规则');
 await button('保存优化规则').click();
 const template={id:'fixture-rule',name:'验收规范',text:'保留原图布局'};
 await call('updateSettings',{templates:[template]});
 await call('saveRow',{id:'rewrite-row',name:'优化验收',referencePrompt:'原图是青色卡片',userPrompt:'调整数字',templateId:template.id});
 await button('01 图片素材').click();
 const requirements=page.getByLabel('用户要求',{exact:true});
 await button('一键优化').click();
 await page.getByRole('dialog',{name:'优化后的用户要求'}).waitFor();
 assert.equal(await requirements.inputValue(),'调整数字');
 await button('使用此提示词').click();
 assert.equal(await requirements.inputValue(),'只调整指定的数字，保留其余内容。');
 await button('带要求的优化').click();
 await page.getByLabel('本次优化方向').fill('把数字固定为 800');
 await button('开始优化').click();
 await button('使用此提示词').click();
 assert.equal(await requirements.inputValue(),'将数字改为 800，其余保持原样。');
 await button('保存本行').click();
 await page.getByText('当前行已保存',{exact:true}).waitFor();
 await button('02 视频开头').click();
 assert.equal(await button('充值中心').count(),0);
 assert.equal(await button('平台消费明细').count(),0);
 await page.getByLabel('视频时长',{exact:true}).fill('10');
 await page.getByLabel('视频生成数量',{exact:true}).fill('3');
 const estimate=page.getByRole('region',{name:'视频费用估算'});
 await estimate.getByText('¥0.15/秒',{exact:true}).waitFor();
 await estimate.getByText('¥1.50',{exact:true}).waitFor();
 await estimate.getByText('¥4.50',{exact:true}).waitFor();
 await page.getByRole('button',{name:/参考生视频/}).click();
 const modelPicker=page.getByLabel('OAIREGBOX H3 型号',{exact:true});
 const warning=page.getByRole('dialog',{name:'参考素材超出型号支持范围'});
 const ffmpeg=path.join(root,'runtime','ffmpeg.exe');
 const clip=path.join(data,'fixture-reference.mp4'),image=path.join(data,'fixture-reference.png'),audio=path.join(data,'fixture-reference.wav');
 await runMedia(ffmpeg,['-loglevel','error','-y','-f','lavfi','-i','color=c=green:s=320x240:d=3','-c:v','libx264','-pix_fmt','yuv420p',clip]);
 await runMedia(ffmpeg,['-loglevel','error','-y','-i',clip,'-frames:v','1',image]);
 await runMedia(ffmpeg,['-loglevel','error','-y','-f','lavfi','-i','sine=duration=2',audio]);
 await app.evaluate((_electron,files)=>{globalThis.capture.files=files},[clip,image,audio]);
 await button('添加参考素材').click();
 await warning.getByText(/minimax-h3-768p 不支持参考视频.*minimax-h3-pro-768p/).waitFor();
 await warning.getByRole('button',{name:'知道了'}).click();
 assert.equal(await button('放大 fixture-reference.mp4').count(),0);
 await modelPicker.selectOption('minimax-h3-pro-768p');
 await button('添加参考素材').click();
 await button('放大 fixture-reference.mp4').waitFor();
 const previewGrid=page.locator('.video-reference-grid');
 assert.equal(await previewGrid.locator('article').count(),3);
 for(const name of ['video','audio']){
  const player=previewGrid.locator(name);
  await player.evaluate(async el=>{await el.play()});
  await page.waitForFunction(tag=>document.querySelector('.video-reference-grid '+tag).currentTime>0,name);
  await player.evaluate(el=>el.pause());
 }
 await button('放大 fixture-reference.png').click();
 await page.getByTestId('image-viewer').waitFor();
 await page.waitForFunction(()=>document.querySelector('.viewer-stage img').naturalWidth===320);
 await button('关闭图片查看器').click();
 await button('放大 fixture-reference.mp4').click();
 await page.getByRole('dialog',{name:'fixture-reference.mp4'}).waitFor();
 await button('关闭弹窗').click();
 await page.getByLabel('视频内容描述',{exact:true}).fill('参照素材制作开头');
 await button('H3 官方模板').click();
 await page.getByRole('dialog',{name:'MiniMax H3 官方模板'}).getByText(/subject_definitions/).waitFor();
 await button('关闭弹窗').click();
 await button('转换为 MiniMax H3 提示词').click();
 await button('使用此提示词').click();
 assert.equal(await page.getByLabel('视频内容描述',{exact:true}).inputValue(),refPrompt);
 await modelPicker.selectOption('minimax-h3-768p');
 await warning.getByText(/不支持参考视频/).waitFor();
 assert.equal(await modelPicker.inputValue(),'minimax-h3-pro-768p');
 await page.screenshot({path:path.join(out,'model-reference-warning.png')});
 await warning.getByRole('button',{name:'知道了'}).click();
 await page.getByRole('button',{name:/文生视频/}).click();
 await page.getByLabel('OAIREGBOX H3 型号',{exact:true}).selectOption('minimax-h3-pro-2k');
 await estimate.getByText('¥9.90',{exact:true}).waitFor();
 await page.screenshot({path:path.join(out,'pricing-and-account.png')});
 await page.getByLabel('视频生成数量',{exact:true}).fill('1');
 await page.getByLabel('视频内容描述',{exact:true}).fill('验收用模拟视频');
 await button('转换为 MiniMax H3 提示词').click();
 await button('使用此提示词').click();
 await button('加入视频生成队列').click();
 const savingClock=page.locator('.status-saving .job-clock');
 await savingClock.waitFor();
 await page.waitForFunction(()=>/已用 00:0[1-9]/.test(document.querySelector('.status-saving .job-clock')?.textContent||''));
 let state;
 for(let n=0;n<80;n++){
  state=await call('getState');
  if(state.jobs.some(j=>j.kind==='video'&&j.status==='succeeded'))break;
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 assert.equal(state.jobs[0]?.status,'succeeded',state.jobs[0]?.error);
 assert.ok(Date.parse(state.jobs[0].finishedAt)>Date.parse(state.jobs[0].startedAt));
 assert.match(await page.locator('.status-succeeded .image-elapsed').innerText(),/用时 00:0[1-9]/);
 assert.equal(state.jobs[0].remoteId,'fixture-video');
 assert.equal(state.jobs[0].snapshot.provider.model,'minimax-h3-pro-2k');
 assert.deepEqual(await app.evaluate(()=>globalThis.capture.posts),[{model:'minimax-h3-pro-2k',prompt:basePrompt,duration:10,ratio:'9:16'}]);
 const rewrites=await app.evaluate(()=>globalThis.capture.rewrites);
 assert.equal(rewrites.length,4);
 assert.ok(rewrites.every(request=>request.model==='fixture-chat'&&request.messages[0].role==='system'));
 assert.equal(rewrites[0].messages[0].content,'验收自定义规则');
 assert.equal(JSON.parse(rewrites[0].messages[1].content).项目规范,template.text);
 assert.equal(JSON.parse(rewrites[0].messages[1].content).参考提示词,'原图是青色卡片');
 assert.equal(JSON.parse(rewrites[1].messages[1].content).补充方向,'把数字固定为 800');
 assert.deepEqual(JSON.parse(rewrites[2].messages[1].content).参考素材.map(item=>item.label),['<Video 1>','<Picture 1>','<Audio 1>']);
 assert.doesNotMatch(rewrites[2].messages[1].content,/isolated-/);
 assert.doesNotMatch(JSON.stringify(state),/sk-oairegbox-fixture|oairegbox-fixture-account/);
 assert.doesNotMatch(await fs.readFile(path.join(data,'credentials.dpapi.json'),'utf8'),/sk-oairegbox-fixture|oairegbox-fixture-account/);
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({version,passed:true,packaged:Boolean(process.env.ZIYUN_TEST_EXE),fixtureCostPerVideo:1.5,fixtureBatchCost:4.5,accountAndLogs:'fixture',videoSubmission:'fixture',registrationLinks:true,referenceValidationDialog:true},null,2));
 console.log('OAIREGBOX_VERIFICATION_PASS');
}finally{await app.close()}
