import React,{useEffect,useRef,useState} from 'react';
import {LinkSimple,Trash,FolderOpen} from '@phosphor-icons/react';

export const emptyTextBindings=text=>({textSnapshot:text,bindings:[]});
export default function TextMaterialEditor({text,record,folders=[],onTextChange,onBindingsChange,label,readOnly=false}){
 const input=useRef(null),[selection,setSelection]=useState(null),[folder,setFolder]=useState(''),[error,setError]=useState('');
 const bindings=record?.bindings||[];
 useEffect(()=>{setSelection(null);setError('')},[text]);
 const stale=bindings.length>0&&record?.textSnapshot!==text;
 const capture=event=>{const el=event.currentTarget,start=el.selectionStart,end=el.selectionEnd;setSelection(start<end?{start,end,quote:text.slice(start,end)}:null)};
 const commit=next=>{if(onBindingsChange({textSnapshot:text,bindings:next})!==false){setSelection(null);setError('')}};
 const bind=()=>{
  if(stale){setError('文案已修改，请先清空旧标注，再为当前文字重新绑定。');return}
  if(!selection?.quote.trim()){setError('请在文案框内选中需要匹配画面的文字。');return}
  const target=folders.find(item=>item.path===folder);
  if(!target?.mediaCount){setError('请选择包含可用图片的素材子目录。');return}
  if(bindings.some(item=>item.status!=='needs-review'&&selection.start<item.end&&selection.end>item.start)){setError('选中文字与已有标注重叠，请先删除原标注或选择其他文字。');return}
  commit([...bindings,{id:crypto.randomUUID(),...selection,folderPath:target.path,folderLabel:target.label,status:'ready'}].sort((a,b)=>a.start-b.start));
 };
 const usable=stale?[]:bindings.filter(item=>item.status!=='needs-review'&&text.slice(item.start,item.end)===item.quote).sort((a,b)=>a.start-b.start);
 const marked=[];let offset=0;for(const item of usable){marked.push(text.slice(offset,item.start),<mark key={item.id} title={item.folderLabel||item.folderPath}>{item.quote}</mark>);offset=item.end;}marked.push(text.slice(offset));
 return <div className="text-material-editor">
  <textarea ref={input} aria-label={label} value={text} readOnly={readOnly} rows={2} onSelect={capture} onMouseUp={capture} onKeyUp={capture} onChange={event=>{setSelection(null);setError('');onTextChange?.(event.target.value)}} placeholder="填写这一条完整文案，支持多行文字"/>
  <div className="text-binding-tools">
   <span className={selection?'selection-ready':''}>{selection?`已选 ${selection.quote.length} 字`:'选中文字，指定对应画面'}</span>
   <button className="text-button" type="button" disabled={!text.trim()||stale} onClick={()=>{input.current?.focus();input.current?.setSelectionRange(0,text.length);setSelection({start:0,end:text.length,quote:text})}}>选择整条</button>
   <select aria-label={`${label} 素材目录`} value={folder} onChange={event=>setFolder(event.target.value)} disabled={!folders.length||stale}><option value="">{folders.length?'选择素材子目录':'先导入素材大目录'}</option>{folders.map(item=><option key={item.path} value={item.path} disabled={!item.mediaCount}>{item.label} · {item.mediaCount} 个素材{!item.mediaCount?'（空目录）':''}</option>)}</select>
   <button className="button binding-add" type="button" disabled={!selection?.quote.trim()||!folder||stale} onClick={bind}><LinkSimple size={14}/>绑定选中文字</button>
  </div>
  {error&&<p className="binding-error" role="alert">{error}</p>}
  {stale&&<div className="binding-stale" role="alert"><span>文案已修改，旧标注待重新绑定；校对与生成会暂停。</span><button className="text-button" onClick={()=>commit([])}>清空旧标注</button></div>}
  {!!bindings.length&&<div className="text-binding-summary">
   {!stale&&usable.length>0&&<p className="binding-highlight" aria-label={`${label} 标注预览`}>{marked}</p>}
   <ul>{bindings.map((item,index)=><li key={item.id||index} className={stale||item.status==='needs-review'?'binding-unresolved':''}>
    <span className="binding-order">{index+1}</span><div className="binding-range"><q>{item.quote||item.previousQuote||'待重新选中文字'}</q>{item.reason&&<small>{item.reason}</small>}{item.status==='needs-review'&&<small>请删除此待确认标注，再从上方文案选中对应文字重新绑定。</small>}</div>
    <FolderOpen size={14}/><select aria-label={`${label} 标注 ${index+1} 文件夹`} value={item.folderPath} disabled={stale||item.status==='needs-review'} onChange={event=>{const target=folders.find(folder=>folder.path===event.target.value);if(target?.mediaCount)commit(bindings.map((current,i)=>i===index?{id:current.id,start:current.start,end:current.end,quote:current.quote,folderPath:target.path,folderLabel:target.label,status:'ready'}:current))}}>{!folders.some(folder=>folder.path===item.folderPath)&&<option value={item.folderPath}>{item.folderLabel||item.folderPath}（需重新导入）</option>}{folders.map(folder=><option key={folder.path} value={folder.path} disabled={!folder.mediaCount}>{folder.label}{!folder.mediaCount?'（空目录）':''}</option>)}</select>
    <button className="icon-button" aria-label={`${label} 删除标注 ${index+1}`} onClick={()=>{if(stale){const next=bindings.filter((_,i)=>i!==index);onBindingsChange(next.length?{...record,bindings:next}:emptyTextBindings(text));}else commit(bindings.filter((_,i)=>i!==index))}}><Trash size={14}/></button>
   </li>)}</ul>
  </div>}
 </div>;
}
