import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {cleanBatchReplaceDraft} from '../shared/batch-replace.mjs';
import {imageRowCategories} from '../shared/image-rows.mjs';
import {currentImageSlots} from '../shared/image-jobs.mjs';
import BatchAssetList from './BatchAssetList.jsx';
import BatchTemplateInput from './BatchTemplateInput.jsx';
import CoverLayoutPanel from './CoverLayoutPanel.jsx';
import {User, Images} from '@phosphor-icons/react';
import './batch-replace.css';

const fileName = value => (value || '').split(/[\\/]/).pop();
const statusLabel = {queued:'排队中',planning:'准备中',running:'生成中',saving:'保存中',succeeded:'已完成',failed:'失败',unknown:'状态待核实',cancelled:'已取消'};

function Preview({plan,busy,onSubmit,onClose,itemId,onSelect,bridge,onPrompt,onEdit,openImages}) {
  const {freshCount,requested,items} = plan;
  const item=items.find(v=>v.id===itemId)||items[0];
  const dialog=useRef(null);
  useEffect(()=>{
    const previous=document.activeElement;
    dialog.current?.focus();
    return ()=>{if(previous?.isConnected) previous.focus();};
  },[]);
  function keyDown(event) {
    if(event.key==='Escape'&&!busy) {event.preventDefault();onClose();}
    if(event.key!=='Tab') return;
    const controls=Array.from(dialog.current.querySelectorAll('button:not(:disabled),textarea:not(:disabled),summary'));
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}
    if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
  return <div className="modal-backdrop"><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="混批组合预览" onKeyDown={keyDown} className="modal wide br-preview">
    <header><h2>混批组合预览</h2><button className="button" disabled={busy} onClick={onClose}>关闭</button></header>
    <p>计划生成 {requested} 张，本次可用 {freshCount} 个新组合。{freshCount<requested && ' 已排除生成过和处理中的组合。'}</p>
    {Boolean(plan.unverified?.length) && <details className="br-history-review"><summary>历史待核对（{plan.unverified.length} 个组合，本批暂缓）</summary>
      <p>旧版记录缺少最后一张配图的独立索引。无法确认以下搭配是否已经生成，请对照原批次的素材或增选其他搭配。</p>
      <ul>{plan.unverified.map(v=><li key={v.key}><strong>{v.title||'沿用模板标题'}</strong> · {[v.person,...v.pictures.map(p=>p.path)].filter(Boolean).map(fileName).join(' ／ ')} <small>旧批次 {v.history.map(h=>h.batchId.slice(-4)+' · 第 '+(h.slot+1)+' 张').join('，')}</small></li>)}</ul>
    </details>}
    {!item && !plan.unverified?.length && <p>当前组合已用完。增加候选标题、人物或配图后可继续生成。</p>}
    {item && <div className="br-review-body"><nav aria-label="选择待核对的组合">{items.map((v,i)=>
      <button key={v.id} aria-current={v.id===item.id?'true':undefined} disabled={busy} onClick={()=>onSelect(v.id)}>
        <img loading="lazy" alt="" src={bridge.mediaUrl(v.boardPath)}/><span>第 {i+1} 张<strong>{v.title||'沿用模板标题'}</strong></span></button>)}</nav>
      <div className="br-review-detail">
        <button className="br-board" title="放大组合参考图" onClick={()=>openImages?.([item.boardPath],0)}><img src={bridge.mediaUrl(item.boardPath)} alt={'组合参考图 · '+(item.title||'沿用模板标题')}/></button>
        <div className="br-review-refs" aria-label="模型参考图顺序">{item.referencePaths.map((file,i)=>
          <button key={i} title={'放大图'+(i+1)+' · '+item.roles[i]} onClick={()=>openImages?.(item.referencePaths,i)}>
            <img alt="" src={bridge.mediaUrl(file)}/><span>图{i+1} · {item.roles[i]}</span></button>)}</div>
        {item.noteFallback && <small className="br-muted">配图备注未匹配到特定素材，已从启用的配图位中搭配。</small>}
        <label className="field">本张完整提示词<textarea rows={6} maxLength={30000} disabled={busy} value={item.prompt} onChange={event=>onPrompt(item.id,event.target.value)}/></label>
        <div className="actions"><button className="button" disabled={busy||!onEdit} onClick={()=>onEdit(item)}>去 02 标注这张</button>
          <button className="button" disabled={busy||item.prompt===item.defaultPrompt} onClick={()=>onPrompt(item.id,item.defaultPrompt)}>恢复自动提示词</button></div>
      </div></div>}
    <div className="modal-actions">
      {freshCount>0 && <button disabled={busy} className="button primary" onClick={()=>onSubmit(freshCount<requested ? 'remaining':'fresh')}>
        {busy?'正在提交…':freshCount===requested?`生成 ${requested} 张`:`仅生成 ${freshCount} 张新组合`}
      </button>}
    </div>
  </section></div>;
}

function Results({jobs,bridge,run,call,openImages,onEditInTemplate}) {
  const batches = new Map();
  for (const job of jobs) if (job.snapshot?.feature === 'batch-replace') {
    if (!batches.has(job.rowId)) batches.set(job.rowId, []);
    batches.get(job.rowId).push(job);
  }
  const ids = [...batches.keys()].reverse();
  const [chosen,setChosen] = useState('');
  const [confirmRetry,setConfirmRetry] = useState(null);
  const [exporting,setExporting] = useState(false);
  const [exported,setExported] = useState(null);
  const exportLock = useRef(false);
  const active = batches.has(chosen) ? chosen : ids[0];
  const current = currentImageSlots(batches.get(active)||[]);
  const success = current.filter(j=>j.status==='succeeded' && j.localPath);
  const failedExports = success.filter(job=>job.exportError);
  const configuredDirectory = current[0]?.snapshot.outputDir;
  function exportResults(items,selectDirectory) {
    if (exportLock.current) return;
    exportLock.current=true; setExporting(true); setExported(null);
    return run(async()=>{
      try {
        const folder = selectDirectory ? await bridge.chooseFolder('output') : configuredDirectory;
        if (!folder) return;
        const result = await call('exportJobs',items.map(j=>j.id),folder);
        const saved=result.filter(item=>item.path);
        if(result.length) setExported({batch:active,count:saved.length,failed:result.length-saved.length,path:saved[0]?.path||''});
      } finally {exportLock.current=false;setExporting(false);}
    });
  }
  return <section className="panel br-results"><h2>生成结果</h2>
    {!ids.length ? <p className="br-muted">提交后可在这里查看生成进度和封面。</p> : <>
      <label className="field">查看批次<select value={active} onChange={e=>setChosen(e.target.value)}>
        {ids.map(id=><option value={id} key={id}>{new Date(batches.get(id)[0].createdAt).toLocaleString('zh-CN')} · {batches.get(id)[0].snapshot.row.count} 张 · {id.slice(-4)}</option>)}
      </select></label>
      {success.some(j=>j.snapshot.replacement.revision) && <small className="br-muted">批量导出使用每张最新的修订成品，其余使用原图。</small>}
      {success.length>0 && <div className="actions"><button className="button" disabled={exporting} onClick={()=>exportResults(success,!configuredDirectory)}>导出已完成（{success.length}）</button>
        {(configuredDirectory || failedExports.length>0) && <button className="button" disabled={exporting} onClick={()=>exportResults(failedExports.length ? failedExports : success,true)}>
          {failedExports.length ? `另选目录导出失败项（${failedExports.length}）` : '另选目录导出'}
        </button>}
        <button className="button" onClick={()=>run(()=>bridge.openOutput(success.map(j=>j.id)))}>打开结果目录</button></div>}
      {exported?.batch===active && <small role="status" className="br-muted" title={exported.path}>已导出 {exported.count} 张{exported.failed>0?`，失败 ${exported.failed} 张`:''} {exported.path && '· '+exported.path.slice(0,Math.max(exported.path.lastIndexOf('/'),exported.path.lastIndexOf('\\')))}</small>}
      <div className="br-result-grid">{current.map(job=><article key={job.id}>
        {job.localPath && <button className="br-thumb" onClick={()=>openImages?.(success.map(j=>j.localPath),success.findIndex(j=>j.id===job.id))}><img src={bridge.mediaUrl(job.localPath)} alt={'生成原图 · '+(job.snapshot.replacement.title || '封面')}/></button>}
        <strong>{job.slot+1}. {job.snapshot.replacement.title || '沿用模板标题'}</strong><span>{statusLabel[job.status] || job.status} · 第 {job.attempt} 次</span>
        {(job.snapshot.replacement.person || job.snapshot.replacement.pictures?.length>0) && <details className="br-result-files"><summary>查看组合素材</summary><ul>
          {job.snapshot.replacement.person && <li><b>人物</b>{fileName(job.snapshot.replacement.person)}</li>}
          {job.snapshot.replacement.pictures?.map((p,i)=><li key={i}><b>{p.name||'配图位 '+(i+1)}</b>{fileName(p.path)}</li>)}
        </ul></details>}
        {job.localPath && onEditInTemplate && <button className="button" onClick={()=>run(()=>onEditInTemplate({id:'result:'+job.id,kind:'batch-result',
          jobId:job.id,path:job.snapshot.replacement.revision?.path||job.localPath,prompt:job.snapshot.replacement.revision?.prompt??job.prompt,
          label:'第 '+(job.slot+1)+' 张成品',referencePaths:job.referencePaths||[],originalReferencePaths:job.referencePaths||[],roles:job.snapshot.replacement.roles||[]}))}>去 02 编辑成品</button>}
        {job.snapshot.replacement.revision && <div className="br-revision">
          <button className="br-thumb" onClick={()=>openImages?.([job.snapshot.replacement.revision.path],0)}><img alt="本张修订图" src={bridge.mediaUrl(job.snapshot.replacement.revision.path)}/></button>
          <details><summary>修订提示词</summary><p>{job.snapshot.replacement.revision.prompt}</p></details>
          <button className="button" onClick={()=>run(async()=>{const dir=await bridge.chooseFolder('output');if(dir) await call('exportBatchRevision',job.id,dir);})}>另存修订成品</button>
          {job.snapshot.replacement.revision.exportedPath && <small>已另存至 {job.snapshot.replacement.revision.exportedPath}</small>}
        </div>}
        {job.error&&<small className="br-error">{job.error}</small>}
        {job.exportError&&<small className="br-error">导出失败：{job.exportError}。请检查图片文件和目标目录。</small>}
        {job.status==='failed'&&<button className="button" onClick={()=>run(()=>call('retryJobs',[job.id]))}>重试这张</button>}
        {(job.status==='unknown' || (job.status==='failed' && job.result?.images?.length>0)) &&
          <button className="button" onClick={()=>setConfirmRetry(job)}>核对后重新生成</button>}
      </article>)}</div>
    </>}
    {confirmRetry && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="确认重新生成封面" className="modal">
      <header><h2>确认重新生成第 {confirmRetry.slot+1} 张</h2></header>
      <p>服务商可能已处理上次请求。请先核对服务记录；重新生成会提交新请求，可能再次计费。</p>
      <div className="modal-actions"><button className="button" onClick={()=>setConfirmRetry(null)}>返回核对</button>
        <button className="button primary" onClick={()=>{const id=confirmRetry.id;setConfirmRetry(null);run(()=>call('retryJobs',[id],{regenerate:true}));}}>已核对，重新生成</button></div>
    </section></div>}
  </section>;
}

export default function BatchReplaceWorkspace({state,call,run,bridge=window.studio,templatePath,onTemplateConsumed,openImages,registerFlush,onEditInTemplate,returnedEdit,onEditConsumed}) {
  const [draft,setDraft] = useState(()=>cleanBatchReplaceDraft(state.batchReplaceDraft));
  const latest = useRef(draft), lastSent = useRef(JSON.stringify(draft)), timer = useRef(null), sending = useRef(Promise.resolve());
  const [saveError,setSaveError] = useState(''), [busy,setBusy] = useState(false), [preview,setPreview] = useState(null);
  const locked = useRef(false);
  const templateVersion=useRef(0);
  const [planningStatus,setPlanningStatus] = useState('');
  const [importing,setImporting] = useState(false);
  const importEnd = useRef(null), importPromise = useRef(Promise.resolve());
  const slotKeys = useRef(null);
  if (!slotKeys.current) slotKeys.current=draft.slots.map(()=>crypto.randomUUID());
  const inputsDisabled = busy || importing;
  function importPending(start) {
    if (start) importPromise.current = new Promise(resolve=>{importEnd.current=resolve;});
    else {importEnd.current?.();importEnd.current=null;}
    setImporting(start);
  }
  const [itemId,setItemId]=useState(''),[returnError,setReturnError]=useState(''),[returnAttempt,retryReturn]=useState(0);
  const applying=useRef(false),applyPromise=useRef(Promise.resolve()),applied=useRef(null),promptTimer=useRef(null),pendingPrompts=useRef(new Map()),promptSaves=useRef(Promise.resolve());
  function flushPrompts() {
    clearTimeout(promptTimer.current);
    const entries=[...pendingPrompts.current];pendingPrompts.current.clear();
    if(!entries.length) return promptSaves.current;
    promptSaves.current=promptSaves.current.catch(()=>{}).then(async()=>{
      for(const [i,[id,prompt]] of entries.entries()) {
        try {await call('saveBatchPreviewPrompt',id,prompt);}
        catch(error) {
          for(const [key,value] of entries.slice(i)) if(!pendingPrompts.current.has(key)) pendingPrompts.current.set(key,value);
          throw error;
        }
      }
    });
    return promptSaves.current;
  }
  function changePrompt(id,prompt) {
    setPreview(p=>({...p,items:p.items.map(item=>item.id===id?{...item,prompt}:item)}));
    pendingPrompts.current.set(id,prompt);clearTimeout(promptTimer.current);
    promptTimer.current=setTimeout(()=>flushPrompts().then(()=>setSaveError(''),e=>setSaveError(e.message)),350);
  }
  function flushAll(){return Promise.all([flush(),flushPrompts()]);}
  useLayoutEffect(()=>{
    if(!returnedEdit || applying.current || applied.current===returnedEdit) return;
    applying.current=true;
    applyPromise.current=(async()=>{
      await flushAll();
      const updated=await call('applyBatchEdit',{id:returnedEdit.id,path:returnedEdit.path,prompt:returnedEdit.prompt});
      if(updated){setPreview(updated);setItemId(returnedEdit.id);}
      else setPreview(null);
      applied.current=returnedEdit;setReturnError('');onEditConsumed?.();
    })().finally(()=>{applying.current=false;});
    applyPromise.current.catch(e=>setReturnError(e.message));
  },[returnedEdit,returnAttempt]);
  function flush() {
    clearTimeout(timer.current);
    const value = latest.current, key = JSON.stringify(value);
    if (key===lastSent.current) return sending.current;
    lastSent.current=key;
    const pending = sending.current.catch(()=>{}).then(()=>call('saveBatchReplaceDraft',value));
    sending.current=pending;
    pending.then(()=>setSaveError(''),error=>{
      if(lastSent.current===key) lastSent.current='';
      setSaveError(error.message || '保存失败，请重试');
    });
    return pending;
  }
  function edit(patch) {
    if(Object.hasOwn(patch,'templatePath'))templateVersion.current++;
    const value = {...latest.current,...patch};
    latest.current=value; setDraft(value); setPreview(null);
    clearTimeout(timer.current);
    timer.current=setTimeout(flush,300);
  }
  useEffect(()=>()=>{flushAll().catch(()=>{});},[]);
  useEffect(()=>registerFlush?.('batch',async()=>{await importPromise.current;await flushAll();await applyPromise.current;}),[registerFlush]);
  useEffect(()=>{
    if(!templatePath)return;
    let current=true;
    if(locked.current?.kind==='preview'){locked.current=false;setBusy(false);setPlanningStatus('');}
    edit({templatePath});
    flush().then(()=>{if(current)onTemplateConsumed?.();}).catch(()=>{});
    return ()=>{current=false;};
  },[templatePath]);
  const updateSlot = (i,patch) => edit({slots:latest.current.slots.map((s,j)=>j===i?{...s,...patch}:s)});
  function checkedWork(fn,kind='action') {
    if (locked.current || importEnd.current) return;
    const owner={kind};locked.current=owner;setBusy(true);
    return run(async()=>{try{await flushAll();if(locked.current===owner)await fn();}
      finally{if(locked.current===owner){locked.current=false;setBusy(false);}}});
  }
  const layoutBound = Boolean(state.settings.bindings.vision);
  const layoutKnown = Boolean(draft.templatePath && state.coverTemplateLayout?.path===draft.templatePath);
  const needsLayout = Boolean(draft.templatePath && layoutBound && !layoutKnown);
  const plan = layoutMode => {
    const submitted=latest.current;
    return checkedWork(async()=>{
      if(latest.current!==submitted)return;
      try {
        if(layoutMode==='analyze'){
          setPlanningStatus('正在识别版式…');
          await call('analyzeCoverLayout',submitted.templatePath);
        }
        if(layoutMode==='cached') await call('analyzeCoverLayout',submitted.templatePath,{cachedOnly:true});
        if(latest.current!==submitted)return;
        setPlanningStatus('正在制作组合参考图…');
        const result=await call('previewBatchReplace',submitted,{requireCurrentDraft:true});
        if(result && latest.current===submitted){setPreview(result);setItemId(result.items[0]?.id);}
      } catch(error){if(latest.current===submitted)throw error;}
      finally {if(latest.current===submitted)setPlanningStatus('');}
    },'preview');
  };
  const editItem=item=>checkedWork(async()=>{
    await onEditInTemplate({id:item.id,slotId:item.slotId,previewId:preview.id,kind:'batch-preview',path:item.boardPath,prompt:item.prompt,
      label:'第 '+(Number(item.slotId)+1)+' 张 · '+(item.title||'沿用模板标题'),referencePaths:item.referencePaths.filter((_,i)=>i!==1),
      originalReferencePaths:item.referencePaths,roles:item.roles});
    setPreview(null);
  });
  const submit = mode => checkedWork(async()=>{
    await call('enqueueBatchReplace',latest.current,{mode,token:preview.token,requestId:preview.requestId,requireCurrentDraft:true});
    setPreview(null);
  });
  const outputCategories = imageRowCategories(state.rows);
  const pickerVersion=templateVersion.current;
  return <div className="br-workspace" data-testid="batch-replace-workspace">
    {returnError&&<p role="alert" className="br-error">未能保存调试结果：{returnError} <button className="button" onClick={()=>retryReturn(n=>n+1)}>重试保存修订</button></p>}
    <div className="br-setup panel" onBlur={()=>flush().catch(()=>{})}>
      <h2>批量替换</h2>
      <fieldset disabled={inputsDisabled} className="br-section">
        <legend>固定模板</legend>
        <BatchTemplateInput path={draft.templatePath} {...{bridge,call}} onSelect={templatePath=>{
          if(pickerVersion===templateVersion.current)edit({templatePath});
        }} disabled={inputsDisabled} onPending={importPending}/>
        <CoverLayoutPanel templatePath={draft.templatePath} report={state.coverTemplateLayout} bound={layoutBound} busy={inputsDisabled}
          onAnalyze={(refresh=false)=>checkedWork(()=>call('analyzeCoverLayout',latest.current.templatePath,{refresh}))}/>
      </fieldset>
      <fieldset disabled={inputsDisabled} className="br-section"><legend><label><input type="checkbox" disabled={inputsDisabled} checked={draft.titlesEnabled} onChange={e=>edit({titlesEnabled:e.target.checked})}/>替换标题</label></legend>
        {draft.titlesEnabled&&<textarea aria-label="封面标题" rows={4} placeholder={'一行一条，可带配图备注\n化妆师如何接到同城客户（配图：后台咨询截图）'}
          value={draft.titles} onChange={e=>edit({titles:e.target.value})}/>}
      </fieldset>
      <fieldset disabled={inputsDisabled} className="br-section br-role br-person"><legend><label><input type="checkbox" disabled={inputsDisabled} checked={draft.peopleEnabled} onChange={e=>edit({peopleEnabled:e.target.checked})}/><User size={16} aria-hidden="true"/>替换人物</label></legend>
        {draft.peopleEnabled&&<BatchAssetList role="人物" assets={draft.people} onChange={people=>edit({people})} {...{bridge,call}} disabled={inputsDisabled} onPending={importPending}/>}
      </fieldset>
      {draft.slots.map((s,i)=><fieldset disabled={inputsDisabled} key={slotKeys.current[i]} className={'br-section br-role br-slot tone-'+(i%3)}><legend><label><input type="checkbox" disabled={inputsDisabled} checked={s.enabled} onChange={e=>updateSlot(i,{enabled:e.target.checked})}/><Images size={16} aria-hidden="true"/>替换配图位 {i+1}</label></legend>
        {s.enabled&&<>
          <label className="field">模板中的位置或用途（选填）<input aria-label={`配图位 ${i+1} 名称`} value={s.name} onChange={e=>updateSlot(i,{name:e.target.value})}/></label>
          <BatchAssetList role={'配图位 '+(i+1)} assets={s.assets} onChange={assets=>updateSlot(i,{assets})} onEditTags {...{bridge,call}} disabled={inputsDisabled} onPending={importPending}/>
        </>}
        {draft.slots.length>1 && <button className="br-remove br-remove-slot" onClick={()=>{slotKeys.current.splice(i,1);edit({slots:latest.current.slots.filter((_,j)=>j!==i)});}}>移除此位置</button>}
      </fieldset>)}
      <button className="button" disabled={inputsDisabled} onClick={()=>{slotKeys.current.push(crypto.randomUUID());edit({slots:[...latest.current.slots,{name:`画中画 ${draft.slots.length+1}`,enabled:true,assets:[]}]});}}>添加配图位置</button>
      <label className="field">输出分类<select disabled={inputsDisabled} value={draft.outputCategory} onChange={e=>edit({outputCategory:e.target.value})}>
        <option value="">保留在本机，导出时选择目录</option>
        {draft.outputCategory && !outputCategories.includes(draft.outputCategory) &&
          <option value={draft.outputCategory}>{draft.outputCategory} 类 · 上次选择（当前无此分类任务）</option>}
        {outputCategories.map(key =>
          <option key={key} value={key}>{key} 类 · {state.settings.imageCategoryDirectories?.[key] || (state.settings.outputDir ? '沿用输出根目录' : '尚未设置输出根目录')}</option>)}
      </select></label>
      <div className="br-controls"><label className="field">生成张数<input disabled={inputsDisabled} type="number" min="1" max="100" value={draft.count} onChange={e=>edit({count:e.target.value})}/></label>
        <label className="field">分辨率<select disabled={inputsDisabled} value={draft.resolution} onChange={e=>edit({resolution:e.target.value})}>{['1K','2K','4K'].map(v=><option key={v}>{v}</option>)}</select></label>
        <button className="button primary" disabled={inputsDisabled} aria-describedby={needsLayout?'br-vision-help':undefined} onClick={()=>plan(needsLayout?'analyze':layoutKnown?'cached':'direct')}>{busy?(planningStatus||'正在准备…'):needsLayout?'识别版式并预览':'预览组合'}</button>
        {needsLayout && <button className="button" disabled={inputsDisabled} onClick={()=>plan('direct')}>直接预览组合</button>}
        {state.batchReplacePreview && JSON.stringify(state.batchReplacePreview.draft)===JSON.stringify(draft) &&
          <button className="button" disabled={inputsDisabled} onClick={()=>checkedWork(async()=>{setPreview(state.batchReplacePreview);setItemId(state.batchReplacePreview.items[0]?.id);})}>继续核对已保存组合</button>}</div>
      {needsLayout && <small id="br-vision-help" className="br-muted">识别会调用已绑定的识图服务；直接预览会在本机组合素材。</small>}
      {saveError&&<p role="alert" className="br-error">{saveError} <button className="button" onClick={()=>run(flush)}>重试保存</button></p>}
    </div>
    <Results {...{jobs:state.jobs||[],bridge,run,call,openImages,onEditInTemplate}}/>
    {preview&&<Preview plan={preview} {...{busy,itemId,bridge,openImages}} onClose={()=>checkedWork(async()=>setPreview(null))} onSelect={setItemId} onPrompt={changePrompt} onEdit={onEditInTemplate?editItem:null} onSubmit={submit}/>}
  </div>;
}
