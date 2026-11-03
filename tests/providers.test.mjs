import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runProvider,downloadMedia,sniffMedia,readOairegboxDashboard} from '../electron/providers.mjs';
import {h3Cost,OAIREGBOX_BASE,h3Model,h3ReferenceError} from '../shared/oairegbox.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEtcAAAAASUVORK5CYII=','base64');
function ctx(protocol='openai-images',fetch=async()=>new Response('{}'),model='gpt-image-2') {return {provider:{protocol,baseUrl:'https://test.invalid/v1',key:'test-secret-never-print',model,timeoutMs:1000},fetch};}
async function fixtures(fn) {const dir=await mkdtemp(path.join(tmpdir(),'ziyun-providers-'));try{const image=path.join(dir,'reference.png');const video=path.join(dir,'reference.mp4');await writeFile(image,png);await writeFile(video,Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0]));await fn({dir,image,video});}finally{await rm(dir,{recursive:true,force:true});}}
const response=x=>new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}});

test('OAIREGBOX reference limits enforce 503 and 913 and recommend an available matching Pro',()=>{
 const standard=h3Model('minimax-h3-768p'),pro=h3Model('minimax-h3-pro-768p');
 assert.equal(h3ReferenceError(standard,'reference',[...Array(5).fill('image'),...Array(3).fill('audio')]),'');
 assert.match(h3ReferenceError(standard,'reference',['video']),/minimax-h3-pro-768p/);
 assert.match(h3ReferenceError(standard,'reference',['video'],['minimax-h3-pro-2k']),/minimax-h3-pro-2k/);
 assert.match(h3ReferenceError(standard,'reference',Array(6).fill('image')),/本次共选了 6 张/);
 assert.equal(h3ReferenceError(pro,'reference',[...Array(9).fill('image'),'video',...Array(3).fill('audio')]),'');
 assert.match(h3ReferenceError(pro,'reference',['video','video']),/1 视频/);
 assert.match(h3ReferenceError(pro,'reference',['audio']),/至少 1 张参考图/);
 assert.match(h3ReferenceError(standard,'image',Array(3).fill('image')),/最多接受两张图片/);
});

test('OAIREGBOX H3 sends documented text, frame and Pro reference requests and resumes with the task ID',()=>fixtures(async({image,video})=>{
 const requests=[],ids=[];
 const context={...ctx('oairegbox-video',async(url,options)=>{
  assert.equal(options.headers.Authorization,'Bearer test-secret-never-print');
  assert.equal(new URL(url).origin,OAIREGBOX_BASE);
  requests.push(options.body?JSON.parse(options.body):new URL(url).pathname);
  return options.method==='GET'?response({status:'completed',video_url:'https://cdn.example.invalid/video.mp4'}):response({task_id:'task-a'});
 },'minimax-h3-pro-768p'),inspectDuration:async()=>3,onRemoteId:id=>ids.push(id)};
 context.provider.baseUrl=OAIREGBOX_BASE;
 const base={prompt:'测试',duration:10,resolution:'768P',ratio:'9:16'};
 await runProvider('videoSubmit',{...base,mode:'text'},context);
 await runProvider('videoSubmit',{...base,mode:'image',ratio:'source',referencePaths:[image,image]},context);
 await runProvider('videoSubmit',{...base,mode:'reference',referencePaths:[image,video]},context);
 assert.deepEqual(ids,['task-a','task-a','task-a']);
 assert.deepEqual(requests[0],{model:'minimax-h3-pro-768p',prompt:'测试',duration:10,ratio:'9:16'});
 assert.match(requests[1].first_image,/^data:image\/png;base64,/);
 assert.match(requests[1].last_image,/^data:image\/png;base64,/);
 assert.match(requests[2].referenceVideos[0],/^data:video\/mp4;base64,/);
 const standard={...context,provider:{...context.provider,model:'minimax-h3-768p'}};
 await assert.rejects(runProvider('videoSubmit',{...base,mode:'reference',referencePaths:[video]},standard),/minimax-h3-pro-768p/);
 await assert.rejects(runProvider('videoSubmit',{...base,mode:'reference',referencePaths:[video]},{...context,inspectDuration:async()=>9}),/2–5/);
 assert.deepEqual(await runProvider('videoPoll',{remoteId:'task-a'},context),{status:'succeeded',url:'https://cdn.example.invalid/video.mp4'});
 assert.equal(requests.at(-1),'/v1/videos/task-a');
 await runProvider('videoSubmit',{...base,mode:'text',duration:4,resolution:'2K'},{...context,provider:{...context.provider,model:'minimax-h3-pro-2k'}});
 assert.equal(requests.at(-1).duration,4);
 assert.equal(requests.at(-1).model,'minimax-h3-pro-2k');
 const failed=await runProvider('videoPoll',{remoteId:'task-a'},{...context,fetch:async()=>response({status:'failed',error:{message:'private'}})});
 assert.equal(failed.status,'failed');
 assert.doesNotMatch(failed.error,/private/);
}));

test('OAIREGBOX separates PAT and calling key, calculates second-based prices and sanitizes consumption records',async()=>{
 const keys={pricing:'Bearer account-private',models:'Bearer sk-call-private',usage:'Bearer sk-call-private',self:'Bearer account-private',logs:'Bearer account-private'};
 const fetch=async(url,{headers,method})=>{
  assert.equal(method,'GET');
  const route=new URL(url).pathname;
  const kind={'/api/pricing':'pricing','/v1/models':'models','/api/usage/token/':'usage','/api/user/self':'self','/api/log/self':'logs'}[route];
  assert.equal(headers.Authorization,keys[kind]);
  const fixtures={
   pricing:{data:[{model_name:'minimax-h3-768p',billing_unit:'second',model_price:.15},{model_name:'minimax-h3-2k',billing_unit:'token',model_price:9}],group_ratio:{minimax:1}},
   models:{data:[{id:'minimax-h3-768p'},{id:'unrelated'}]},
   usage:{data:{total_available:1000000,total_used:250000,unlimited_quota:false}},
   self:{data:{username:'studio',group:'minimax',quota:2750000,used_quota:750000,id:73}},
   logs:{data:{items:[{type:2,model_name:'minimax-h3-768p',quota:750000,created_at:1793664000,content:'private-prompt',token_name:'secret'}]}},
  };
  if(kind==='logs'){assert.equal(headers['New-Api-User'],'73');assert.equal(new URL(url).searchParams.get('type'),'2')}
  return response(fixtures[kind]);
 };
 const data=await readOairegboxDashboard({baseUrl:OAIREGBOX_BASE,key:'sk-call-private',accountToken:'account-private',fetch});
 assert.deepEqual(data.prices,{'minimax-h3-768p':.15});
 assert.equal(data.priceSource,'account');
 assert.deepEqual(h3Cost(data.prices['minimax-h3-768p'],10,3),{perVideo:1.5,total:4.5});
 assert.equal(data.account.balance,5.5);
 assert.equal(data.token.remaining,2);
 assert.deepEqual(data.logs,[{time:1793664000,model:'minimax-h3-768p',cost:1.5}]);
 assert.doesNotMatch(JSON.stringify(data),/private|secret/);
 await assert.rejects(readOairegboxDashboard({baseUrl:'https://api.oairegbox.cc.evil.invalid',accountToken:'secret',fetch}),/HTTPS/);
});

test('GPT Image 2.5 submits source and 3:4 edits with the requested model',()=>fixtures(async({image})=>{
  const portrait=Buffer.from(png);
  portrait.writeUInt32BE(1080,16);
  portrait.writeUInt32BE(2340,20);
  await writeFile(image,portrait);
  const sizes=[];
  const context=ctx('openai-images',async(_url,options)=>{
    assert.equal(options.body.get('model'),'gpt-image-2.5');
    sizes.push(options.body.get('size'));
    return response({data:[{b64_json:png.toString('base64')}]});
  },'gpt-image-2.5');
  for(const ratio of ['source','3:4']){
    await runProvider('image',{prompt:'参考布局',referencePaths:[image],ratio,resolution:'1K'},context);
  }
  assert.equal(sizes[1],'1152x1536');
  const [w,h]=sizes[0].split('x').map(Number);
  assert.ok(Math.abs(w/h-1080/2340)<0.01);
  assert.ok(w%16===0 && h%16===0 && w*h>=655360);
}));

test('describe sends actual image bytes and excludes user requested changes',()=>fixtures(async({image})=>{
  const context=ctx('openai-chat',async(url,options)=>{
    assert.equal(url,'https://test.invalid/v1/chat/completions');const body=JSON.parse(options.body);
    assert.equal(body.stream,false);const content=body.messages[0].content;
    assert.equal(content[1].image_url.url,`data:image/png;base64,${png.toString('base64')}`);
    assert(!JSON.stringify(body).includes('MODIFY_SECRET'));return response({choices:[{message:{content:'原图描述'}}]});
  },'vision-test');
  assert.deepEqual(await runProvider('describe',{referencePaths:[image],prompt:'MODIFY_SECRET',userPrompt:'MODIFY_SECRET'},context),{text:'原图描述'});
}));
test('plan supports normal text and explicit JSON output without changing payload',async()=>{
  const payload={prompt:'做三种文案',json:true};
  const result=await runProvider('plan',payload,ctx('openai-chat',async(url,o)=>{assert.deepEqual(JSON.parse(o.body).response_format,{type:'json_object'});return response({choices:[{message:{content:'{"prompts":[]}'}}]});},'chat-model'));
  assert.equal(result.text,'{"prompts":[]}');assert.equal(payload.prompt,'做三种文案');
});
test('read-only models check reaches service and reports actual model names without generation',async()=>{
  const context=ctx('openai-images',async(url,o)=>{assert.equal(url,'https://test.invalid/v1/models');assert.equal(o.method,'GET');assert.equal(o.body,undefined);return response({data:[{id:'gpt-image-2'},{id:'vision-model'}]});});
  const result=await runProvider('models',{},context);assert.deepEqual(result.models,['gpt-image-2','vision-model']);assert(result.text.includes('连接成功'));
});
test('reference edit uses real multipart image and fixed one-image slot',()=>fixtures(async({image})=>{
  const context=ctx('openai-images',async(url,o)=>{assert.equal(url,'https://test.invalid/v1/images/edits');assert(o.body instanceof FormData);assert(!o.headers['Content-Type']);assert.equal(o.body.get('n'),'1');assert.equal(o.body.get('size'),'864x1536');assert.deepEqual(Buffer.from(await o.body.get('image').arrayBuffer()),png);return response({data:[{b64_json:png.toString('base64')}]});});
  const r=await runProvider('image',{prompt:'保留构图，背景改蓝',referencePaths:[image],ratio:'9:16',resolution:'1K'},context);assert.equal(r.images[0].mime,'image/png');assert.deepEqual(r.images[0].bytes,png);assert.equal(r.images[0].requestedSize,'864x1536');assert.equal(r.images[0].actualSize,'1x1');assert(r.warning.includes('与请求'));
}));
test('text generation uses generations route; unsupported size rejects before any request',async()=>{
  let calls=0;const context=ctx('openai-images',async(url,o)=>{calls++;assert(url.endsWith('/images/generations'));assert.equal(JSON.parse(o.body).size,'2048x2048');return response({data:[{url:'https://media.invalid/image.png'}]});});
  assert.equal((await runProvider('image',{prompt:'风景',ratio:'1:1',resolution:'2K'},context)).images[0].url,'https://media.invalid/image.png');
  await assert.rejects(runProvider('image',{prompt:'风景',ratio:'7:3',resolution:'2K'},context),/比例/);assert.equal(calls,1);
  await assert.rejects(runProvider('image',{prompt:'风景',ratio:'9:16',resolution:'1K'}, {...context,provider:{...context.provider,model:'gpt-image-1'}}),/比例/);
});
test('MiniMax H3 V2 reference video carries bytes, roles and persists ID before returning',()=>fixtures(async({image,video})=>{
  const ids=[];const context=ctx('minimax-video',async(url,o)=>{assert.equal(url,'https://test.invalid/v2/video_generation');const b=JSON.parse(o.body);assert.equal(b.model,'MiniMax-H3');assert.equal(b.content[1].type,'image_url');assert.equal(b.content[1].role,'reference_image');assert(b.content[2].video_url.url.startsWith('data:video/mp4;base64,'));assert.equal(b.content[2].role,'reference_video');return response({task_id:'task_123'});},'MiniMax-H3');context.onRemoteId=async id=>ids.push(id);
  assert.deepEqual(await runProvider('videoSubmit',{mode:'reference',prompt:'参考运镜',referencePaths:[image,video],ratio:'9:16',duration:5,resolution:'768P'},context),{remoteId:'task_123'});assert.deepEqual(ids,['task_123']);
}));
test('H3 image mode rejects a fixed ratio instead of silently ignoring it',()=>fixtures(async({image})=>{
  let called=false;const context=ctx('minimax-video',async()=>{called=true;return response({});},'MiniMax-H3-Lite');
  await assert.rejects(runProvider('videoSubmit',{mode:'image',prompt:'镜头推进',referencePaths:[image],ratio:'9:16'},context),/原图比例/);assert.equal(called,false);
  await assert.rejects(runProvider('videoSubmit',{mode:'image',prompt:'镜头推进',referencePaths:[image],ratio:'source',resolution:'2K'},context),/分辨率/);
}));
test('Replicate H3 routes official model, actual video reference and poll response',()=>fixtures(async({video})=>{
  const context=ctx('replicate-video',async(url,o)=>{
    if(o.method==='POST') {assert.equal(url,'https://test.invalid/v1/models/minimax/h3-lite/predictions');const b=JSON.parse(o.body);assert(b.input.reference_video_urls[0].startsWith('data:video/mp4;base64,'));return response({id:'prediction_123'});}
    assert(url.endsWith('/v1/predictions/prediction_123'));return response({status:'succeeded',output:'https://media.invalid/out.mp4'});
  },'minimax/h3-lite');
  await runProvider('videoSubmit',{mode:'reference',prompt:'跟随动作',referencePaths:[video],ratio:'16:9',resolution:'480P'},context);
  assert.deepEqual(await runProvider('videoPoll',{remoteId:'prediction_123'},context),{status:'succeeded',url:'https://media.invalid/out.mp4'});
}));
test('MiniMax poll normalizes V2 task status and errors never include upstream secret text',async()=>{
  const context=ctx('minimax-video',async()=>response({task:{status:'succeeded',content:{url:'https://media.invalid/video.mp4'}}}),'MiniMax-H3');
  assert.equal((await runProvider('videoPoll',{remoteId:'123'},context)).status,'succeeded');
  context.fetch=async()=>response({task:{status:'failed',error:'test-secret-never-print'}});
  assert(!(await runProvider('videoPoll',{remoteId:'123'},context)).error.includes('test-secret-never-print'));
});
test('no automatic retry after submit network failure, HTTP 500 or invalid JSON',async()=>{
  for(const fetcher of [async()=>{throw new Error('test-secret-never-print');},async()=>new Response('test-secret-never-print',{status:500}),async()=>new Response('<html>test-secret-never-print</html>')]) {
    let calls=0;const context=ctx('openai-images',async(...args)=>{calls++;return fetcher(...args);});
    await assert.rejects(runProvider('image',{prompt:'风景',ratio:'1:1'},context),e=>e.code==='PROVIDER_UNKNOWN'&&e.unknown===true&&!e.message.includes('test-secret-never-print'));assert.equal(calls,1);
  }
});
test('malformed billable image response is unknown and cannot invite blind resubmission',async()=>{
  for(const data of [[{b64_json:'<invalid>'}],[{b64_json:Buffer.from('HTML error page').toString('base64')}],{unexpected:true},[{url:'file:///private-file.png'}]]) {
    let calls=0;const context=ctx('openai-images',async()=>{calls++;return response({data});});
    await assert.rejects(runProvider('image',{prompt:'风景',ratio:'1:1'},context),e=>e.unknown===true&&e.code==='PROVIDER_UNKNOWN');assert.equal(calls,1);
  }
});
test('accepted submissions remain unknown on declared/streamed size overflow and body read failure',async()=>{
  const oversized=96*1024*1024+1;
  const fetchers=[
    async()=>new Response('{}',{headers:{'content-length':String(oversized)}}),
    async()=>({ok:true,headers:new Headers(),body:{getReader:()=>({read:async()=>({done:false,value:{byteLength:oversized}}),cancel:async()=>{},releaseLock(){}})}}),
    async()=>new Response(new ReadableStream({start(controller){controller.error(new Error('test-secret-never-print'));}})),
    async()=>new Response(new ReadableStream({start(controller){controller.error(null);}})),
    async()=>response({error:{message:'test-secret-never-print'}}),
  ];
  for(const fetcher of fetchers)for(const operation of ['image','tts']){let calls=0;const context=ctx(operation==='image'?'openai-images':'openai-tts',async()=>{calls++;return fetcher();});await assert.rejects(runProvider(operation,{prompt:'风景',ratio:'1:1'},context),e=>e.unknown===true&&e.code==='PROVIDER_UNKNOWN'&&!e.message.includes('test-secret-never-print'));assert.equal(calls,1);}
});
test('video submit missing or invalid ID after HTTP 200 remains unknown',async()=>{
  for(const protocol of ['minimax-video','replicate-video'])for(const body of [{},{task_id:{bad:true},id:{bad:true}}]){
    let calls=0;const context=ctx(protocol,async()=>{calls++;return response(body);},protocol==='minimax-video'?'MiniMax-H3':'minimax/h3');
    await assert.rejects(runProvider('videoSubmit',{mode:'text',prompt:'镜头推进',ratio:'16:9',duration:5,resolution:'768P'},context),e=>e.unknown===true&&e.code==='PROVIDER_UNKNOWN');assert.equal(calls,1);
  }
});
test('pre-submit validation and definite HTTP rejection remain ordinary failures',async()=>{
  let calls=0;const context=ctx('openai-images',async()=>{calls++;return {ok:false,status:400,body:{cancel:async()=>{throw new Error('test-secret-never-print');}}};});
  await assert.rejects(runProvider('image',{prompt:'风景',ratio:'7:3'},context),e=>!e.unknown&&e.code==='PROVIDER_ERROR');assert.equal(calls,0);
  await assert.rejects(runProvider('image',{prompt:'风景',ratio:'1:1'},context),e=>!e.unknown&&e.code==='PROVIDER_HTTP'&&e.status===400);assert.equal(calls,1);
});
test('authentication failures suppress untrusted body and caller abort prevents submission',async()=>{
  const context=ctx('openai-chat',async()=>new Response('echo Authorization Bearer test-secret-never-print',{status:401}),'chat');
  await assert.rejects(runProvider('plan',{prompt:'测试'},context),e=>e.status===401&&!e.message.includes('test-secret'));
  const controller=new AbortController();controller.abort();let calls=0;context.signal=controller.signal;context.fetch=async()=>{calls++;};
  await assert.rejects(runProvider('plan',{prompt:'测试'},context),e=>e.code==='ABORT_ERR');assert.equal(calls,0);
});
test('in-flight caller abort is forwarded and ambiguous image submission remains unknown',async()=>{
  const controller=new AbortController();let calls=0;
  const context=ctx('openai-images',async(url,o)=>{calls++;assert(o.signal instanceof AbortSignal);return new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});setImmediate(()=>controller.abort());});});
  context.signal=controller.signal;
  await assert.rejects(runProvider('image',{prompt:'风景',ratio:'1:1'},context),e=>e.unknown===true&&e.code==='PROVIDER_UNKNOWN');assert.equal(calls,1);
});
test('TTS returns real MP3; a JSON/html response never becomes audio',async()=>{
  const context=ctx('openai-tts',async(url,o)=>{assert(url.endsWith('/audio/speech'));assert.equal(JSON.parse(o.body).input,'你好');return new Response(Buffer.from('ID3real-mp3-fixture'));},'tts-test');
  assert.equal((await runProvider('tts',{prompt:'你好'},context)).mime,'audio/mpeg');
  context.fetch=async()=>new Response('{"error":"no audio"}');await assert.rejects(runProvider('tts',{prompt:'你好'},context),/文件内容/);
});
test('media download omits API credential, rejects content overflow and wrong file magic',async()=>{
  const out=await downloadMedia('https://media.invalid/out.png',{kind:'image',fetch:async(url,o)=>{assert.deepEqual(o.headers,{});assert.equal(o.method,'GET');return new Response(png);}});assert.equal(out.mime,'image/png');
  await assert.rejects(downloadMedia('https://media.invalid/out.png',{maxBytes:2,fetch:async()=>new Response(png)}),/上限/);
  await assert.rejects(downloadMedia('https://media.invalid/out.png',{fetch:async()=>new Response('<html>failed</html>')}),/文件内容/);
  assert.throws(()=>sniffMedia(Buffer.from('not an image')),/文件内容/);
});

test('video download tolerates slow continuous data and times out on a stalled transfer',async()=>{
  const data=Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109]);
  const fetch=(_url,{signal})=>{
    let timer;
    return new Response(new ReadableStream({
      start(controller){
        controller.enqueue(data);
        let left=3;
        timer=setInterval(()=>{
          controller.enqueue(Buffer.from([0]));
          if(!--left){clearInterval(timer);controller.close();}
        },40);
        signal.addEventListener('abort',()=>{clearInterval(timer);controller.error(signal.reason);},{once:true});
      },
      cancel(){clearInterval(timer);}
    }));
  };
  const url='https://media.invalid/out.mp4';
  assert.equal((await downloadMedia(url,{kind:'video',idleTimeoutMs:100,fetch})).bytes.length,15);
  await assert.rejects(downloadMedia(url,{kind:'video',idleTimeoutMs:15,fetch}),e=>e.code==='PROVIDER_DOWNLOAD_IDLE');
});
