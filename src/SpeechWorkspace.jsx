import React, { useEffect, useState } from 'react';
import { MusicNote, Play, Gear, DownloadSimple, FilmStrip, ArrowsClockwise, FolderOpen, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { TTS_PROTOCOLS } from '../shared/speech.mjs';
import { SpeechFields, speechDefaults } from './SpeechSettings.jsx';

const statusLabels = { queued: '等待中', running: '合成中', planning: '准备中', saving: '保存中', succeeded: '已完成', failed: '失败', unknown: '状态待确认', cancelled: '已取消' };
const activeStatuses = ['queued', 'running', 'planning', 'saving'];
const media = path => window.studio?.mediaUrl(path);
const formatDuration = seconds => Number.isFinite(+seconds) && +seconds > 0 ? `${Math.floor(seconds / 60)} 分 ${(seconds % 60).toFixed(1)} 秒` : '时长待读取';
const elapsed = (job, clock) => {
  const start = Date.parse(job.startedAt || job.createdAt);
  const end = activeStatuses.includes(job.status) ? clock : Date.parse(job.finishedAt || job.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${job.status === 'queued' ? '等待' : activeStatuses.includes(job.status) ? '已用' : '用时'} ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

export default function SpeechWorkspace({ state, call, run, notify, onUseForMontage, onOpenSettings }) {
  const { settings } = state;
  const presets = settings.speechPresets || [];
  const providers = settings.providers.filter(provider => TTS_PROTOCOLS.includes(provider.protocol));
  const defaultPreset = presets.find(preset => preset.id === settings.defaultSpeechPresetId);
  const defaultProvider = providers.find(provider => provider.id === (defaultPreset?.providerId || settings.bindings.tts)) || providers[0];
  const [text, setText] = useState('');
  const [name, setName] = useState('我的配音');
  const [presetId, setPresetId] = useState(defaultPreset?.id || '');
  const [providerId, setProviderId] = useState(defaultProvider?.id || '');
  const [options, setOptions] = useState(() => ({ ...speechDefaults(defaultProvider), ...defaultPreset }));
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState('all');
  const [durations, setDurations] = useState({});
  const [regenerate, setRegenerate] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const jobs = state.jobs.filter(job => job.kind === 'speech').slice().reverse();
  const provider = providers.find(item => item.id === providerId);
  const visible = jobs.filter(job => filter === 'all' || job.status === filter);
  const texts = text.split(/\r?\n\s*---\s*\r?\n/).map(part => part.trim()).filter(Boolean);
  const running = jobs.some(job => activeStatuses.includes(job.status));
  useEffect(() => {
    if (providerId || !defaultProvider) return;
    setProviderId(defaultProvider.id);
    setPresetId(defaultPreset?.id || '');
    setOptions({ ...speechDefaults(defaultProvider), ...defaultPreset });
  }, [providerId, defaultProvider?.id, defaultPreset?.id]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const selectPreset = id => {
    setPresetId(id);
    const preset = presets.find(item => item.id === id);
    if (preset) {
      setProviderId(preset.providerId);
      setOptions({ ...speechDefaults(providers.find(item => item.id === preset.providerId)), ...preset });
    }
  };
  const submit = () => run(async () => {
    if (!texts.length) throw new Error('请先填写要合成的文案');
    if (!provider) throw new Error('请先在设置中保存并选择语音服务连接');
    if (!options.voice?.trim()) throw new Error('请选择或填写音色 ID');
    setSubmitting(true);
    try {
      const jobs = await call('enqueueSpeech', { ...options, text, name: name.trim() || '我的配音', providerId, presetId });
      notify(`已提交 ${Array.isArray(jobs) ? jobs.length : texts.length} 条配音`);
    } finally { setSubmitting(false); }
  });
  return <div className="page-scroll speech-page" data-testid="speech-workspace">
    <div className="page-title"><div><span className="eyebrow">VOICE STUDIO</span><h2>把文案，变成声音</h2><p>选择豆包或 MiniMax 声音，先试听配音，再用于批量混剪。</p></div><button className="button" onClick={onOpenSettings}><Gear size={18}/>配置语音服务</button></div>
    <section className="surface speech-composer"><div className="speech-copy"><label className="field"><span className="field-label">配音名称</span><input aria-label="配音名称" value={name} maxLength={80} onChange={e => setName(e.target.value)}/></label><label className="field"><span className="field-label">配音文案 <small>多篇文案之间用独占一行的 --- 分隔</small></span><textarea aria-label="配音文案" data-testid="speech-text" rows={12} value={text} onChange={e => setText(e.target.value)} placeholder={'填写整篇旁白，可保留自然分段。\n\n---\n\n这里填写另一篇文案，即可批量合成。'}/></label><div className="speech-text-stats"><span>{text.length} 字符</span><span>{texts.length} 篇文案</span><span>实际时长将在合成后显示</span></div></div>
      <aside className="speech-configuration"><label className="field"><span className="field-label">配音预设</span><select aria-label="本次配音预设" value={presetId} onChange={e => selectPreset(e.target.value)}><option value="">本次自行设置</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label><label className="field"><span className="field-label">语音服务</span><select aria-label="本次语音服务" value={providerId} onChange={e => { const next = providers.find(item => item.id === e.target.value); setPresetId(''); setProviderId(e.target.value); setOptions(speechDefaults(next)); }}><option value="">选择已配置连接</option>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></label><SpeechFields value={options} onChange={value => { setPresetId(''); setOptions(value); }} provider={provider} prefix="本次"/><p className="field-note">合成会调用所选语音服务并按其规则计费。生成成功的音频可反复用于不同画面组合。</p><button className="button primary speech-generate" disabled={submitting || !provider || !text.trim()} onClick={submit}><Play size={19}/>{submitting ? '正在提交…' : `生成配音${texts.length > 1 ? `（${texts.length} 篇）` : ''}`}</button>{!providers.length && <p className="speech-notice">尚未配置语音服务。请到“全局设置 → 模型服务 → 语音合成”添加服务，再设置配音预设。</p>}</aside>
    </section>
    <section className="speech-history"><div className="results-header"><h2>配音记录</h2><div className="actions"><select aria-label="配音记录筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部（{jobs.length}）</option><option value="succeeded">已完成</option><option value="failed">失败</option><option value="unknown">状态待确认</option></select><button className="button" disabled={!jobs.some(job => job.status === 'succeeded')} onClick={() => run(() => call('exportJobs', jobs.filter(job => job.status === 'succeeded').map(job => job.id)), '配音已导出至输出目录')}><DownloadSimple size={18}/>下载全部成功配音</button></div></div>
      {!jobs.length ? <div className="empty"><div className="empty-icon"><MusicNote size={35}/></div><h3>配音结果将在这里呈现</h3><p>填写文案并生成，完成后可试听、下载或用于混剪。</p></div> : <div className="speech-job-list">{visible.map(job => {
        const config = job.snapshot?.config || {};
        const duration = job.duration || job.result?.duration || durations[job.id];
        const complete = job.status === 'succeeded' && job.localPath;
        return <article className={`surface speech-job status-${job.status}`} key={job.id}><div className="speech-job-heading"><span className="speech-job-icon">{complete ? <CheckCircle size={25}/> : job.status === 'failed' ? <WarningCircle size={25}/> : <MusicNote size={25}/>}</span><div><h3>{config.name || job.name || '配音'}</h3><span className="muted">{job.snapshot?.provider?.name || '语音服务'} · {config.voiceOptions?.voice || config.voice || '所选音色'}</span></div><span className="speech-job-status">{statusLabels[job.status] || job.status}<small>{elapsed(job, clock)}</small></span></div><p className="speech-job-text">{config.text || job.prompt}</p>{complete && <><audio aria-label={`试听配音 ${config.name || job.id}`} controls preload="metadata" src={media(job.localPath)} onLoadedMetadata={e => { const seconds = e.currentTarget.duration; if (Number.isFinite(seconds)) setDurations(previous => ({ ...previous, [job.id]: seconds })); }}/><div className="speech-job-footer"><span>{formatDuration(duration)}</span><div className="actions"><button className="button" onClick={() => run(() => window.studio.reveal(job.localPath))}><FolderOpen size={17}/>打开位置</button><button className="button" onClick={() => run(() => call('exportJobs', [job.id]), '配音已导出至输出目录')}><DownloadSimple size={17}/>下载</button><button className="button primary" onClick={() => onUseForMontage(job)}><FilmStrip size={17}/>用于混剪</button></div></div></>}{job.warning && <p className="speech-notice">{job.warning}</p>}{job.error && <p className="red speech-error">{job.error}</p>}{job.status === 'failed' && <button className="button" onClick={() => run(() => call('retryJobs', [job.id], { regenerate: false }), '配音任务已重新加入队列')}><ArrowsClockwise size={17}/>重试失败任务</button>}{job.status === 'unknown' && <div className="speech-unknown"><p>服务可能已处理请求，请先核对服务商记录后再决定是否重新生成。</p><button className="button" onClick={() => setRegenerate(job)}>核对后重新生成</button></div>}</article>;
      })}</div>}
    </section>
    {regenerate && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="重新生成配音"><header><h2>确认重新生成配音</h2></header><p>原任务状态未确认。确认已核对服务商记录后继续，将建立新请求，可能再次计费。</p><div className="modal-actions"><button className="button" onClick={() => setRegenerate(null)}>返回核对</button><button className="button primary" onClick={() => run(async () => { await call('retryJobs', [regenerate.id], { regenerate: true }); setRegenerate(null); }, '新的配音请求已加入队列')}>我已核对，重新生成</button></div></section></div>}
  </div>;
}
