import {OAIREGBOX_BASE,H3_MODELS,h3Cost,h3Model,h3ReferenceError,h3ReferenceKind,h3ReferenceLimits} from '../shared/oairegbox.mjs';
import {IMAGE_PROMPT_RULES,H3_PROMPT_SECTIONS,videoReferences} from '../shared/prompt-rules.mjs';
import {rowCategory,visibleImageRows,reorderVisibleRows} from '../shared/image-rows.mjs';
import './image-row-actions.css';
import ImageBatchImport from './ImageBatchImport.jsx';
import ImageFolderImport from './ImageFolderImport.jsx';
import TimelineEditor from './TimelineEditor.jsx';
import SpeechWorkspace from './SpeechWorkspace.jsx';
import SpeechSettings from './SpeechSettings.jsx';
import MontageWorkspace from './MontageWorkspace.jsx';
import ModelConnections from './ModelConnections.jsx';
import React,{useState,useEffect,useRef,useMemo} from 'react';
import {Cloud,Image as ImageIcon,VideoCamera,FilmStrip,Stack,Gear,ArrowRight,Plus,Play,Pause,FolderOpen,UploadSimple,ArrowsClockwise,Sparkle,FloppyDisk,CheckCircle,WarningCircle,X,CaretLeft,CaretRight,MagnifyingGlassPlus,ArrowCounterClockwise,DownloadSimple,Trash,PencilSimple,Copy,Eye,SidebarSimple,Info,Spinner,MusicNote,Link as LinkIcon,Check,FileImage} from '@phosphor-icons/react';

const bridge=window.studio;
const initial={settings:{projectName:'我的素材项目',outputDir:'',autoExport:true,concurrency:10,videoConcurrency:2,renderConcurrency:1,panelOpen:true,providers:[],bindings:{},templates:[]},rows:[],jobs:[],assets:[],formulas:[]};
const statuses={queued:'等待中',planning:'规划中',running:'生成中',saving:'保存中',succeeded:'已完成',failed:'失败',unknown:'状态待确认',cancelled:'已取消'};
const busyStatuses=['queued','planning','running','saving'];
const ratioOptions=[['source','跟随原图'],['9:16','9:16 竖屏'],['16:9','16:9 横屏'],['1:1','1:1 方形'],['3:4','3:4'],['4:3','4:3']];
const uid=()=>crypto.randomUUID();
const media=path=>path&&bridge?bridge.mediaUrl(path):'';
const basename=path=>path?.split(/[\\/]/).pop()||'';
const slotLabel=j=>String(Number.isInteger(j.slot)?j.slot+1:1).padStart(4,"0");
const short=(s,n=60)=>s?.length>n?s.slice(0,n)+'…':s||'';
const imageRuleLabels={imageOptimize:'一键优化',imageDirected:'带要求的优化'};

function currentImageSlots(jobs,rowId){
 const slots=new Map();
 for(const job of jobs){
  if(job.kind!=='image'||job.rowId!==rowId||job.archivedAt||job.discardedAt)continue;
  const prior=slots.get(job.slot);
  if(!prior||job.status==='succeeded'||(prior.status!=='succeeded'&&job.attempt>=prior.attempt))slots.set(job.slot,job);
 }
 return [...slots.values()].sort((a,b)=>a.slot-b.slot);
}

function Button({icon:Icon,children,primary=false,danger=false,className='',...props}){return <button className={`button ${primary?'primary':''} ${danger?'danger':''} ${className}`} {...props}>{Icon&&<Icon size={18}/>} {children}</button>}
function Field({label,hint,children,className=''}){return <label className={`field ${className}`}><span className="field-label">{label}{hint&&<small>{hint}</small>}</span>{children}</label>}
function InlineRowCode({value,label,onSave}){
 const [text,setText]=useState(value),[busy,setBusy]=useState(false);const cancel=useRef(false);
 useEffect(()=>setText(value),[value]);
 return <input className="row-code-input" aria-label={`编号 ${label}`} title="直接编辑编号，离开输入框自动保存。例如 A01、B01" value={text} disabled={busy} maxLength={40} onClick={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} onChange={e=>setText(e.target.value)} onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){cancel.current=true;setText(value);e.currentTarget.blur()}}} onBlur={async()=>{if(cancel.current){cancel.current=false;return}if(text===value)return;setBusy(true);try{const result=await onSave(text);setText(result?.code??value)}finally{setBusy(false)}}}/>;
}

function Empty({icon:Icon=ImageIcon,title,description,children}){return <div className="empty"><div className="empty-icon"><Icon size={35} weight="light"/></div><h3>{title}</h3><p>{description}</p>{children}</div>}
function Modal({title,children,onClose,wide=false}){useEffect(()=>{const fn=e=>{if(e.key==='Escape')onClose()};window.addEventListener('keydown',fn);return()=>window.removeEventListener('keydown',fn)},[onClose]);return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide?'wide':''}`}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={22}/></button></header>{children}</section></div>}

function PromptRewrite({input,call,run,onApply,video=false,disabled=false}){
 const [busy,setBusy]=useState(''),[direction,setDirection]=useState(null),[result,setResult]=useState(null),[guide,setGuide]=useState(false);
 const fingerprint=JSON.stringify(input);
 const generate=(kind,extra='')=>run(async()=>{
  setBusy(kind);
  setDirection(null);
  try{
   const text=await call('rewritePrompt',{...input,kind,direction:extra});
   setResult({text,fingerprint});
  }finally{setBusy('')}
 });
 const locked=disabled||Boolean(busy)||!input.prompt.trim();
 const label=video?'转换为 MiniMax H3 提示词':imageRuleLabels.imageOptimize;
 const kind=video?'video':'imageOptimize';
 const stale=result&&result.fingerprint!==fingerprint;
 return <>
  <div className="actions prompt-tools">
   <Button className="prompt-action" icon={Sparkle} disabled={locked} onClick={()=>generate(kind)}>{busy===kind?(video?'转换中…':'优化中…'):label}</Button>
   {video?<Button icon={Info} disabled={Boolean(busy)} onClick={()=>setGuide(true)}>H3 官方模板</Button>:<Button className="prompt-action" icon={Plus} disabled={locked} onClick={()=>setDirection('')}>{busy==='imageDirected'?'优化中…':imageRuleLabels.imageDirected}</Button>}
  </div>
  {direction!==null&&<Modal title={imageRuleLabels.imageDirected} onClose={()=>setDirection(null)}>
   <Field label="本次优化方向"><textarea autoFocus aria-label="本次优化方向" rows={4} value={direction} onChange={e=>setDirection(e.target.value)} placeholder="例如：只改播放量，并逐项写清要保留的位置和样式。"/></Field>
   <div className="modal-actions"><Button onClick={()=>setDirection(null)}>取消</Button><Button primary disabled={locked||!direction.trim()} onClick={()=>generate('imageDirected',direction)}>开始优化</Button></div>
  </Modal>}
  {result&&<Modal wide title={video?'H3 提示词预览':'优化后的用户要求'} onClose={()=>setResult(null)}>
   <Field label="确认后回填，可继续编辑"><textarea aria-label="提示词结果" rows={10} value={result.text} onChange={e=>setResult({...result,text:e.target.value})}/></Field>
   {stale&&<p className="amber">本次请求的上下文已变化。可以复制结果，或关闭后重新生成。</p>}
   <div className="modal-actions"><Button onClick={()=>setResult(null)}>取消</Button><Button primary disabled={stale||!result.text.trim()} onClick={()=>{onApply(result.text.trim());setResult(null)}}>使用此提示词</Button></div>
  </Modal>}
  {guide&&<Modal title="MiniMax H3 官方模板" onClose={()=>setGuide(false)}>
   <p>{input.mode==='reference'?'参考生视频按素材定义、目标、保留关系、镜头、环境声和配乐组织。素材按类型分别编号。':'文生视频按镜头、环境声和配乐组织。图生视频在开头补充首帧或首尾帧的对齐说明。'}</p>
   <pre className="h3-template">{H3_PROMPT_SECTIONS[input.mode==='reference'?'reference':'base'].map(section=>section+': …').join('\n\n')}</pre>
   <p className="muted">镜头描述使用英文，台词和画面文字保留原文。</p>
   <div className="modal-actions"><Button icon={LinkIcon} onClick={()=>run(()=>call('openH3Guide',input.mode==='reference'))}>查看 MiniMax 官方指南</Button></div>
  </Modal>}
 </>;
}

function ImageViewer({items,index,onClose,docked=false}){
 const [current,setCurrent]=useState(index),[transform,setTransform]=useState({x:0,y:0,s:1}),[size,setSize]=useState({w:1,h:1});
 const stage=useRef(),drag=useRef(null),fitRef=useRef(1),item=items[current];
 const fit=(natural=size)=>{if(!stage.current)return;const r=stage.current.getBoundingClientRect();const s=Math.min(Math.max(1,r.width-48)/natural.w,Math.max(1,r.height-28)/natural.h,1);fitRef.current=s;setTransform({x:0,y:0,s})};
 const go=delta=>setCurrent(v=>(v+delta+items.length)%items.length);
 useEffect(()=>{const fn=e=>{if(e.defaultPrevented||document.querySelector('.modal-backdrop'))return;if(e.key==='Escape'){onClose();return}if(e.target.closest?.('input,textarea,select,[contenteditable]'))return;if(e.key==='ArrowLeft')go(-1);if(e.key==='ArrowRight')go(1)};window.addEventListener('keydown',fn);return()=>window.removeEventListener('keydown',fn)},[items.length,onClose]);
 useEffect(()=>{const observer=new ResizeObserver(()=>fit());if(stage.current)observer.observe(stage.current);return()=>observer.disconnect()},[size]);
 useEffect(()=>{if(docked)stage.current?.parentElement.scrollIntoView({block:'nearest'})},[docked]);
 const wheel=e=>{e.preventDefault();const r=stage.current.getBoundingClientRect(),x=e.clientX-r.left-r.width/2,y=e.clientY-r.top-r.height/2;setTransform(t=>{const s=Math.min(12,Math.max(.02,t.s*Math.exp(-e.deltaY*.0015))),f=s/t.s;return{x:x-(x-t.x)*f,y:y-(y-t.y)*f,s}})};
 useEffect(()=>{const el=stage.current;if(!el)return;el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel)},[]);
 return <div className={`viewer ${docked?'viewer-docked':''}`} data-testid="image-viewer" role={docked?'region':'dialog'} aria-modal={docked?undefined:true} aria-label="图片预览"><header><span className="viewer-name">{item?.name||basename(item?.path)}</span><span>{current+1} / {items.length} · {size.w} × {size.h}</span><div className="viewer-tools"><Button onClick={()=>setTransform({x:0,y:0,s:1})}>100%</Button><Button icon={ArrowCounterClockwise} onClick={()=>fit()}>适应窗口</Button><span className="zoom-label">{Math.round(transform.s*100)}%</span><button className="icon-button" aria-label="关闭图片查看器" onClick={onClose}><X size={25}/></button></div></header><div ref={stage} className="viewer-stage" onDoubleClick={()=>transform.s===1?fit():setTransform({x:0,y:0,s:1})} onPointerDown={e=>{if(e.button!==0)return;drag.current={x:e.clientX,y:e.clientY,tx:transform.x,ty:transform.y};e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{if(drag.current){const d=drag.current;setTransform(t=>({...t,x:d.tx+e.clientX-d.x,y:d.ty+e.clientY-d.y}))}}} onPointerUp={()=>drag.current=null} onPointerCancel={()=>drag.current=null}><img key={item?.path} draggable="false" src={media(item?.path)} alt={item?.name||'图片预览'} onLoad={e=>{const n={w:e.target.naturalWidth,h:e.target.naturalHeight};setSize(n);fit(n)}} style={{width:size.w,height:size.h,transform:`translate(${transform.x}px,${transform.y}px) scale(${transform.s})`}}/></div>{items.length>1&&<><button className="viewer-prev" aria-label="上一张" onClick={()=>go(-1)}><CaretLeft size={30}/></button><button className="viewer-next" aria-label="下一张" onClick={()=>go(1)}><CaretRight size={30}/></button></>}<footer>滚轮缩放 · 拖动查看 · 双击切换 100% · ← → 切换 · Esc 关闭</footer></div>
}

export default function App(){
 const [state,setState]=useState(initial),[loaded,setLoaded]=useState(false),[route,setRoute]=useState('images'),[archive,setArchive]=useState(null),[archiveConfirm,setArchiveConfirm]=useState(false),[editor,setEditor]=useState(null),[editorDirty,setEditorDirty]=useState(false),[activeId,setActiveId]=useState(''),[rowSelected,setRowSelected]=useState([]),[drafts,setDrafts]=useState({}),[toast,setToast]=useState(null),[viewer,setViewer]=useState(null),[videoPreview,setVideoPreview]=useState(null),[describeCandidate,setDescribeCandidate]=useState(null),[describing,setDescribing]=useState(false),[saving,setSaving]=useState(false),[confirmDelete,setConfirmDelete]=useState(null),[saveBefore,setSaveBefore]=useState(null);
 const toastTimer=useRef();
 const [speechForMontage,setSpeechForMontage]=useState(null),[settingsSection,setSettingsSection]=useState('connections');
 useEffect(()=>{if(bridge)bridge.call('setUnsaved',Object.keys(drafts).length>0||editorDirty).catch(()=>{})},[drafts,editorDirty]);
 const rowDragPointer=useRef(null),suppressRowClick=useRef(0);
 const [dragRow,setDragRow]=useState(''),[rowOver,setRowOver]=useState(''),[sorting,setSorting]=useState(false);
 const [addingRow,setAddingRow]=useState(false),[deletingRows,setDeletingRows]=useState(false);
 const [imageImportOpen,setImageImportOpen]=useState(false);
 const [folderImport,setFolderImport]=useState(null);
 const addingRowRef=useRef(false),deletingRowsRef=useRef(false);
 const [rowQuery,setRowQuery]=useState(''),[rowCategoryFilter,setRowCategoryFilter]=useState(''),[rowOrder,setRowOrder]=useState('manual'),[selectedOnly,setSelectedOnly]=useState(false),[sourceOver,setSourceOver]=useState(false),[dropping,setDropping]=useState(false);
 const visibleRows=visibleImageRows(state.rows,{query:rowQuery,category:rowCategoryFilter,order:rowOrder,selectedOnly,selected:rowSelected});
 const visibleSelected=rowSelected.filter(id=>visibleRows.some(row=>row.id===id));
 const deleteTargets=confirmDelete?.rows||[];
 const deleteBlocked=deleteTargets.filter(row=>state.jobs.some(job=>job.rowId===row.id&&[...busyStatuses,'unknown'].includes(job.status)));
 const deleteDirtyCount=deleteTargets.filter(row=>drafts[row.id]).length;
 const hasRowFilter=Boolean(rowQuery||rowCategoryFilter||selectedOnly);
 const clearRowFilters=()=>{setRowQuery('');setRowCategoryFilter('');setSelectedOnly(false)};
 const reorder=(source,target)=>run(async()=>{
  if(!source||source===target||sorting)return;
  const ids=reorderVisibleRows(state.rows,visibleRows.map(row=>row.id),source,target);setSorting(true);
  try{await call('reorderRows',ids);setRowOrder('manual')}finally{setSorting(false);setDragRow('');setRowOver('')}
 });
 const notify=(message,type='success')=>{clearTimeout(toastTimer.current);setToast({message,type});toastTimer.current=setTimeout(()=>setToast(null),6500)};
 const call=async(method,...args)=>{if(!bridge)throw new Error('请在桌面应用中使用此功能');return bridge.call(method,...args)};
 const run=async(fn,success)=>{try{const value=await fn();if(success)notify(success);return value}catch(e){notify(e.message||'操作未完成，请重试','error');return undefined}};
 useEffect(()=>{if(!bridge){setLoaded(true);return}let alive=true;call('getState').then(s=>{if(alive){setState(s);setActiveId(s.rows[0]?.id||'');setLoaded(true)}}).catch(e=>{notify(e.message,'error');setLoaded(true)});const off=bridge.onChange(s=>{if(alive)setState(s)});return()=>{alive=false;off?.()}},[]);
 useEffect(()=>{if(!state.rows.some(r=>r.id===activeId))setActiveId(state.rows[0]?.id||'')},[state.rows,activeId]);
 const settings=state.settings,active=state.rows.find(r=>r.id===activeId),draft=active?(drafts[activeId]||active):null;
 const dirty=Boolean(active&&drafts[activeId]);
 const outputBound=draft?.outputMode==='source-children';
 const boundOutputPath=outputBound&&draft.sourceFolder?draft.sourceFolder.replace(/[\\/]+$/,'')+(draft.sourceFolder.startsWith('/')?'/':'\\')+'子图':'';
 const edit=(patch)=>setDrafts(prev=>({...prev,[activeId]:{...(prev[activeId]||active),...patch}}));
 const updateSettings=patch=>run(()=>call('updateSettings',patch));
 const saveRow=async(row=draft)=>{if(!row)return;if(!row.name.trim())throw new Error('请填写类型名称');if(!Number.isInteger(+row.count)||+row.count<1||+row.count>100)throw new Error('生成数量应为 1–100 的整数');const result=await call('saveRow',{...row,count:+row.count});setDrafts(prev=>{const n={...prev};delete n[row.id];return n});return result};
 const withSavedRows=(ids,label,action)=>{
  if(saving)return;
  const pending=[...new Set(ids)].map(id=>drafts[id]).filter(Boolean);
  if(pending.length){setSaveBefore({pending,label,action});return}
  return run(action);
 };
 const changeRow=id=>{if(id!==activeId)withSavedRows([activeId],'切换类型',()=>setActiveId(id))};
 const changeRoute=next=>{if(next!==route)withSavedRows([activeId],'切换工作区',()=>{setViewer(null);setRoute(next)})};
 const addRow=()=>withSavedRows([activeId],'新增类型',async()=>{
  if(addingRowRef.current)return;
  addingRowRef.current=true;setAddingRow(true);
  try{
   const row=await call('saveRow',{id:uid(),name:'',sourceMode:'single',sourcePaths:[],referencePrompt:'',userPrompt:'',count:1,ratio:'source',resolution:'1K',folderName:''});
   setActiveId(row.id);setRowSelected(ids=>[...ids,row.id]);clearRowFilters();setRowOrder('manual');
  }finally{addingRowRef.current=false;setAddingRow(false)}
 });
 const requestRowDeletion=ids=>{
  const targets=state.rows.filter(row=>ids.includes(row.id));
  if(targets.length)setConfirmDelete({rows:targets.map(row=>({id:row.id,code:row.code,name:row.name||'未命名类型'}))});
 };
 const deleteRows=()=>run(async()=>{
  if(deletingRowsRef.current||!deleteTargets.length)return;
  if(deleteBlocked.length)throw new Error('选中类型还有生成中或状态待确认的任务，请处理完成后再删除。');
  deletingRowsRef.current=true;setDeletingRows(true);
  const ids=deleteTargets.map(row=>row.id);
  try{
   await call('deleteRows',ids);
   setDrafts(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>!ids.includes(id))));
   setRowSelected(previous=>previous.filter(id=>!ids.includes(id)));
   setConfirmDelete(null);
   notify(`已删除 ${ids.length} 个素材类型，原文件和生成历史已保留`);
  }finally{deletingRowsRef.current=false;setDeletingRows(false)}
 });
 const generate=ids=>withSavedRows([activeId,...ids],'提交生成',async()=>{
  if(!ids.length)throw new Error('请先勾选要生成的类型');
  const jobs=await call('enqueueImages',ids);
  if(jobs.length){
   setArchive(null);
   if(!jobs.some(job=>job.rowId===activeId))setActiveId(jobs[0].rowId);
   notify(`已提交 ${jobs.length} 个空位`);
  }else notify('当前批次已占满。失败占位可重跑或删除，开始下一批请先归档。');
 });
 const choose=async kind=>{if(!bridge)throw new Error('请在桌面应用中选择本地文件');return bridge.chooseFiles(kind)};
 const chooseFolder=async purpose=>{if(!bridge)throw new Error('请在桌面应用中选择文件夹');return bridge.chooseFolder(purpose)};
 const openImages=(paths,index=0)=>setViewer({items:paths.map(p=>typeof p==='string'?{path:p,name:basename(p)}:p),index});
 const sourceChoose=(folder=false)=>run(async()=>{if(folder){const path=await chooseFolder('image');if(path){const paths=await call('scanFolder',path);if(!paths.length){const preview=await call('previewImageFolderImport',path);if(preview?.previewId)setFolderImport({plan:preview});return}edit({sourceMode:'folder',referenceMode:'rotate',sourcePaths:paths})}}else{const paths=await choose('image');if(paths?.length){if(paths.length>16)throw new Error('每次最多同时使用 16 张参考图，请减少选择。');edit({sourceMode:'single',referenceMode:'all',sourcePaths:paths})}}});
 const chooseRowOutput=()=>run(async()=>{const result=await call('chooseImageOutputFolder');if(result?.outputMappingToken)edit({outputMode:'source-children',sourceRoot:result.sourceRoot,sourceFolder:result.sourceFolder,folderName:result.outputPath,outputMappingToken:result.outputMappingToken,clearOutputMapping:false})});
 const clearRowOutput=()=>edit({outputMode:undefined,sourceRoot:undefined,sourceFolder:undefined,motherPath:undefined,motherPaths:undefined,folderName:'',outputMappingToken:'',clearOutputMapping:true});
 const changeReferenceMode=(referenceMode,sourceMode=draft.sourceMode)=>{if(referenceMode==='all'&&draft.sourcePaths.length>16){notify('一起作为参考最多 16 张。请减少图片，或继续逐张轮流使用。','error');return}edit({referenceMode,sourceMode})};
 const commitRowCode=(id,code)=>run(async()=>{const row=await call('saveRowCode',id,code);setDrafts(previous=>previous[id]?{...previous,[id]:{...previous[id],code:row.code}}:previous);return row});
 const dropReference=event=>{
  if(!Array.from(event.dataTransfer.types).includes('Files'))return;
  event.preventDefault();event.stopPropagation();setSourceOver(false);
  const files=Array.from(event.dataTransfer.files),rowId=activeId;if(!rowId||dropping)return;
  run(async()=>{setDropping(true);try{const result=await bridge.importDroppedImages(files);if(result.sourceMode!=='folder'&&result.sourcePaths.length>16)throw new Error('每次最多同时使用 16 张参考图，请减少选择。');const fresh=await call('getState');const row=fresh.rows.find(item=>item.id===rowId);if(!row)throw new Error('接收图片的任务行已删除，请重新选择任务。');setDrafts(previous=>({...previous,[rowId]:{...(previous[rowId]||row),...result,referenceMode:result.sourceMode==='folder'?'rotate':'all'}}));notify(`已导入 ${result.sourcePaths.length} 张参考图，保存本行后生效`)}finally{setDropping(false)}});
 };
 const describe=()=>withSavedRows([activeId],'反推提示词',async()=>{setDescribing(true);try{const text=await call('describe',activeId);setDescribeCandidate({rowId:activeId,text:typeof text==='string'?text:text?.text||''})}finally{setDescribing(false)}});
 const stats=state.jobs.reduce((o,j)=>{if(busyStatuses.includes(j.status))o.busy++;if(j.status==='failed')o.failed++;if(j.status==='succeeded')o.done++;return o},{busy:0,failed:0,done:0});
 const currentJobs=currentImageSlots(state.jobs,activeId);
 const archives=new Map();
 for(const job of state.jobs.filter(j=>j.kind==='image'&&(j.archivedAt||(!j.discardedAt&&!state.rows.some(row=>row.id===j.rowId))))){
  const id=job.archiveId||job.rowId;
  if(!archives.has(id))archives.set(id,{name:job.archiveName||job.snapshot?.row?.name||'已删除类型',time:job.archivedAt||job.createdAt,jobs:[]});
  archives.get(id).jobs.push(job);
 }
 const archiveList=[...archives].sort((a,b)=>b[1].time.localeCompare(a[1].time));
 const archived=archive!==null?(archives.get(archive)||archiveList[0]?.[1]):null;
 const batchResults=(archive===null?currentJobs:archived?.jobs||[]).filter(job=>job.status==='succeeded');
 const typeNames=settings.imageTypeNames||[];
 const requestPresets=settings.imageRequestPresets||[];
 const openEditor=id=>run(async()=>{setEditor(await call('openTimeline',id));setEditorDirty(false)});
 const shared={state,loaded,call,run,notify,choose,chooseFolder,openImages,setVideoPreview,openEditor,updateSettings};
 return <div className="app"><header className="app-header"><div className="brand"><Cloud size={38} weight="bold"/><h1>子云影像工坊</h1></div><div className="header-divider"/><input className="project-name" aria-label="项目名称" defaultValue={settings.projectName} key={loaded?settings.projectName:'loading'} onBlur={e=>{if(e.target.value.trim()&&e.target.value!==settings.projectName)updateSettings({projectName:e.target.value.trim()})}}/><span className="save-indicator"><CheckCircle size={16}/>{loaded?'项目保存在本机':'正在加载项目…'}</span><span className="local-tag">本地工作空间</span></header>
 <nav className="main-nav" aria-label="工作流程"><div className="workflow-nav">{[['images',ImageIcon,'01','图片素材'],['video',VideoCamera,'02','视频开头'],['montage',FilmStrip,'03','混剪成片']].map(([id,Icon,no,label],i)=><React.Fragment key={id}>{i>0&&<ArrowRight className="step-arrow" size={23}/>}<button className={route===id?'active':''} onClick={()=>changeRoute(id)}><Icon size={24}/><span>{no} {label}</span></button></React.Fragment>)}</div><div className="utility-nav"><button data-testid="speech-nav" className={route==='speech'?'active':''} onClick={()=>changeRoute('speech')}><MusicNote size={23}/>语音合成</button><button className={route==='library'?'active':''} onClick={()=>changeRoute('library')}><Stack size={23}/>素材库</button><button data-testid="settings-nav" className={route==='settings'?'active':''} onClick={()=>changeRoute('settings')}><Gear size={23}/>全局设置</button></div></nav>
 {!bridge&&<div className="desktop-banner"><Info size={20}/><strong>请在桌面应用中使用</strong><span>此浏览器仅显示界面；本地文件、任务和连接配置由桌面应用安全管理。</span></div>}
 <main className={`main-content route-${route}`}>
 {route==='images'&&<div className={`image-workspace ${settings.panelOpen?'':'panel-closed'}`}><section className="task-workspace"><div className="section-header"><div className="section-heading"><h2>批量任务</h2><span className="badge">{state.rows.length} 个类型</span><span className="muted heading-hint">拖动整行调整顺序，配置和结果随行保留。</span></div><div className="actions"><Button primary icon={Play} disabled={!visibleSelected.length} onClick={()=>generate(visibleSelected)}>生成选中{visibleSelected.length?`(${visibleSelected.length})`:''}</Button><Button icon={Sparkle} disabled={!visibleRows.length} onClick={()=>generate(visibleRows.map(r=>r.id))}>{hasRowFilter?`生成当前 ${visibleRows.length} 行`:'全部生成'}</Button><Button icon={Plus} disabled={addingRow} onClick={addRow} data-testid="add-row">{addingRow?'新增中…':'新增类型'}</Button><Button icon={UploadSimple} data-testid="image-excel-import" onClick={()=>setImageImportOpen(true)}>Excel 导入</Button><Button icon={FolderOpen} data-testid="image-folder-import" onClick={()=>setFolderImport({plan:null})}>文件夹导入</Button><button data-testid="panel-toggle" className="icon-button panel-toggle" aria-label={settings.panelOpen?'隐藏当前行配置':'展开当前行配置'} title={settings.panelOpen?'隐藏配置栏，扩展工作区':'恢复配置栏'} onClick={()=>updateSettings({panelOpen:!settings.panelOpen})}><SidebarSimple size={20}/><span>{settings.panelOpen?'隐藏配置':'显示配置'}</span></button></div></div>
 <div className="image-row-toolbar"><div className="row-filter-search"><MagnifyingGlassPlus size={16}/><input aria-label="搜索任务编号或名称" placeholder="搜索编号或类型名称" value={rowQuery} onChange={e=>setRowQuery(e.target.value)}/></div><select aria-label="按编号分类筛选" value={rowCategoryFilter} onChange={e=>setRowCategoryFilter(e.target.value)}><option value="">全部分类</option>{[...new Set(state.rows.map(row=>rowCategory(row.code)).filter(Boolean))].sort().map(category=><option key={category} value={category}>{category} 类</option>)}<option value="#">无字母前缀</option></select><select aria-label="任务排列顺序" value={rowOrder} onChange={e=>setRowOrder(e.target.value)}><option value="manual">手动顺序</option><option value="asc">编号正序</option><option value="desc">编号倒序</option></select><label className="inline-check"><input type="checkbox" aria-label="仅显示已勾选任务" checked={selectedOnly} onChange={e=>setSelectedOnly(e.target.checked)}/>仅已勾选</label>{hasRowFilter&&<button className="text-button" onClick={clearRowFilters}>清除筛选</button>}<span className="row-visible-count">显示 {visibleRows.length} / {state.rows.length} 行</span><Button className="image-row-delete" danger icon={Trash} disabled={!visibleSelected.length||deletingRows} data-testid="delete-rows" onClick={()=>requestRowDeletion(visibleSelected)}>删除选中{visibleSelected.length?` (${visibleSelected.length})`:''}</Button></div>
 <div className="table-scroll"><table className="task-table" data-testid="task-table"><colgroup><col className="check-col"/><col className="name-col"/><col className="source-col"/><col className="prompt-col"/><col className="user-col"/><col className="count-col"/><col className="progress-col"/><col className="operation-col"/></colgroup><thead><tr><th><input type="checkbox" aria-label="选择全部类型" checked={!!visibleRows.length&&visibleSelected.length===visibleRows.length} onChange={e=>setRowSelected(previous=>e.target.checked?[...new Set([...previous,...visibleRows.map(row=>row.id)])]:previous.filter(id=>!visibleRows.some(row=>row.id===id)))}/></th><th>序号 / 类型名称</th><th>来源</th><th>参考提示词</th><th>用户要求</th><th>数量</th><th>进度</th><th>操作</th></tr></thead><tbody>{visibleRows.map((row,i)=>{const r=drafts[row.id]||row,jobs=currentImageSlots(state.jobs,row.id),done=jobs.filter(j=>j.status==='succeeded').length,busy=jobs.filter(j=>busyStatuses.includes(j.status)).length,failed=jobs.filter(j=>j.status==='failed').length;return <tr key={r.id} className={`${r.id===activeId?'active-row':''} ${dragRow===r.id?'row-dragging':''} ${rowOver===r.id?'row-drop-target':''}`} data-row-id={r.id} onPointerDown={e=>{if(sorting||e.button!==0||e.target.closest('input,textarea,select,button,a'))return;rowDragPointer.current={id:r.id,y:e.clientY,moved:false,target:''};e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{const drag=rowDragPointer.current;if(!drag||drag.id!==r.id)return;if(!drag.moved&&Math.abs(e.clientY-drag.y)<5)return;drag.moved=true;e.preventDefault();setDragRow(r.id);const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('tr[data-row-id]')?.dataset.rowId;if(target){drag.target=target;setRowOver(target)}}} onPointerCancel={()=>{rowDragPointer.current=null;setDragRow('');setRowOver('')}} onPointerUp={e=>{const drag=rowDragPointer.current;rowDragPointer.current=null;if(drag?.moved){suppressRowClick.current=Date.now()+200;reorder(drag.id,drag.target)}setDragRow('');setRowOver('');if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}} onClick={()=>{if(Date.now()>suppressRowClick.current)changeRow(r.id)}} tabIndex={0} onKeyDown={e=>{if(e.target===e.currentTarget&&e.key==='Enter')changeRow(r.id)}} aria-label={`编辑 ${r.name}`}><td onClick={e=>e.stopPropagation()}><input type="checkbox" aria-label={`选择 ${r.name}`} checked={rowSelected.includes(r.id)} onChange={e=>setRowSelected(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/></td><td title={r.name}><span className="row-grip" aria-label={`拖动排序 ${r.name}`} title="拖动整行排序，也可按 Alt + ↑ / ↓" tabIndex={0} onKeyDown={e=>{if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();e.stopPropagation();const target=visibleRows[i+(e.key==='ArrowUp'?-1:1)];if(target)reorder(r.id,target.id)}}}>⠿</span><InlineRowCode value={r.code} label={r.name||'未命名类型'} onSave={code=>commitRowCode(r.id,code)}/><strong className="row-type-name"> / {r.name||'未命名类型'}</strong>{drafts[r.id]&&<span className="dirty-dot" title="有未保存修改"/>}</td><td><div className="source-cell" title={r.sourcePaths.join('\n')}>{r.sourceMode==='folder'?<FolderOpen size={19}/>:<ImageIcon size={18}/>}<span>{r.sourcePaths.length?(r.referenceMode==='all'&&r.sourcePaths.length>1?`多图 ${r.sourcePaths.length} 张`:r.sourceMode==='folder'?`文件夹 ${r.sourcePaths.length} 张`:'单图'):'未选择'}</span>{r.sourcePaths[0]&&<button className="source-mini" aria-label={`查看 ${r.name} 参考图`} onClick={e=>{e.stopPropagation();openImages(r.sourcePaths)}}><img src={media(r.sourcePaths[0])} alt="参考图"/></button>}</div></td><td title={r.referencePrompt}>{r.referencePrompt||<span className="muted">待填写原图描述</span>}</td><td title={r.userPrompt}>{r.userPrompt||<span className="muted">待填写修改要求</span>}</td><td>{r.count}</td><td><div className="progress-cell">{done>0&&<span className="green">{done} 成功</span>}{busy>0&&<span className="amber">{busy} 生成中</span>}{failed>0&&<span className="red">{failed} 失败</span>}{!jobs.length&&<span className="muted">未开始</span>}{!!jobs.length&&!done&&!busy&&!failed&&<span className="muted">{statuses[jobs.at(-1)?.status]}</span>}</div></td><td><div className="row-actions"><Button icon={Play} onClick={e=>{e.stopPropagation();generate([r.id])}}>生成</Button><button className="icon-button small" title="删除类型" aria-label={`删除 ${r.name}`} onClick={e=>{e.stopPropagation();requestRowDeletion([r.id])}}><Trash size={16}/></button></div></td></tr>})}</tbody></table>{state.rows.length>0&&!visibleRows.length&&<Empty title="没有符合筛选的任务" description="清除筛选即可重新显示全部任务。"><Button onClick={clearRowFilters}>显示全部</Button></Empty>}{!state.rows.length&&<Empty title="从第一个素材类型开始" description="导入参考图，分别填写原图描述和修改要求，即可批量生成。"><Button primary icon={Plus} disabled={addingRow} onClick={addRow}>新增类型</Button></Empty>}</div>
 <div className="history-scope">
  <Button icon={FolderOpen} disabled={!batchResults.length} onClick={()=>run(()=>bridge.openOutput(batchResults.map(job=>job.id)))}>打开批次目录</Button>
  <Button onClick={()=>setArchive(archive===null?(archiveList[0]?.[0]||''):null)}>{archive===null?`归档记录（${archiveList.length}）`:'返回当前批次'}</Button>
  {archive===null?<Button icon={Stack} disabled={!currentJobs.length||currentJobs.some(j=>busyStatuses.includes(j.status))} onClick={()=>setArchiveConfirm(true)}>归档当前批次</Button>:<select aria-label="选择归档批次" value={archives.has(archive)?archive:archiveList[0]?.[0]||''} onChange={e=>setArchive(e.target.value)}>{!archiveList.length&&<option value="">暂无归档</option>}{archiveList.map(([id,item])=><option key={id} value={id}>{item.name} · {new Date(item.time).toLocaleString('zh-CN')}</option>)}</select>}
 </div>
 {viewer&&<ImageViewer key={viewer.items[viewer.index]?.path} {...viewer} docked onClose={()=>setViewer(null)}/>}<div hidden={!!viewer}><JobGallery key={archive===null?activeId:archive} {...shared} archived={archive!==null} jobs={archive===null?currentJobs:archived?.jobs||[]} title={archive!==null?(archived?`${archived.name} · ${new Date(archived.time).toLocaleString('zh-CN')}`:'图片归档'):active?`${active.name||'未命名类型'} · 生成结果（${currentJobs.length}/${active.count} 占位）`:'生成结果'} type="image"/></div>
 </section>{settings.panelOpen&&<aside className="row-panel" data-testid="row-panel"><div className="panel-heading"><h2>当前行配置</h2><span className={dirty?'amber':'green'}>{dirty?'未保存':<><CheckCircle size={16}/>已保存</>}</span></div>{draft?<><div className="row-identity"><input aria-label="类型序号" title="可填写 A01、B01 等分类编号，拖动不会改变编号" placeholder="A01" maxLength={40} value={draft.code} onChange={e=>edit({code:e.target.value})}/>
 <div className="row-type-picker">
  <select aria-label="图片类型" value={typeNames.includes(draft.name)?draft.name:''} onChange={e=>edit({name:e.target.value})}>
   <option value="">自定义类型</option>
   {typeNames.map(name=><option key={name}>{name}</option>)}
  </select>
  {!typeNames.includes(draft.name)&&<input aria-label="类型名称" placeholder="填写自定义类型名称" maxLength={60} value={draft.name} onChange={e=>edit({name:e.target.value})}/>}
 </div></div><div className="source-heading"><strong>参考来源</strong><div className="segmented"><button className={draft.sourceMode==='single'?'active':''} onClick={()=>changeReferenceMode('all','single')}><ImageIcon size={17}/>图片</button><button className={draft.sourceMode==='folder'?'active':''} onClick={()=>edit({sourceMode:'folder',referenceMode:'rotate'})}><FolderOpen size={17}/>文件夹</button></div></div><div className={`source-editor source-dropzone ${sourceOver?'source-drop-active':''}`} role="region" aria-label="拖入参考图片" aria-busy={dropping} onDragEnter={e=>{if(Array.from(e.dataTransfer.types).includes('Files')){e.preventDefault();setSourceOver(true)}}} onDragOver={e=>{if(Array.from(e.dataTransfer.types).includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy'}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget))setSourceOver(false)}} onDrop={dropReference}>{draft.sourcePaths[0]?<button className="reference-thumb" aria-label="放大参考图片" onClick={()=>openImages(draft.sourcePaths)}><img src={media(draft.sourcePaths[0])} alt="当前参考图"/>{draft.sourcePaths.length>1&&<span>{draft.sourcePaths.length} 张</span>}</button>:<div className="reference-placeholder"><FileImage size={38}/><span>尚未导入</span></div>}<div className="source-buttons"><Button icon={UploadSimple} onClick={()=>sourceChoose(draft.sourceMode==='folder')}>{draft.sourceMode==='folder'?'选择文件夹':'上传图片'}</Button><Button icon={ArrowsClockwise} onClick={()=>sourceChoose(draft.sourceMode==='folder')}>更换来源</Button><Button icon={Sparkle} disabled={describing||!draft.sourcePaths.length} onClick={describe}>{describing?'正在反推…':'反推提示词'}</Button></div><div className="source-drop-hint"><UploadSimple size={16}/>{dropping?'正在导入参考图片…':'拖入图片或图片文件夹到这里'}<small>只更换参考来源，保存位置、提示词和其他参数保留</small></div></div>{draft.sourcePaths.length>1&&<div className="reference-mode-control"><span>{draft.sourcePaths.length} 张参考图</span><select aria-label="多张参考图使用方式" value={draft.referenceMode==='all'?'all':'rotate'} onChange={e=>changeReferenceMode(e.target.value)}><option value="all">每次全部一起作为参考</option><option value="rotate">每次轮流使用一张</option></select></div>}<Field label={<span>参考提示词 <span className="tiny-badge">手工维护</span></span>}><textarea aria-label="参考提示词" rows={4} placeholder="描述参考图里的主体、构图、背景与风格。" value={draft.referencePrompt} onChange={e=>edit({referencePrompt:e.target.value})}/></Field><p className="field-note"><Info size={16}/>反推结果先预览，不自动覆盖手工内容。</p><div className="request-preset-picker"><Field label="常用要求" hint="从全局设置维护"><select aria-label="用户要求预设" value="" disabled={!requestPresets.length} onChange={e=>{const preset=requestPresets.find(item=>item.id===e.target.value);if(preset)edit({userPrompt:preset.text})}}><option value="">{requestPresets.length?'套用预设，替换本行要求':'暂无预设，可直接填写'}</option>{requestPresets.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div><Field label="用户要求" hint="可直接填写或修改预设内容"><textarea aria-label="用户要求" rows={3} placeholder="例如：换成浅色服装，保持页面结构与元素位置。" value={draft.userPrompt} onChange={e=>edit({userPrompt:e.target.value})}/></Field><PromptRewrite key={draft.id} input={{prompt:draft.userPrompt,name:draft.name,referencePrompt:draft.referencePrompt,templateId:draft.templateId,templateText:settings.templates.find(item=>item.id===draft.templateId)?.text,referenceCount:draft.sourcePaths.length,ratio:draft.ratio}} call={call} run={run} onApply={userPrompt=>edit({userPrompt})} disabled={saving}/>
 <div className="config-grid"><Field label="生成数量"><input aria-label="生成数量" type="number" min="1" max="100" value={draft.count} onChange={e=>edit({count:e.target.value})}/></Field><Field label="图片比例"><select aria-label="图片比例" value={draft.ratio} onChange={e=>edit({ratio:e.target.value})}>{ratioOptions.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></Field><Field label="分辨率"><select aria-label="图片分辨率" value={draft.resolution} onChange={e=>edit({resolution:e.target.value})}>{['1K','2K','4K'].map(v=><option key={v}>{v}</option>)}</select></Field><Field label="项目规范"><select aria-label="项目规范模板" value={draft.templateId} onChange={e=>edit({templateId:e.target.value})}><option value="">不使用模板</option>{settings.templates.map(t=><option value={t.id} key={t.id}>{t.name}</option>)}</select></Field></div><div className="row-output-settings" data-testid="row-source-output"><Field label={<><FolderOpen size={19}/>本行保存子目录</>} hint={outputBound?'直接保存到此完整路径':'位于底部系统输出根目录下'}><input aria-label="本行保存子目录" value={outputBound?boundOutputPath:draft.folderName||''} readOnly={outputBound} title={outputBound?boundOutputPath:undefined} placeholder="留空使用类型名称，序号和批次自动添加" onChange={e=>edit({folderName:e.target.value})}/></Field><div className="row-output-actions"><Button icon={FolderOpen} onClick={chooseRowOutput}>{outputBound?'更换保存位置':'指定母图 / 子图目录'}</Button>{outputBound&&<button className="text-button" onClick={clearRowOutput}>使用系统输出目录</button>}</div><p className="field-note">{outputBound?`${settings.autoExport?'自动导出已开启：生成成功后写回这里。':'自动导出已关闭：点击下载后写回这里。'} 更换参考图片不会改变此位置。`:'可独立指定类型目录，自动定位其「子图」文件夹；参考图片保持不变。'}</p></div><Button className="save-row" icon={FloppyDisk} disabled={saving||!dirty} onClick={()=>run(async()=>{setSaving(true);try{await saveRow()}finally{setSaving(false)}},'当前行已保存')}>{saving?'正在保存…':'保存本行'}</Button></>:<Empty title="选择一个类型" description="新增或点击左侧任务，编辑当前行配置。"/>}</aside>}</div>}
 <div className="route-pane" hidden={route!=='video'}><VideoPage {...shared} active={route==='video'}/></div><div className="route-pane" hidden={route!=='speech'}><SpeechWorkspace {...shared} onOpenSettings={()=>{setSettingsSection({tab:'speech',visit:uid()});changeRoute('settings')}} onUseForMontage={job=>{setSpeechForMontage({id:job.id,masterAudioPath:job.localPath,masterText:job.snapshot?.config?.text||job.prompt||'',masterCues:job.result?.segments||job.segments||[],name:job.snapshot?.config?.name||'配音混剪'});changeRoute('montage');notify('配音已带入混剪，请添加画面素材并预览方案')}}/></div><div className="route-pane" hidden={route!=='montage'}><MontageWorkspace {...shared} speechInput={speechForMontage} renderGallery={jobs=><JobGallery {...shared} type="montage" title="混剪成片 · 导出记录" jobs={jobs}/>}/></div><div className="route-pane" hidden={route!=='library'}><LibraryPage {...shared}/></div><div className="route-pane" hidden={route!=='settings'}><SettingsPage {...shared} initialSection={settingsSection}/></div>
 </main><footer className="app-footer"><div className="output-location" title={settings.outputDir}><FolderOpen size={23}/><strong>输出根目录：</strong><span>{settings.outputDir||'尚未设置'}</span><Button icon={FolderOpen} disabled={!settings.outputDir} onClick={()=>run(()=>bridge.openOutput())}>打开目录</Button><Button onClick={()=>run(async()=>{const path=await chooseFolder();if(path)await call('updateSettings',{outputDir:path})})}>更改</Button></div><div className="footer-item"><span>自动导出</span><button className={`switch ${settings.autoExport?'on':''}`} role="switch" aria-label="自动导出" aria-checked={settings.autoExport} onClick={()=>updateSettings({autoExport:!settings.autoExport})}/></div><div className="footer-item"><Stack size={20}/><span>生图并发</span><select aria-label="生图并发" value={settings.concurrency} onChange={e=>updateSettings({concurrency:+e.target.value})}>{Array.from({length:100},(_,i)=><option value={i+1} key={i}>{i+1}</option>)}</select></div><div className="footer-item queue-indicator"><Spinner size={20} className={stats.busy?'spinning':''}/><span>当前生成中 <b>{stats.busy}</b></span></div><Button icon={settings.paused?Play:Pause} onClick={()=>run(()=>call('setPaused',!settings.paused),settings.paused?'队列已继续':'队列已暂停，正在执行的任务会安全完成')}>{settings.paused?'继续':'暂停'}</Button>{route==='images'&&<button className="next-step" onClick={()=>changeRoute('video')}>进入视频开头 <ArrowRight size={20}/></button>}{route==='video'&&<button className="next-step" onClick={()=>changeRoute('montage')}>进入混剪成片 <ArrowRight size={20}/></button>}</footer>
 {toast&&<div className={`toast ${toast.type}`} role="status">{toast.type==='error'?<WarningCircle size={22}/>:<CheckCircle size={22}/>}<span>{toast.message}</span><button aria-label="关闭通知" onClick={()=>setToast(null)}><X size={18}/></button></div>}{viewer&&route!=='images'&&<ImageViewer key={viewer.items[viewer.index]?.path} {...viewer} onClose={()=>setViewer(null)}/>}{videoPreview&&<Modal title={videoPreview.name||'视频预览'} wide onClose={()=>setVideoPreview(null)}><video className="video-preview" controls autoPlay src={media(videoPreview.path)}/><div className="modal-actions"><Button icon={FolderOpen} onClick={()=>run(()=>bridge.reveal(videoPreview.path))}>打开文件位置</Button></div></Modal>}
 {editor&&<TimelineEditor key={editor.id} record={editor} call={call} choose={choose} media={media} run={run} setDirty={setEditorDirty} onClose={()=>{setEditor(null);setEditorDirty(false)}}/>}
 {archiveConfirm&&<Modal title="归档当前批次" onClose={()=>setArchiveConfirm(false)}><p>将“{active?.name}”当前批次和生成记录移入归档，保留原图片。当前占位归零，可按本行设置开始下一批。</p><div className="modal-actions"><Button onClick={()=>setArchiveConfirm(false)}>取消</Button><Button primary icon={Stack} onClick={()=>run(async()=>{await call('archiveImages',activeId);setArchiveConfirm(false)},'当前批次已归档，可以开始下一批')}>确认归档</Button></div></Modal>}
 {saveBefore&&<Modal title="保存行配置后继续" onClose={()=>{if(!saving)setSaveBefore(null)}}>
  <p>以下类型有未保存的修改。请先保存，再{saveBefore.label}。</p>
  <ul>{saveBefore.pending.map(row=><li key={row.id}>{row.code} / {row.name}</li>)}</ul>
  <div className="modal-actions"><Button disabled={saving} onClick={()=>setSaveBefore(null)}>取消</Button><Button primary icon={FloppyDisk} disabled={saving} onClick={()=>run(async()=>{
   setSaving(true);
   try{for(const row of saveBefore.pending)await saveRow(row);setSaveBefore(null);await saveBefore.action()}finally{setSaving(false)}
  })}>{saving?'正在保存…':'保存并继续'}</Button></div>
 </Modal>}
 {describeCandidate&&<Modal title="反推提示词 · 候选预览" onClose={()=>setDescribeCandidate(null)}><p className="modal-intro">仅在点击“采用候选”后，才会替换这一行的参考提示词。</p><textarea className="candidate-text" rows={10} value={describeCandidate.text} onChange={e=>setDescribeCandidate(c=>({...c,text:e.target.value}))}/><div className="modal-actions"><Button onClick={()=>setDescribeCandidate(null)}>保留原内容</Button><Button primary icon={Check} onClick={()=>{const id=describeCandidate.rowId;setDrafts(prev=>({...prev,[id]:{...(prev[id]||state.rows.find(r=>r.id===id)),referencePrompt:describeCandidate.text}}));setDescribeCandidate(null);notify('候选已采用，请保存本行')}}>采用候选</Button></div></Modal>}
 {confirmDelete&&<Modal title={deleteTargets.length>1?'批量删除素材类型':'删除素材类型'} onClose={()=>{if(!deletingRows)setConfirmDelete(null)}}><p className="row-delete-intro">确认删除这 {deleteTargets.length} 个素材类型？原始素材、已生成文件和生成历史都会保留。</p><ul className="row-delete-list">{deleteTargets.map(row=><li key={row.id}><strong>{row.code}</strong><span>{row.name}</span></li>)}</ul>{deleteDirtyCount>0&&<p className="row-delete-warning">其中 {deleteDirtyCount} 行有尚未保存的配置，删除后这些修改也会一并移除。</p>}{deleteBlocked.length>0&&<p className="row-delete-warning" role="alert">其中 {deleteBlocked.length} 行仍有生成中或状态待确认的任务。请等待任务结束或确认任务状态后再删除，本次不会删除任何行。</p>}<div className="modal-actions"><Button disabled={deletingRows} onClick={()=>setConfirmDelete(null)}>取消</Button><Button danger icon={Trash} disabled={deletingRows||deleteBlocked.length>0} onClick={deleteRows}>{deletingRows?'正在删除…':deleteTargets.length>1?`删除这 ${deleteTargets.length} 个类型`:'删除类型'}</Button></div></Modal>}
 {folderImport&&<ImageFolderImport dirtyIds={Object.keys(drafts)} call={call} media={media} initialPlan={folderImport.plan} onClose={()=>setFolderImport(null)} onImported={ids=>{setRowSelected(ids);clearRowFilters();setRowOrder('manual');if(ids.length&&!drafts[activeId])setActiveId(ids[0])}}/>}
 {imageImportOpen&&<ImageBatchImport dirtyIds={Object.keys(drafts)} call={call} rows={state.rows} onClose={()=>setImageImportOpen(false)} onImported={ids=>{setRowSelected(ids);clearRowFilters();setRowOrder('manual');if(ids.length&&!drafts[activeId])setActiveId(ids[0])}}/>}
 </div>
}

function jobElapsed(job,clock){
 const waiting=job.status==='queued';
 const active=busyStatuses.includes(job.status);
 const from=Date.parse(waiting?(job.updatedAt||job.createdAt):job.startedAt);
 const to=active?clock:Date.parse(job.finishedAt);
 if(!Number.isFinite(from)||!Number.isFinite(to))return null;
 const seconds=Math.max(0,Math.floor((to-from)/1000));
 return `${waiting?'等待':active?'已用':'用时'} ${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
}

function ArchiveDetails({job}){
 const row=job.snapshot?.row;
 const image=job.result?.images?.[0];
 const batch=job.snapshot?.imageBatch;
 const date=value=>value?new Date(value).toLocaleString('zh-CN'):'—';
 const fields=[
  ['序号 / 类型',[row?.code,row?.name||job.archiveName].filter(Boolean).join(' / ')],
  ['图片编号',slotLabel(job)],['生成状态',statuses[job.status]||job.status],['尝试次数',job.attempt],
  ['提交时间',date(job.createdAt)],['生成用时',jobElapsed(job)],['归档时间',date(job.archivedAt)],
  ['模型',job.snapshot?.provider?.model],['本次配置数量',row?.count],
  ['图片比例',ratioOptions.find(([id])=>id===row?.ratio)?.[1]||row?.ratio],
  ['分辨率',row?.resolution],['请求尺寸',image?.requestedSize],['实际尺寸',image?.actualSize],
  ['项目规范',job.snapshot?.template?.name||'未使用'],['批次目录',batch?.folder||(batch&&`${batch.rowFolder} / ${batch.batchFolder}`)],
  ['原图文件',job.referencePaths?.map(basename).join('、')],['生成文件',job.localPath],
  ['导出位置',job.exportedPath],['参考提示词',row?.referencePrompt],['用户要求',row?.userPrompt],
 ];
 if(job.planningNote)fields.push(['差异方案',job.planningNote]);
 if(job.error)fields.push(['失败原因',job.error]);
 return <table className="archive-metadata"><thead><tr><th scope="col">标题</th><th scope="col">参数</th></tr></thead><tbody>
  {fields.map(([label,value])=><tr key={label}><th scope="row">{label}</th><td>{value||'—'}</td></tr>)}
 </tbody></table>;
}

function JobGallery({jobs,title,type,state,call,run,openImages,setVideoPreview,openEditor,archived=false}){
 const [filter,setFilter]=useState('all'),[regenerateCandidate,setRegenerateCandidate]=useState(null),[deleteCandidates,setDeleteCandidates]=useState(null),[details,setDetails]=useState(null);
 const selected=jobs.filter(j=>j.selected),failed=jobs.filter(j=>j.status==='failed'),success=jobs.filter(j=>j.status==='succeeded'&&j.localPath),visible=jobs.filter(j=>filter==='all'||filter==='selected'&&j.selected||filter==='failed'&&j.status==='failed');
 const timed=type==='image'||type==='video';
 const timing=timed&&visible.some(job=>busyStatuses.includes(job.status));
 const [clock,setClock]=useState(Date.now);
 useEffect(()=>{
  if(!timing)return;
  const tick=()=>setClock(Date.now());
  tick();
  const timer=setInterval(tick,1000);
  return ()=>clearInterval(timer);
 },[timing]);
 const select=(ids,value)=>run(()=>call('selectJobs',ids,value));
 const exportIds=ids=>run(async()=>{if(!ids.length)throw new Error('没有可下载的已完成文件');await call('exportJobs',ids)},'文件已导出至各任务的保存位置');
 return <section className="results"><div className="results-header"><h2>{title}</h2><div className="result-controls"><div className="result-tabs">{[['all',`全部(${jobs.length})`],['selected',`已选(${selected.length})`],['failed',`失败(${failed.length})`]].map(([v,l])=><button key={v} className={filter===v?'active':''} onClick={()=>setFilter(v)}>{l}</button>)}</div><label className="inline-check"><input type="checkbox" aria-label="选择全部结果" checked={!!visible.length&&visible.every(j=>j.selected)} onChange={e=>select(visible.map(j=>j.id),e.target.checked)}/>全选</label>{!archived&&<Button danger icon={ArrowsClockwise} disabled={!failed.length} onClick={()=>run(()=>call('retryJobs',failed.map(j=>j.id),{regenerate:false}),'失败任务已重新加入队列')}>重跑失败{failed.length?`(${failed.length})`:''}</Button>}{type==='image'&&!archived&&<Button icon={Trash} disabled={!selected.some(j=>j.status==='failed')} onClick={()=>setDeleteCandidates(selected.filter(j=>j.status==='failed').map(j=>j.id))}>删除选中失败</Button>}<Button icon={DownloadSimple} disabled={!selected.some(j=>j.status==='succeeded')} onClick={()=>exportIds(selected.filter(j=>j.status==='succeeded').map(j=>j.id))}>下载选中{selected.length?`(${selected.length})`:''}</Button><button className="icon-button" title="下载全部成功文件" aria-label="下载全部成功文件" disabled={!success.length} onClick={()=>exportIds(success.map(j=>j.id))}><DownloadSimple size={20}/></button></div></div>{!jobs.length?<Empty icon={type==='image'?ImageIcon:FilmStrip} title="生成结果将在这里呈现" description="提交任务后可查看真实进度，已完成文件会保存至本地。"/>:<div className={`result-grid ${type!=='image'?'video-grid':''}`}>{visible.map(j=>{const elapsed=timed?jobElapsed(j,clock):null;const showClock=elapsed&&busyStatuses.includes(j.status);const videoDownload=type==='video'&&j.result?.url&&!j.localPath;const stage=videoDownload&&j.status==='saving'?'下载并保存中':videoDownload&&j.status==='failed'?'已生成 · 取回失败':statuses[j.status]||j.status;return <article className={`result-card status-${j.status}`} key={j.id}><input className="card-check" type="checkbox" aria-label={`选择结果 ${j.slot||j.id.slice(0,6)}`} checked={!!j.selected} onChange={e=>select([j.id],e.target.checked)}/>{j.status==='succeeded'&&j.localPath?<>{type==='image'?<button className="result-image" aria-label={`放大结果 ${j.slot||''}`} onClick={()=>openImages(success.map(x=>({path:x.localPath,name:`图片 ${slotLabel(x)}`})),success.findIndex(x=>x.id===j.id))}><img src={media(j.localPath)} alt={j.prompt||'生成结果'} loading={timing?'eager':'lazy'} onLoad={e=>e.currentTarget.classList.add('image-revealed')}/><MagnifyingGlassPlus className="zoom-icon" size={26}/></button>:<video src={media(j.localPath)} controls preload="metadata"/>}<div className="card-overlay"><span>{slotLabel(j)}{elapsed&&<span className="image-elapsed">{elapsed}</span>}</span><div><button aria-label="打开文件位置" title="打开文件位置" onClick={()=>run(()=>bridge.reveal(j.localPath))}><FolderOpen size={17}/></button>{type!=='image'&&<button aria-label="同槽位重新生成" title="重新生成新尝试，保留原文件" onClick={()=>run(()=>call('retryJobs',[j.id],{regenerate:true}),'已建立新的生成尝试')}><ArrowsClockwise size={17}/></button>}{type!=='image'&&<button aria-label="放大视频" onClick={()=>setVideoPreview({path:j.localPath,name:title})}><Eye size={17}/></button>}</div></div></>:<div className="job-status">{j.status==='failed'?<WarningCircle size={38}/>:j.status==='unknown'?<Info size={38}/>:showClock?<span className="image-elapsed job-clock">{elapsed}</span>:<Spinner size={34} className={busyStatuses.includes(j.status)?'spinning':''}/>}<strong>{slotLabel(j)} · {stage}</strong>{elapsed&&!showClock&&<span className="image-elapsed">{elapsed}</span>}{j.error&&<p title={j.error}>{short(j.error,130)}</p>}{!archived&&['failed','unknown'].includes(j.status)&&<><Button danger={j.status==='failed'} onClick={()=>run(()=>call('retryJobs',[j.id],{regenerate:false}),'恢复任务已加入队列')}>{j.status==='unknown'?'查询并恢复':videoDownload?'重试下载':'重试'}</Button>{type==='image'&&j.status==='failed'&&<button className="text-button" onClick={()=>setDeleteCandidates([j.id])}>删除失败占位</button>}{j.status==='unknown'&&<button className="text-button" onClick={()=>setRegenerateCandidate(j)}>明确重新生成</button>}</>}</div>}{j.planningNote&&<div className="job-warning" title={j.planningNote}><Info size={12}/>{j.planningNote}</div>}{j.warning&&<div className="job-warning" title={j.warning}><WarningCircle size={12}/>{j.warning}</div>}{j.exportError&&<div className="job-export-error" role="status"><span><WarningCircle size={14}/>已生成，导出失败：{j.exportError}</span><button className="text-button" onClick={()=>exportIds([j.id])}>重试导出</button></div>}{type==='montage'&&j.status==='succeeded'&&j.localPath&&<div className="montage-result-actions"><Button icon={PencilSimple} onClick={()=>openEditor(j.id)}>编辑成片</Button></div>}<div className="job-meta" title={j.prompt}>{archived&&<button className="text-button archive-detail" onClick={()=>setDetails(j)}>明细</button>}{j.attempt>1?`第 ${j.attempt} 次尝试 · `:''}{short(j.prompt,75)||new Date(j.createdAt).toLocaleString('zh-CN')}</div></article>})}</div>}{jobs.length>0&&<p className="gallery-hint"><MagnifyingGlassPlus size={17}/>点击图片放大 · 滚轮缩放 · 拖动查看<span>成功文件不会被重生成覆盖</span></p>}{details&&<Modal title="图片生成明细" onClose={()=>setDetails(null)}><ArchiveDetails job={details}/></Modal>}{deleteCandidates&&<Modal title="删除失败占位" onClose={()=>setDeleteCandidates(null)}><p>释放 {deleteCandidates.length} 个失败占位。下次点击生成时，空位会采用当前行设置。</p><div className="modal-actions"><Button onClick={()=>setDeleteCandidates(null)}>取消</Button><Button danger onClick={()=>run(async()=>{await call('deleteFailedImages',deleteCandidates);setDeleteCandidates(null)},'失败占位已释放')}>确认删除</Button></div></Modal>}{regenerateCandidate&&<Modal title="确认建立新的生成请求" onClose={()=>setRegenerateCandidate(null)}><p>原任务状态未确认，可能已由服务商处理。请先核对服务商记录；继续会建立新的请求，可能再次计费，原记录和文件会保留。</p><div className="modal-actions"><Button onClick={()=>setRegenerateCandidate(null)}>返回核对</Button><Button primary onClick={()=>run(async()=>{await call('retryJobs',[regenerateCandidate.id],{regenerate:true});setRegenerateCandidate(null)},'新的生成请求已加入队列')}>我已核对，重新生成</Button></div></Modal>}</section>
}

const money=value=>Number.isFinite(value)?`¥${value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6})}`:'—';

function OairegboxLinks({call,run,pages=['home','register','token','topup']}){
 const labels={home:'OAIREGBOX 官网',register:'注册账号',token:'创建 API 令牌',topup:'充值中心',logs:'平台消费明细',profile:'个人设置'};
 return <div className="actions oai-links">{pages.map(page=><Button key={page} onClick={()=>run(()=>call('openOairegboxPage',page))}>{labels[page]}</Button>)}</div>;
}

function OairegboxAccount({data,provider,call,run}){
 return <div className="oai-account">
  <h3>OAIREGBOX 账户与用量</h3>
  {data?.account?<dl className="oai-metrics"><div><dt>账号</dt><dd>{data.account.name}</dd></div><div><dt>账号总余额</dt><dd>{money(data.account.balance)}</dd></div><div><dt>账号已消费</dt><dd>{money(data.account.used)}</dd></div></dl>:<p>{provider?.hasAccountToken?'暂未读到账户余额，请检查账号访问令牌。':'在全局设置中添加账号访问令牌，即可查看账号余额。'}</p>}
  {data?.token&&<p>调用令牌剩余 {data.token.unlimited?'不限额':money(data.token.remaining)} · 已用 {money(data.token.used)}</p>}
  {data?.account&&<><h4>最近消费记录</h4>{data.logs===null?<p>平台明细接口暂不可读，可打开控制台查看。</p>:data.logs.length?<table className="archive-metadata"><thead><tr><th>时间</th><th>模型</th><th>费用</th></tr></thead><tbody>{data.logs.map((item,i)=><tr key={i}><td>{item.time?new Date(item.time*1000).toLocaleString('zh-CN'):'—'}</td><td>{item.model||'—'}</td><td>{money(item.cost)}</td></tr>)}</tbody></table>:<p>暂无消费记录。</p>}</>}
  <OairegboxLinks call={call} run={run} pages={['topup','logs']}/>
 </div>;
}

function OairegboxSettings({settings,call,run}){
 const provider=settings.providers.find(p=>p.id===settings.bindings.video&&p.protocol==='oairegbox-video')
  ||settings.providers.find(p=>p.protocol==='oairegbox-video');
 const [result,setResult]=useState(null),[loading,setLoading]=useState(false);
 const refresh=()=>run(async()=>{
  setLoading(true);
  setResult(null);
  try{setResult({id:provider.id,data:await call('readOairegboxDashboard',provider.id)})}
  finally{setLoading(false)}
 });
 return <section className="surface setting-section">
  {provider&&<div className="setting-title"><p className="muted">当前账户连接 · {provider.name}</p><Button icon={ArrowsClockwise} disabled={loading} onClick={refresh}>{loading?'正在读取…':'刷新账户与用量'}</Button></div>}
  <OairegboxAccount provider={provider} data={result?.id===provider?.id?result?.data:null} call={call} run={run}/>
 </section>;
}

function ImagePromptSettings({rules,call,run}){
 const [draft,setDraft]=useState(null),[saving,setSaving]=useState(false);
 const saved=Object.fromEntries(Object.entries(IMAGE_PROMPT_RULES).map(([key,fallback])=>[key,rules?.[key]||fallback]));
 const values=draft||saved;
 const save=()=>run(async()=>{
  setSaving(true);
  try{await call('updateSettings',{imagePromptRules:values});setDraft(null)}
  finally{setSaving(false)}
 },'生图优化规则已保存');
 return <section className="surface setting-section">
  <div className="setting-title"><div><h3>生图提示词优化规则</h3><p>两种优化可分别维护系统提示词。清空某项并保存可恢复该项默认规则。</p></div></div>
  {Object.entries(imageRuleLabels).map(([key,label])=><Field key={key} label={label}><textarea aria-label={label+'系统提示词'} rows={6} maxLength={12000} disabled={saving} value={values[key]} onChange={e=>setDraft({...values,[key]:e.target.value})}/></Field>)}
  <div className="actions prompt-tools"><Button disabled={saving} onClick={()=>setDraft({...IMAGE_PROMPT_RULES})}>填入默认规则</Button><Button primary icon={FloppyDisk} disabled={!draft||saving} onClick={save}>保存优化规则</Button></div>
 </section>;
}

function VideoPage(props){
 const {state,call,run,choose,openImages,setVideoPreview,active}=props;
 const [config,setConfig]=useState({mode:'text',prompt:'',referencePaths:[],duration:5,ratio:'9:16',resolution:'768P',count:1,model:''});
 const [submitting,setSubmitting]=useState(false),[dashboard,setDashboard]=useState(null),[loading,setLoading]=useState(false),[referenceWarning,setReferenceWarning]=useState('');
 const provider=state.settings.providers.find(p=>p.id===state.settings.bindings.video);
 const oai=!provider||provider.protocol==='oairegbox-video';
 const providerId=provider?.id;
 const currentDashboard=dashboard?.id===providerId?dashboard?.data:null;
 const requestId=useRef(0);
 const refresh=async()=>{
  const seq=++requestId.current;
  setLoading(true);
  try{
   const data=await call('readOairegboxDashboard',providerId);
   if(seq===requestId.current)setDashboard({id:providerId,data});
  }catch{if(seq===requestId.current)setDashboard({id:providerId,data:null})}
  finally{if(seq===requestId.current)setLoading(false)}
 };
 useEffect(()=>{
  if(active&&oai)refresh();
  return()=>{requestId.current++}
 },[active,oai,providerId,provider?.hasAccountToken]);
 useEffect(()=>setConfig(c=>({...c,model:''})),[providerId]);
 const edit=patch=>setConfig(c=>({...c,...patch}));
 const model=h3Model(config.model)||h3Model(provider?.model)||H3_MODELS[0];
 const rate=currentDashboard?.prices[model.id]??model.price;
 const quote=h3Cost(rate,config.duration,config.count);
 const source=currentDashboard?.prices[model.id]===undefined?'文档参考价':currentDashboard.priceSource==='account'?'账号价格接口':'平台公开价格接口';
 const unavailable=Boolean(currentDashboard?.models&&!currentDashboard.models.includes(model.id));
 const limits=h3ReferenceLimits(model);
 const ratioChoices=config.mode==='image'?ratioOptions.filter(([id])=>id==='source'):
  oai?[...ratioOptions.filter(([id])=>id!=='source'),['21:9','21:9'],...(config.mode==='reference'?[['adaptive','自动适配']]:[])]:ratioOptions.filter(([id])=>id!=='source');
 const validateReferences=(selectedModel,paths)=>{
  const warning=oai?h3ReferenceError(selectedModel,config.mode,paths.map(h3ReferenceKind),currentDashboard?.models):'';
  if(warning)setReferenceWarning(warning);
  return !warning;
 };
 const selectModel=id=>{if(validateReferences(h3Model(id),config.referencePaths))edit({model:id})};
 const selectResolution=resolution=>{
  if(!oai){edit({resolution});return}
  selectModel(H3_MODELS.find(item=>item.resolution===resolution&&item.pro===model.pro).id);
 };
 const submit=()=>run(async()=>{
  if(!config.prompt.trim())throw new Error('请填写视频内容描述');
  if(config.mode!=='text'&&!config.referencePaths.length)throw new Error('请选择本次视频的参考素材');
  if(!Number.isInteger(config.duration)||config.duration<4||config.duration>15)throw new Error('视频时长应为 4–15 秒整数');
  if(!Number.isInteger(config.count)||config.count<1||config.count>20)throw new Error('视频数量应为 1–20');
  setSubmitting(true);
  try{await call('enqueueVideo',{...config,providerId,...(oai?{model:model.id,resolution:model.resolution}:{})})}
  finally{setSubmitting(false)}
 },'视频任务已加入队列');
 const references=videoReferences(config.referencePaths,config.mode);
 const pictures=references.filter(item=>item.type==='Picture').map(item=>item.path);
 return <div className="page-scroll"><div className="page-title"><div><span className="eyebrow">STEP 02 · VIDEO OPENING</span><h2>制作一个吸引人的开头</h2><p>文字、首帧图片或参考素材，选择适合这条视频的起点。</p></div><span className="connection-chip"><LinkIcon size={16}/>{provider?.name||'尚未绑定视频连接'}</span></div>
  <section className="video-config surface"><div className="video-form">
   <div className="mode-tabs">{[['text','文生视频','从文字开始'],['image','图生视频','首帧或首尾帧'],['reference',oai?'参考生视频':'参考视频',oai?'参考图、视频或音频':'沿用画面与运动']].map(([v,l,d])=><button key={v} className={config.mode===v?'active':''} onClick={()=>edit({mode:v,referencePaths:[],ratio:v==='image'?'source':'9:16'})}><strong>{l}</strong><small>{d}</small></button>)}</div>
   <Field label="视频内容描述"><textarea aria-label="视频内容描述" rows={5} value={config.prompt} placeholder="描述主体、动作、镜头运动、环境与氛围。" onChange={e=>edit({prompt:e.target.value})}/></Field>
   {active&&<PromptRewrite video input={{mode:config.mode,prompt:config.prompt,duration:config.duration,ratio:config.ratio,referencePaths:config.referencePaths}} call={call} run={run} onApply={prompt=>edit({prompt})}/>}
   {oai&&<Field label="OAIREGBOX H3 型号" hint="按秒计费"><select aria-label="OAIREGBOX H3 型号" value={model.id} onChange={e=>selectModel(e.target.value)}>{H3_MODELS.map(item=><option key={item.id} value={item.id} disabled={Boolean(currentDashboard?.models&&!currentDashboard.models.includes(item.id)&&item.id!==model.id)}>{item.label} · {money(currentDashboard?.prices[item.id]??item.price)}/秒{currentDashboard?.models&&!currentDashboard.models.includes(item.id)?' · 令牌不可用':''}</option>)}</select></Field>}
   <div className="video-options">
    <Field label="时长（秒）"><input aria-label="视频时长" type="number" min="4" max="15" value={config.duration||''} onChange={e=>edit({duration:+e.target.value})}/></Field>
    <Field label="分辨率"><select aria-label="视频分辨率" value={oai?model.resolution:config.resolution} onChange={e=>selectResolution(e.target.value)}><option>768P</option>{!oai&&<option>1080P</option>}<option>2K</option></select></Field>
    <Field label="画面比例"><select aria-label="视频比例" value={config.ratio} onChange={e=>edit({ratio:e.target.value})}>{ratioChoices.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></Field>
    <Field label="生成数量"><input aria-label="视频生成数量" type="number" min="1" max="20" value={config.count||''} onChange={e=>edit({count:+e.target.value})}/></Field>
   </div>
   {oai&&<section className="oai-quote" aria-label="视频费用估算">
    <div className="oai-quote-title"><strong>视频费用估算</strong><Button icon={ArrowsClockwise} onClick={refresh} disabled={loading}>{loading?'正在刷新…':'刷新价格与余额'}</Button></div>
    <dl className="oai-metrics"><div><dt>单价</dt><dd>{money(rate)}/秒</dd></div><div><dt>时长</dt><dd>{config.duration||'—'} 秒</dd></div><div><dt>每条</dt><dd>{money(quote?.perVideo)}</dd></div><div><dt>本批 {config.count||'—'} 条</dt><dd>{money(quote?.total)}</dd></div></dl>
    <p>{source}{currentDashboard?.prices[model.id]!==undefined&&currentDashboard?.refreshedAt?` · ${new Date(currentDashboard.refreshedAt).toLocaleString('zh-CN')}`:''} · 实扣以平台账单为准。</p>
    {quote&&Number.isFinite(currentDashboard?.account?.balance)&&quote.total>currentDashboard.account.balance&&<p className="red">本批估算超过最近读取的账号余额。</p>}
    {quote&&currentDashboard?.token&&!currentDashboard.token.unlimited&&Number.isFinite(currentDashboard.token.remaining)&&quote.total>currentDashboard.token.remaining&&<p className="red">本批估算超过最近读取的调用令牌额度。</p>}
    {unavailable&&<p className="red">当前调用令牌未开通此型号，请核对 minimax 分组。</p>}
    {!provider&&<p>请在全局设置中新建并绑定 OAIREGBOX 视频连接。</p>}
   </section>}
   <Button primary icon={Play} onClick={()=>{if(validateReferences(model,config.referencePaths))submit()}} disabled={!provider||submitting||unavailable||oai&&!quote}>{submitting?'正在提交…':'加入视频生成队列'}</Button>
  </div><div className="video-reference">
   {config.mode==='text'?<Empty icon={VideoCamera} title="从一句描述开始" description="具体的主体动作和镜头语言，能让视频更接近你的设想。"/>:<>
    <h3>参考素材{references.length?` · ${references.length} 项`:''}</h3>
    {references.length?<div className="video-reference-grid">{references.map(item=>{
     const name=basename(item.path);
     return <article className="video-reference-item" key={item.path}>
      <div className="reference-media">
       {item.type==='Picture'?<button aria-label={`放大 ${name}`} onClick={()=>openImages(pictures,pictures.indexOf(item.path))}><img src={media(item.path)} alt={name}/></button>:
        item.type==='Audio'?<audio src={media(item.path)} aria-label={name} controls preload="metadata"/>:
        <video src={media(item.path)} aria-label={name} controls preload="metadata"/>}
      </div>
      <div className="reference-caption"><span title={name}><strong>{item.role||item.label}</strong> {name}</span>
       {item.type==='Video'&&<button className="icon-button" aria-label={`放大 ${name}`} onClick={()=>setVideoPreview({path:item.path,name})}><MagnifyingGlassPlus size={20}/></button>}</div>
     </article>;
    })}</div>:<div className="reference-large"><div><UploadSimple size={40}/><p>选择本地参考素材</p></div></div>}
    <div className="actions"><Button icon={UploadSimple} onClick={()=>run(async()=>{
     const paths=await choose(config.mode==='image'?'image':oai?'h3-reference':'video');
     if(!paths?.length)return;
     const referencePaths=config.mode==='image'?(oai?paths:paths.slice(0,1)):oai?[...new Set([...config.referencePaths,...paths])]:paths;
     if(validateReferences(model,referencePaths))edit({referencePaths});
    })}>{config.mode==='image'?'选择首帧 / 尾帧':oai?'添加参考素材':'选择参考视频'}</Button>{references.length>0&&<Button onClick={()=>edit({referencePaths:[]})}>清空素材</Button>}</div>
    <p className="field-note">{oai&&config.mode==='reference'?`当前型号最多 ${limits.image} 图、${limits.video} 视频、${limits.audio} 音频。参考音频须搭配参考图。`:'按选择顺序使用素材。'}</p>
   </>}
  </div></section><JobGallery {...props} type="video" title="视频开头 · 生成记录" jobs={state.jobs.filter(j=>j.kind==='video')}/>
  {active&&referenceWarning&&<Modal title="参考素材超出型号支持范围" onClose={()=>setReferenceWarning('')}><p>{referenceWarning}</p><div className="modal-actions"><Button primary onClick={()=>setReferenceWarning('')}>知道了</Button></div></Modal>}</div>
}

function LibraryPage({state,call,run,choose,openImages,setVideoPreview}){
 const [kind,setKind]=useState('all'),[query,setQuery]=useState(''),[category,setCategory]=useState(''),[categoryFilter,setCategoryFilter]=useState('');
 const visible=state.assets.filter(a=>(kind==='all'||a.kind===kind)&&(!categoryFilter||a.category===categoryFilter)&&(!query||`${a.name} ${a.category}`.toLowerCase().includes(query.toLowerCase())));
 const importKind=k=>run(async()=>{const paths=await choose(k);if(paths?.length)await call('importFiles',paths,k,category.trim())},'素材已导入本地素材库');
 return <div className="page-scroll"><div className="page-title"><div><span className="eyebrow">YOUR LOCAL ASSETS</span><h2>素材库</h2><p>让每一份可复用的素材，都有位置。</p></div><div className="actions"><input aria-label="导入素材分类" placeholder="本次导入分类（可选）" value={category} onChange={e=>setCategory(e.target.value)}/><Button icon={ImageIcon} onClick={()=>importKind('image')}>导入图片</Button><Button icon={VideoCamera} onClick={()=>importKind('video')}>导入视频</Button><Button icon={MusicNote} onClick={()=>importKind('audio')}>导入音频</Button></div></div><section className="surface library-surface"><div className="library-toolbar"><div className="result-tabs">{[['all','全部素材'],['image','图片'],['video','视频'],['audio','音频']].map(([v,l])=><button className={v===kind?'active':''} onClick={()=>setKind(v)} key={v}>{l} <span>{state.assets.filter(a=>v==='all'||a.kind===v).length}</span></button>)}</div><select aria-label="素材分类筛选" value={categoryFilter} onChange={e=>setCategoryFilter(e.target.value)}><option value="">全部分类</option>{[...new Set(state.assets.map(a=>a.category).filter(Boolean))].map(c=><option key={c}>{c}</option>)}</select><div className="search-box"><MagnifyingGlassPlus size={18}/><input aria-label="搜索素材" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索名称或分类"/></div></div>{!visible.length?<Empty icon={Stack} title={state.assets.length?'没有匹配的素材':'搭建你的本地素材库'} description="导入图片、视频和音频，在混剪中按段组合使用。原始文件会保留。"/>:<div className="asset-grid">{visible.map(a=><article className="asset-card" key={a.id}><div className="asset-preview">{a.kind==='image'?<button aria-label={`查看素材 ${a.name}`} onClick={()=>openImages(visible.filter(x=>x.kind==='image').map(x=>({path:x.path,name:x.name})),visible.filter(x=>x.kind==='image').findIndex(x=>x.id===a.id))}><img src={media(a.path)} alt={a.name} loading="lazy"/><MagnifyingGlassPlus className="zoom-icon" size={25}/></button>:a.kind==='video'?<video controls preload="metadata" src={media(a.path)}/>:<div className="audio-asset"><MusicNote size={38}/><audio controls src={media(a.path)}/></div>}</div><div className="asset-caption"><strong title={a.name}>{a.name}</strong><span>{a.category||'未分类'} · {{image:'图片',video:'视频',audio:'音频'}[a.kind]}</span><button className="icon-button" aria-label={`打开 ${a.name} 所在位置`} onClick={()=>run(()=>bridge.reveal(a.path))}><FolderOpen size={18}/></button></div></article>)}</div>}</section></div>
}

function ImageTypeSettings({names,call,run}){
 const [editType,setEditType]=useState(null),[deleteType,setDeleteType]=useState(null),[busy,setBusy]=useState(false);
 const save=(list,message)=>run(async()=>{
  setBusy(true);
  try{await call('updateSettings',{imageTypeNames:list});setEditType(null);setDeleteType(null)}
  finally{setBusy(false)}
 },message);
 return <section className="surface setting-section">
  <div className="setting-title"><div><h3>图片分类</h3><p>为当前行配置维护常用类型。修改分类名称后，已保存的任务仍显示提交时的名称。</p></div><Button primary icon={Plus} onClick={()=>setEditType({original:'',name:''})}>新增分类</Button></div>
  {names.length?<div className="template-list">{names.map(name=><article className="template-card" key={name}>
   <div><h4>{name}</h4></div>
   <Button icon={PencilSimple} aria-label={`编辑分类 ${name}`} onClick={()=>setEditType({original:name,name})}>编辑</Button>
   <button className="icon-button" aria-label={`删除分类 ${name}`} onClick={()=>setDeleteType(name)}><Trash size={19}/></button>
  </article>)}</div>:<Empty title="暂无预设分类" description="可新增常用分类，或在当前行手工填写。"/>}
  {editType&&<Modal title={editType.original?'编辑分类':'新增分类'} onClose={()=>{if(!busy)setEditType(null)}}>
   <Field label="分类名称"><input aria-label="分类名称" autoFocus maxLength={60} value={editType.name} onChange={e=>setEditType({...editType,name:e.target.value})}/></Field>
   <div className="modal-actions"><Button disabled={busy} onClick={()=>setEditType(null)}>取消</Button><Button primary icon={FloppyDisk} disabled={busy||!editType.name.trim()} onClick={()=>save(editType.original?names.map(name=>name===editType.original?editType.name:name):[...names,editType.name],'图片分类已保存')}>保存分类</Button></div>
  </Modal>}
  {deleteType&&<Modal title="删除分类" onClose={()=>{if(!busy)setDeleteType(null)}}>
   <p>将「{deleteType}」从下拉选项移除。使用该分类的历史任务和图片会保留。</p>
   <div className="modal-actions"><Button disabled={busy} onClick={()=>setDeleteType(null)}>取消</Button><Button danger icon={Trash} disabled={busy} onClick={()=>save(names.filter(name=>name!==deleteType),'图片分类已删除')}>确认删除分类</Button></div>
  </Modal>}
 </section>;
}

function ImageRequestSettings({presets,call,run}){
 const [draft,setDraft]=useState(null),[deleting,setDeleting]=useState(null),[busy,setBusy]=useState(false);
 const save=(items,message)=>run(async()=>{
  setBusy(true);
  try{await call('updateSettings',{imageRequestPresets:items});setDraft(null);setDeleting(null)}
  finally{setBusy(false)}
 },message);
 return <section className="surface setting-section">
  <div className="setting-title"><div><h3>用户要求预设</h3><p>保存常用的改图要求。套用时会复制文字到当前行，可以继续修改。</p></div><Button primary icon={Plus} onClick={()=>setDraft({id:uid(),name:'',text:''})}>新增预设</Button></div>
  {presets.length?<div className="template-list">{presets.map(preset=><article className="template-card" key={preset.id}>
   <div><h4>{preset.name}</h4><p>{preset.text}</p></div>
   <Button icon={PencilSimple} aria-label={`编辑预设 ${preset.name}`} onClick={()=>setDraft({...preset})}>编辑</Button>
   <button className="icon-button" aria-label={`删除预设 ${preset.name}`} onClick={()=>setDeleting(preset)}><Trash size={19}/></button>
  </article>)}</div>:<Empty title="暂无用户要求预设" description="新增预设后，即可在图片素材的当前行配置中选择。"/>}
  {draft&&<Modal title={presets.some(item=>item.id===draft.id)?'编辑预设':'新增预设'} onClose={()=>{if(!busy)setDraft(null)}}>
   <Field label="预设名称"><input aria-label="预设名称" autoFocus maxLength={60} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></Field>
   <Field label="要求内容"><textarea aria-label="要求内容" rows={6} maxLength={12000} value={draft.text} onChange={e=>setDraft({...draft,text:e.target.value})}/></Field>
   <div className="modal-actions"><Button disabled={busy} onClick={()=>setDraft(null)}>取消</Button><Button primary icon={FloppyDisk} disabled={busy||!draft.name.trim()||!draft.text.trim()} onClick={()=>save(presets.some(item=>item.id===draft.id)?presets.map(item=>item.id===draft.id?draft:item):[...presets,draft],'用户要求预设已保存')}>保存预设</Button></div>
  </Modal>}
  {deleting&&<Modal title="删除用户要求预设" onClose={()=>{if(!busy)setDeleting(null)}}>
   <p>将「{deleting.name}」从预设列表移除。已套用到各行的文字会保留。</p>
   <div className="modal-actions"><Button disabled={busy} onClick={()=>setDeleting(null)}>取消</Button><Button danger icon={Trash} disabled={busy} onClick={()=>save(presets.filter(item=>item.id!==deleting.id),'用户要求预设已删除')}>确认删除预设</Button></div>
  </Modal>}
 </section>;
}

function SettingsPage({state,call,run,chooseFolder,updateSettings,notify,initialSection}){
 const {settings}=state,[template,setTemplate]=useState(null),[tab,setTab]=useState(initialSection?.tab||initialSection||'connections');
 useEffect(()=>{if(initialSection)setTab(initialSection.tab||initialSection)},[initialSection]);
 return <div className="page-scroll settings-page" data-testid="settings-page"><div className="page-title"><div><span className="eyebrow">STUDIO PREFERENCES</span><h2>全局设置</h2><p>连接、规范与工作习惯，独立管理。</p></div></div><div className="settings-layout"><aside className="settings-menu">{[['connections',LinkIcon,'模型服务'],['speech',MusicNote,'配音预设'],['templates',FileImage,'项目规范'],['imageTypes',ImageIcon,'图片分类'],['imageRequests',PencilSimple,'用户要求预设'],['imagePromptRules',Sparkle,'生图优化规则'],['preferences',Gear,'工作空间']].map(([v,Icon,l])=><button className={tab===v?'active':''} key={v} onClick={()=>setTab(v)}><Icon size={20}/>{l}<CaretRight size={16}/></button>)}</aside><div className="settings-main">{tab==='connections'&&<ModelConnections settings={settings} call={call} run={run} notify={notify} renderAccount={<OairegboxSettings settings={settings} call={call} run={run}/>}/>}
 {tab==='speech'&&<SpeechSettings settings={settings} call={call} run={run}/>}
 {tab==='imagePromptRules'&&<ImagePromptSettings rules={settings.imagePromptRules} call={call} run={run}/>}
 {tab==='templates' &&<section className="surface setting-section"><div className="setting-title"><div><h3>项目规范模板</h3><p>规范独立于参考图描述和本次修改要求，可在每行单独选择。</p></div><Button primary icon={Plus} onClick={()=>setTemplate({id:uid(),name:'',text:''})}>新增规范</Button></div><Field label="默认项目规范" hint="新增类型时采用，可在行内改选"><select aria-label="默认项目规范" value={settings.defaultTemplateId||''} onChange={e=>updateSettings({defaultTemplateId:e.target.value})}><option value="">无默认规范</option>{settings.templates.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><div className="template-list">{settings.templates.map(t=><article key={t.id} className="template-card"><div><h4>{t.name}</h4><p>{t.text}</p></div><Button icon={PencilSimple} onClick={()=>setTemplate({...t})}>编辑</Button><button className="icon-button" aria-label={`删除规范 ${t.name}`} onClick={()=>run(()=>call('updateSettings',{templates:settings.templates.filter(x=>x.id!==t.id)}),'项目规范已删除')}><Trash size={19}/></button></article>)}{!settings.templates.length&&<Empty title="还没有项目规范" description="将通用的画面、品牌或内容要求保存为可复用模板。"/>}</div></section>}
 {tab==='imageTypes'&&<ImageTypeSettings names={settings.imageTypeNames||[]} call={call} run={run}/>}
 {tab==='imageRequests'&&<ImageRequestSettings presets={settings.imageRequestPresets||[]} call={call} run={run}/>}
 {tab==='preferences'&&<section className="surface setting-section"><div className="setting-title"><div><h3>工作空间与队列</h3><p>任务和配置保存在本机，重启后自动恢复。</p></div></div><div className="preference-row"><div><strong>输出根目录</strong><p>{settings.outputDir||'尚未设置，请选择文件夹'}</p></div><Button icon={FolderOpen} onClick={()=>run(async()=>{const path=await chooseFolder();if(path)await call('updateSettings',{outputDir:path})})}>选择文件夹</Button></div><div className="preference-row"><div><strong>自动导出</strong><p>生成成功后，将结果文件保存至输出目录。</p></div><button className={`switch ${settings.autoExport?'on':''}`} role="switch" aria-label="设置自动导出" aria-checked={settings.autoExport} onClick={()=>updateSettings({autoExport:!settings.autoExport})}/></div><div className="binding-grid concurrency-fields">{[['concurrency','图片生成并发',100],['videoConcurrency','视频生成并发',20],['renderConcurrency','混剪渲染并发',10],['speechConcurrency','语音合成并发',4]].map(([key,label,max])=><Field key={key} label={label} hint={`1–${max}`}><input aria-label={label} type="number" min="1" max={max} defaultValue={settings[key]} onBlur={e=>{const v=+e.target.value;if(!Number.isInteger(v)||v<1||v>max){e.target.value=settings[key];return}updateSettings({[key]:v})}}/></Field>)}</div><div className="preference-row"><div><strong>显示当前行配置栏</strong><p>隐藏后，批量任务表格和结果区会扩展显示。</p></div><button className={`switch ${settings.panelOpen?'on':''}`} role="switch" aria-label="显示当前行配置栏" aria-checked={settings.panelOpen} onClick={()=>updateSettings({panelOpen:!settings.panelOpen})}/></div></section>}
 </div></div>{template&&<Modal title="编辑项目规范" onClose={()=>setTemplate(null)}><div className="modal-form"><Field label="规范名称"><input aria-label="规范名称" value={template.name} onChange={e=>setTemplate(t=>({...t,name:e.target.value}))}/></Field><Field label="规范内容"><textarea aria-label="规范内容" rows={9} value={template.text} onChange={e=>setTemplate(t=>({...t,text:e.target.value}))} placeholder="填写始终适用的项目要求…"/></Field></div><div className="modal-actions"><Button onClick={()=>setTemplate(null)}>取消</Button><Button primary icon={FloppyDisk} onClick={()=>run(async()=>{if(!template.name.trim()||!template.text.trim())throw new Error('请填写规范名称和内容');await call('updateSettings',{templates:[...settings.templates.filter(t=>t.id!==template.id),template]});setTemplate(null)},'项目规范已保存')}>保存规范</Button></div></Modal>}</div>
}
