import React, {useEffect, useRef, useState} from 'react';
import {DownloadSimple, FolderOpen, Image as ImageIcon, MagnifyingGlassPlus, X} from '@phosphor-icons/react';
import {emptyTemplateDraft,templateEditReferences} from '../shared/template-edit.mjs';
import './template-studio.css';

const bridge = window.studio;
const basename = file => file?.split(/[\\/]/).pop() || '';
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const coordinates = box => ({
  left: box.x*100+'%', top: box.y*100+'%', width: box.w*100+'%', height: box.h*100+'%',
});
const labels = {queued:'等待中', planning:'准备中', running:'正在生成', saving:'正在保存', succeeded:'已完成', failed:'失败', cancelled:'已取消', unknown:'状态待确认'};

function RegionCanvas({draft, selected, select, change, remove, imageLoaded}) {
  const layer = useRef(null), gesture = useRef(null);
  const [preview,setPreview] = useState(null), [failedPath,setFailedPath] = useState('');
  const point = event => {
    const rect = layer.current.getBoundingClientRect();
    return {x:clamp((event.clientX-rect.left)/rect.width,0,1), y:clamp((event.clientY-rect.top)/rect.height,0,1)};
  };
  const shape = (g, end) => {
    const {start, box, action, corner} = g;
    if (action === 'move') return {...box, x:clamp(box.x+end.x-start.x,0,1-box.w), y:clamp(box.y+end.y-start.y,0,1-box.h)};
    const anchor = action === 'resize' ? {
      x:corner.endsWith('e') ? box.x : box.x+box.w, y:corner.startsWith('s') ? box.y : box.y+box.h,
    } : start;
    return {...box, x:Math.min(anchor.x,end.x), y:Math.min(anchor.y,end.y), w:Math.abs(anchor.x-end.x), h:Math.abs(anchor.y-end.y)};
  };
  const start = event => {
    if (event.button !== 0 || gesture.current || !layer.current || failedPath === draft.basePath) return;
    const item = draft.regions.find(region => region.id === event.target.closest('[data-region]')?.dataset.region);
    const corner = event.target.dataset.corner;
    const action = !event.shiftKey && item ? (corner ? 'resize' : 'move') : 'draw';
    if (action === 'draw' && draft.regions.length >= 12) return;
    const from = point(event);
    const box = action === 'draw' ? {id:crypto.randomUUID(), ...from, w:0, h:0, note:'', referencePath:''} : item;
    if (action !== 'draw') select(box.id);
    layer.current.focus({preventScroll:true});
    gesture.current = {pointerId:event.pointerId, action, start:from, box, corner};
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const end = event => {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointerId) return;
    gesture.current = null;
    setPreview(null);
    if (event.type === 'pointercancel') return;
    const box = shape(g,point(event));
    if (box.w < .007 || box.h < .007) return;
    if (g.action === 'draw') {
      change([...draft.regions,box]);
    } else change(draft.regions.map(item => item.id === box.id ? box : item));
    select(box.id);
  };
  function keyboard(event) {
    if(event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
       gesture.current || failedPath===draft.basePath)return;
    const region=draft.regions.find(item=>item.id===(event.target.closest('[data-region]')?.dataset.region || selected));
    if(event.key==='Delete' && region){
      event.preventDefault();if(!event.repeat){layer.current.focus();remove(region.id);}return;
    }
    if(event.key==='Insert' || (event.key==='Enter' && event.target===layer.current)){
      event.preventDefault();if(event.repeat || draft.regions.length>=12)return;
      const id=crypto.randomUUID();
      change([...draft.regions,{id,x:.35,y:.35,w:.3,h:.3,note:'',referencePath:''}]);select(id);
      layer.current.focus({preventScroll:true});return;
    }
    const directions={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    const delta=directions[event.key];
    if(!delta || !region)return;
    event.preventDefault();
    const [dx,dy]=delta;
    const moved=event.shiftKey?{w:clamp(region.w+dx*.01,.01,1-region.x),h:clamp(region.h+dy*.01,.01,1-region.y)}:
      {x:clamp(region.x+dx*.01,0,1-region.w),y:clamp(region.y+dy*.01,0,1-region.h)};
    change(draft.regions.map(item=>item.id===region.id?{...item,...moved}:item));
  }
  const shown = preview ? [...draft.regions.filter(r => r.id !== preview.id), preview] : draft.regions;
  return <div className="template-artboard">
    {draft.basePath ? <div className="template-surface" ref={layer} onPointerDown={start} tabIndex={0} role="group" aria-label="圈选画布"
      aria-keyshortcuts="Insert Delete" onKeyDown={keyboard}
      onPointerMove={event => {if (gesture.current?.pointerId===event.pointerId) setPreview(shape(gesture.current, point(event)));}}
      onPointerUp={end} onPointerCancel={end}>
      <img src={bridge.mediaUrl(draft.basePath)} alt="模板调试底图" draggable="false"
        onError={()=>setFailedPath(draft.basePath)} onLoad={e=>{
          const {naturalWidth:width,naturalHeight:height}=e.target;
          layer.current.style.setProperty('--image-ratio',String(width/height));
          setFailedPath('');imageLoaded({path:draft.basePath,width,height});
        }}/>
      {failedPath===draft.basePath && <span role="alert">无法打开底图，请重新选择图片。</span>}
      {shown.map(box => <div key={box.id} className={'template-region'+(box.id===selected?' active':'')}
        role="button" tabIndex={0} aria-label={'选区 '+(draft.regions.findIndex(r=>r.id===box.id)+1 || draft.regions.length+1)}
        aria-pressed={box.id===selected} onFocus={()=>select(box.id)} aria-keyshortcuts="Delete"
        style={coordinates(box)} data-region={box.id}><strong>{draft.regions.findIndex(r=>r.id===box.id)+1 || draft.regions.length+1}</strong>
        {selected===box.id && ['nw','ne','sw','se'].map(corner=><span key={corner} className={'template-handle '+corner} data-corner={corner}/>)}
      </div>)}
    </div> : <div className="template-empty"><strong>选择一张封面开始调试</strong><p>可以使用参考封面，也可以选用已有的生成结果。</p></div>}
  </div>;
}

function startingDraft(state,batchEdit) {
  if(!batchEdit) return state.templateDraft || emptyTemplateDraft();
  const prior=state.templateCombinationDraft;
  const sources={originalReferencePaths:batchEdit.originalReferencePaths || batchEdit.referencePaths || [],
    ...(batchEdit.kind==='batch-result'?{kind:'batch-result'}:{})};
  if(prior?.combination?.id===batchEdit.id && prior.combination.entryPath===batchEdit.path &&
     prior.combination.entryPrompt===String(batchEdit.prompt || '')) return {...prior,combination:{...prior.combination,...sources}};
  return {...emptyTemplateDraft(),basePath:batchEdit.path,combination:{id:batchEdit.id,entryPath:batchEdit.path,
    entryPrompt:String(batchEdit.prompt || ''),prompt:String(batchEdit.prompt || ''),
    ...sources}};
}

export default function TemplateStudio(props) {
  const context=props.batchEdit;
  return <>
    <div className="template-editor-route" hidden={Boolean(context)}><TemplateEditor {...props} batchEdit={null}/></div>
    {context && <div className="template-editor-route"><TemplateEditor key={JSON.stringify([context.id,context.path,context.prompt])} {...props}/></div>}
  </>;
}

function TemplateEditor({state, call, onUseTemplate, registerFlush,openImages,batchEdit,onReturnToBatch,onCancelBatchEdit}) {
  const [draft,setDraft] = useState(()=>startingDraft(state,batchEdit));
  const [selected,select] = useState(''), [imageInfo,setImageInfo] = useState(null);
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [saved,setSaved] = useState('已保存');
  const [confirmRetry,setConfirmRetry] = useState('');
  const [fileMenu,setFileMenu] = useState(''), [downloadMessage,setDownloadMessage] = useState('');
  const [removedId,setRemovedId] = useState('');
  const [removedArea,setRemovedArea] = useState(null);
  const downloads=useRef(new Set()), menuElement=useRef(null);
  const current=useRef(draft), timer=useRef(null), dirty=useRef(false), alive=useRef(true), submitting=useRef(false);
  const writes=useRef(Promise.resolve());
  const caller=useRef(call);
  caller.current=call;
  const flush = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return writes.current;
    const value=current.current;
    dirty.current=false;
    const pending=writes.current.catch(()=>{}).then(()=>caller.current('saveTemplateDraft',value));
    writes.current=pending;
    pending.then(()=>{
      if (alive.current && value===current.current) setSaved('已保存');
    },e=>{
      if (value===current.current) dirty.current=true;
      if (alive.current) {setError(e.message);setSaved('保存失败');}
    });
    return pending;
  };
  useEffect(()=>registerFlush?.(batchEdit?'template-combination':'template',flush),[registerFlush,Boolean(batchEdit)]);
  useEffect(()=>{
    if(!fileMenu)return;
    const close=e=>{if(!menuElement.current?.contains(e.target)) setFileMenu('');};
    const escape=e=>{if(e.key==='Escape'){e.preventDefault();setFileMenu('');}};
    window.addEventListener('pointerdown',close);
    window.addEventListener('keydown',escape);
    menuElement.current?.querySelector('[role=menuitem]')?.focus();
    return ()=>{window.removeEventListener('pointerdown',close);window.removeEventListener('keydown',escape);};
  },[fileMenu]);
  useEffect(()=>{
    alive.current=true;
    return ()=>{alive.current=false;flush().catch(()=>{});};
  },[]);
  function edit(patch) {
    const next={...current.current,...patch};
    current.current=next; dirty.current=true; setDraft(next); setSaved('保存中');setError('');
    clearTimeout(timer.current);
    timer.current=setTimeout(()=>flush().catch(()=>{}),400);
  }
  const area = draft.regions.find(r=>r.id===selected) || draft.regions.at(-1);
  function removeArea(id){
    const regions=current.current.regions,index=regions.findIndex(r=>r.id===id);
    if(index<0)return;
    const kept=regions.filter(r=>r.id!==id);
    setRemovedArea({region:regions[index],index});
    edit({regions:kept});select(kept[Math.min(index,kept.length-1)]?.id || '');
  }
  function restoreArea(){
    if(!removedArea || current.current.regions.length>=12)return;
    const regions=[...current.current.regions];
    regions.splice(removedArea.index,0,removedArea.region);
    edit({regions});select(removedArea.region.id);setRemovedArea(null);
  }
  function updateArea(id,patch) {
    edit({regions:current.current.regions.map(item=>item.id===id ? {...item,...patch} : item)});
  }
  function setBase(file) {
    if (!file || file===current.current.basePath) return;
    edit({basePath:file,instruction:'',regions:[]});select('');setRemovedArea(null);
  }
  async function pick(region) {
    try {
      const files=await bridge.chooseFiles('image');
      if (!files?.length) return;
      if (region) updateArea(region.id,{referencePath:files[0]}); else setBase(files[0]);
    } catch(e) {setError(e.message);}
  }
  const allJobs=state.jobs || [];
  const recent=allJobs.filter(job=>job.kind==='image' && job.status==='succeeded' && job.localPath &&
    job.snapshot?.feature!=='template-edit').slice().reverse();
  const allHistory=allJobs.filter(job=>job.snapshot?.feature==='template-edit' &&
    (job.snapshot.templateEdit?.combinationId || '')===(batchEdit?.id || '')).slice().reverse();
  const history=allHistory.filter(job=>!job.templateResultHidden);
  const completed=history.filter(job=>job.status==='succeeded' && job.localPath);
  const lastAttempts=new Map();
  for(const job of allHistory) if(!lastAttempts.has(job.rowId)) lastAttempts.set(job.rowId,job.id);
  const waiting = history.some(job=>['queued','planning','running','saving'].includes(job.status));
  const finished = batchEdit?.kind==='batch-result';
  const pendingImageEdit = Boolean(batchEdit && (draft.regions.length || draft.instruction.trim()));
  const referencePlan = templateEditReferences(draft);
  const valid = draft.basePath && (draft.regions.length ? draft.regions.every(r=>r.note.trim() || r.referencePath) : draft.instruction.trim() || referencePlan.usePrompt);
  async function generate() {
    if (submitting.current || waiting || !valid) return;
    submitting.current=true;setBusy(true);setError('');
    try {
      await flush();
      await call('enqueueTemplateEdit',{...current.current,requestId:crypto.randomUUID()});
    } catch(e) {setError(e.message);} finally {submitting.current=false;if(alive.current)setBusy(false);}
  }
  async function handoff(file,generatedPrompt) {
    try {
      await flush();
      if(batchEdit) await onReturnToBatch({id:batchEdit.id,path:file,prompt:finished ? generatedPrompt : current.current.combination.prompt});
      else await onUseTemplate(file);
    } catch(e) {setError(e.message);}
  }
  async function retry(job,regenerate=false) {
    setConfirmRetry('');
    try {await call('retryJobs',[job.id],{regenerate});} catch(e){setError(e.message);}
  }
  async function download(job) {
    if(!job || downloads.current.has(job.id))return;
    setFileMenu('');setDownloadMessage('');setError('');downloads.current.add(job.id);
    try {
      const result=await call('downloadTemplateResult',job.id);
      if(result) setDownloadMessage('已下载到 '+result);
    } catch(e){setError(e.message);}
    finally {downloads.current.delete(job.id);}
  }
  async function setOutput(action) {
    setError('');setDownloadMessage('');
    try {await call('templateOutputDirectory',action);} catch(e){setError(e.message);}
  }
  async function showResult(id,visible) {
    try {
      await call('setTemplateResultVisibility',id,visible);
      setFileMenu('');setRemovedId(visible?'':id);
    } catch(e){setError(e.message);}
  }
  const overallField=<label className="field"><span className="field-label">{draft.regions.length?'选区补充要求（可选）':'整图修改要求'}</span>
    <textarea aria-label="整体修改意见" rows={draft.regions.length?2:4} value={draft.instruction} onChange={e=>edit({instruction:e.target.value})}
      placeholder={draft.regions.length?'例如：两个选区都保留原来的配色':'例如：标题上移一点，整体配色更接近参考封面。'}/></label>;
  return <section className="template-studio" aria-label="模板调试">
    <header className="template-heading"><div><h2>{batchEdit?'调试当前组合':'模板调试'}</h2></div>
      <div className="template-toolbar">{batchEdit && <button className="button" onClick={async()=>{try{await flush();await onCancelBatchEdit();}catch(e){setError(e.message);}}}>返回批量替换</button>}
        {(pendingImageEdit || (finished && referencePlan.changedPrompt)) && <span className="template-apply-hint" id="template-apply-hint">请先生成修改，再从左侧结果应用到组合。</span>}
        {!finished && <button className="button primary" disabled={!draft.basePath || pendingImageEdit} aria-describedby={pendingImageEdit?'template-apply-hint':undefined} onClick={()=>handoff(draft.basePath)}>{batchEdit?'应用到当前组合':'用当前底图批量替换'}</button>}</div>
    </header>
    {error && <div className="template-error" role="alert">{error} {saved==='保存失败' && <button className="button" onClick={()=>flush().catch(()=>{})}>重试保存</button>}</div>}
    {downloadMessage && <p className="template-download-message" role="status">{downloadMessage}</p>}
    <div className="template-columns">
      <aside className="template-results" aria-label="调试结果">
        <header><h3>调试结果</h3><span>{completed.length} 张已完成</span></header>
        {removedId && <div className="template-removed" role="status"><span>已从列表移除</span><button className="text-button" onClick={()=>showResult(removedId,true)}>撤销移除</button></div>}
        {!history.length && <div className="template-list-empty"><ImageIcon size={24} aria-hidden="true"/><p>提交调试后在这里查看进度和图片。</p></div>}
        <div className="template-history-list">{history.map(job=><article key={job.id} className="template-history-item" aria-label={labels[job.status]+'的调试任务'}>
          <div className="template-result-meta"><strong className={'template-state '+job.status}>{labels[job.status] || job.status}</strong>
            <span>{job.snapshot.templateEdit.regions.length?'圈选修改':'整图修改'}</span><time dateTime={job.createdAt} title={new Date(job.createdAt).toLocaleString('zh-CN')}>{new Date(job.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time>
            {['succeeded','failed','cancelled'].includes(job.status) && <button className="template-remove" title="从列表移除，原文件保留" aria-label="从列表移除" onClick={()=>showResult(job.id,false)}><X size={15}/></button>}</div>
          {job.localPath && <div className="template-thumb-wrap"><button className="template-thumb" aria-label="放大调试结果" aria-haspopup="dialog"
            onClick={()=>openImages(completed.map(j=>j.localPath),completed.findIndex(j=>j.id===job.id),{onDownload:file=>download(completed.find(item=>item.localPath===file))})}
            onContextMenu={e=>{e.preventDefault();setFileMenu(job.id);}}>
            <img loading="lazy" src={bridge.mediaUrl(job.localPath)} alt="模板调试结果"/><MagnifyingGlassPlus aria-hidden="true" size={20}/>
          </button>{fileMenu===job.id && <div className="template-context-menu" role="menu" ref={menuElement}>
            <button role="menuitem" onClick={()=>download(job)}><DownloadSimple size={17} aria-hidden="true"/>下载图片</button>
          </div>}</div>}
          <p className="template-source-caption" title={job.snapshot.templateEdit.originalPath}>{basename(job.snapshot.templateEdit.originalPath)}</p>
          {job.error && <p className="template-error">{job.error}</p>}
          {job.exportError && <p className="template-error">输出目录写入失败，图片已保存在本机。{job.exportError}</p>}
          {job.status==='succeeded' && <div className="template-result-actions"><button className="button" onClick={()=>download(job)}>下载图片</button>
            <button className="button" onClick={()=>setBase(job.localPath)}>继续调试</button>
            <button className="button template-use" onClick={()=>handoff(job.localPath,job.snapshot.templateEdit.combinationPrompt)}>{batchEdit?'将此图应用到当前组合':'用此模板批量替换'}</button></div>}
          {job.status==='failed' && lastAttempts.get(job.rowId)===job.id &&
            <button className="button" onClick={()=>retry(job)}>{job.result?'重试保存':'重试调试'}</button>}
          {lastAttempts.get(job.rowId)===job.id && (job.status==='unknown' || (job.status==='failed' && job.result)) &&
            (confirmRetry===job.id ? <div><p>服务商可能已计费。核对服务记录后，可重新提交这次调试。</p><div className="template-toolbar">
              <button className="button" onClick={()=>setConfirmRetry('')}>取消</button>
              <button className="button primary" onClick={()=>retry(job,true)}>已核对，重新生成</button></div></div> :
              <button className="button" onClick={()=>setConfirmRetry(job.id)}>核对后重新生成</button>)}
        </article>)}</div>
      </aside>
      <section className="template-panel template-preview">
        <div className="template-toolbar template-canvas-heading"><div><span className="template-image-meta">当前底图 {imageInfo?.path===draft.basePath && `· ${imageInfo.width} × ${imageInfo.height}`}</span><strong title={draft.basePath}>{basename(draft.basePath)||'尚未选择图片'}</strong></div>
          <button className="button" onClick={()=>pick()}>选择底图</button>
          {!batchEdit && recent.length>0 && <select aria-label="从生成结果选择底图" value="" onChange={e=>setBase(e.target.value)}>
            <option value="">从生成结果选择</option>{recent.map(job=><option value={job.localPath} key={job.id}>{job.snapshot?.row?.name || '图片'} · {basename(job.localPath)}</option>)}</select>}
        </div>
        <RegionCanvas key={draft.basePath} draft={draft} selected={area?.id} select={select} remove={removeArea}
          imageLoaded={setImageInfo} change={regions=>edit({regions})}/>
        {draft.basePath && <div className="template-hint"><span>拖动圈选 · 拖四角调整 · <kbd>Del</kbd> 删除</span>
          {removedArea && <button className="text-button" disabled={draft.regions.length>=12} onClick={restoreArea}>撤销删除选区</button>}
          <details><summary>键盘与重叠选区</summary><p>画布聚焦后，按 Insert 新建选区，方向键移动，Shift + 方向键调整大小。按住 Shift 拖动可新建重叠选区。</p></details></div>}
      </section>
      <section className="template-panel template-controls">
        <div className="template-inspector-heading"><h3>编辑要求</h3><span>{draft.regions.length?draft.regions.length+' 个选区':'整图修改'}</span></div>
        <div className="template-control-fields">
        {draft.combination && <label className="field"><span className="field-label">当前组合生成提示词</span>
          <textarea aria-label="当前组合生成提示词" rows={5} value={draft.combination.prompt} onChange={e=>edit({combination:{...current.current.combination,prompt:e.target.value}})}/></label>}
        {area && <><div className="template-area-tabs" aria-label="圈选区域">
          {draft.regions.map((item,i)=><button key={item.id} className={'button'+(item.id===area.id?' selected':'')} aria-pressed={item.id===area.id}
            onKeyDown={e=>{if(e.key==='Delete' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing){e.preventDefault();if(!e.repeat){const next=e.currentTarget.nextElementSibling||e.currentTarget.previousElementSibling;removeArea(item.id);next?.focus();}}}}
            onClick={()=>select(item.id)}>区域 {i+1}</button>)}</div>
          <div className="template-area-editor"><div className="template-toolbar"><strong>区域 {draft.regions.indexOf(area)+1}</strong>
            <button className="button" onClick={()=>removeArea(area.id)}>删除本区</button></div>
            <label className="field"><span className="field-label">本区修改要求</span><textarea rows={3} aria-label="本区修改要求" value={area.note}
              placeholder="例如：手机内换成咨询截图，保留手机边框。" onChange={e=>updateArea(area.id,{note:e.target.value})}/></label>
            <div className="template-toolbar"><button className="button" onClick={()=>pick(area)}>{area.referencePath?'更换本区参考图':'添加本区参考图'}</button>
              {area.referencePath && <button className="button" onClick={()=>updateArea(area.id,{referencePath:''})}>移除参考图</button>}</div>
            {area.referencePath && <div className="template-reference"><img alt="本区参考图" src={bridge.mediaUrl(area.referencePath)}/><span>{basename(area.referencePath)}</span></div>}
          </div></>}
        {overallField}
        <div className="template-output-setting">
          <span className="field-label"><FolderOpen aria-hidden="true" size={17}/>调试图片输出目录</span>
          <span className="template-output-path" title={state.settings.templateOutputDir}>{state.settings.templateOutputDir || '未设置 · 下载时选择目录'}</span>
          <div className="template-toolbar"><button className="button" onClick={()=>setOutput('choose')}>{state.settings.templateOutputDir?'更改输出目录':'设置输出目录'}</button>
            {state.settings.templateOutputDir && <button className="button" onClick={()=>setOutput('clear')}>清除目录</button>}</div>
        </div>
        {referencePlan.mode==='regions-from-base' && <p className="template-apply-hint">组合已达到附图上限，本次按当前底图、选区位置和本区参考图修改。完整组合素材和提示词保留在 03。</p>}
        {referencePlan.mode==='from-originals' && <p className="template-apply-hint">组合已达到附图上限，本次将用原组合的全部参考图，按当前提示词和整图要求重新生成。</p>}
        {referencePlan.mode==='from-base' && <p className="template-apply-hint">组合已达到附图上限，本次按当前成品底图和整图要求修改。</p>}
        </div><div className="template-submit"><small role="status">{saved}</small><button className="button primary" disabled={busy||waiting||!valid} onClick={generate}>
          {busy?'正在提交…':waiting?'调试任务处理中…':draft.regions.length?'生成圈选修改':'生成整图修改'}</button></div>
      </section>
    </div>
  </section>;
}
