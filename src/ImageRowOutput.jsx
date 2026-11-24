import React from 'react';
import { FolderOpen } from '@phosphor-icons/react';

const relativeHint = '可选，留空时沿用底栏目录';

export default function ImageRowOutput({ draft, edit, run, call, Field }) {
  const sourceBound = draft.outputMode === 'source-children';
  const hint = sourceBound ? '沿用导入时的子图目录，可直接修改' :
    draft.rowOutputDir ? '本行已指定完整路径' : draft.outputMode === 'system' ? '此行沿用 Excel 指定的输出根目录' : relativeHint;
  function setDirectory(folderName, rowOutputDir = '') {
    edit({folderName, rowOutputDir, outputMode: undefined, outputMappingToken: '', clearOutputMapping: true});
  }
  async function browse() {
    const picked = await call('chooseImageOutputFolder');
    if (picked?.outputMappingToken) {
      edit({folderName:picked.outputPath,rowOutputDir:'',outputMode:'source-children',sourceRoot:picked.sourceRoot,
        sourceFolder:picked.sourceFolder,outputMappingToken:picked.outputMappingToken,clearOutputMapping:false});
    } else if (picked?.directory) setDirectory('',picked.directory);
  }
  return <div className="row-output-settings" data-testid="row-source-output">
    <Field label="本行保存子目录" hint={hint}>
      <input aria-label="本行保存子目录" value={draft.rowOutputDir || draft.folderName || ''}
        placeholder="例如：12月" onChange={event => setDirectory(event.target.value)}/>
    </Field>
    <button type="button" className="button row-directory-picker" aria-label="选择本行保存目录" title="选择本行保存目录"
      onClick={() => run(browse)}><FolderOpen size={18} aria-hidden="true"/></button>
  </div>;
}
