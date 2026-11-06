import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Plus, Play, VideoCamera, MusicNote, X, Sparkle, Trash, FilmStrip, CaretRight, ArrowRight, CheckCircle, PencilSimple, DownloadSimple } from '@phosphor-icons/react';
import { batchCapacity, splitTexts, sectionCapacity } from '../shared/montage-batch.mjs';
import { SPEECH_CATALOGS, TTS_PROTOCOLS } from '../shared/speech.mjs';
import CandidateEditor, { candidateEntries } from './CandidateEditor.jsx';
import CombinationReview from './CombinationReview.jsx';
import { montageReviewSignature, montageReviewCombination } from '../shared/montage-review.mjs';
import { montageVisualFragments } from '../shared/montage-bindings.mjs';
import './montage-bindings.css';
import './montage-workflow.css';

const basename = file => file?.split(/[\\/]/).pop() || '';
const section = (id, enabled = true) => ({ section: id, enabled, title: `${id} 段`, candidates: [], candidateBindings:[], candidateMode: 'texts', paths: [], assetIds: [], folder: '' });
const normalizeSections = rows => rows.map(item => ({ ...item, candidates: candidateEntries(item.candidates) }));
function nextSectionCode(rows) { const used = new Set(rows.map(item => item.section)); for (let index=0; ; index++) { let value=index+1, code=''; while(value){value--;code=String.fromCharCode(65+value%26)+code;value=Math.floor(value/26);} if (!used.has(code)) return code; } }
const blank = () => ({ name: '我的批量混剪', mode: 'sections', sections: [section('A'), section('B')], voicePresetId: '', voice: '', ratio: '9:16', subtitle: true, openingPath: '', openingAudioMode: 'original', masterAudioPath: '', masterText: '', masterCues: [], limit: 'all', analyzeAssets: false });
function Button({ icon: Icon, children, primary, ...props }) { return <button className={`button ${primary ? 'primary' : ''}`} {...props}>{Icon && <Icon size={18}/>} {children}</button>; }
function Field({ label, children }) { return <label className="field"><span className="field-label">{label}</span>{children}</label>; }

const stepNames = ['文案与素材', '完整组合', 'AI 校对', '配音与片头', '生成草稿', '编辑与导出'];
function WorkflowStep({ number, title = stepNames[number - 1], role, hint, children, className = '' }) {
  return <section className={`surface workflow-step ${className}`} data-workflow-step={number} aria-labelledby={`montage-step-${number}`}>
    <header className="workflow-step-heading"><span className="workflow-number" aria-hidden="true">{String(number).padStart(2, '0')}</span><div><h2 id={`montage-step-${number}`} tabIndex={-1}>{title}</h2><p>{hint}</p></div><span className="workflow-role">{role}</span></header>
    {children}
  </section>;
}
function StepLink({ children, onClick }) {
  return <button type="button" className="workflow-next" onClick={onClick}>{children}<ArrowRight size={16}/></button>;
}

export default function MontageWorkspace({ state, loaded, call, run, notify, choose, chooseFolder, openEditor, setVideoPreview, speechInput, renderGallery }) {
  const [setup, setSetup] = useState(blank), [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(''), [progress, setProgress] = useState(null), [failures, setFailures] = useState([]), [saveState, setSaveState] = useState('');
  const stop = useRef(false), initialized = useRef(false), latest = useRef(setup);
  const [exporting,setExporting]=useState(false),[previewPage,setPreviewPage]=useState(0);
  const pageSize=10;
  const [chosenDrafts,setChosenDrafts]=useState([]);
  const [chosenSections,setChosenSections]=useState([]),[deleteSections,setDeleteSections]=useState(null);
  const [reviewBusy,setReviewBusy]=useState(false);
  const viewport=useRef(null), nav=useRef(null), navigationTop=useRef(null), generating=useRef(false);
  const [activeStep,setActiveStep]=useState(1);
  const assets = state.montageAssets || [], drafts = state.montageDrafts || [];
  const library=state.montageBindingLibrary||{folders:[]};
  const bindingFolders=library.folders||[];
  const provider = state.settings.providers.find(item => item.id === state.settings.bindings.tts);
  const presets = state.settings.speechPresets || [];
  useEffect(() => {
    if (!loaded || initialized.current) return;
    initialized.current = true;
    const saved = state.montageSetup;
    const next = saved ? { ...blank(), ...saved, sections: normalizeSections(saved.sections || blank().sections) } : { ...blank(), voicePresetId: state.settings.defaultSpeechPresetId || '', voice: SPEECH_CATALOGS[provider?.protocol]?.voice || 'alloy' };
    latest.current = next; setSetup(next); setReady(true);
  }, [loaded, state.montageSetup, provider]);
  useEffect(() => {
    if (!ready) return;
    setSaveState('正在保存…');
    const timer = setTimeout(() => call('saveMontageSetup', setup).then(() => setSaveState('配置已保存')).catch(error => setSaveState(error.message)), 450);
    return () => clearTimeout(timer);
  }, [setup, ready]);
  useEffect(() => {
    if (!speechInput) return;
    setSetup(previous => ({ ...previous, mode: 'master', masterAudioPath: speechInput.masterAudioPath, masterText: speechInput.masterText, masterCues: speechInput.masterCues || [], name: speechInput.name || '配音混剪' }));
  }, [speechInput]);
  useEffect(()=>{latest.current=setup;},[setup]);
  const patch = change => { const next = { ...latest.current, ...change }; if(JSON.stringify(next).length>480000){notify('当前混剪配置文字过多，请减少部分候选文案后再保存。','error');return false;}latest.current=next;setSetup(next);return true; };
  const editSection = (index, change) => patch({ sections: setup.sections.map((item,i) => i === index ? { ...item, ...change } : item) });
  const removeSections = () => { const removed = new Set(deleteSections); patch({sections:setup.sections.filter(item=>!removed.has(item.section))});setChosenSections(previous=>previous.filter(id=>!removed.has(id)));setDeleteSections(null); };
  const active = setup.sections.filter(item => item.enabled !== false);
  const capacity = setup.mode === 'master' ? (setup.masterText.trim() ? 1 : 0) : batchCapacity(setup.sections);
  const count = setup.limit === 'all' ? capacity : Math.min(capacity, Math.max(0, Math.floor(Number(setup.limit)||0)));
  const reviewSignature=montageReviewSignature(setup);
  const reviewSession=(state.montageReviews||[]).find(item=>item.signature===reviewSignature);
  const passedCount=Object.values(reviewSession?.items||{}).filter(item=>item.index<count&&item.status==='pass'&&!item.accepted?.segments?.some(segment=>segment.bindings?.some(binding=>binding.status==='needs-review'))).length;
  const staleBindings=setup.mode!=='master'&&active.some(item=>item.candidateBindings?.some((record,index)=>record?.bindings?.length&&record.textSnapshot!==candidateEntries(item.candidates)[index]));
  const readyToGenerate=Boolean(count&&passedCount===count&&!staleBindings);
  const combinationAt = index => reviewSession?.items?.[index]?.accepted || montageReviewCombination(setup,index);
  const pages=Math.max(1,Math.ceil(count/pageSize)), currentPage=Math.min(previewPage,pages-1);
  const combinations = useMemo(() => Array.from({length:Math.min(pageSize,Math.max(0,count-currentPage*pageSize))},(_,index)=>combinationAt(currentPage*pageSize+index)),[setup,count,currentPage,reviewSession]);
  const hasMasterAudio=setup.mode==='master'&&Boolean(setup.masterAudioPath);
  const reuseMasterAudio=hasMasterAudio&&count>0&&combinationAt(0).masterText===setup.masterText.trim();
  const presetId=setup.voicePresetId||state.settings.defaultSpeechPresetId;
  const preset=presets.find(item=>item.id===presetId);
  const speechProvider=state.settings.providers.find(item=>item.id===(preset?.providerId||state.settings.bindings.tts));
  const visionProvider=state.settings.providers.find(item=>item.id===state.settings.bindings.montageVision);
  const executionKey=JSON.stringify([reviewSession?.sourceKey,reviewSession?.updatedAt,count,setup.name,presetId,setup.voice,setup.ratio,setup.subtitle,setup.openingPath,setup.openingAudioMode,setup.analyzeAssets,setup.masterAudioPath]);
  const materialProblem=useMemo(()=>{
    if(!readyToGenerate)return '';
    const inspected=new Set();
    const hasSharedAssets=active.some(item=>item.assetIds?.length);
    for(const record of Object.values(reviewSession.items)){
      if(record.index>=count)continue;
      const {segments}=combinationAt(record.index);
      let hasMaterial=hasSharedAssets;
      for(const segment of segments){
        if(segment.paths?.length||segment.assetIds?.length)hasMaterial=true;
        if(!segment.bindings?.length)continue;
        hasMaterial=true;
        const key=JSON.stringify([segment.section,segment.text,segment.bindings,Boolean(segment.paths?.length||segment.assetIds?.length)]);
        if(inspected.has(key))continue;
        try{montageVisualFragments([segment],bindingFolders);}
        catch(error){return `组合 ${record.index+1}：${error.message}`;}
        inspected.add(key);
      }
      if(!hasMaterial)return `组合 ${record.index+1} 尚未指定图片或视频。请绑定文字范围，或选择本段素材文件夹。`;
    }
    return '';
  },[count,readyToGenerate,reviewSession,reviewSignature,state.montageBindingLibrary]);
  const locked=Boolean(busy)||reviewBusy||!ready;
  const goToStep=number=>{
    const host=viewport.current, target=host?.querySelector(`[data-workflow-step="${number}"]`);
    if(!target)return;
    const top=host.scrollTop+target.getBoundingClientRect().top-host.getBoundingClientRect().top-(nav.current?.offsetHeight||0)-12;
    host.scrollTo({top:Math.max(0,top)});
    navigationTop.current=host.scrollTop;
    target.querySelector('h2')?.focus({preventScroll:true});
    setActiveStep(number);
  };
  useEffect(()=>{
    const host=viewport.current;
    let frame=0;
    const readPosition=()=>{
      frame=0;
      if(navigationTop.current!==null&&Math.abs(host.scrollTop-navigationTop.current)<1)return;
      navigationTop.current=null;
      const marker=host.getBoundingClientRect().top+(nav.current?.offsetHeight||0)+16;
      const visible=Array.from(host.querySelectorAll('[data-workflow-step]')).filter(item=>item.getBoundingClientRect().top<=marker);
      setActiveStep(Number(visible.at(-1)?.dataset.workflowStep)||1);
    };
    const handleScroll=()=>{if(!frame)frame=requestAnimationFrame(readPosition);};
    host.addEventListener('scroll',handleScroll,{passive:true});
    return()=>{host.removeEventListener('scroll',handleScroll);cancelAnimationFrame(frame);};
  },[]);
  const generationBlock = (() => {
    if (!ready) return {message:'正在载入项目配置。'};
    if (busy) return {message:busy==='生成'?'正在处理本批组合。':busy};
    if (reviewBusy) return {message:'AI 校对或建议处理正在进行。',step:3};
    if (!setup.name.trim()) return {message:'请先填写任务名称。',step:1};
    if (setup.mode==='sections'&&active.some(item=>item.candidateMode==='files'&&new Set(splitTexts(item.candidates)).size!==1)) return {message:'按文件组合的段落需填写一条固定文案。',step:1};
    if (!capacity) return {message:setup.mode==='master'?'请先填写完整旁白文案。':'请给每个参与组合的段落填写候选文案；按文件组合的段落还需选择素材文件夹。',step:1};
    if (!count||!Number.isSafeInteger(count)) return {message:'请选择有效的本次组合数量。',step:2};
    if (staleBindings) return {message:'文案有修改，请重新确认标红的文字与素材。',step:1};
    if (!readyToGenerate) return {message:`本次 ${count} 条组合中有 ${count-passedCount} 条需要校对、复检或确认素材对应。`,step:3};
    if (!reuseMasterAudio&&((presetId&&!preset)||!TTS_PROTOCOLS.includes(speechProvider?.protocol)||!speechProvider?.model||!speechProvider?.baseUrl)) return {message:'请选择有效的配音预设，或在全局设置中补全并绑定语音服务。',step:4};
    if (setup.analyzeAssets&&(!visionProvider?.baseUrl||!visionProvider?.model||visionProvider.protocol!=='openai-chat')) return {message:'请在全局设置中补全并绑定混剪素材识别服务，或关闭本次 AI 素材识别。',step:4};
    if (materialProblem) return {message:materialProblem,step:1};
    return null;
  })();
  const importBindingLibrary=()=>run(async()=>{
    const rootPath=await chooseFolder('montage-root');if(!rootPath)return;
    setBusy('正在识别素材子目录');
    try{const result=await call('scanMontageBindingFolders',rootPath);notify(`已识别 ${result.folders.length} 个素材子目录，可在候选文案中选中文字绑定。`)}finally{setBusy('')}
  });
  const selectFolder = index => run(async () => {
    const folder = await chooseFolder('montage-section'); if (!folder) return;
    setBusy('扫描文件夹');
    try {
      const result = await call('scanMontageLibrary', { folder, analyze: false });
      if (!result.assets?.length) throw new Error('这个文件夹没有可用的图片或视频。');
      editSection(index, { folder, paths: result.assets.map(item=>item.path), assetIds: result.assets.map(item=>item.id) });
    } finally { setBusy(''); }
  });
  const begin = () => run(async () => {
    if (generating.current || busy || reviewBusy) return;
    if (!setup.name.trim()) throw new Error('请填写任务名称。');
    if (setup.mode==='sections' && active.some(item=>item.candidateMode==='files'&&new Set(splitTexts(item.candidates)).size!==1)) throw new Error('按文件组合的段落只填写一条固定文案；多条文案请选择按文案组合。');
    if (!count || !combinations.length) throw new Error('请给启用的每一段填写文案。');
    if (!Number.isSafeInteger(count)) throw new Error('组合数量过大，请缩小本次处理范围。');
    if(!readyToGenerate)throw new Error('请先完成本次全部组合的 AI 校对，并解决文案和素材标注问题后再生成配音。');
    if (generationBlock) throw new Error(generationBlock.message);
    generating.current=true;
    stop.current = false; setBusy('生成'); setFailures([]); setProgress(null); let first, completed = 0;
    try {
      await call('saveMontageSetup',setup);
      for (let index=0; index<count; index++) {
        const combo=combinationAt(index);
        if (stop.current) break;
        setProgress({ runKey: executionKey, current: index+1, total: count, completed, stage: '' });
        const config = { setup,reviewSourceKey:reviewSession.sourceKey,reviewIndex:index,name: `${setup.name} · ${String(index+1).padStart(2,'0')}`, fullNarration: true, voicePresetId: presetId || '', voice: presetId ? undefined : setup.voice || SPEECH_CATALOGS[speechProvider?.protocol]?.voice || 'alloy', ratio: setup.ratio, subtitle: setup.subtitle, openingPath: setup.openingPath, openingAudioMode: setup.openingAudioMode, analyzeAssets: setup.analyzeAssets, assetIds: active.flatMap(item=>item.assetIds||[]), segments:combo.segments, masterText:combo.masterText, ...(reuseMasterAudio?{masterAudioPath:setup.masterAudioPath,masterCues:setup.masterCues}:{}), variant: index };
        // The review source key already identifies the candidate pool. Changing
        // only the batch limit must still reopen the same completed draft.
        config.requestKey = JSON.stringify({ ...config, setup: undefined });
        try { const draft = await call('createMontageDraft',config); first ||= draft; completed++; }
        catch (error) { setFailures(previous=>[...previous,{index:index+1,text:combo.masterText,error:error.message}]); }
      }
      setProgress({ runKey: executionKey, current: completed, total: count, completed, stage: stop.current ? '已停止后续组合，已完成草稿保留' : '本批处理结束' });
      notify(`已准备 ${completed} 条时间线草稿${stop.current?'，后续已停止':''}`);
      if (first && count === 1) openEditor(first.id);
    } finally { generating.current=false; setBusy(''); }
  });
  const loadLegacy = formula => {
    const sections = (Array.isArray(formula.sections) ? formula.sections : Object.values(formula.sections||{})).map((item,index)=>({ ...section(item.section||String.fromCharCode(65+index)), ...item, candidates:candidateEntries(item.candidates), enabled: Boolean(splitTexts(item.candidates).length), folder: item.folder||'' }));
    patch({ ...blank(), ...formula, sections: sections.length?sections:blank().sections, mode: formula.masterText?'master':'sections', limit:'all' });
    notify('旧配置已载入；本流程将按完整组合重新配音，请核对段落和文件夹。');
  };
  const exportBatch = () => run(async()=>{
    setExporting(true);
    try { for(const id of chosenDrafts){const record=await call('openTimeline',id);await call('enqueueTimeline',id,record.timeline)} notify(`已提交 ${chosenDrafts.length} 条视频导出任务`);setChosenDrafts([]); }
    finally {setExporting(false)}
  });
  const folderLibrary=<section className="montage-folder-library" aria-label="文案素材目录库"><header><div><h3><FolderOpen size={19}/>素材目录库</h3><p>选择包含素材子目录的总文件夹。分段文案可选中文字，分别指定对应的子目录。</p></div><Button icon={FolderOpen} onClick={importBindingLibrary}>{bindingFolders.length?'重新导入素材大目录':'导入素材大目录'}</Button></header>{library.rootPath&&<p className="binding-library-root" title={library.rootPath}>{library.rootPath}</p>}<div className="binding-folder-grid">{bindingFolders.map(folder=><div key={folder.path} title={folder.path}><FolderOpen size={18}/><span>{folder.label}</span><small>{folder.mediaCount} 个素材</small></div>)}{!bindingFolders.length&&<p className="binding-library-empty">例如：产品外观、使用场景、细节展示，各自放入一个素材子目录。</p>}</div></section>;
  return <div ref={viewport} className="page-scroll montage-workspace" data-testid="montage-workspace">
    <div className="page-title workflow-title"><div><h2>批量混剪工作台</h2><p>给每条完整文案配音、匹配画面，再打开时间线编辑或导出。</p></div><span className="save-indicator">{saveState}</span></div>
    <nav ref={nav} className="workflow-step-nav" aria-label="混剪步骤导航">
      {stepNames.map((name,index)=><button type="button" key={name} data-workflow-jump={index+1} aria-current={activeStep===index+1?'step':undefined} onClick={()=>goToStep(index+1)}><span>{index+1}</span>{name}</button>)}
    </nav>
    <WorkflowStep number={1} role="你来设置" hint="选择文案来源，为每个参与组合的段落指定素材。" className="batch-setup">
      <fieldset disabled={locked}>
        <div className="batch-heading"><Field label="任务名称"><input aria-label="混剪任务名称" value={setup.name} onChange={e=>patch({name:e.target.value})}/></Field><div className="montage-mode-tabs"><button className={setup.mode==='sections'?'active':''} onClick={()=>patch({mode:'sections'})}>分段文案组合</button><button className={setup.mode==='master'?'active':''} onClick={()=>patch({mode:'master'})}>整篇文案 / 已有配音</button></div></div>
        {setup.mode==='master'&&<div className="batch-master"><Field label="完整旁白文案"><textarea aria-label="混剪完整旁白" placeholder="填写整篇文案，或从已完成的语音合成中选取配音和文案" rows={4} readOnly={Boolean(setup.masterAudioPath)} value={setup.masterText} onChange={e=>patch({masterText:e.target.value})}/></Field><div className="actions"><Button icon={MusicNote} disabled={!setup.masterText.trim()} title="先填写对应的完整文案，再导入音频" onClick={()=>run(async()=>{const files=await choose('audio');if(files?.length)patch({masterAudioPath:files[0],masterCues:[]})})}>导入完整旁白音频</Button><select aria-label="选择已生成的配音" value="" onChange={e=>{const job=state.jobs.find(item=>item.id===e.target.value);if(job)patch({masterText:job.snapshot?.config?.text||job.prompt,masterAudioPath:job.localPath,masterCues:job.result?.segments||job.segments||[]})}}><option value="">使用已完成的语音合成…</option>{state.jobs.filter(item=>item.kind==='speech'&&item.status==='succeeded').map(item=><option key={item.id} value={item.id}>{item.snapshot?.config?.name||item.prompt.slice(0,30)}</option>)}</select>{setup.masterAudioPath&&<><audio controls src={window.studio?.mediaUrl(setup.masterAudioPath)}/><button className="text-button" onClick={()=>patch({masterAudioPath:'',masterCues:[]})}>解除配音绑定</button></>}</div></div>}
        {setup.mode==='sections'?folderLibrary:<details className="workflow-master-library"><summary>素材对应目录（可选）</summary>{folderLibrary}</details>}
        <div className="section-header batch-step-heading"><div><h3>{setup.mode==='sections'?'段落与候选文案':'正文素材文件夹'}</h3><p className="field-note">{setup.mode==='sections'?'每个段落取一条候选，按下方顺序组成完整文案。关闭“参与组合”可暂时停用段落。':'选择正文要使用的图片或视频文件夹。'}</p></div><Button icon={Plus} disabled={setup.sections.length>=50} onClick={()=>patch({sections:[...setup.sections,section(nextSectionCode(setup.sections))]})}>添加段落</Button></div>
        <div className="section-selection-toolbar"><label className="inline-check"><input type="checkbox" aria-label="选择全部段落" checked={setup.sections.length>0&&chosenSections.length===setup.sections.length} onChange={event=>setChosenSections(event.target.checked?setup.sections.map(item=>item.section):[])}/>选择全部</label><span>{chosenSections.length?`已选 ${chosenSections.length} 段`:`共 ${setup.sections.length} 段`}</span><Button icon={Trash} className="button danger" disabled={!chosenSections.length} onClick={()=>setDeleteSections(chosenSections)}>删除所选段落</Button></div>
        <div className="table-scroll"><table className={`batch-section-table ${setup.mode==='master'?'master-sections':''}`}><thead><tr><th>选择</th><th>段落</th>{setup.mode==='sections'&&<th>候选文案</th>}<th>本段素材文件夹</th><th>操作</th></tr></thead><tbody>{setup.sections.map((item,index)=><tr key={item.section} className={item.enabled===false?'disabled-section':''}>
          <td><input type="checkbox" aria-label={`选择 ${item.section} 段`} checked={chosenSections.includes(item.section)} onChange={event=>setChosenSections(previous=>event.target.checked?[...previous,item.section]:previous.filter(id=>id!==item.section))}/></td><td><strong className="section-letter">{item.section}</strong><input aria-label={`${item.section} 段名称`} value={item.title} onChange={e=>editSection(index,{title:e.target.value})}/><label className="inline-check section-enabled"><input type="checkbox" aria-label={`启用 ${item.section} 段`} checked={item.enabled!==false} onChange={e=>editSection(index,{enabled:e.target.checked})}/>参与组合</label></td>
          {setup.mode==='sections'&&<td><CandidateEditor section={item.section} value={item.candidates} bindings={item.candidateBindings} folders={bindingFolders} onChange={(candidates,candidateBindings)=>editSection(index,{candidates,candidateBindings})}/><select aria-label={`${item.section} 段组合方式`} value={item.candidateMode||'texts'} onChange={e=>editSection(index,{candidateMode:e.target.value})}><option value="texts">按文案组合，匹配本段画面</option><option value="files">固定一条文案，按文件逐个组合</option></select></td>}
          <td className="section-folder-cell"><span className="section-fallback-label">未标注文字的备用素材</span><Button icon={FolderOpen} onClick={()=>selectFolder(index)}>{item.paths?.length?'更换文件夹':'选择素材文件夹'}</Button><p className="batch-folder" title={item.folder||item.paths?.join('\n')}>{item.folder|| (item.paths?.length?'已导入本段素材':'全部文字已绑定时可不选')}</p><small>{item.paths?.length||0} 个图片 / 视频（含子文件夹）</small></td>
          <td><div className="section-row-actions"><button className="icon-button" aria-label={`上移 ${item.section} 段`} disabled={!index} title="上移段落" onClick={()=>{const rows=[...setup.sections];[rows[index-1],rows[index]]=[rows[index],rows[index-1]];patch({sections:rows})}}>↑</button><button className="icon-button" aria-label={`下移 ${item.section} 段`} disabled={index===setup.sections.length-1} title="下移段落" onClick={()=>{const rows=[...setup.sections];[rows[index+1],rows[index]]=[rows[index],rows[index+1]];patch({sections:rows})}}>↓</button><button className="icon-button danger" aria-label={`删除 ${item.section} 段`} title="删除段落" onClick={()=>setDeleteSections([item.section])}><Trash size={17}/></button></div></td>
        </tr>)}</tbody></table>{!setup.sections.length&&<div className="batch-empty"><Plus size={25}/><div><strong>还没有段落</strong><p>添加段落后，填写候选文案并选择素材文件夹。</p></div><Button onClick={()=>patch({sections:[section('A')]})}>添加段落</Button></div>}</div>
      </fieldset>
      {busy&&busy!=='生成'&&<p className="workflow-loading" role="status">{busy}…</p>}
      <div className="workflow-step-footer"><StepLink onClick={()=>goToStep(2)}>查看完整组合</StepLink></div>
    </WorkflowStep>
    <WorkflowStep number={2} role="系统自动组合" hint={setup.mode==='sections'?'系统按段落顺序各取一条候选，自动拼成完整文案。选择本次要处理的数量。':'当前整篇文案作为一条组合。可展开预览核对全文。'} className="batch-setup">
      <div className="workflow-range"><div><span className="workflow-field-title">可用组合</span><p className="batch-total" data-testid="combination-count">{setup.mode==='sections'?(active.map(item=>sectionCapacity(item)).join(' × ')||'0'):'完整文案'} = <strong>{capacity} 条组合</strong></p></div><fieldset disabled={locked}><Field label="本次处理范围"><select aria-label="本次混剪范围" value={setup.limit==='all'?'all':'limited'} onChange={e=>patch({limit:e.target.value==='all'?'all':Math.min(capacity,10)})}><option value="all">全部组合</option><option value="limited">先处理前几条</option></select>{setup.limit!=='all'&&<input aria-label="混剪组合数量" type="number" min="1" max={capacity||1} value={setup.limit} onChange={e=>patch({limit:e.target.value})}/>}</Field></fieldset></div>
      <details className="workflow-preview"><summary aria-label="查看完整文案预览"><span><CaretRight size={16}/>查看完整文案预览</span><small>本次 {count.toLocaleString()} 条</small></summary>
        <div className="batch-copy-preview">{combinations.map((combo,index)=><div key={index}><span>{String(currentPage*pageSize+index+1).padStart(2,'0')}</span><p>{combo.masterText}{combo.segments.some(segment=>active.find(item=>item.section===segment.section)?.candidateMode==='files')&&<small className="batch-file-variant">{combo.segments.filter(segment=>active.find(item=>item.section===segment.section)?.candidateMode==='files').map(segment=>`${segment.section}：${basename(segment.paths[0])}`).join(' · ')}</small>}</p></div>)}{!capacity&&<p className="muted">填写启用段落的文案后，这里会显示完整组合。</p>}</div>
        <div className="batch-pagination" aria-label="完整文案预览分页"><span>共 {count.toLocaleString()} 条 · 第 {currentPage+1} / {pages} 页</span><Button disabled={currentPage===0} onClick={()=>setPreviewPage(currentPage-1)}>上一页</Button><Button disabled={currentPage>=pages-1} onClick={()=>setPreviewPage(currentPage+1)}>下一页</Button></div>
      </details>
      <div className="workflow-step-footer"><StepLink onClick={()=>goToStep(3)}>前往 AI 校对</StepLink></div>
    </WorkflowStep>
    <WorkflowStep number={3} role="你来确认" hint="选择文字模型连接，点击「开始 AI 校对」。有问题的组合会单独列出，可逐条或批量处理。">
      <CombinationReview setup={setup} count={count} state={state} session={reviewSession} signature={reviewSignature} combinationAt={combinationAt} call={call} run={run} notify={notify} disabled={Boolean(busy)||!ready||staleBindings} onBusy={setReviewBusy}/>
      {staleBindings&&<p className="binding-stale" role="alert">候选文案已修改，请先处理第 1 步的红色标注，再校对完整组合。</p>}
      <div className="workflow-step-footer"><StepLink onClick={()=>goToStep(4)}>设置配音与片头</StepLink></div>
    </WorkflowStep>
    <WorkflowStep number={4} role="你来设置" hint="在这里选择声音、成片比例和可选片头。到第 5 步点击生成时才会执行。" className="batch-setup">
      <fieldset disabled={locked}>
        <div className="workflow-voice-settings">
          {reuseMasterAudio?<div className="workflow-existing-audio"><MusicNote size={21}/><div><strong>使用已有配音</strong><p>{basename(setup.masterAudioPath)} · 系统沿这段音频的时间线匹配画面。</p></div><StepLink onClick={()=>goToStep(1)}>查看绑定的配音</StepLink></div>:<>
            {hasMasterAudio&&<p className="workflow-review-guide">采纳后的文案与绑定音频的原文不同，本次将按当前文案重新配音。</p>}
            <div className="montage-options workflow-audio-options"><Field label="配音预设"><select aria-label="混剪配音预设" value={setup.voicePresetId} onChange={e=>patch({voicePresetId:e.target.value})}><option value="">{state.settings.defaultSpeechPresetId?'使用全局默认配音预设':'使用已绑定的配音连接'}</option>{presets.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>{!presetId&&<Field label="配音音色"><input aria-label="配音音色" value={setup.voice} onChange={e=>patch({voice:e.target.value})}/></Field>}</div>
          </>}
        </div>
        <div className="montage-options workflow-audio-options"><Field label="成片比例"><select aria-label="混剪画面比例" value={setup.ratio} onChange={e=>patch({ratio:e.target.value})}>{['9:16','16:9','1:1'].map(value=><option key={value}>{value}</option>)}</select></Field><label className="inline-check"><input type="checkbox" aria-label="混剪生成字幕" checked={setup.subtitle} onChange={e=>patch({subtitle:e.target.checked})}/>生成字幕</label><label className="inline-check"><input type="checkbox" aria-label="自动识别素材" checked={setup.analyzeAssets} onChange={e=>patch({analyzeAssets:e.target.checked})}/>开始时 AI 识别素材</label></div>
        <p className="field-note">启用 AI 素材识别会调用所绑定的服务。关闭时，系统使用文件名、已有描述和段落素材匹配画面。</p>
        <div className="montage-opening"><Button icon={VideoCamera} onClick={()=>run(async()=>{const files=await choose('video');if(files?.length)patch({openingPath:files[0]})})}>{setup.openingPath?'更换开头视频':'添加开头视频（可选）'}</Button>{setup.openingPath&&<><button className="text-button" onClick={()=>setVideoPreview({path:setup.openingPath,name:basename(setup.openingPath)})}>{basename(setup.openingPath)}</button><button className="icon-button" aria-label="移除开头视频" onClick={()=>patch({openingPath:''})}><X size={16}/></button><select aria-label="片头声音策略" value={setup.openingAudioMode} onChange={e=>patch({openingAudioMode:e.target.value})}><option value="original">保留片头原声，结束后接正文旁白</option><option value="silent">片头静音，用正文旁白覆盖</option></select></>}</div>
      </fieldset>
      <div className="workflow-step-footer"><StepLink onClick={()=>goToStep(5)}>前往生成草稿</StepLink></div>
    </WorkflowStep>
    <WorkflowStep number={5} role="点击后自动执行" hint={reuseMasterAudio?'使用绑定的完整配音匹配画面，按设置插入片头并保存时间线。':'每条组合先合成一份完整配音，再沿声音时间线匹配画面，按设置插入片头并保存草稿。'} className="workflow-generation">
      <div className="workflow-generate-bar"><div className="workflow-generate-status" aria-live="polite">{generationBlock?<><p data-testid="generation-block-reason">{generationBlock.message}</p>{generationBlock.step&&<button className="workflow-next" data-workflow-target={generationBlock.step} onClick={()=>goToStep(generationBlock.step)}>前往第 {generationBlock.step} 步 · {stepNames[generationBlock.step-1]}<ArrowRight size={15}/></button>}</>:<p><CheckCircle size={18}/>本次 {count} 条组合已就绪</p>}</div>
        <Button primary icon={Play} data-testid="generate-montage-drafts" disabled={Boolean(generationBlock)} onClick={begin}>{reuseMasterAudio?'使用已有配音生成时间线':'生成配音与时间线'} · {count} 条</Button></div>
      {busy==='生成'&&<div className="batch-progress" role="status"><Sparkle size={19}/><span>正在处理第 {progress?.current||1} / {count} 条，已完成 {progress?.completed||0} 条。{progress?.stage}</span><Button onClick={()=>{stop.current=true;setProgress(previous=>({...previous,stage:'当前组合完成后停止。'}))}}>停止后续组合</Button></div>}
      {!busy&&progress?.runKey===executionKey&&<p className="speech-notice">{progress.stage}，已完成 {progress.completed} / {progress.total} 条。</p>}
      {progress?.runKey===executionKey&&failures.length>0&&<div className="batch-failures"><h3>{failures.length} 条未完成</h3>{failures.map(item=><p key={item.index}>第 {item.index} 条：{item.error}</p>)}<p>调整后可再次生成，已保存的相同草稿与配音会复用。</p></div>}
      <div className="workflow-step-footer"><StepLink onClick={()=>goToStep(6)}>查看时间线草稿</StepLink></div>
    </WorkflowStep>
    <WorkflowStep number={6} role="你来编辑或导出" hint="点「打开时间线」可拖动、增删画面或裁剪音频。在时间线内选择剪映草稿目录，再点「导出剪映草稿」。" className="batch-drafts">
      <div className="workflow-draft-header"><h3>时间线草稿 <span className="draft-count">{drafts.length}</span></h3><Button icon={DownloadSimple} disabled={!chosenDrafts.length||exporting} onClick={exportBatch}>导出选中 MP4（{chosenDrafts.length}）</Button></div>
      {!drafts.length?<div className="batch-empty"><FilmStrip size={30}/><div><strong>暂无时间线草稿</strong><p>在第 5 步点击生成后，每完成一条组合，这里就会出现一条草稿。</p></div><StepLink onClick={()=>goToStep(5)}>去生成草稿</StepLink></div>:<><div className="draft-selection"><label className="inline-check"><input aria-label="选择全部时间线草稿" type="checkbox" checked={drafts.length>0&&drafts.every(draft=>chosenDrafts.includes(draft.id))} onChange={event=>setChosenDrafts(event.target.checked?drafts.map(draft=>draft.id):[])}/>选择全部草稿</label><span>已选 {chosenDrafts.length} / {drafts.length} 条</span></div><div className="batch-draft-list">{drafts.slice().reverse().map(draft=><article key={draft.id}><input type="checkbox" aria-label={`选择草稿 ${draft.name}`} checked={chosenDrafts.includes(draft.id)} onChange={e=>setChosenDrafts(previous=>e.target.checked?[...previous,draft.id]:previous.filter(id=>id!==draft.id))}/><div className="draft-item-body"><strong>{draft.name}</strong><p title={draft.config?.masterText}>{draft.config?.masterText||draft.config?.segments?.map(item=>item.text).join('')}</p><small>{draft.timeline.clips.filter(item=>item.track==='picture').length} 个画面 <span className={draft.warnings?.length?'draft-warning':'draft-ready'}>{draft.warnings?.length?'需要检查提示':'可以编辑'}</span></small></div><Button icon={PencilSimple} onClick={()=>openEditor(draft.id)}>打开时间线</Button></article>)}</div></>}
      {state.jobs.some(job=>job.kind==='montage')&&renderGallery(state.jobs.filter(job=>job.kind==='montage'))}
    </WorkflowStep>
    <details className="surface batch-library"><summary><CaretRight size={18}/><span><strong>附加设置</strong><small>素材描述与旧配置</small></span><span className="library-count">{assets.length} 个素材</span></summary><div className="batch-library-content"><p className="field-note">文件夹已在段落行选择。这里维护的描述用于匹配画面，不修改原文件。</p>{state.formulas?.length>0&&<select disabled={locked} aria-label="载入旧混剪配置" defaultValue="" onChange={e=>{const formula=state.formulas.find(item=>item.id===e.target.value);if(formula)loadLegacy(formula)}}><option value="">载入以前保存的配置…</option>{state.formulas.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}{assets.map(asset=><details key={asset.id}><summary>{asset.name} · {asset.shots?.length||0} 个镜头</summary>{asset.shots?.map(shot=><label className="field" key={shot.id}><span>{basename(asset.path)} / {shot.sourceIn?.toFixed(1)||0} 秒</span><textarea disabled={locked} defaultValue={shot.description||''} aria-label={`镜头描述 ${shot.id}`} onBlur={e=>{if(e.target.value.trim()&&e.target.value!==shot.description)run(()=>call('editMontageShot',{assetId:asset.id,shotId:shot.id,description:e.target.value}))}}/></label>)}</details>)}{!assets.length&&<p className="muted">选择素材文件夹后，这里会列出可维护的素材。</p>}</div></details>
    {deleteSections&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="删除混剪段落"><header><h2>删除 {deleteSections.length} 个段落</h2><button className="icon-button" aria-label="取消删除段落" onClick={()=>setDeleteSections(null)}><X size={20}/></button></header><p>将删除 {deleteSections.join('、')} 段的候选文案和文件夹配置。原素材文件、已生成的时间线草稿和导出视频保留。</p><div className="modal-actions"><Button onClick={()=>setDeleteSections(null)}>取消</Button><button className="button danger" onClick={removeSections}>确认删除 {deleteSections.length} 个段落</button></div></section></div>}
  </div>;
}
