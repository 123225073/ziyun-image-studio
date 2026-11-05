import React, { useMemo, useState } from 'react';
import { Plus, Trash, ListPlus, X } from '@phosphor-icons/react';
import { splitTexts } from '../shared/montage-batch.mjs';

// Stored candidates are distinct entries. Newlines inside an entry are content,
// not a delimiter; legacy strings keep the original import interpretation.
export function candidateEntries(value) {
  return Array.isArray(value) ? value.map(item => String(item ?? '')) : splitTexts(value);
}

export default function CandidateEditor({ section, value, onChange }) {
  const entries = candidateEntries(value);
  const [importing, setImporting] = useState(false);
  const [raw, setRaw] = useState('');
  const [delimiter, setDelimiter] = useState('blank');
  const oversized=raw.length>200000;
  const imported = useMemo(() => raw.length>200000?[]:raw.split(delimiter === 'pipe' ? /[|｜]/ : delimiter === 'line' ? /\r?\n/ : /\r?\n\s*\r?\n/).map(text => text.trim()).filter(Boolean), [raw, delimiter]);
  const add = () => onChange([...entries, '']);
  return <div className="candidate-editor" data-testid={`candidates-${section}`}>
    <div className="candidate-list">
      {entries.map((text, index) => <div className="candidate-entry" key={index}>
        <span className="candidate-number">{String(index + 1).padStart(2, '0')}</span>
        <textarea aria-label={`${section} 段候选文案 ${index + 1}`} value={text} rows={2}
          onChange={event => onChange(entries.map((entry, i) => i === index ? event.target.value : entry))}
          placeholder="填写这一条完整文案，支持多行文字"/>
        <button className="icon-button" aria-label={`删除 ${section} 段文案 ${index + 1}`} title="删除这条候选文案"
          onClick={() => onChange(entries.filter((_, i) => i !== index))}><Trash size={16}/></button>
      </div>)}
      {!entries.length && <button className="candidate-empty" onClick={add}><Plus size={17}/>添加第一条候选文案</button>}
    </div>
    <div className="candidate-actions">
      <button className="text-button" onClick={add}><Plus size={14}/>新增文案</button>
      <button className="text-button" onClick={() => { setRaw(''); setImporting(true); }}><ListPlus size={15}/>批量粘贴</button>
      <span>{new Set(entries.map(text => text.trim()).filter(Boolean)).size} 条不同文案</span>
    </div>
    <p className="candidate-help">每个编号是一条候选；框内回车或自动折行都属于同一条。</p>
    {importing && <div className="modal-backdrop candidate-import-backdrop" onClick={event => { if (event.target === event.currentTarget) setImporting(false); }}>
      <section className="modal candidate-import" role="dialog" aria-modal="true" aria-label={`${section} 段批量导入文案`}>
        <header><h2>批量粘贴到 {section} 段</h2><button className="icon-button" aria-label="关闭批量粘贴" onClick={() => setImporting(false)}><X size={20}/></button></header>
        <p className="modal-intro">先选择分隔方式，再检查预览。导入后，每条文案都有独立边框和编号。</p>
        <label className="field"><span className="field-label">文案之间如何分隔</span><select aria-label="候选文案分隔方式" value={delimiter} onChange={event => setDelimiter(event.target.value)}>
          <option value="blank">空一行分隔（条目内部可以换行）</option>
          <option value="pipe">竖线 | 分隔</option>
          <option value="line">每个手动换行分隔</option>
        </select></label>
        <textarea aria-label="批量粘贴候选文案" value={raw} onChange={event => setRaw(event.target.value)} rows={5} placeholder="把候选文案粘贴到这里"/>
        {oversized&&<p role="alert" className="review-error">本次粘贴超过 20 万字符，请分批导入或缩短内容。现有候选尚未改变。</p>}
        <h3>将追加 {imported.length} 条</h3>
        <ol className="candidate-import-preview">{imported.map((text, index) => <li key={index}>{text}</li>)}</ol>
        {!imported.length && <p className="muted">粘贴后在这里检查分段结果。</p>}
        <div className="modal-actions"><button className="button" onClick={() => setImporting(false)}>取消</button><button className="button primary" disabled={!imported.length||oversized} onClick={() => { if(onChange([...entries, ...imported])!==false)setImporting(false); }}>确认追加 {imported.length} 条</button></div>
      </section>
    </div>}
  </div>;
}
