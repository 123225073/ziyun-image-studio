import React, {useRef, useState} from 'react';
import {FolderOpen, ImageSquare, Trash, CaretDown} from '@phosphor-icons/react';

const basename = path => path.split(/[\\/]/).pop();
const supported = path => /\.(png|jpe?g|webp)$/i.test(path);
const keyOf = path => /^(?:[A-Z]:[\\/]|\\\\)/i.test(path) ? path.replaceAll('/','\\').toLowerCase() : path;
const collapsedCount = 4;

export default function BatchAssetList({role,assets,onChange,bridge,call,onEditTags,disabled,onPending}) {
  const [selected,setSelected] = useState(new Set()), [expanded,setExpanded] = useState(false);
  const [message,setMessage] = useState(''), [error,setError] = useState('');
  const importing = useRef(false);
  const chosen = assets.filter(a=>selected.has(a.path)), all = Boolean(assets.length && chosen.length === assets.length);

  async function add(folder) {
    if (disabled || importing.current) return;
    importing.current = true; onPending(true); setMessage(''); setError('');
    try {
      let paths;
      if (folder) {
        const directory = await bridge.chooseFolder('image');
        if (!directory) return;
        paths = (await call('scanFolder',directory)).filter(supported);
        if (!paths.length) throw new Error('此文件夹第一层没有可用的 PNG、JPG 或 WebP 图片。');
      } else {
        paths = await bridge.chooseFiles('cover-image');
        if (!paths.length) return;
        if (paths.some(p=>!supported(p))) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
      }
      const known = new Set(assets.map(a=>keyOf(a.path))), added = [];
      for (const path of paths) {
        const key = keyOf(path);
        if (!known.has(key)) {known.add(key);added.push({path,tag:''});}
      }
      if (added.length) onChange([...assets,...added]);
      setMessage(added.length ? '已添加 '+added.length+' 张'+(paths.length>added.length?'，已跳过重复项':'') : '所选图片均已在此位置。');
    } catch (problem) {
      setError(problem.message || '读取素材失败，请重新选择。');
    } finally {
      importing.current = false; onPending(false);
    }
  }
  function remove(paths) {
    onChange(assets.filter(a=>!paths.has(a.path)));
    setSelected(prev=>new Set([...prev].filter(p=>!paths.has(p))));
    setError('');setMessage('已从'+role+'移除 '+paths.size+' 张，原文件仍在本机。');
  }
  function toggle(path) {
    setSelected(prev=>{const next=new Set(prev);if(next.has(path)) next.delete(path);else next.add(path);return next;});
  }
  return <div className="br-assets">
    <div className="br-asset-actions">
      <button className="button br-add" disabled={disabled} onClick={()=>add(false)}><ImageSquare size={17}/>添加候选图片</button>
      <button className="button" disabled={disabled} onClick={()=>add(true)} title="读取文件夹第一层的 PNG、JPG 和 WebP 图片"><FolderOpen size={17}/>导入文件夹</button>
      <span className="br-count">{assets.length} 张候选</span>
    </div>
    {assets.length>0 && <div className="br-selection">
      <label><input type="checkbox" checked={all} ref={element=>{if(element) element.indeterminate=chosen.length>0&&!all;}} disabled={disabled}
        aria-label={'全选'+role+'候选'} onChange={()=>setSelected(all?new Set():new Set(assets.map(a=>a.path)))}/>全选</label>
      <button className="br-remove" disabled={disabled||!chosen.length} onClick={()=>remove(new Set(chosen.map(a=>a.path)))}><Trash size={15}/>移除选中（{chosen.length}）</button>
    </div>}
    {(expanded?assets:assets.slice(0,collapsedCount)).map(a=><div className={'br-asset'+(onEditTags?' has-tag':'')} key={a.path}>
      <input type="checkbox" aria-label={'选择候选 '+basename(a.path)} checked={selected.has(a.path)} onChange={()=>toggle(a.path)} disabled={disabled}/>
      <img loading="lazy" src={bridge.mediaUrl(a.path)} alt=""/>
      <span title={a.path}>{basename(a.path)}</span>
      {onEditTags&&<input className="br-tag" aria-label={basename(a.path)+' 的用途'} disabled={disabled} placeholder="用途（选填）" value={a.tag}
        onChange={e=>onChange(assets.map(other=>other.path===a.path?{...other,tag:e.target.value}:other))}/>}
      <button className="br-remove" disabled={disabled} aria-label={'移除候选 '+basename(a.path)} onClick={()=>remove(new Set([a.path]))}>移除</button>
    </div>)}
    {assets.length>collapsedCount && <button className="br-expand" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
      <CaretDown size={15}/>{expanded?'收起素材列表':'展开全部 '+assets.length+' 张'}</button>}
    {message && <small role="status" className="br-muted">{message}</small>}
    {error && <small role="alert" className="br-error">{error}</small>}
  </div>;
}
