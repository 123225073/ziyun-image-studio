import React, {useEffect, useRef, useState} from 'react';
import {Clipboard, Image as ImageIcon, UploadSimple} from '@phosphor-icons/react';

export default function BatchTemplateInput({path,bridge,call,onSelect,disabled,onPending}) {
  const zone = useRef(null), pending = useRef(false);
  const [dragging,setDragging] = useState(false), [error,setError] = useState('');
  const basename = /[\\/]batch-template-inputs[\\/]/.test(path) ? '剪贴板模板' : path.split(/[\\/]/).pop();

  async function receive(read) {
    if (disabled || pending.current) return;
    pending.current = true;
    onPending(true);
    setError('');
    try {
      const file = await read();
      if (file && !/\.(png|jpe?g|webp)$/i.test(file)) throw new Error('固定模板支持 PNG、JPG 或 WebP 图片。');
      if (file) {
        const preview = new Image();
        preview.src = bridge.mediaUrl(file);
        try {await preview.decode();}
        catch {throw new Error('图片无法打开，请重新选择可读的 PNG、JPG 或 WebP 图片。');}
        onSelect(file);
      }
    } catch (problem) {
      setError(problem.message || '读取图片失败，请重新选择。');
    } finally {
      pending.current = false;
      onPending(false);
    }
  }
  async function fromFiles(files) {
    if (files.length !== 1) throw new Error('请选择一张图片作为固定模板。');
    const received = await bridge.importDroppedImages(files);
    if (received.sourceMode === 'folder' || received.sourcePaths.length !== 1) throw new Error('请拖入一张图片文件。');
    return received.sourcePaths[0];
  }
  async function choose() {
    const files = await bridge.chooseFiles('cover-template');
    if (files.length > 1) throw new Error('请选择一张图片作为固定模板。');
    return files[0];
  }
  function paste() {return call('pasteBatchTemplate');}
  useEffect(()=>{
    function handlePaste(event) {
      if (!zone.current?.getClientRects().length || disabled || pending.current ||
          document.querySelector('[aria-modal="true"]:not([hidden])') ||
          event.target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      const data = event.clipboardData;
      const files = Array.from(data?.files || []);
      const inZone = zone.current.contains(event.target);
      if (!files.length && !inZone && !Array.from(data?.types || []).some(t=>t.startsWith('image/'))) return;
      event.preventDefault();
      receive(async()=>{
        if (files.length > 1) throw new Error('剪贴板中有多张图片，请每次粘贴一张固定模板。');
        if (files.length && bridge.droppedImageHasPath(files[0])) return fromFiles(files);
        if (files[0]?.type.startsWith('image/')) {
          if (files[0].size > 20*1024*1024) throw new Error('每张粘贴模板最多 20 MB。');
          return call('pasteBatchTemplate',new Uint8Array(await files[0].arrayBuffer()));
        }
        return paste();
      });
    }
    window.addEventListener('paste',handlePaste);
    return ()=>window.removeEventListener('paste',handlePaste);
  });
  return <div ref={zone} className={'br-template-drop'+(dragging?' is-dragging':'')} tabIndex={0} role="group" aria-label="固定模板导入区"
    onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect=disabled?'none':'copy';if(!disabled)setDragging(true);}}
    onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget))setDragging(false);}}
    onDrop={event=>{event.preventDefault();setDragging(false);const files=Array.from(event.dataTransfer.files);receive(()=>fromFiles(files));}}>
    {path ? <img className="br-template-thumb" src={bridge.mediaUrl(path)} alt="固定模板"/> :
      <div className="br-template-empty" aria-hidden="true"><ImageIcon size={30}/></div>}
    <div className="br-template-actions">
      {path && <strong title={path}>{basename}</strong>}
      <span className="br-muted">拖入一张图片，或按 Ctrl+V 粘贴截图</span>
      <div className="actions"><button type="button" className="button" disabled={disabled} onClick={()=>receive(choose)}>
        <UploadSimple size={16}/>{path?'更换模板':'选择模板图片'}</button>
        <button type="button" className="button" disabled={disabled} onClick={()=>receive(paste)}><Clipboard size={16}/>粘贴图片</button></div>
      {error && <span className="br-error" role="alert">{error}</span>}
    </div>
  </div>;
}
