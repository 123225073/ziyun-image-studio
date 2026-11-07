import React, {useState} from 'react';
import {CheckCircle} from '@phosphor-icons/react';
import {planImageImport} from '../shared/image-import-selection.mjs';

export function useImageImportSelection(plan, dirtyIds) {
  const [choices, setChoices] = useState({});
  const targets = plan?.targets?.map(target => dirtyIds.includes(target.id) ? {...target, busy: true, dirty: true} : target);
  const decisions = planImageImport(plan?.rows || [], targets, choices);
  const selected = decisions.filter(item => item.action !== 'skip');
  return {
    decisions,
    requests: selected.map(({index, action}) => ({index, action})),
    count: selected.length,
    overwriteCount: selected.filter(item => item.action === 'overwrite').length,
    reverseCount: selected.filter(({index}) => plan.rows[index].autoDescribe).length,
    skipCount: decisions.length - selected.length,
    selectAll: () => setChoices({}),
    clear: () => setChoices(Object.fromEntries(decisions.map(({index}) => [index, 'skip']))),
    choose: (index, action) => setChoices(previous => ({...previous, [index]: action})),
  };
}

export function ImageImportSelectionBar({selection, disabled}) {
  return <div className="image-import-selection">
    <div><strong>选择要导入的任务</strong><p>有错误的行可以先跳过。覆盖只替换任务配置，已有结果会保留。</p></div>
    <div className="image-import-selection-actions">
      <span role="status">已选 {selection.count} 行</span>
      <button className="button" disabled={disabled} onClick={selection.selectAll}>全选可新增</button>
      <button className="button" disabled={disabled || !selection.count} onClick={selection.clear}>清空选择</button>
    </div>
  </div>;
}

export function ImageImportCheck({row, decision, choose, disabled}) {
  const active = decision.action !== 'skip';
  const defaultAction = decision.options.find(action => action !== 'overwrite');
  return <input type="checkbox" aria-label={`导入 ${row.values.code} · ${row.values.name || row.excelRow || row.folderName}`}
    checked={active} disabled={disabled || (!active && !defaultAction)}
    onChange={event => choose(decision.index, event.target.checked ? defaultAction : 'skip')}/>;
}

export function ImageImportRowStatus({row, decision, choose, disabled}) {
  const {index, action, options, target, sameFolder, finalCode} = decision;
  if (row.errors.length) return <ul className="image-import-row-errors">{row.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>;
  if (!decision.conflict) return <span className="image-import-valid"><CheckCircle size={15}/>{row.autoDescribe ? '可导入 · 反推 1 次' : '可导入'}</span>;
  return <div className="image-import-conflict">
    <strong>{sameFolder ? '保存目录已被使用' : '编号重复'}</strong>
    <select aria-label={`处理 ${row.values.code} · ${row.values.name || row.excelRow || row.folderName}`} value={action} disabled={disabled || !options.length}
      onChange={event => choose(index, event.target.value)}>
      <option value="skip">跳过此行</option>
      {options.includes('rename') && <option value="rename">加后缀新增</option>}
      {options.includes('overwrite') && <option value="overwrite">覆盖已有任务配置</option>}
    </select>
    {action === 'rename' && <small>导入编号 <b>{finalCode}</b></small>}
    {target && <small title={target.name}>已有任务 {target.code} · {target.name || '未命名类型'}</small>}
    {target?.dirty ? <small>请先保存原任务的编辑内容。</small> : target?.busy ? <small>已有任务仍在处理，暂时无法覆盖。</small> :
      target?.minimumCount > row.values.count ? <small>生成数量小于已有占位数，暂时无法覆盖。</small> :
      sameFolder && !options.length && <small>请保留其中一条使用此目录的任务。</small>}
  </div>;
}

export function imageImportResultTitle(result) {
  const overwritten = result.overwrittenCount || 0;
  const added = (result.importedCount ?? result.importedIds?.length ?? 0) - overwritten;
  return overwritten ? `已新增 ${added} 行 · 已覆盖 ${overwritten} 行` : `已新增 ${added} 行任务`;
}
