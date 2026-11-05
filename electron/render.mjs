import {spawn} from 'node:child_process';
import fs, {constants} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {normalizeTimeline,timelineDuration} from '../shared/timeline.mjs';

export async function resolveFfmpeg(root, userData) {
 const binary=process.platform==='win32'?'ffmpeg.exe':'ffmpeg';
 const local=path.join(root,'runtime',binary);
 const configured=process.env.ZIYUN_FFMPEG_PATH;
 const candidates=[
  configured&&path.isAbsolute(configured)&&configured,
  local,userData&&path.join(userData,'runtime',binary),
  '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg','/usr/local/opt/ffmpeg-full/bin/ffmpeg',
  '/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg',
 ];
 for(const candidate of candidates.filter(Boolean)){
  try{await fs.access(candidate,process.platform==='win32'?constants.F_OK:constants.X_OK);return candidate}catch{}
 }
 return 'ffmpeg';
}

export async function runMedia(executable,args,{cwd,signal,allowFailure=false}={}){
 if(signal?.aborted)throw new Error('视频合成已停止。');
 return new Promise((resolve,reject)=>{const child=spawn(executable,args,{cwd,windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-12000);});const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});child.on('error',()=>{signal?.removeEventListener('abort',abort);reject(new Error('视频合成器无法启动，请重新安装工具。'));});child.on('close',code=>{signal?.removeEventListener('abort',abort);if(signal?.aborted)return reject(new Error('视频合成已停止。'));if(code!==0&&!allowFailure)return reject(new Error(`视频处理失败：${stderr.split('\n').filter(Boolean).slice(-3).join(' ').slice(0,500)}`));resolve({code,stderr});});});
}
export async function mediaDuration(ffmpeg,file,signal){const {stderr}=await runMedia(ffmpeg,['-hide_banner','-i',file],{signal,allowFailure:true});const m=/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);if(!m)throw new Error(`无法读取素材时长：${path.basename(file)}`);const seconds=Number(m[1])*3600+Number(m[2])*60+Number(m[3]);if(!Number.isFinite(seconds)||seconds<=0)throw new Error('素材没有有效时长。');return seconds;}
function stamp(seconds){const ms=Math.max(0,Math.round(seconds*1000));return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;}
export function subtitleCues(text,duration,offset=0){const parts=String(text||'').replace(/\r/g,'').split(/(?<=[。！？!?；;，,])|\n/).map(s=>s.trim()).filter(Boolean).flatMap(s=>Array.from({length:Math.ceil(s.length/22)},(_,i)=>s.slice(i*22,(i+1)*22)));if(!parts.length)return[];const total=parts.reduce((n,s)=>n+s.length,0);let cursor=offset;return parts.map((t,i)=>{const end=i===parts.length-1?offset+duration:cursor+duration*t.length/total;const c={text:t,start:cursor,end};cursor=end;return c;});}
export function toSrt(cues){return cues.map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');}
const IMAGE=/\.(png|jpe?g|webp|gif|bmp)$/i;
const frameFilter=(width,height)=>`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30`;
const frameSize=ratio=>ratio==='16:9'?[1920,1080]:ratio==='1:1'?[1080,1080]:[1080,1920];
const subtitleStyle=size=>`FontName=${process.platform==='darwin'?'PingFang SC':'Microsoft YaHei'},FontSize=${size},PrimaryColour=&H00FFFFFF,OutlineColour=&H00202020,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=54`;

function montageTimeline(ratio,segments,cues) {
 const clips=[];
 for(const segment of segments){
  let start=segment.start;
  for(const [i,file] of segment.paths.entries()){
   const duration=segment.allocations?.[i]??segment.duration/segment.paths.length;
   if(duration>=.001)clips.push({id:randomUUID(),track:'picture',start,duration,path:file,sourceIn:0});
   start+=duration;
  }
  clips.push({id:randomUUID(),track:'voice',start:segment.start,duration:segment.duration,path:segment.audioPath,sourceIn:0,volume:1});
 }
 for(const cue of cues)if(cue.end-cue.start>=.001)clips.push({id:randomUUID(),track:'subtitle',start:cue.start,duration:cue.end-cue.start,text:cue.text});
 return {ratio,fontSize:ratio==='16:9'?24:30,clips};
}

export async function readMontageTimeline(job,ffmpeg) {
 const ratio=job.snapshot?.config?.ratio||'9:16';
 const manifest=await fs.readFile(job.localPath.replace(/\.mp4$/i,'.json'),'utf8').then(JSON.parse).catch(()=>null);
 if(manifest?.timeline)return manifest.timeline;
 const originalFiles=manifest?.segments?.flatMap(segment=>[...(segment.paths||[]),segment.audioPath]);
 if(originalFiles?.length&&(await Promise.all(originalFiles.map(file=>fs.stat(file).then(stat=>stat.isFile()).catch(()=>false)))).every(Boolean)){
  const segments=manifest.segments;
  if(job.snapshot?.config?.openingPath&&segments[0].paths.length>1){
   const first=segments[0];
   const head=Math.min(first.duration,await mediaDuration(ffmpeg,first.paths[0]).catch(()=>first.duration/first.paths.length));
   first.allocations=[head,...first.paths.slice(1).map(()=>(first.duration-head)/(first.paths.length-1))];
  }
  let cues=[];
  if(job.snapshot?.config?.subtitle!==false){
   const srt=await fs.readFile(job.localPath.replace(/\.mp4$/i,'.srt'),'utf8').catch(()=>'');
   const seconds=value=>value.split(/[:,]/).reduce((time,part,i)=>time+Number(part)*[3600,60,1,.001][i],0);
   cues=srt.trim().split(/\r?\n\r?\n/).flatMap(cue=>{
    const [,range,...text]=cue.split(/\r?\n/);
    const times=range?.match(/^(\d+:\d+:\d+,\d+) --> (\d+:\d+:\d+,\d+)$/);
    return times?[{start:seconds(times[1]),end:seconds(times[2]),text:text.join('\n')}]:[];
   });
   if(!cues.length)cues=segments.flatMap(s=>subtitleCues(s.text,s.duration,s.start));
  }
  return montageTimeline(ratio,segments,cues);
 }
 const duration=await mediaDuration(ffmpeg,job.localPath);
 const clips=[{id:randomUUID(),track:'picture',start:0,duration,path:job.localPath,sourceIn:0}];
 const {stderr}=await runMedia(ffmpeg,['-hide_banner','-i',job.localPath],{allowFailure:true});
 if(/Stream .*Audio:/.test(stderr))clips.push({id:randomUUID(),track:'voice',start:0,duration,path:job.localPath,sourceIn:0,volume:1});
 return {ratio,fontSize:30,clips,flattened:true};
}

async function renderTimeline(config,ffmpeg,{signal,onProgress}){
 const timeline=normalizeTimeline(config.timeline);
 const duration=timelineDuration(timeline.clips);
 const pictures=timeline.clips.filter(c=>c.track==='picture').sort((a,b)=>a.start-b.start);
 if(!pictures.length)throw new Error('请至少保留一个画面片段。');
 const [width,height]=frameSize(timeline.ratio);
 const base=path.resolve(config.outputDir);
 const id=String(config.jobId||randomUUID()).replace(/[^a-zA-Z0-9_-]/g,'_');
 const work=path.join(base,`work_${id}`);
 await fs.mkdir(work,{recursive:true});
 const args=['-hide_banner','-loglevel','error','-y'];
 const files=[];
 const renderPicture=async(clip,frames)=>{
  if(frames<1)return;
  const file=`frame_${files.length}.mp4`;
  const input=!clip?['-f','lavfi','-i',`color=c=black:s=${width}x${height}:r=30`]:IMAGE.test(clip.path)?
   ['-loop','1','-i',clip.path]:['-stream_loop','-1','-ss',String(clip.sourceIn),'-i',clip.path];
  await runMedia(ffmpeg,[...args,...input,'-frames:v',String(frames),'-vf',frameFilter(width,height),'-an','-c:v','libx264','-preset','veryfast','-crf','21','-pix_fmt','yuv420p',file],{cwd:work,signal});
  files.push(file);
 };
 let cursor=0;
 for(const [i,clip] of pictures.entries()){
  const first=Math.round(clip.start*30),last=Math.round((clip.start+clip.duration)*30);
  await renderPicture(null,first-cursor);
  await renderPicture(clip,last-first);
  cursor=last;
  onProgress?.({stage:'rendering',completed:i+1,total:pictures.length});
 }
 await renderPicture(null,Math.ceil(duration*30)-cursor);
 await fs.writeFile(path.join(work,'frames.txt'),files.map(file=>`file '${file}'`).join('\n'));
 const output=path.join(base,`${id}.mp4`);
 const subtitlePath=path.join(base,`${id}.srt`);
 const subtitles=timeline.clips.filter(c=>c.track==='subtitle').sort((a,b)=>a.start-b.start);
 const srt=toSrt(subtitles.map(c=>({start:c.start,end:c.start+c.duration,text:c.text})));
 await fs.writeFile(subtitlePath,srt,'utf8');
 if(subtitles.length)await fs.writeFile(path.join(work,'subtitles.srt'),srt,'utf8');
 const audio=timeline.clips.filter(c=>c.track==='voice'||c.track==='music');
 const audioInputs=[];
 for(const [i,c] of audio.entries()){
  const file=`audio_${i}.wav`;
  await runMedia(ffmpeg,[...args,'-ss',String(c.sourceIn),'-i',c.path,'-map','0:a:0','-t',String(c.duration),'-ar','48000','-ac','2','-c:a','pcm_s16le',file],{cwd:work,signal});
  audioInputs.push('-i',file);
 }
 const filters=audio.map((c,i)=>`[${i+1}:a:0]volume=${c.volume},adelay=${Math.round(c.start*1000)}:all=1[a${i}]`);
 if(audio.length)filters.push(`${audio.map((_,i)=>`[a${i}]`).join('')}amix=inputs=${audio.length}:normalize=0:dropout_transition=0,alimiter=latency=1,apad[aout]`);
 // Filter scripts avoid Windows' command-line limit on projects with many audio clips.
 if(audio.length)await fs.writeFile(path.join(work,'audio.txt'),filters.join(';'),'utf8');
 await runMedia(ffmpeg,[...args,'-f','concat','-safe','1','-i','frames.txt',...audioInputs,
  ...(audio.length?['-filter_complex_script','audio.txt','-map','[aout]','-c:a','aac','-b:a','160k']:[]),'-map','0:v:0',
  ...(subtitles.length?['-vf',`subtitles=subtitles.srt:force_style='${subtitleStyle(timeline.fontSize)}'`,'-c:v','libx264','-preset','veryfast','-crf','21']:['-c:v','copy']),
  '-t',String(duration),'-movflags','+faststart',output],{cwd:work,signal});
 await fs.writeFile(path.join(base,`${id}.json`),JSON.stringify({timeline},null,2),'utf8');
 return {localPath:output,subtitlePath,timeline,width,height,duration};
}

function audioCues(cues, text, duration) {
 let subdivided=false;
 const valid=(Array.isArray(cues)?cues:[]).filter(c=>typeof c.text==='string'&&c.text.trim()&&Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.start>=0&&c.end>c.start&&c.start<duration).sort((a,b)=>a.start-b.start).flatMap(cue=>{
  if(cue.text.length<=22)return [cue];
  subdivided=true;
  const parts=Array.from({length:Math.ceil(cue.text.length/22)},(_,index)=>cue.text.slice(index*22,(index+1)*22));
  let at=cue.start;
  return parts.map((part,index)=>{
   const end=index===parts.length-1?cue.end:at+(cue.end-cue.start)*part.length/cue.text.length;
   const result={text:part,start:at,end};at=end;return result;
  });
 });
 if(!valid.length)return {cues:subtitleCues(text,duration),estimated:true};
 const grouped=[];
 let current;
 for(const cue of valid){
  const end=Math.min(duration,cue.end);
  if(current&&(current.text.length+cue.text.length>22||cue.start-current.end>.6)){
   grouped.push(current);current=null;
  }
  if(!current)current={text:'',start:cue.start,end};
  current.text+=cue.text;current.end=end;
  if(/[。！？!?；;，,]$/.test(current.text)){grouped.push(current);current=null;}
 }
 if(current)grouped.push(current);
 let previous=0;
 for(const cue of grouped){cue.start=Math.max(previous,cue.start);previous=cue.end;}
 return {cues:grouped.filter(c=>c.end-c.start>=.001),estimated:subdivided};
}

async function plannedAudio(segment,config,context,ffmpeg,work,index){
 let audioPath=segment.audioPath;
 let cues=segment.audioCues||segment.cues;
 if(!audioPath){
  if(!context.providerRunner)throw new Error('请先生成配音或导入音频。');
  const options={voice:config.voice||'alloy',...(config.voiceOptions||{})};
  const result=await context.providerRunner('tts',{...options,prompt:segment.text});
  audioPath=result.localPath;
  cues=result.segments;
  if(!audioPath){
   audioPath=path.join(work,`planned_voice_${index}.${result.mime==='audio/wav'?'wav':'mp3'}`);
   await fs.writeFile(audioPath,Buffer.from(result.bytes||[]));
  }
 }
 const duration=await mediaDuration(ffmpeg,audioPath,context.signal);
 if(duration>600)throw new Error('单段音频超过10分钟，请分段后再混剪。');
 return {audioPath,duration,...audioCues(cues,segment.text,duration)};
}

export async function prepareMontageTimeline(config,context,ffmpeg){
 const ratio=config.ratio||'9:16';
 if(!['9:16','16:9','1:1'].includes(ratio))throw new Error('混剪输出比例暂支持9:16、16:9、1:1。');
 const base=path.resolve(config.outputDir);
 const id=String(config.jobId||randomUUID()).replace(/[^a-zA-Z0-9_-]/g,'_');
 const work=path.join(base,`work_${id}`);
 await fs.mkdir(work,{recursive:true});
 const clips=[];
 const prepared=[];
 let offset=0,estimated=false;
 if(config.openingPath&&config.openingAudioMode==='original'){
  const duration=await mediaDuration(ffmpeg,config.openingPath,context.signal);
  const info=await runMedia(ffmpeg,['-hide_banner','-i',config.openingPath],{signal:context.signal,allowFailure:true});
  if(!/Stream .*Audio:/.test(info.stderr))throw new Error('所选片头没有原声音轨，请改用纯画面模式。');
  clips.push({id:randomUUID(),track:'picture',start:0,duration,path:config.openingPath,sourceIn:0});
  clips.push({id:randomUUID(),track:'voice',start:0,duration,path:config.openingPath,sourceIn:0,volume:1});
  if(config.subtitle!==false&&config.openingText){
   const opening=audioCues(config.openingCues,config.openingText,duration);estimated ||= opening.estimated;
   for(const cue of opening.cues)clips.push({id:randomUUID(),track:'subtitle',start:cue.start,duration:cue.end-cue.start,text:cue.text});
  }
  offset=duration;
 }
 const bodyStart=offset;
 let master;
 if(config.masterAudioPath){
  const duration=await mediaDuration(ffmpeg,config.masterAudioPath,context.signal);
  master={duration,...audioCues(config.masterCues,config.masterText||config.segments.map(segment=>segment.text).join(''),duration)};
  estimated ||= master.estimated;
  clips.push({id:randomUUID(),track:'voice',start:bodyStart,duration,path:config.masterAudioPath,sourceIn:0,volume:1});
 }
 const declared=config.segments.reduce((total,segment)=>total+(Number(segment.duration)||0),0);
 const declaredMaster=master&&config.segments.every(segment=>Number(segment.duration)>0)&&Math.abs(declared-master.duration)<.15;
 const textLength=config.segments.reduce((total,segment)=>total+String(segment.text||'').length,0);
 for(const [index,segment] of config.segments.entries()){
  if(!segment.text?.trim())throw new Error(`第${index+1}段缺少文案。`);
  const audio=master?{audioPath:config.masterAudioPath,duration:declaredMaster?Number(segment.duration):master.duration*segment.text.length/textLength,cues:[],estimated:!declaredMaster}:await plannedAudio(segment,config,context,ffmpeg,work,index);
  if(master&&!declaredMaster)estimated=true;
  if(!master){
   estimated ||= audio.estimated;
   clips.push({id:randomUUID(),track:'voice',start:offset,duration:audio.duration,path:audio.audioPath,sourceIn:0,volume:1});
   if(config.subtitle!==false)for(const cue of audio.cues)clips.push({id:randomUUID(),track:'subtitle',start:offset+cue.start,duration:cue.end-cue.start,text:cue.text});
  }
  let shots=segment.shots?.length?segment.shots.map(shot=>({...shot})):Array.from(new Set(segment.paths||[])).map(file=>({path:file,sourceIn:0,duration:audio.duration/(new Set(segment.paths||[]).size)}));
  if(!shots.length)throw new Error(`第${index+1}段没有已确认的镜头。`);
  if(index===0&&config.openingPath&&config.openingAudioMode!=='original'){
   const head=Math.min(audio.duration,await mediaDuration(ffmpeg,config.openingPath,context.signal));
   shots=shots.filter(shot=>path.resolve(shot.path)!==path.resolve(config.openingPath));
   const remaining=audio.duration-head;
   if(remaining>.04&&!shots.length)throw new Error('片头短于正文配音，请补充后续素材。');
   shots=[{path:config.openingPath,sourceIn:0,duration:head},...shots.map(shot=>({...shot,duration:remaining/shots.length}))].filter(shot=>shot.duration>.001);
  }
  const sum=shots.reduce((total,shot)=>total+Number(shot.duration),0);
  if(!Number.isFinite(sum)||Math.abs(sum-audio.duration)>.15)throw new Error(`第${index+1}段镜头总时长与配音不一致，请重新匹配镜头。`);
  shots[shots.length-1].duration+=audio.duration-sum;
  let start=offset;
  for(const shot of shots){
   const sourceIn=Number(shot.sourceIn||0),duration=Number(shot.duration);
   if(!Number.isFinite(sourceIn)||sourceIn<0||!Number.isFinite(duration)||duration<.001||!shot.path)throw new Error('镜头入点或时长无效。');
   if(!IMAGE.test(shot.path)){
    const native=await mediaDuration(ffmpeg,shot.path,context.signal);
    if(sourceIn+duration>native+.08)throw new Error('镜头超出源视频可用时长，请补充素材或重新匹配。');
   }
   clips.push({id:randomUUID(),track:'picture',start,duration,path:shot.path,sourceIn});
   start+=duration;
  }
  prepared.push({...segment,shots,duration:audio.duration,start:offset,audioPath:audio.audioPath});
  offset+=audio.duration;
 }
 if(master&&config.subtitle!==false)for(const cue of master.cues)clips.push({id:randomUUID(),track:'subtitle',start:bodyStart+cue.start,duration:cue.end-cue.start,text:cue.text});
 const timeline=normalizeTimeline({ratio,fontSize:ratio==='16:9'?24:30,clips});
 return {timeline,prepared,duration:offset,estimated};
}

async function renderPlannedMontage(config,context,ffmpeg){
 const {timeline,prepared,duration:offset,estimated}=await prepareMontageTimeline(config,context,ffmpeg);
 const base=path.resolve(config.outputDir);
 const id=String(config.jobId||randomUUID()).replace(/[^a-zA-Z0-9_-]/g,'_');
 const result=await renderTimeline({...config,jobId:id,timeline},ffmpeg,context);
 const actual=await mediaDuration(ffmpeg,result.localPath,context.signal);
 if(Math.abs(actual-offset)>.25)throw new Error('成片时长与声音时间轴不一致，请检查镜头范围后重试。');
 await fs.writeFile(path.join(base,`${id}.json`),JSON.stringify({name:config.name,duration:actual,segments:prepared,timeline:result.timeline},null,2),'utf8');
 return {...result,duration:actual,...(estimated&&config.subtitle!==false?{warning:'部分字幕或正文分段采用估算时间，请在时间轴预览中复核。'}:{})};
}

export async function renderMontage(config,context={}){
 const ffmpeg=context.ffmpegPath||await resolveFfmpeg(process.cwd());const {signal}=context;
 if(config.timeline)return renderTimeline(config,ffmpeg,context);
 if(!config.segments?.length)throw new Error('请先填写文案段落并选择对应素材。');
 if(config.masterAudioPath||config.openingAudioMode==='original'||config.segments.some(segment=>segment.shots?.length))return renderPlannedMontage(config,context,ffmpeg);
 if(!['9:16','16:9','1:1'].includes(config.ratio||'9:16'))throw new Error('混剪输出比例暂支持9:16、16:9、1:1。');
 const [width,height]=(config.ratio==='16:9'?[1920,1080]:config.ratio==='1:1'?[1080,1080]:[1080,1920]);
 const base=path.resolve(config.outputDir);await fs.mkdir(base,{recursive:true});const taskId=String(config.jobId||createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0,20)).replace(/[^a-zA-Z0-9_-]/g,'_');const work=path.join(base,`work_${taskId}`);await fs.mkdir(work,{recursive:true});
 const checkpoint={...context.checkpoint,audio:{...(context.checkpoint?.audio||{})},cues:{...(context.checkpoint?.cues||{})}};const persist=()=>context.onCheckpoint?.(checkpoint);
 const allCues=[],clips=[],manifest=[];let offset=0,estimatedSubtitles=false;
 for(let i=0;i<config.segments.length;i++){
  if(signal?.aborted)throw new Error('视频合成已停止。');
  const segment=config.segments[i];if(!segment.text?.trim())throw new Error(`第${i+1}段缺少文案。`);let audio=segment.audioPath,exactCues=null;
  const hash=createHash('sha256').update(JSON.stringify({text:segment.text,voice:config.voice||'alloy',voiceOptions:config.voiceOptions,provider:context.provider?.id,model:context.provider?.model})).digest('hex');
  if(!audio){
   const cached=checkpoint.audio[hash];if(cached&&await fs.stat(cached).then(s=>s.isFile()).catch(()=>false)){audio=cached;exactCues=checkpoint.cues[hash];}
   else{
    if(!context.providerRunner)throw new Error('请配置配音服务或为每段导入音频。');
    const chunks=String(segment.text).split(/(?<=[。！？!?；;])|\n/).map(s=>s.trim()).filter(Boolean).flatMap(s=>Array.from({length:Math.ceil(s.length/60)},(_,n)=>s.slice(n*60,(n+1)*60)));
    let at=0;const chunkFiles=[];exactCues=[];
    for(let n=0;n<chunks.length;n++){
     const r=await context.providerRunner('tts',{voice:config.voice||'alloy',...(config.voiceOptions||{}),prompt:chunks[n]});let input=r.localPath;
     if(!input){input=path.join(work,`voice_${hash}_${n}.mp3`);await fs.writeFile(input,Buffer.from(r.bytes||[]));}
     const wav=`speech_${i}_${n}.wav`;await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-i',path.resolve(input),'-ar','48000','-ac','2','-c:a','pcm_s16le',wav],{cwd:work,signal});
     const seconds=await mediaDuration(ffmpeg,path.join(work,wav),signal);const timing=audioCues(r.segments,chunks[n],seconds);exactCues.push(...timing.cues.map(c=>({...c,start:c.start+at,end:c.end+at})));at+=seconds;chunkFiles.push(wav);
    }
    await fs.writeFile(path.join(work,`speech_${i}.txt`),chunkFiles.map(f=>`file '${f}'`).join('\n'));
    audio=path.join(work,`voice_${hash}.wav`);await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','concat','-safe','1','-i',`speech_${i}.txt`,'-c:a','pcm_s16le',audio],{cwd:work,signal});
    checkpoint.audio[hash]=audio;checkpoint.cues[hash]=exactCues;await persist();
   }
  }
  const duration=await mediaDuration(ffmpeg,audio,signal);if(duration>600)throw new Error('单段音频超过10分钟，请分段后再混剪。');
  let paths=Array.from(new Set(segment.paths||[]));if(!paths.length)throw new Error(`第${i+1}段没有匹配素材。`);
  if(i===0&&config.openingPath)paths=[config.openingPath,...paths.filter(p=>path.resolve(p).toLowerCase()!==path.resolve(config.openingPath).toLowerCase())];
  const cues=exactCues?exactCues.map(c=>({...c,start:c.start+offset,end:c.end+offset})):subtitleCues(segment.text,duration,offset);if(!exactCues)estimatedSubtitles=true;allCues.push(...cues);
  let allocations=paths.map(()=>duration/paths.length);
  if(i===0&&config.openingPath){
   const native=await mediaDuration(ffmpeg,config.openingPath,signal);
   if(paths.length===1&&duration>native+.15)throw new Error('开头视频短于A段配音，请缩短文案、使用更长开头或补充后续素材。');
   const head=Math.min(duration,native);if(duration-head<.04){paths=[paths[0]];allocations=[duration];}else allocations=[head,...paths.slice(1).map(()=>(duration-head)/(paths.length-1))];
  }
  for(let j=0;j<paths.length;j++){
   const media=path.resolve(paths[j]);const name=`clip_${i}_${j}.mp4`;const image=IMAGE.test(media);const slice=allocations[j];
   const mediaArgs=image?['-loop','1','-i',media]:['-stream_loop','-1','-i',media];
   await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y',...mediaArgs,'-t',String(slice),'-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30`,'-an','-c:v','libx264','-preset','veryfast','-crf','21','-pix_fmt','yuv420p',name],{cwd:work,signal});
   clips.push({name,duration:slice});
  }
  const visualDuration=clips.slice(-paths.length).reduce((sum,c)=>sum+c.duration,0);if(Math.abs(visualDuration-duration)>.15)throw new Error('所选开头时长不足以覆盖配音，请增加配套素材。');
  const list=`segment_${i}.txt`;await fs.writeFile(path.join(work,list),clips.slice(-paths.length).map(c=>`file '${c.name}'`).join('\n'));
  const section=`section_${i}.mp4`;await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','concat','-safe','1','-i',list,'-i',path.resolve(audio),'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','160k','-ar','48000','-ac','2','-t',String(duration),section],{cwd:work,signal});
  manifest.push({section:segment.section||String(i+1),text:segment.text,paths,audioPath:audio,duration,start:offset,clip:section,allocations});offset+=duration;
  checkpoint.completedSections=i+1;await persist();context.onProgress?.({stage:'rendering',completed:i+1,total:config.segments.length});
 }
 await fs.writeFile(path.join(work,'sections.txt'),manifest.map(s=>`file '${s.clip}'`).join('\n'));const output=path.join(base,`${taskId}.mp4`);const srt=path.join(base,`${taskId}.srt`);await fs.writeFile(srt,toSrt(allCues),'utf8');
 let subtitleFilter=[];
 if(config.subtitle!==false){await fs.writeFile(path.join(work,'subtitles.srt'),toSrt(allCues),'utf8');const fontSize=config.ratio==='16:9'?24:30;subtitleFilter=['-vf',`subtitles=subtitles.srt:force_style='${subtitleStyle(fontSize)}'`];}
 await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','concat','-safe','1','-i','sections.txt',...subtitleFilter,'-c:v',config.subtitle===false?'copy':'libx264',...(config.subtitle===false?[]:['-preset','veryfast','-crf','21']),'-c:a','copy','-movflags','+faststart',output],{cwd:work,signal});
 const actual=await mediaDuration(ffmpeg,output,signal);if(Math.abs(actual-offset)>.5)throw new Error('成片时长与声音时间轴不一致，请检查素材后重试。');
 const timeline=montageTimeline(config.ratio||'9:16',manifest,config.subtitle===false?[]:allCues);
 await fs.writeFile(path.join(base,`${taskId}.json`),JSON.stringify({name:config.name,duration:actual,width,height,segments:manifest,subtitlePath:srt,timeline},null,2),'utf8');
 checkpoint.output=output;await persist();return {localPath:output,subtitlePath:srt,width,height,duration:actual,timeline,...(estimatedSubtitles&&config.subtitle!==false?{warning:'导入音频的字幕按文字长度估算时间，请在成片中复核；自动配音已按实际分句音频时长对齐。'}:{})};
}
