import React, {useEffect,useState} from 'react';
import {ArrowsClockwise,ArrowSquareOut} from '@phosphor-icons/react';

export default function AppVersion({call,run,Dialog,Button,onInfo}) {
  const [info,setInfo]=useState(null), [open,setOpen]=useState(false);
  const [checking,setChecking]=useState(false), [result,setResult]=useState(null), [error,setError]=useState('');
  const [progress,setProgress]=useState(null);
  useEffect(()=>{
    let mounted=true;
    const unsubscribe=window.studio?.onUpdateProgress?.(setProgress);
    call('appInfo').then(value=>{if(mounted){setInfo(value);onInfo(value)}}).catch(()=>{});
    return()=>{mounted=false;unsubscribe?.()};
  },[]);
  async function check() {
    setChecking(true);setError('');setProgress(null);
    try{setResult(await call(info.oneClickUpdate?'installMacUpdate':'checkAppRelease'))}
    catch(failure){setResult(null);setError(failure.message)}
    finally{setChecking(false)}
  }
  if(!info)return null;
  const status=({
    checking:'正在查询 Mac 版本…',
    downloading:`正在下载 v${progress?.latest} · ${progress?.percent}%`,
    verifying:'正在校验并准备安装…',
    restarting:'正在安装，即将重新打开工坊…',
  })[progress?.phase]||'正在查询…';
  return <>
    <button className="version-badge" aria-label={`版本管理，当前 v${info.version}`} onClick={()=>setOpen(true)}>v{info.version}{result?.comparison==='update'&&<i aria-hidden="true"/>}</button>
    {open&&<Dialog title="版本管理" onClose={()=>{if(!checking)setOpen(false)}}>
      <dl className="version-details">
        <dt>当前运行版本</dt><dd>v{info.version} · {info.platform==='darwin'?'macOS':info.platform==='win32'?'Windows':info.platform} / {info.arch}</dd>
        <dt>{info.oneClickUpdate?'Mac 最新稳定版':'GitHub 最新稳定版'}</dt><dd aria-live="polite">{checking?status:result?`v${result.latest} · ${{update:'有新版本',current:'已是最新版',ahead:'当前运行版本更新'}[result.comparison]}`:error||'点击下方检查更新'}</dd>
      </dl>
      {info.oneClickUpdate&&<p className="update-hint">发现新版后将自动下载并安装。请按 macOS 的提示确认打开新版，项目、图片和设置保存在原位置。</p>}
      {checking&&progress?.phase==='downloading'&&<progress className="update-download-progress" max="100" value={progress.percent} aria-label="下载更新"/>}
      <div className="modal-actions">
        {checking&&info.oneClickUpdate&&['checking','downloading'].includes(progress?.phase)
          ?<Button onClick={()=>run(()=>call('cancelMacUpdate'))}>取消更新</Button>
          :<Button icon={ArrowSquareOut} disabled={checking} onClick={()=>run(()=>call('openAppReleases'))}>打开 GitHub 发布页</Button>}
        <Button primary icon={ArrowsClockwise} disabled={checking} onClick={check}>{info.oneClickUpdate?'检查并更新':'检查更新'}</Button>
      </div>
    </Dialog>}
  </>;
}
