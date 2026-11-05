import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Plus, Play, FloppyDisk, VideoCamera, MusicNote, X, Sparkle } from '@phosphor-icons/react';
import { batchCapacity, batchCombinationAt, splitTexts, sectionCapacity } from '../shared/montage-batch.mjs';
import { SPEECH_CATALOGS } from '../shared/speech.mjs';

const basename = file => file?.split(/[\\/]/).pop() || '';
const section = (id, enabled = true) => ({ section: id, enabled, title: `${id} 段`, candidates: '', candidateMode: 'texts', paths: [], assetIds: [], folder: '' });
const blank = () => ({ name: '我的批量混剪', mode: 'sections', sections: [section('A'), section('B')], voicePresetId: '', voice: '', ratio: '9:16', subtitle: true, openingPath: '', openingAudioMode: 'original', masterAudioPath: '', masterText: '', masterCues: [], limit: 'all', analyzeAssets: false });
function Button({ icon: Icon, children, primary, ...props }) { return <button className={`button ${primary ? 'primary' : ''}`} {...props}>{Icon && <Icon size={18}/>} {children}</button>; }
function Field({ label, children }) { return <label className="field"><span className="field-label">{label}</span>{children}</label>; }

export default function MontageWorkspace({ state, loaded, call, run, notify, choose, chooseFolder, openEditor, setVideoPreview, speechInput, renderGallery }) {
  const [setup, setSetup] = useState(blank), [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(''), [progress, setProgress] = useState(null), [failures, setFailures] = useState([]), [saveState, setSaveState] = useState('');
  const stop = useRef(false), initialized = useRef(false), latest = useRef(setup);
  const [exporting,setExporting]=useState(false),[previewPage,setPreviewPage]=useState(0);
  const pageSize=10;
  const [chosenDrafts,setChosenDrafts]=useState([]);
  const assets = state.montageAssets || [], drafts = state.montageDrafts || [];
  const provider = state.settings.providers.find(item => item.id === state.settings.bindings.tts);
  const presets = state.settings.speechPresets || [];
  useEffect(() => {
    if (!loaded || initialized.current) return;
    initialized.current = true;
    const saved = state.montageSetup;
    const next = saved ? { ...blank(), ...saved } : { ...blank(), voicePresetId: state.settings.defaultSpeechPresetId || '', voice: SPEECH_CATALOGS[provider?.protocol]?.voice || 'alloy' };
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
  const patch = change => setSetup(previous => { const next = { ...previous, ...change }; latest.current = next; return next; });
  const editSection = (index, change) => patch({ sections: setup.sections.map((item,i) => i === index ? { ...item, ...change } : item) });
  const active = setup.sections.filter(item => item.enabled !== false);
  const capacity = setup.mode === 'master' ? (setup.masterText.trim() ? 1 : 0) : batchCapacity(setup.sections);
  const count = setup.limit === 'all' ? capacity : Math.min(capacity, Math.max(0, Math.floor(Number(setup.limit)||0)));
  const combinationAt = index => setup.mode === 'master' ? { masterText: setup.masterText.trim(), segments: [{ section: '正文', text: setup.masterText.trim(), paths: active.flatMap(item=>item.paths||[]), assetIds: active.flatMap(item=>item.assetIds||[]) }] } : batchCombinationAt(setup.sections,index);
  const pages=Math.max(1,Math.ceil(count/pageSize)), currentPage=Math.min(previewPage,pages-1);
  const combinations = useMemo(() => Array.from({length:Math.min(pageSize,Math.max(0,count-currentPage*pageSize))},(_,index)=>combinationAt(currentPage*pageSize+index)),[setup,count,currentPage]);
  const selectFolder = index => run(async () => {
    const folder = await chooseFolder(); if (!folder) return;
    setBusy('扫描文件夹');
    try {
      const result = await call('scanMontageLibrary', { folder, analyze: false });
      if (!result.assets?.length) throw new Error('这个文件夹没有可用的图片或视频。');
      editSection(index, { folder, paths: result.assets.map(item=>item.path), assetIds: result.assets.map(item=>item.id) });
    } finally { setBusy(''); }
  });
  const begin = () => run(async () => {
    if (busy) return;
    if (!setup.name.trim()) throw new Error('请填写任务名称。');
    if (setup.mode==='sections' && active.some(item=>item.candidateMode==='files'&&new Set(splitTexts(item.candidates)).size!==1)) throw new Error('按文件组合的段落只填写一条固定文案；多条文案请选择按文案组合。');
    if (!count || !combinations.length) throw new Error('请给启用的每一段填写文案。');
    if (!Number.isSafeInteger(count)) throw new Error('组合数量过大，请缩小本次处理范围。');
    if (setup.mode==='sections' ? active.some(item => !(item.paths?.length || item.assetIds?.length)) : !active.some(item => item.paths?.length || item.assetIds?.length)) throw new Error(setup.mode==='sections'?'请给每个启用的段落选择素材文件夹。':'请至少选择一个正文素材文件夹。');
    if (!(setup.mode==='master' && setup.masterAudioPath) && !setup.voicePresetId && !provider) throw new Error('请先在全局设置绑定语音服务或选择配音预设。');
    if (setup.analyzeAssets && !state.settings.bindings.montageVision) throw new Error('请先在全局设置绑定「混剪素材识别」服务。');
    await call('saveMontageSetup',setup);
    stop.current = false; setBusy('生成'); setFailures([]); let first, completed = 0;
    try {
      for (let index=0; index<count; index++) {
        const combo=combinationAt(index);
        if (stop.current) break;
        setProgress({ current: index+1, total: count, completed, stage: '合成完整配音 → 匹配素材 → 保存时间线' });
        const config = { name: `${setup.name} · ${String(index+1).padStart(2,'0')}`, fullNarration: true, voicePresetId: setup.voicePresetId, voice: setup.voicePresetId ? undefined : setup.voice || 'alloy', ratio: setup.ratio, subtitle: setup.subtitle, openingPath: setup.openingPath, openingAudioMode: setup.openingAudioMode, analyzeAssets: setup.analyzeAssets, assetIds: active.flatMap(item=>item.assetIds||[]), ...combo, ...(setup.mode==='master'?{masterAudioPath:setup.masterAudioPath,masterCues:setup.masterCues}:{}), variant: index };
        config.requestKey = JSON.stringify(config);
        try { const draft = await call('createMontageDraft',config); first ||= draft; completed++; }
        catch (error) { setFailures(previous=>[...previous,{index:index+1,text:combo.masterText,error:error.message}]); }
      }
      setProgress({ current: completed, total: count, completed, stage: stop.current ? '已停止后续组合，已完成草稿保留' : '本批处理结束' });
      notify(`已准备 ${completed} 条时间线草稿${stop.current?'，后续已停止':''}`);
      if (first && count === 1) openEditor(first.id);
    } finally { setBusy(''); }
  });
  const loadLegacy = formula => {
    const sections = (Array.isArray(formula.sections) ? formula.sections : Object.values(formula.sections||{})).map((item,index)=>({ ...section(item.section||String.fromCharCode(65+index)), ...item, enabled: Boolean(item.candidates?.trim()), folder: item.folder||'' }));
    patch({ ...blank(), ...formula, sections: sections.length?sections:blank().sections, mode: formula.masterText?'master':'sections', limit:'all' });
    notify('旧配置已载入；本流程将按完整组合重新配音，请核对段落和文件夹。');
  };
  const exportBatch = () => run(async()=>{
    setExporting(true);
    try { for(const id of chosenDrafts){const record=await call('openTimeline',id);await call('enqueueTimeline',id,record.timeline)} notify(`已提交 ${chosenDrafts.length} 条视频导出任务`);setChosenDrafts([]); }
    finally {setExporting(false)}
  });
  return <div className="page-scroll montage-workspace" data-testid="montage-workspace">
    <div className="page-title"><div><span className="eyebrow">STEP 03 · 批量混剪</span><h2>选好文案和文件夹，组合成片</h2><p>文案组合 → 完整配音 → 匹配画面 → 多轨编辑 → 导出视频 / 剪映草稿</p></div><span className="save-indicator">{saveState}</span></div>
    <section className="surface batch-setup">
      <fieldset disabled={Boolean(busy)||!ready}>
        <div className="batch-heading"><Field label="任务名称"><input aria-label="混剪任务名称" value={setup.name} onChange={e=>patch({name:e.target.value})}/></Field><div className="montage-mode-tabs"><button className={setup.mode==='sections'?'active':''} onClick={()=>patch({mode:'sections'})}>分段文案组合</button><button className={setup.mode==='master'?'active':''} onClick={()=>patch({mode:'master'})}>整篇文案 / 已有配音</button></div></div>
        {setup.mode==='master'&&<div className="batch-master"><Field label="完整旁白文案"><textarea aria-label="混剪完整旁白" rows={4} readOnly={Boolean(setup.masterAudioPath)} value={setup.masterText} onChange={e=>patch({masterText:e.target.value})}/></Field><div className="actions"><Button icon={MusicNote} onClick={()=>run(async()=>{const files=await choose('audio');if(files?.length)patch({masterAudioPath:files[0],masterCues:[]})})}>导入完整旁白音频</Button><select aria-label="选择已生成的配音" value="" onChange={e=>{const job=state.jobs.find(item=>item.id===e.target.value);if(job)patch({masterText:job.snapshot?.config?.text||job.prompt,masterAudioPath:job.localPath,masterCues:job.result?.segments||job.segments||[]})}}><option value="">使用已完成的语音合成…</option>{state.jobs.filter(item=>item.kind==='speech'&&item.status==='succeeded').map(item=><option key={item.id} value={item.id}>{item.snapshot?.config?.name||item.prompt.slice(0,30)}</option>)}</select>{setup.masterAudioPath&&<><audio controls src={window.studio?.mediaUrl(setup.masterAudioPath)}/><button className="text-button" onClick={()=>patch({masterAudioPath:'',masterCues:[]})}>解除配音绑定</button></>}</div></div>}
        <div className="section-header"><div><h3>{setup.mode==='sections'?'1. 逐行设置段落':'1. 选择正文素材文件夹'}</h3><p className="field-note">{setup.mode==='sections'?'每段取一条候选，按表格从上到下拼接。按文案匹配本段文件夹，也可用固定文案让文件逐个参与组合。':'正文从下面启用的文件夹里匹配画面，完整配音直接复用。'}</p></div><Button icon={Plus} disabled={setup.sections.length>=50} onClick={()=>patch({sections:[...setup.sections,section(setup.sections.length<26?String.fromCharCode(65+setup.sections.length):String(setup.sections.length+1))]})}>添加段落</Button></div>
        <div className="table-scroll"><table className="batch-section-table"><thead><tr><th>使用</th><th>段落</th>{setup.mode==='sections'&&<th>候选文案与组合方式</th>}<th>本段素材文件夹</th><th>顺序</th></tr></thead><tbody>{setup.sections.map((item,index)=><tr key={item.section} className={item.enabled===false?'disabled-section':''}>
          <td><input type="checkbox" aria-label={`启用 ${item.section} 段`} checked={item.enabled!==false} onChange={e=>editSection(index,{enabled:e.target.checked})}/></td><td><strong className="section-letter">{item.section}</strong><input aria-label={`${item.section} 段名称`} value={item.title} onChange={e=>editSection(index,{title:e.target.value})}/></td>
          {setup.mode==='sections'&&<td><textarea aria-label={`${item.section} 段候选文案`} rows={4} value={item.candidates} onChange={e=>editSection(index,{candidates:e.target.value})} placeholder="候选文案一\n候选文案二"/><small>{new Set(splitTexts(item.candidates)).size} 条不同文案</small><select aria-label={`${item.section} 段组合方式`} value={item.candidateMode||'texts'} onChange={e=>editSection(index,{candidateMode:e.target.value})}><option value="texts">按文案组合，匹配本段画面</option><option value="files">固定一条文案，按文件逐个组合</option></select></td>}
          <td><Button icon={FolderOpen} onClick={()=>selectFolder(index)}>{item.paths?.length?'更换文件夹':'选择素材文件夹'}</Button><p className="batch-folder" title={item.folder||item.paths?.join('\n')}>{item.folder|| (item.paths?.length?'已导入本段素材':'尚未选择')}</p><small>{item.paths?.length||0} 个图片 / 视频（含子文件夹）</small></td>
          <td><button className="icon-button" aria-label={`上移 ${item.section} 段`} disabled={!index} onClick={()=>{const rows=[...setup.sections];[rows[index-1],rows[index]]=[rows[index],rows[index-1]];patch({sections:rows})}}>↑</button><button className="icon-button" aria-label={`下移 ${item.section} 段`} disabled={index===setup.sections.length-1} onClick={()=>{const rows=[...setup.sections];[rows[index+1],rows[index]]=[rows[index],rows[index+1]];patch({sections:rows})}}>↓</button></td>
        </tr>)}</tbody></table></div>
        <div className="batch-heading"><h3>2. 配音与画面</h3></div>
        <div className="montage-options"><Field label="配音预设"><select aria-label="混剪配音预设" value={setup.voicePresetId} onChange={e=>patch({voicePresetId:e.target.value})}><option value="">使用已绑定的配音连接</option>{presets.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>{!setup.voicePresetId&&<Field label="配音音色"><input aria-label="配音音色" value={setup.voice} onChange={e=>patch({voice:e.target.value})}/></Field>}<Field label="成片比例"><select aria-label="混剪画面比例" value={setup.ratio} onChange={e=>patch({ratio:e.target.value})}>{['9:16','16:9','1:1'].map(value=><option key={value}>{value}</option>)}</select></Field><label className="inline-check"><input type="checkbox" aria-label="混剪生成字幕" checked={setup.subtitle} onChange={e=>patch({subtitle:e.target.checked})}/>生成字幕</label><label className="inline-check"><input type="checkbox" aria-label="自动识别素材" checked={setup.analyzeAssets} onChange={e=>patch({analyzeAssets:e.target.checked})}/>开始时 AI 识别素材</label></div>
        <p className="field-note">每条组合生成一份完整旁白，不先拼接 A/B 段录音。AI 识别按绑定服务计费；未启用时使用文件名、已有描述和本段所选素材匹配。</p>
        <div className="montage-opening"><Button icon={VideoCamera} onClick={()=>run(async()=>{const files=await choose('video');if(files?.length)patch({openingPath:files[0]})})}>{setup.openingPath?'更换开头视频':'添加开头视频（可选）'}</Button>{setup.openingPath&&<><button className="text-button" onClick={()=>setVideoPreview({path:setup.openingPath,name:basename(setup.openingPath)})}>{basename(setup.openingPath)}</button><button className="icon-button" aria-label="移除开头视频" onClick={()=>patch({openingPath:''})}><X size={16}/></button><select aria-label="片头声音策略" value={setup.openingAudioMode} onChange={e=>patch({openingAudioMode:e.target.value})}><option value="original">保留片头原声，结束后接正文旁白</option><option value="silent">片头静音，用正文旁白覆盖</option></select></>}</div>
        <div className="batch-heading"><div><h3>3. 预览组合与开始</h3><p className="batch-total" data-testid="combination-count">{setup.mode==='sections'?active.map(item=>sectionCapacity(item)).join(' × '):'完整文案'} = <strong>{capacity} 条组合</strong></p></div><Field label="本次处理"><select aria-label="本次混剪范围" value={setup.limit==='all'?'all':'limited'} onChange={e=>patch({limit:e.target.value==='all'?'all':Math.min(capacity,10)})}><option value="all">全部组合</option><option value="limited">先处理前几条</option></select>{setup.limit!=='all'&&<input aria-label="混剪组合数量" type="number" min="1" max={capacity||1} value={setup.limit} onChange={e=>patch({limit:e.target.value})}/>}</Field></div>
        <div className="batch-copy-preview">{combinations.map((combo,index)=><div key={index}><span>{String(currentPage*pageSize+index+1).padStart(2,'0')}</span><p>{combo.masterText}{combo.segments.some(segment=>active.find(item=>item.section===segment.section)?.candidateMode==='files')&&<small className="batch-file-variant">{combo.segments.filter(segment=>active.find(item=>item.section===segment.section)?.candidateMode==='files').map(segment=>`${segment.section}：${basename(segment.paths[0])}`).join(' · ')}</small>}</p></div>)}{!capacity&&<p className="muted">填写启用段落的文案后，这里会显示完整组合。</p>}</div>
        <div className="batch-pagination"><span>共 {count.toLocaleString()} 条 · 第 {currentPage+1} / {pages} 页</span><Button disabled={currentPage===0} onClick={()=>setPreviewPage(currentPage-1)}>上一页</Button><Button disabled={currentPage>=pages-1} onClick={()=>setPreviewPage(currentPage+1)}>下一页</Button></div><div className="batch-start"><p>点击开始后会调用所选语音服务；已完成的相同组合直接打开原草稿。时间线保存后可继续编辑或导出。</p><Button primary icon={Play} disabled={!count} onClick={begin}>开始混剪 · {count} 条</Button></div>
      </fieldset>
      {busy&&<div className="batch-progress" role="status"><Sparkle size={20}/>{busy==='生成'?`正在处理 ${progress?.current||0} / ${progress?.total||count}：${progress?.stage||'准备中'}`:busy}{busy==='生成'&&<Button onClick={()=>{stop.current=true;setProgress(previous=>({...previous,stage:'正在完成当前条，随后停止'}))}}>停止后续组合</Button>}</div>}
      {!busy&&progress&&<p className="speech-notice">{progress.stage}，已完成 {progress.completed} / {progress.total} 条。</p>}
      {failures.length>0&&<div className="batch-failures"><h3>{failures.length} 条未完成</h3>{failures.map(item=><p key={item.index}>第 {item.index} 条：{item.error}</p>)}<p>调整素材后可再次开始；已保存的相同草稿与配音会复用。</p></div>}
    </section>
    <section className="surface batch-drafts"><div className="section-header"><div><h2>时间线草稿</h2><p className="field-note">画面、配音、音乐和字幕分轨保存。先编辑检查，再选择导出。</p></div><Button icon={Play} disabled={!chosenDrafts.length||exporting} onClick={exportBatch}>导出选中视频（{chosenDrafts.length}）</Button></div>{!drafts.length?<p className="muted">开始混剪后，完成一条就会在这里出现一条。</p>:<div className="batch-draft-list">{drafts.slice().reverse().map(draft=><article key={draft.id}><input type="checkbox" aria-label={`选择草稿 ${draft.name}`} checked={chosenDrafts.includes(draft.id)} onChange={e=>setChosenDrafts(previous=>e.target.checked?[...previous,draft.id]:previous.filter(id=>id!==draft.id))}/><div><strong>{draft.name}</strong><p>{draft.config?.masterText||draft.config?.segments?.map(item=>item.text).join('')}</p><small>{draft.timeline.clips.filter(item=>item.track==='picture').length} 个画面 · {draft.warnings?.length?'含待检查提示':'已准备'}</small></div><Button icon={FloppyDisk} onClick={()=>openEditor(draft.id)}>打开时间线</Button></article>)}</div>}</section>
    <details className="surface batch-library"><summary>素材描述与旧配置</summary><p className="field-note">文件夹已在段落行选择。这里可维护素材描述，帮助匹配；不修改原文件。</p>{state.formulas?.length>0&&<select aria-label="载入旧混剪配置" defaultValue="" onChange={e=>{const formula=state.formulas.find(item=>item.id===e.target.value);if(formula)loadLegacy(formula)}}><option value="">载入以前保存的配置…</option>{state.formulas.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}{assets.map(asset=><details key={asset.id}><summary>{asset.name} · {asset.shots?.length||0} 个镜头</summary>{asset.shots?.map(shot=><label className="field" key={shot.id}><span>{basename(asset.path)} / {shot.sourceIn?.toFixed(1)||0} 秒</span><textarea defaultValue={shot.description||''} aria-label={`镜头描述 ${shot.id}`} onBlur={e=>{if(e.target.value.trim()&&e.target.value!==shot.description)run(()=>call('editMontageShot',{assetId:asset.id,shotId:shot.id,description:e.target.value}))}}/></label>)}</details>)}</details>
    {renderGallery(state.jobs.filter(job=>job.kind==='montage'))}
  </div>;
}
