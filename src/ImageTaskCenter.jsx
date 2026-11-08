import React, {useMemo,useState} from 'react';
import {ArrowsClockwise,ArrowSquareOut,Copy,Eye,Image,Trash} from '@phosphor-icons/react';
import {currentImageSlots,imageJobError,imageJobStages} from '../shared/image-jobs.mjs';
import './image-task-center.css';

const statusNames={queued:'排队中',planning:'规划中',running:'生成中',saving:'保存中',succeeded:'已完成',failed:'失败',unknown:'状态待确认',cancelled:'已取消'};
const filters=[['all','全部'],['queued','排队中'],['active','执行中'],['failed','失败'],['unknown','待确认'],['succeeded','已完成']];
const category=status=>['planning','running','saving'].includes(status)?'active':status;
const slot=job=>String(job.slot+1).padStart(4,'0');
const slotKey=job=>`${job.rowId}:${job.slot}`;
const date=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
const pageSize=25;
const failureHelp=job=>{
  if(job.failureCode==='CREDENTIAL_STORAGE_CONNECTION_CHANGED')return '原连接已更改。重新绑定生图服务后，选中失败项并用当前模型重跑。';
  if(job.failureCode==='HTTP 429')return '先核对服务额度。如服务商限制并发，可降低底部「生图并发」后再重跑。';
  if(job.referencePaths?.length&&['HTTP 400','HTTP 404','HTTP 422'].includes(job.failureCode))return '请核对该模型是否支持参考图编辑，以及参考图数量和尺寸限制。';
  return '';
};

export default function ImageTaskCenter({state,call,notify,openImages,reveal,info,Button,Dialog}) {
  const [filter,setFilter]=useState('all'),[query,setQuery]=useState(''),[page,setPage]=useState(0);
  const [selected,setSelected]=useState([]),[detail,setDetail]=useState(null),[confirm,setConfirm]=useState(null),[busy,setBusy]=useState(false);
  const rows=useMemo(()=>new Map(state.rows.map(row=>[row.id,row])),[state.rows]);
  const {jobs,chains}=useMemo(()=>{
    const chains=new Map();
    for(const job of state.jobs){
      if(job.kind!=='image'||job.archivedAt||job.discardedAt)continue;
      const key=slotKey(job);
      if(!chains.has(key))chains.set(key,[]);
      chains.get(key).push(job);
    }
    return {chains,jobs:currentImageSlots(state.jobs).filter(job=>rows.has(job.rowId)).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))};
  },[state.jobs,rows]);
  const counts=jobs.reduce((all,job)=>{const key=category(job.status);all[key]=(all[key]||0)+1;return all},{});
  const needle=query.trim().toLocaleLowerCase();
  const matching=jobs.filter(job=>{
    const row=rows.get(job.rowId);
    const haystack=`${row.code} ${row.name} ${job.snapshot?.provider?.model||''} ${job.failureCode||''} ${job.error||''}`;
    return (filter==='all'||category(job.status)===filter)&&haystack.toLocaleLowerCase().includes(needle);
  });
  const pages=Math.max(1,Math.ceil(matching.length/pageSize)), visiblePage=Math.min(page,pages-1);
  const visible=matching.slice(visiblePage*pageSize,(visiblePage+1)*pageSize);
  const chosen=matching.filter(job=>selected.includes(job.id));
  const failed=chosen.filter(job=>job.status==='failed');
  const canSwitch=failed.filter(job=>!job.result&&!job.remoteId);
  const removable=chosen.filter(job=>chains.get(slotKey(job)).every(item=>!item.result&&!item.remoteId&&
    (['failed','cancelled'].includes(item.status)||(item.status==='queued'&&!item.startedAt))));
  const item=state.jobs.find(job=>job.id===detail);
  const currentProvider=state.settings.providers.find(provider=>provider.id===state.settings.bindings.image);
  function changeFilter(value){setFilter(value);setPage(0);setSelected([])}
  function toggle(ids,checked){setSelected(previous=>checked?[...new Set([...previous,...ids])]:previous.filter(id=>!ids.includes(id)))}
  async function perform(){
    if(!confirm||busy)return;
    setBusy(true);
    try{
      if(confirm.kind==='delete'){
        await call('deleteFailedImages',confirm.ids,{includeQueued:true});
        notify(`已移除 ${confirm.ids.length} 个占位`);
      }else{
        const retried=await call('retryJobs',confirm.ids,{useCurrentImageProvider:confirm.kind==='switch'});
        notify(retried.length?`已提交 ${retried.length} 个重试任务`:'所选任务状态已变化，请刷新选择');
      }
      toggle(confirm.ids,false);setConfirm(null);
    }catch(error){notify(error.message,'error');setConfirm(null)}
    finally{setBusy(false)}
  }
  async function copyDetails(job){
    const model=job.snapshot?.provider?.model||'未记录';
    const report=[
      `子云影像工坊 v${info?.version||'未知'} · ${info?.platform||''} ${info?.arch||''}`,
      `任务 ${job.id} · 第 ${job.attempt||1} 次 · ${statusNames[job.status]||job.status}`,
      `时间 ${date(job.finishedAt||job.updatedAt)}`,
      `模型 ${model} · ${job.referencePaths?.length?'参考图编辑':'纯文生图'}`,
      `阶段 ${imageJobStages[job.failureStage]||'未记录'}${job.failureCode?` · ${job.failureCode}`:''}`,
      imageJobError(job),
    ].filter(Boolean).join('\n');
    try{await navigator.clipboard.writeText(report);notify('已复制任务诊断信息')}
    catch{notify('无法复制诊断信息，请选中详情文字复制。','error')}
  }
  return <div className="page-scroll image-task-center">
    <div className="page-title"><div><span className="eyebrow">IMAGE TASKS</span><h2>生图任务中心</h2><p>跨素材类型查看当前批次。每个出图槽位显示当前结果，重试记录在任务详情中查看。</p></div>{state.settings.paused&&<span className="image-task-pause">队列已暂停 · 底部点击「继续」</span>}</div>
    <div className="image-task-filters" aria-label="按任务状态筛选">
      {filters.map(([value,label])=><button key={value} className={filter===value?'active':''} aria-pressed={filter===value} onClick={()=>changeFilter(value)}><span>{label}</span><strong>{value==='all'?jobs.length:counts[value]||0}</strong></button>)}
    </div>
    <section className="image-task-panel" aria-label="生图任务列表">
      <div className="image-task-toolbar">
        <input type="search" value={query} aria-label="搜索生图任务" placeholder="搜索编号、类型、模型或报错" onChange={event=>{setQuery(event.target.value);setPage(0);setSelected([])}}/>
        <span role="status">已选 {chosen.length} 项</span>
        <Button disabled={!matching.length||busy} onClick={()=>setSelected(matching.map(job=>job.id))}>全选筛选结果</Button>
        <Button icon={ArrowsClockwise} disabled={!failed.length||busy} onClick={()=>setConfirm({kind:'retry',ids:failed.map(job=>job.id)})}>重跑失败{failed.length?` (${failed.length})`:''}</Button>
        <Button disabled={!canSwitch.length||!currentProvider||busy} onClick={()=>setConfirm({kind:'switch',ids:canSwitch.map(job=>job.id)})}>用当前模型重跑</Button>
        <Button danger icon={Trash} disabled={!removable.length||busy} onClick={()=>setConfirm({kind:'delete',ids:removable.map(job=>job.id)})}>移除占位{removable.length?` (${removable.length})`:''}</Button>
      </div>
      <div className="image-task-table-scroll"><table>
        <thead><tr><th><input type="checkbox" aria-label="选择本页任务" disabled={!visible.length} checked={!!visible.length&&visible.every(job=>selected.includes(job.id))} onChange={event=>toggle(visible.map(job=>job.id),event.target.checked)}/></th><th>素材类型 / 槽位</th><th>状态</th><th>模型</th><th>说明</th><th>操作</th></tr></thead>
        <tbody>{visible.map(job=>{
          const row=rows.get(job.rowId);
          const note=imageJobError(job)||job.exportError||job.warning||'';
          return <tr key={job.id}>
            <td><input type="checkbox" aria-label={`选择任务 ${row.code} / ${slot(job)}`} checked={selected.includes(job.id)} onChange={event=>toggle([job.id],event.target.checked)}/></td>
            <td><strong>{row.code} / {row.name||'未命名类型'}</strong><small>第 {slot(job)} 张 · 第 {job.attempt||1} 次</small></td>
            <td><span className={`image-task-status ${category(job.status)}`}>{statusNames[job.status]||job.status}</span></td>
            <td>{job.snapshot?.provider?.model||'—'}</td>
            <td className="image-task-note" title={note}>{note||date(job.updatedAt)}</td>
            <td><button className="text-button" onClick={()=>setDetail(job.id)}><Eye size={16}/>详情</button></td>
          </tr>;
        })}{!visible.length&&<tr><td colSpan={6} className="image-task-empty"><Image size={26}/><p>{jobs.length?'当前筛选没有匹配任务':'图片素材页提交生成后，任务会出现在这里。'}</p></td></tr>}</tbody>
      </table></div>
      <div className="image-task-pagination"><span>共 {matching.length} 条 · 第 {visiblePage+1} / {pages} 页</span><Button disabled={visiblePage===0} onClick={()=>setPage(visiblePage-1)}>上一页</Button><Button disabled={visiblePage+1>=pages} onClick={()=>setPage(visiblePage+1)}>下一页</Button></div>
    </section>
    {item&&<Dialog title={`任务详情 · 第 ${slot(item)} 张`} onClose={()=>setDetail(null)}>
      <dl className="version-details image-task-details">
        <dt>任务状态</dt><dd>{statusNames[item.status]} · 第 {item.attempt||1} 次</dd>
        <dt>提交 / 结束</dt><dd>{date(item.createdAt)} / {date(item.finishedAt)}</dd>
        <dt>生图连接</dt><dd>{item.snapshot?.provider?.name||'未记录'} · {item.snapshot?.provider?.model||'未记录'}</dd>
        <dt>请求方式</dt><dd>{item.referencePaths?.length?`参考图编辑 · ${item.referencePaths.length} 张参考图`:'纯文生图'}</dd>
        {item.remoteId&&<><dt>远端任务编号</dt><dd>{item.remoteId}</dd></>}
        {imageJobError(item)&&<><dt>失败阶段</dt><dd>{imageJobStages[item.failureStage]||'这条任务未记录阶段'} {item.failureCode&&`· ${item.failureCode}`}</dd><dt>失败原因</dt><dd>{imageJobError(item)}</dd></>}
        {failureHelp(item)&&<><dt>排查入口</dt><dd>{failureHelp(item)}</dd></>}
        {item.exportError&&<><dt>导出错误</dt><dd>{item.exportError}</dd></>}
      </dl>
      {(chains.get(slotKey(item))?.length||0)>1&&<details className="image-task-history"><summary>查看历次尝试</summary><ul>{chains.get(slotKey(item)).map(job=><li key={job.id}>第 {job.attempt} 次 · {statusNames[job.status]} · {job.snapshot?.provider?.model||'未记录'}{imageJobError(job)&&` · ${imageJobError(job)}`}</li>)}</ul></details>}
      <div className="modal-actions">
        <Button icon={Copy} onClick={()=>copyDetails(item)}>复制诊断信息</Button>
        {item.localPath&&<><Button icon={ArrowSquareOut} onClick={()=>reveal(item.localPath)}>打开文件位置</Button><Button primary icon={Eye} onClick={()=>{setDetail(null);openImages([item.localPath])}}>查看图片</Button></>}
      </div>
    </Dialog>}
    {confirm&&<Dialog title={confirm.kind==='delete'?'移除图片占位':confirm.kind==='switch'?'用当前模型重跑':'重跑失败任务'} onClose={()=>{if(!busy)setConfirm(null)}}>
      <p>{confirm.kind==='delete'?`移除这 ${confirm.ids.length} 个未开始或已失败的占位。移除后可从图片素材页重新提交，原始素材会保留。`:confirm.kind==='switch'?`将用「${currentProvider?.name||''} · ${currentProvider?.model||''}」重跑 ${confirm.ids.length} 张，沿用原来的提示词和参考图，服务商可能计费。`:`将重试 ${confirm.ids.length} 张，沿用原任务的模型。已有可恢复结果会优先继续保存。`}</p>
      <div className="modal-actions"><Button disabled={busy} onClick={()=>setConfirm(null)}>取消</Button><Button primary={confirm.kind!=='delete'} danger={confirm.kind==='delete'} disabled={busy} onClick={perform}>确认{confirm.kind==='delete'?'移除':'重跑'}</Button></div>
    </Dialog>}
  </div>;
}
