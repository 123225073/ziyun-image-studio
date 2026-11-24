import React from 'react';

export default function CoverLayoutPanel({templatePath, report, bound, busy, onAnalyze}) {
  if (!templatePath) return null;
  const current = report?.path === templatePath ? report : null;
  return <div className="cover-layout-panel">
    {current ? <details key={current.templateId}><summary>查看已识别的模板版式</summary>
      <p style={{whiteSpace:'pre-line'}}>{current.text}</p>
      {bound && <button type="button" className="button" disabled={busy} onClick={()=>onAnalyze(true)}>重新识别版式</button>}
    </details>
      : <p className="br-muted">{bound ? '将固定模板发给已绑定的识图服务，识别标题、主角和嵌图的位置。' : '生成时模型会读取固定模板。绑定「参考图理解」后，可提前查看版式。'}</p>}
    {bound && !current && <button type="button" className="button" onClick={()=>onAnalyze(false)} disabled={busy}>AI 识别模板版式</button>}
  </div>;
}
