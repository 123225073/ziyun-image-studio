import React,{useEffect,useRef,useState} from 'react';
import {FolderOpen,CheckCircle,WarningCircle,X,ArrowRight} from '@phosphor-icons/react';
import './image-batch-import.css';
import './image-folder-import.css';

export default function ImageFolderImport({call,media,onClose,onImported,initialPlan=null}){
 const [plan,setPlan]=useState(initialPlan),[result,setResult]=useState(null),[busy,setBusy]=useState(''),[error,setError]=useState('');
 const operationActive=useRef(false);
 const close=()=>{if(!operationActive.current)onClose()};
 useEffect(()=>{const handle=event=>{if(event.key==='Escape'&&!operationActive.current)onClose()};window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle)},[onClose]);
 const operate=async(kind,action)=>{if(operationActive.current)return;operationActive.current=true;setBusy(kind);setError('');try{await action()}catch(caught){setError(caught.message||'操作未完成，请重试。')}finally{operationActive.current=false;setBusy('')}};
 const choose=()=>operate('preview',async()=>{const preview=await call('previewImageFolderImport');if(preview?.previewId){setPlan(preview);setResult(null)}});
 const confirm=()=>operate('import',async()=>{const imported=await call('importImageFolderBatch',plan.previewId);setResult(imported);onImported(imported.importedIds||[])});
 const valid=plan&&plan.validCount>0&&!plan.invalidCount&&!plan.errors?.length;
 return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)close()}}><section className="modal image-import-dialog folder-import-dialog" role="dialog" aria-modal="true" aria-label="按文件夹批量导入图片任务">
  <header><div className="image-import-title"><FolderOpen size={25}/><div><h2>按文件夹批量导入</h2><p>一个类型目录，一行任务；母图作参考，结果回到子图目录。</p></div></div><button className="icon-button" aria-label="关闭文件夹导入" disabled={!!busy} onClick={close}><X size={22}/></button></header>
  <div className="image-import-content">
   {!result&&<div className="folder-import-guide"><div><strong>选择包含各类型目录的大文件夹</strong><p>读取每个类型目录中的母图，已有「子图」内容不会作为参考。目录编号和名称会显示在下方，其他参数采用新建任务默认值，导入后可继续配置。</p><p>导入只新增任务，不会自动反推或生成图片。开启自动导出后，生成结果写回各自「子图」目录；关闭时，点击下载后写回。</p></div><div className="folder-import-example"><span>大文件夹 / A01-类型名称</span><div><b>母图.jpg</b><ArrowRight size={15}/><b>子图 / 生成结果</b></div><small>每个类型目录独立保存</small></div><button className="button primary" disabled={!!busy} onClick={choose}><FolderOpen size={18}/>{busy==='preview'?'正在扫描…':plan?'重新选择大文件夹':'选择大文件夹'}</button></div>}
   {error&&<p className="image-import-error" role="alert"><WarningCircle size={18}/>{error}</p>}
   {plan&&!result&&<>
    <div className="image-import-summary"><div><strong>{plan.rowCount}</strong><span>个类型目录</span></div><div><strong>{plan.validCount}</strong><span>行可导入</span></div><div className={plan.invalidCount||plan.errors?.length?'has-errors':''}><strong>{plan.invalidCount+(plan.errors?.length||0)}</strong><span>处需修正</span></div><p title={plan.rootPath}>{plan.rootPath}</p></div>
    {!!plan.errors?.length&&<ul className="image-import-error-list" role="alert">{plan.errors.map((message,index)=><li key={index}>{message}</li>)}</ul>}
    {!!plan.warnings?.length&&<p className="image-import-note">{plan.warnings.join(' ')}</p>}
    {!!plan.rows.length&&<div className="image-import-table-scroll"><table className="folder-import-table"><thead><tr><th>编号 / 类型</th><th>类型目录</th><th>参考母图</th><th>结果保存位置</th><th>检查结果</th></tr></thead><tbody>{plan.rows.map((row,index)=><tr key={row.folderPath||index} className={row.errors.length?'invalid':''}><td><strong>{row.code}</strong><p>{row.name||row.folderName}</p></td><td><span className="image-import-path">{row.folderPath}</span></td><td>{row.motherPath?<div className="folder-mother-preview"><img src={media(row.motherPath)} alt={`${row.name||row.folderName} 母图`}/><span className="image-import-path">{row.motherPath.split(/[\\/]/).pop()}</span></div>:<span className="muted">尚未确定母图</span>}</td><td><span className="folder-output-label">本类型 / 子图</span><p className="image-import-path">{row.outputPath}</p></td><td>{row.errors.length?<ul className="image-import-row-errors">{row.errors.map((message,errorIndex)=><li key={errorIndex}>{message}</li>)}</ul>:<span className="image-import-valid"><CheckCircle size={15}/>可导入</span>}{row.warnings?.map((message,warningIndex)=><small className="image-import-row-warning" key={warningIndex}>{message}</small>)}</td></tr>)}</tbody></table></div>}
   </>}
   {result&&<div className="image-import-result"><CheckCircle size={36}/><h3>已新增 {result.importedCount??result.importedIds?.length??0} 行任务</h3><p>母图与「子图」保存位置已绑定。填写提示词和生成参数后，勾选任务开始生成。</p><p>没有调用反推或图片生成服务。</p></div>}
   {busy==='import'&&<p className="image-import-progress" role="status">正在创建任务并保存目录绑定，请稍候…</p>}
  </div>
  <footer className="image-import-footer"><p>{result?'可在右侧当前行配置中查看具体保存位置。':!plan?'支持一次导入多个类型目录。母图存在歧义时会标出，不会自动任选。':valid?`将新增 ${plan.validCount} 行任务，生成结果分别保存到各类型的「子图」目录。`:'请修正标记的问题后，重新选择大文件夹；本次尚未新增任务。'}</p><div><button className="button" disabled={!!busy} onClick={close}>{result?'完成':'取消'}</button>{!result&&<button className="button primary" disabled={!valid||!!busy} onClick={confirm}>{busy==='import'?'正在导入…':`确认导入${plan?.validCount?` ${plan.validCount} 行`:''}`}</button>}</div></footer>
 </section></div>;
}
