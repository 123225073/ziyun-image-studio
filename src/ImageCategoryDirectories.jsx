import React, {useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {FolderOpen, X} from '@phosphor-icons/react';
import {imageRowCategories} from '../shared/image-rows.mjs';

export default function ImageCategoryDirectories({rows, settings, call, chooseFolder, Button}) {
  const dialog = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const categories = imageRowCategories(rows);
  async function change(category, clear = false) {
    setBusy(true);
    setError('');
    try {
      const directory = clear ? '' : await chooseFolder('image-output');
      if (clear || directory) await call('updateSettings', {imageCategoryDirectory:{category, directory}});
    } catch (err) {
      setError(err.message || '保存目录失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return <>
    <Button onClick={() => {setError(''); dialog.current.showModal();}}>分类目录</Button>
    {createPortal(<dialog className="modal image-category-dialog" ref={dialog} aria-label="分类输出目录">
      <header><h2>分类输出目录</h2><button className="icon-button" aria-label="关闭分类目录" onClick={() => dialog.current.close()}><X size={20}/></button></header>
      <p className="field-note">分类取自全部任务的编号前缀。已指定本行目录的任务优先使用本行设置。</p>
      <p className="category-root"><strong>输出根目录</strong><span>{settings.outputDir || '尚未设置'}</span></p>
      {categories.length ? <ul className="category-dirs">{categories.map(category => {
        const directory = settings.imageCategoryDirectories?.[category];
        return <li key={category}><div><strong>{category} 类</strong><span>{directory || '沿用输出根目录'}</span></div>
          <div className="category-dir-actions"><Button icon={FolderOpen} aria-label={`设置${category}类目录`} disabled={busy} onClick={() => change(category)}>{directory ? '更改目录' : '选择目录'}</Button>
            {directory && <button className="text-button" aria-label={`恢复${category}类为输出根目录`} disabled={busy} onClick={() => change(category, true)}>恢复默认</button>}
          </div></li>;
      })}</ul> : <p className="field-note">当前任务没有编号前缀，默认使用输出根目录。</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </dialog>, document.body)}
  </>;
}
