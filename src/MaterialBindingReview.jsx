import React, { useState } from 'react';
import { FolderOpen, X } from '@phosphor-icons/react';
import TextMaterialEditor from './TextMaterialEditor.jsx';
import { normalizeMontageBindings } from '../shared/montage-bindings.mjs';

export function BindingOverview({ segments = [] }) {
  const bound = segments.flatMap(segment => (segment.bindings || []).map(binding => ({ ...binding, section: segment.section })));
  if (!bound.length) return null;
  return <div className="review-binding-overview" aria-label="文字与素材对应">
    <strong>文字与素材对应</strong>
    {bound.map((binding, index) => <div key={`${binding.section}-${binding.id}-${index}`} className={binding.status === 'needs-review' ? 'binding-unresolved' : ''}>
      <span className="binding-section">{binding.section}</span>
      <q>{binding.quote || binding.previousQuote || '待选中文字'}</q>
      <span className="binding-directory" title={binding.folderPath}><FolderOpen size={14}/>{binding.folderLabel || binding.folderPath?.split(/[\\/]/).pop()}</span>
      {binding.status === 'needs-review' && <small>需要重新选中文字并匹配目录：{binding.reason || '改写后的内容无法确认原素材是否适配。'}</small>}
    </div>)}
  </div>;
}

export default function MaterialBindingReview({ index, combo, folders, saving, onSave, onClose }) {
  const [records, setRecords] = useState(() => combo.segments.map(segment => ({ textSnapshot: segment.text, bindings: structuredClone(segment.bindings || []) })));
  let error = '';
  try { records.forEach(record => normalizeMontageBindings(record.textSnapshot, record.bindings)); }
  catch (issue) { error = issue.message; }
  return <div className="modal-backdrop"><section className="modal wide binding-review-modal" role="dialog" aria-modal="true" aria-label="检查组合素材对应">
    <header><div><h2>组合 {String(index + 1).padStart(2, '0')} · 检查素材对应</h2><p>选中当前文字，再指定素材子目录；每个范围都可以单独更换或删除。</p></div><button className="icon-button" aria-label="关闭素材对应检查" disabled={saving} onClick={onClose}><X size={20}/></button></header>
    <fieldset disabled={saving}>
      {combo.segments.map((segment, position) => <section className="binding-review-segment" key={`${segment.section}-${position}`}><h3>{segment.section} 段</h3><TextMaterialEditor text={segment.text} record={records[position]} folders={folders} readOnly label={`组合 ${index + 1} ${segment.section} 段素材对应`} onBindingsChange={next => setRecords(previous => previous.map((record, i) => i === position ? next : record))}/></section>)}
    </fieldset>
    {error && <p className="binding-error" role="alert">{error}</p>}
    <p className="field-note">保存实质修改后，需要再次 AI 校对。只更换本条完整组合的标注，原候选文案与其他组合保留。</p>
    <div className="modal-actions"><button className="button" disabled={saving} onClick={onClose}>返回</button><button className="button primary" disabled={saving || Boolean(error)} onClick={() => onSave(records.map(record => record.bindings))}>{saving ? '正在保存…' : '保存素材对应'}</button></div>
  </section></div>;
}
