import React,{useEffect,useRef,useState} from 'react';
import {tracks,timelineDuration,normalizeTimeline} from '../shared/timeline.mjs';

const isImage=file=>/\.(png|jpe?g|webp|gif|bmp)$/i.test(file||'');
const name=file=>file?.split(/[\\/]/).pop();
const at=(clip,time)=>clip.start<=time&&time<clip.start+clip.duration;
const clock=time=>`${Math.floor(time/60)}:${(time%60).toFixed(1).padStart(4,'0')}`;
const round=time=>Math.round(time*1000)/1000;
const overlaps=(clip,clips)=>['picture','subtitle'].includes(clip.track)&&clips.some(other=>
 other.id!==clip.id&&other.track===clip.track&&clip.start<other.start+other.duration-.001&&other.start<clip.start+clip.duration-.001);

function PreviewMedia({clip,time,playing,media,picture=false}){
 const ref=useRef(null);
 useEffect(()=>{
  const el=ref.current;
  if(!el)return;
  const sync=()=>{
   if(!el.duration)return;
   const offset=Math.max(0,time-clip.start+clip.sourceIn);
   const target=picture?offset%el.duration:offset;
   if(Math.abs(el.currentTime-target)>(playing ? .18 : .025))el.currentTime=Math.min(target,el.duration);
   if(!picture)el.volume=clip.volume??1;
   if(playing&&target<el.duration&&el.paused)el.play().catch(()=>{});
   if((!playing||target>=el.duration)&&!el.paused)el.pause();
  };
  sync();
  el.addEventListener('loadedmetadata',sync);
  return()=>el.removeEventListener('loadedmetadata',sync);
 },[clip,time,playing,picture]);
 if(picture&&isImage(clip.path))return <img src={media(clip.path)} alt="当前画面"/>;
 if(picture)return <video ref={ref} src={media(clip.path)} muted preload="auto" loop/>;
 return <audio ref={ref} src={media(clip.path)} preload="auto"/>;
}

function NumberEdit({label,value,step=.1,min=0,max,onChange}){
 return <label>{label}<input key={value} type="number" defaultValue={Number(value.toFixed(3))} min={min} max={max} step={step}
  onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur()}}
  onBlur={event=>{const input=event.currentTarget;const next=input.valueAsNumber;if(Number.isFinite(next)&&next>=min&&(max===undefined||next<=max)&&next!==value)onChange(next);input.value=Number(value.toFixed(3))}}/></label>;
}

export default function TimelineEditor({record,call,choose,media,run,setDirty,onClose}){
 const [timeline,setTimeline]=useState(()=>normalizeTimeline(record.timeline));
 const [selected,setSelected]=useState(''),[time,setTime]=useState(0),[playing,setPlaying]=useState(false);
 const [scale,setScale]=useState(64),[message,setMessage]=useState(''),[working,setWorking]=useState(false);
 const [dirty,setLocalDirty]=useState(false),[closing,setClosing]=useState(false),[dragging,setDragging]=useState(null);
 const [undo,setUndo]=useState([]);
 const [draftRoot,setDraftRoot]=useState(''),[exported,setExported]=useState('');
 useEffect(()=>{call('getState').then(state=>setDraftRoot(state.settings.jianyingDraftRoot||''))},[]);
 const drag=useRef(null), playhead=useRef(0);
 const clips=timeline.clips;
 const duration=timelineDuration(clips);
 const selectedClip=clips.find(c=>c.id===selected);
 const picture=clips.find(c=>c.track==='picture'&&at(c,time));
 const subtitle=clips.find(c=>c.track==='subtitle'&&at(c,time));
 const sound=clips.filter(c=>(c.track==='voice'||c.track==='music')&&at(c,time));
 const railLength=Math.max(6,Math.ceil(duration)+1);
 const rulerStep=scale<30?5:scale<60?2:1;
 const seek=next=>{playhead.current=Math.min(duration,Math.max(0,next));setTime(playhead.current)};
 const stop=()=>setPlaying(false);
 const mark=value=>{setLocalDirty(value);setDirty(value)};
 const close=()=>{stop();if(dirty)setClosing(true);else onClose()};
 useEffect(()=>{
  const handler=event=>{if(event.key==='Escape'){event.preventDefault();close()}};
  window.addEventListener('keydown',handler);
  return()=>window.removeEventListener('keydown',handler);
 },[dirty]);
 useEffect(()=>{
  if(!playing)return;
  let last=performance.now(),frame;
  const tick=now=>{
   seek(playhead.current+(now-last)/1000);
   last=now;
   if(playhead.current>=duration)stop();
   else frame=requestAnimationFrame(tick);
  };
  frame=requestAnimationFrame(tick);
  return()=>cancelAnimationFrame(frame);
 },[playing,duration]);
 useEffect(()=>{if(time>duration)seek(duration)},[duration]);

 function edit(next){
  try{
   const normalized=normalizeTimeline(next);
   setUndo(history=>[...history.slice(-19),timeline]);
   setTimeline(normalized);
   setMessage('');
   mark(true);
  }catch(error){setMessage(error.message)}
 }
 function update(patch){
  stop();
  edit({...timeline,clips:clips.map(c=>c.id===selected?{...c,...patch}:c)});
 }
 function split(){
  const c=selectedClip;
  if(!c||time<c.start+.05||time>c.start+c.duration-.05)return;
  const duration=round(time-c.start);
  const next={...c,id:crypto.randomUUID(),start:c.start+duration,duration:c.duration-duration,sourceIn:(c.sourceIn??0)+duration};
  edit({...timeline,clips:clips.flatMap(clip=>clip.id===selected?[{...c,duration},next]:[clip])});
  setSelected(next.id);
 }
 function add(track){
  stop();
  run(async()=>{
   if(track==='subtitle'){
    const c={id:crypto.randomUUID(),track,start:round(time),duration:2,text:'新字幕'};
    if(overlaps(c,clips)){setMessage('请把播放头移到空白位置再添加字幕。');return}
    edit({...timeline,clips:[...clips,c]});setSelected(c.id);return;
   }
   const files=await choose(track==='picture'?'media':'audio');
   if(!files?.length)return;
   const additions=[];
   let start=track==='picture'?timelineDuration(clips.filter(c=>c.track===track)):round(time);
   for(const path of files){
    const duration=isImage(path)?3:await call('timelineMediaDuration',path);
    const c={id:crypto.randomUUID(),track,path,start,duration,sourceIn:0,volume:track==='music'?.25:1};
    additions.push(c);start+=duration;
   }
   edit({...timeline,clips:[...clips,...additions]});setSelected(additions[0].id);
  });
 }
 const persist=enqueue=>run(async()=>{
  setWorking(true);
  try{
   await call(enqueue?'enqueueTimeline':'saveTimeline',record.id,timeline);
   mark(false);
   if(enqueue)onClose();
  }finally{setWorking(false)}
 },enqueue?'编辑版已加入导出队列':'时间轴草稿已保存');
 const togglePlay=()=>{if(!duration)return;if(playing)stop();else{if(time>=duration)seek(0);setPlaying(true)}};
 const selectDraftRoot=()=>run(async()=>{const folder=await window.studio.chooseFolder('jianying');if(folder){await call('updateSettings',{jianyingDraftRoot:folder});setDraftRoot(folder)}});
 const exportDraft=()=>run(async()=>{stop();setWorking(true);try{const result=await call('exportJianying',record.id,timeline);mark(false);setExported(result.directory)}finally{setWorking(false)}});

 return <div className="timeline-overlay" role="dialog" aria-modal="true" aria-label="成片时间轴">
  <header className="timeline-header">
   <div><small>03 混剪成片 / 时间轴</small><h2>{record.name}</h2></div>
   <div className="actions">
    <button className="button" disabled={working} onClick={close}>返回成片</button>
    <button className="button" disabled={working||!dirty} onClick={()=>persist(false)}>保存草稿</button>
    <button className="button" disabled={working||!draftRoot||!clips.some(c=>c.track==='picture')} onClick={exportDraft}>导出剪映草稿</button>
    <button className="button primary" disabled={working||!clips.some(c=>c.track==='picture')} onClick={()=>persist(true)}>导出编辑版</button>
   </div>
  </header>
  <div className="timeline-upper">
   <section className="timeline-add">
    <h3>添加到轨道</h3>
    {tracks.map(track=><button key={track.id} className="button" onClick={()=>add(track.id)}>＋ {track.name}</button>)}
    <p>拖动片段改变位置。双击片段可跳转预览。选中后可在右侧精确调整时间。</p>
    <button className="button" disabled={working} onClick={selectDraftRoot}>{draftRoot?'更换剪映草稿目录':'选择剪映草稿目录'}</button>
    <p className="draft-root" title={draftRoot}>{draftRoot||'在剪映「设置 → 草稿位置」查看根目录，然后在这里选择。'}</p>
    {exported&&<p role="status" className="draft-root">已导出：{exported}。请在剪映草稿页打开检查画面和声音。</p>}
    {record.warnings?.map((warning,index)=><p key={index}>{warning}</p>)}
    {timeline.flattened&&<p>此旧成片缺少分轨清单，已将原画面和声音导入。原片内已有字幕随画面保留。</p>}
   </section>
   <section className="timeline-player">
    <div className="timeline-screen" style={{'--frame-ratio':timeline.ratio.replace(':',' / ')}}>
     {picture&&<PreviewMedia key={picture.id} clip={picture} time={time} playing={playing} media={media} picture/>}
     {subtitle&&<div className="timeline-caption" style={{fontSize:`${timeline.fontSize*.64}px`}}>{subtitle.text}</div>}
     {sound.map(clip=><PreviewMedia key={clip.id} clip={clip} time={time} playing={playing} media={media}/>)}
    </div>
    <div className="timeline-play"><button className="button" onClick={togglePlay}>{playing?'暂停':'播放'}</button><input type="range" aria-label="预览播放进度" min="0" max={duration||1} step=".01" value={time} onChange={e=>{stop();seek(+e.target.value)}}/><span>{clock(time)} / {clock(duration)}</span></div>
   </section>
   <section className="timeline-inspector">
    <h3>{selectedClip?tracks.find(t=>t.id===selectedClip.track).name+'片段':'片段属性'}</h3>
    {selectedClip?<><div className="timeline-properties">
     <NumberEdit label="起点（秒）" value={selectedClip.start} onChange={start=>update({start})}/>
     <NumberEdit label="时长（秒）" value={selectedClip.duration} min={.001} onChange={duration=>update({duration})}/>
     {selectedClip.path&&!isImage(selectedClip.path)&&<NumberEdit label="素材入点（秒）" value={selectedClip.sourceIn} onChange={sourceIn=>update({sourceIn})}/>}
     {['voice','music'].includes(selectedClip.track)&&<NumberEdit label="音量（%）" value={(selectedClip.volume??1)*100} max={100} step={1} onChange={volume=>update({volume:volume/100})}/>}
    </div>
    {selectedClip.track==='subtitle'&&<label className="timeline-text">字幕文字<textarea key={selectedClip.id} defaultValue={selectedClip.text} aria-label="字幕文字" maxLength={500} onBlur={e=>{if(e.target.value!==selectedClip.text)update({text:e.target.value})}}/></label>}
    <div className="actions">
     <button className="button" disabled={time<selectedClip.start+.05||time>selectedClip.start+selectedClip.duration-.05} onClick={split}>在播放头分割</button>
     <button className="button danger" onClick={()=>{stop();edit({...timeline,clips:clips.filter(c=>c.id!==selected)});setSelected('')}}>移除片段</button>
    </div></>:<p>点选下方任一片段，调整时长、声音或字幕。</p>}
    <NumberEdit label="字幕字号" value={timeline.fontSize} min={12} max={72} step={1} onChange={fontSize=>edit({...timeline,fontSize:Math.round(fontSize)})}/>
   </section>
  </div>
  <section className="timeline-lower">
   <div className="timeline-tools"><strong>多轨时间轴</strong><span role="status">{message}</span><button className="button" disabled={!undo.length} onClick={()=>{stop();setTimeline(undo.at(-1));setUndo(undo.slice(0,-1));mark(true);setMessage('')}}>撤销</button><label>缩放 <input aria-label="时间轴缩放" type="range" min={16} max={140} value={scale} onChange={e=>setScale(+e.target.value)}/></label></div>
   <div className="timeline-scroll">
    <div className="timeline-track-labels"><span>时间</span>{tracks.map(track=><span key={track.id}>{track.name}</span>)}</div>
    <div className="timeline-rails" style={{width:railLength*scale}}>
     <div className="timeline-ruler" aria-label="时间刻度" onClick={e=>{stop();seek((e.clientX-e.currentTarget.getBoundingClientRect().left)/scale)}}>
      {Array.from({length:Math.ceil(railLength/rulerStep)},(_,i)=><span key={i} style={{left:i*rulerStep*scale}}>{clock(i*rulerStep)}</span>)}
     </div>
     {tracks.map(track=><div className="timeline-rail" key={track.id} onClick={e=>{if(e.currentTarget===e.target){stop();seek((e.clientX-e.currentTarget.getBoundingClientRect().left)/scale)}}}>
      {clips.filter(c=>c.track===track.id).map(c=><button key={c.id} type="button" title={c.text||name(c.path)} className={`timeline-clip ${c.track} ${selected===c.id?'chosen':''}`}
       style={{left:(dragging?.id===c.id?dragging.start:c.start)*scale,width:Math.max(3,c.duration*scale)}}
       onClick={()=>setSelected(c.id)} onDoubleClick={()=>{stop();seek(c.start)}}
       onPointerDown={e=>{if(e.button!==0)return;stop();setSelected(c.id);drag.current={id:c.id,x:e.clientX};e.currentTarget.setPointerCapture(e.pointerId)}}
       onPointerMove={e=>{if(drag.current?.id===c.id&&Math.abs(e.clientX-drag.current.x)>4)setDragging({id:c.id,start:Math.max(0,round(c.start+(e.clientX-drag.current.x)/scale))})}}
       onPointerCancel={()=>{drag.current=null;setDragging(null)}}
       onPointerUp={()=>{drag.current=null;if(dragging?.id===c.id){const next={...c,start:dragging.start};if(overlaps(next,clips))setMessage('此位置会与同轨片段重叠。');else edit({...timeline,clips:clips.map(clip=>clip.id===c.id?next:clip)})}setDragging(null)}}>
       {c.text||name(c.path)}
      </button>)}
     </div>)}
     <div className="timeline-head" style={{left:time*scale}}/>
    </div>
   </div>
  </section>
  {closing&&<div className="timeline-confirm"><section><h3>时间轴有未保存的修改</h3><div className="actions"><button className="button" onClick={()=>setClosing(false)}>继续编辑</button><button className="button danger" onClick={onClose}>放弃修改</button></div></section></div>}
 </div>;
}
