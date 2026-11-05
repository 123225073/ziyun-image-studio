import React, { useEffect, useRef, useState } from 'react';
import { Sparkle, ArrowsClockwise, CheckCircle, WarningCircle, X } from '@phosphor-icons/react';

const statusName = status => ({ pass:'未发现明显问题', issue:'发现问题', error:'校对失败', unchecked:'待重新校对' }[status] || '未校对');
const number = index => String(index + 1).padStart(2, '0');
export default function CombinationReview({ setup, count, state, session, signature, combinationAt, call, run, notify, disabled, onBusy }) {
  const [providerId,setProviderId]=useState('');
  const [scope,setScope]=useState('all'),[filter,setFilter]=useState('issue'),[page,setPage]=useState(0),[selected,setSelected]=useState([]);
  const [operation,setOperation]=useState(null),[confirm,setConfirm]=useState(null),[notice,setNotice]=useState('');
  const stopping=useRef(false),mounted=useRef(true);
  const providers=state.settings.providers.filter(item=>item.protocol==='openai-chat');
  const defaultProvider=state.settings.bindings.rewrite||state.settings.bindings.vision||'';
  const chosenProvider=providerId||defaultProvider;
  const boundMasterAudio=setup.mode==='master'&&Boolean(setup.masterAudioPath);
  const items=session?.items||{};
  const records=Object.values(items).filter(item=>Number.isSafeInteger(item.index)&&item.index<count);
  const issues=records.filter(item=>item.status==='issue').map(item=>item.index).sort((a,b)=>a-b);
  const passed=records.filter(item=>item.status==='pass').length;
  const reviewed=records.filter(item=>item.status==='pass'||item.status==='issue').length;
  const pageSize=5;
  const filtered=filter==='all'?null:records.filter(item=>filter==='issue'?item.status==='issue':filter==='pass'?item.status==='pass':item.status==='error'||item.status==='unchecked').map(item=>item.index).sort((a,b)=>a-b);
  const listCount=filtered?filtered.length:count;
  const pages=Math.max(1,Math.ceil(listCount/pageSize)),currentPage=Math.min(page,pages-1);
  const indices=filtered?filtered.slice(currentPage*pageSize,(currentPage+1)*pageSize):Array.from({length:Math.min(pageSize,Math.max(0,count-currentPage*pageSize))},(_,i)=>currentPage*pageSize+i);
  const proposals=selected.filter(index=>items[index]?.proposal&&items[index]?.accepted?.proposalId!==items[index].proposal.id);
  const toggle=index=>setSelected(previous=>previous.includes(index)?previous.filter(value=>value!==index):[...previous,index]);
  useEffect(()=>{setSelected([]);setPage(0);setConfirm(null);setNotice('');stopping.current=true;},[signature]);
  useEffect(()=>{setSelected(previous=>previous.filter(index=>index<count));setConfirm(null);setPage(0);},[count]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;stopping.current=true;};},[]);
  const execute=(kind,chosen,force=false)=>run(async()=>{
    if(operation||disabled)return;
    const total=chosen?.length??count;
    if(!total)throw new Error('请先准备或选择需要处理的组合。');
    if(kind!=='accept'&&!providers.some(item=>item.id===chosenProvider))throw new Error('请选择用于文案校对的 AI 连接。');
    if(setup.mode==='master'&&setup.masterAudioPath&&kind!=='review')throw new Error('已绑定旁白音频，调整文案前请先解除配音绑定。');
    stopping.current=false;onBusy(true);setNotice('');let completed=0,failed=0,lastError='';
    setOperation({kind,current:0,total});
    try{
      for(let cursor=0;cursor<total;cursor++){
        if(stopping.current||!mounted.current)break;
        const index=chosen?chosen[cursor]:cursor;
        setOperation({kind,current:cursor+1,total});
        try{
          if(kind==='review'){const result=await call('reviewMontageCombinations',{setup,indices:[index],providerId:chosenProvider,force});const item=result.items?.find(item=>item.index===index);if(!item||item.status==='error')throw new Error(item?.error||'这条文案未完成校对，请重试。');}
          else if(kind==='accept')await call('acceptMontageSuggestion',{setup,index,sourceKey:session.sourceKey,proposalId:items[index].proposal.id});
          else await call('suggestMontageCombination',{setup,index,mode:kind,sourceKey:session?.sourceKey,providerId:chosenProvider});
          completed++;
        }catch(error){failed++;lastError=error.message;}
      }
      if(mounted.current){setNotice(`${stopping.current?'已停止后续处理。':''}完成 ${completed} 条${failed?`，${failed} 条未完成：${lastError}`:''}`);if(kind==='review')setFilter('issue');if(kind==='accept'){setConfirm(null);setSelected([]);setFilter('pending');}notify(`${kind==='review'?'文案校对':kind==='accept'?'采纳建议':'生成建议'}完成 ${completed} 条${failed?`，${failed} 条未完成`:''}`);}
    }finally{if(mounted.current)setOperation(null);onBusy(false);}
  });
  const reviewTargets=scope==='selected'?selected:scope==='page'?indices:null;
  const suggestionTargets=selected.filter(index=>['pass','issue'].includes(items[index]?.status));
  const canSuggest=!disabled&&!operation&&suggestionTargets.length>0&&!(setup.mode==='master'&&setup.masterAudioPath);
  return <section className="combination-review" aria-label="AI 文案逻辑校对">
    <div className="review-title"><div><h3><Sparkle size={20}/>4. AI 文案逻辑校对</h3><p>先通读完整组合并列出问题，再选择重新搭配或轻度改写。建议经你采纳后才用于配音。</p></div><span className="review-optional">可选步骤</span></div>
    <div className="review-controls">
      <label className="field"><span className="field-label">校对连接</span><select aria-label="文案校对AI连接" disabled={disabled||Boolean(operation)} value={chosenProvider} onChange={e=>setProviderId(e.target.value)}><option value="">请选择文字模型连接</option>{providers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="field"><span className="field-label">校对范围</span><select aria-label="文案校对范围" disabled={disabled||Boolean(operation)} value={scope} onChange={e=>setScope(e.target.value)}><option value="all">本次全部 {count} 条组合</option><option value="page">当前显示的 {indices.length} 条</option><option value="selected">已勾选的 {selected.length} 条</option></select></label>
      <button className="button primary" disabled={disabled||Boolean(operation)||!count||(scope!=='all'&&!reviewTargets?.length)} onClick={()=>execute('review',reviewTargets)}><Sparkle size={17}/>开始 AI 校对</button>
      <span className="review-cost-note">点击后调用所选 AI 服务</span>
    </div>
    <div className="review-stats"><span>已校对 <b>{reviewed}</b> / {count}</span><span className="review-good">通过 <b>{passed}</b></span><span className="review-problems">有问题 <b>{issues.length}</b></span><span>待校对 / 重试 <b>{Math.max(0,count-reviewed)}</b></span></div>
    {boundMasterAudio&&<p className="review-notice">当前文案绑定了已有配音。可以校对；如需改写，请先解除配音绑定，调整后重新合成声音。</p>}
    {operation&&<div className="review-progress" role="status"><span>{operation.kind==='review'?'正在校对':operation.kind==='accept'?'正在采纳':'正在生成建议'} {operation.current} / {operation.total}，已完成的结果会保留。</span><button className="button" onClick={()=>{stopping.current=true;setNotice('当前条完成后停止。')}}>停止后续处理</button></div>}
    {notice&&<p className="review-notice" role="status">{notice}</p>}
    <div className="review-list-toolbar">
      <div className="review-tabs">{[['issue','有问题'],['pending','待复检 / 失败'],['pass','已通过'],['all','全部组合']].map(([value,label])=><button key={value} className={filter===value?'active':''} onClick={()=>{setFilter(value);setPage(0)}}>{label}</button>)}</div>
      <label className="inline-check"><input type="checkbox" aria-label="选择当前页组合" disabled={disabled||Boolean(operation)||!indices.length} checked={indices.length>0&&indices.every(index=>selected.includes(index))} onChange={event=>setSelected(previous=>event.target.checked?[...new Set([...previous,...indices])]:previous.filter(index=>!indices.includes(index)))}/>选本页</label>
      <button className="text-button" disabled={disabled||Boolean(operation)||!issues.length} onClick={()=>setSelected(issues)}>选择全部问题</button>
    </div>
    <div className="review-batch-actions"><span>已选 {selected.length} 条{selected.length>suggestionTargets.length?` · ${suggestionTargets.length} 条可调整`:''}</span><button className="button" disabled={!canSuggest||setup.mode==='master'} onClick={()=>execute('rematch',suggestionTargets)}><ArrowsClockwise size={16}/>重新搭配所选</button><button className="button" disabled={!canSuggest} onClick={()=>execute('rewrite',suggestionTargets)}><Sparkle size={16}/>轻度改写所选</button><button className="button" disabled={disabled||Boolean(operation)||!proposals.length} onClick={()=>setConfirm(proposals)}>检查并采纳建议（{proposals.length}）</button>{selected.length>0&&<button className="text-button" disabled={Boolean(operation)} onClick={()=>setSelected([])}>取消选择</button>}</div>
    <div className="review-item-list">
      {indices.map(index=>{const record=items[index],combo=combinationAt(index),proposal=record?.proposal;return <article key={index} className={`review-item ${record?.status||'new'}`}>
        <header><label className="inline-check"><input type="checkbox" aria-label={`选择文案组合 ${index+1}`} disabled={disabled||Boolean(operation)} checked={selected.includes(index)} onChange={()=>toggle(index)}/><strong>组合 {number(index)}</strong></label><span className={`review-status ${record?.status||'new'}`}>{record?.status==='pass'?<CheckCircle size={14}/>:record?.status==='issue'?<WarningCircle size={14}/>:null}{statusName(record?.status)}</span>{record?.accepted&&<span className="review-accepted">已采纳调整</span>}</header>
        <p className="review-copy">{combo.masterText}</p>
        {record?.summary&&<p className="review-summary">{record.summary}</p>}
        {record?.error&&<p className="review-error">{record.error}</p>}
        {record?.suggestionError&&<p className="review-error">建议生成失败：{record.suggestionError}</p>}
        {record?.issues?.length>0&&<ul className="review-issues">{record.issues.map((issue,i)=><li key={i}>{issue.section&&<strong>{issue.section} 段：</strong>}{issue.message}{issue.quote&&<blockquote>{issue.quote}</blockquote>}{issue.suggestion&&<small>{issue.suggestion}</small>}</li>)}</ul>}
        <div className="review-item-actions"><button className="text-button" disabled={disabled||Boolean(operation)} onClick={()=>execute('review',[index],Boolean(record))}>{record?'重新校对':'校对这条'}</button><button className="button" disabled={disabled||Boolean(operation)||setup.mode==='master'||!['pass','issue'].includes(record?.status)||boundMasterAudio} onClick={()=>execute('rematch',[index])}>重新搭配</button><button className="button" disabled={disabled||Boolean(operation)||!['pass','issue'].includes(record?.status)||boundMasterAudio} onClick={()=>execute('rewrite',[index])}>轻度改写</button></div>
        {proposal&&<details className="review-proposal" open><summary>{proposal.mode==='rematch'?'重新搭配建议':'轻度改写建议'}</summary><p>{proposal.reason}</p><div className="review-compare"><div><span>当前文案</span><p>{combo.masterText}</p></div><div><span>建议文案</span><p>{proposal.masterText}</p></div></div><button className="button" disabled={disabled||Boolean(operation)||boundMasterAudio||record.accepted?.proposalId===proposal.id} onClick={()=>setConfirm([index])}>检查并采纳这条建议</button></details>}
      </article>})}
      {!indices.length&&<div className="review-empty">{!count?'填写候选文案后，可以在这里校对完整组合。':filter==='issue'?(reviewed?'当前校对结果中没有问题组合。':'尚未校对。点击上方“开始 AI 校对”，问题会单独列在这里。'):'这里暂时没有对应的组合。'}</div>}
    </div>
    {listCount>pageSize&&<div className="batch-pagination"><span>共 {listCount} 条 · 第 {currentPage+1} / {pages} 页</span><button className="button" disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>上一页</button><button className="button" disabled={currentPage>=pages-1} onClick={()=>setPage(currentPage+1)}>下一页</button></div>}
    {confirm&&<div className="modal-backdrop"><section className="modal wide review-accept-modal" role="dialog" aria-modal="true" aria-label="采纳文案建议"><header><h2>确认采纳 {confirm.length} 条建议</h2><button className="icon-button" disabled={Boolean(operation)} aria-label="关闭采纳建议" onClick={()=>setConfirm(null)}><X size={20}/></button></header><p className="modal-intro">这些调整仅用于对应的完整组合，不会改写段落中的原始候选。采纳后可再次校对，再开始配音。</p>{confirm.map(index=><section key={index}><h3>组合 {number(index)}</h3><div className="review-compare"><div><span>当前文案</span><p>{combinationAt(index).masterText}</p></div><div><span>将采用的文案</span><p>{items[index]?.proposal?.masterText}</p></div></div></section>)}<div className="modal-actions"><button className="button" disabled={Boolean(operation)} onClick={()=>setConfirm(null)}>返回检查</button><button className="button primary" disabled={Boolean(operation)} onClick={()=>execute('accept',confirm)}>确认采纳 {confirm.length} 条</button></div></section></div>}
  </section>;
}
