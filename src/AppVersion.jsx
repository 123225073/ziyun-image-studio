import React, {useEffect,useState} from 'react';
import {ArrowsClockwise,ArrowSquareOut} from '@phosphor-icons/react';

export default function AppVersion({call,run,Dialog,Button,onInfo}) {
  const [info,setInfo]=useState(null), [open,setOpen]=useState(false);
  const [checking,setChecking]=useState(false), [result,setResult]=useState(null), [error,setError]=useState('');
  useEffect(()=>{
    let mounted=true;
    call('appInfo').then(value=>{if(mounted){setInfo(value);onInfo(value)}}).catch(()=>{});
    return()=>{mounted=false};
  },[]);
  async function check() {
    setChecking(true);setError('');
    try{setResult(await call('checkAppRelease'))}
    catch(failure){setResult(null);setError(failure.message)}
    finally{setChecking(false)}
  }
  if(!info)return null;
  return <>
    <button className="version-badge" aria-label={`版本管理，当前 v${info.version}`} onClick={()=>setOpen(true)}>v{info.version}{result?.comparison==='update'&&<i aria-hidden="true"/>}</button>
    {open&&<Dialog title="版本管理" onClose={()=>setOpen(false)}>
      <dl className="version-details">
        <dt>当前运行版本</dt><dd>v{info.version} · {info.platform==='darwin'?'macOS':info.platform==='win32'?'Windows':info.platform} / {info.arch}</dd>
        <dt>GitHub 最新稳定版</dt><dd aria-live="polite">{checking?'正在查询…':result?`v${result.latest} · ${{update:'有新版本',current:'已是最新版',ahead:'当前运行版本更新'}[result.comparison]}`:error||'点击下方检查更新'}</dd>
      </dl>
      <div className="modal-actions"><Button icon={ArrowSquareOut} onClick={()=>run(()=>call('openAppReleases'))}>打开 GitHub 发布页</Button><Button primary icon={ArrowsClockwise} disabled={checking} onClick={check}>检查更新</Button></div>
    </Dialog>}
  </>;
}
