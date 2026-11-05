import React, { useState } from 'react';
import ProviderHelp from './ProviderHelp.jsx';
import { Plus, PencilSimple, Trash, FloppyDisk, CheckCircle, X } from '@phosphor-icons/react';
import { TTS_PROTOCOLS, SPEECH_CATALOGS } from '../shared/speech.mjs';

export function SpeechFields({ value, onChange, provider, prefix = '配音', compact = false }) {
  const catalog = SPEECH_CATALOGS[provider?.protocol];
  const openai = provider?.protocol === 'openai-tts';
  const update = (key, next) => onChange({ ...value, [key]: next });
  return <div className={`speech-fields ${compact ? 'compact' : ''}`}>
    <label className="field"><span className="field-label">音色 ID</span><input aria-label={`${prefix}音色 ID`} value={value.voice || ''} list={`${prefix}-voices`} onChange={e => update('voice', e.target.value)} placeholder="选择或填写控制台中的音色 ID"/><datalist id={`${prefix}-voices`}>{(catalog?.voices || []).map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</datalist></label>
    <label className="field"><span className="field-label">语速 <small>1.0 为正常速度</small></span><input aria-label={`${prefix}语速`} type="number" min="0.5" max="2" step="0.05" value={value.speed ?? 1} onChange={e => update('speed', e.target.value)}/></label>
    {!openai && <label className="field"><span className="field-label">音量</span><input aria-label={`${prefix}音量`} type="number" min={provider?.protocol === 'doubao-tts' ? '0.5' : '0.1'} max={provider?.protocol === 'minimax-tts' ? '10' : '2'} step="0.1" value={value.volume ?? 1} onChange={e => update('volume', e.target.value)}/></label>}
    <label className="field"><span className="field-label">输出格式</span><select aria-label={`${prefix}输出格式`} value={value.format || 'mp3'} onChange={e => update('format', e.target.value)}><option value="mp3">MP3</option><option value="wav">WAV</option></select></label>
    {!compact && <>
      {!openai && <><label className="field"><span className="field-label">语言</span><select aria-label={`${prefix}语言`} value={value.language || 'auto'} onChange={e => update('language', e.target.value)}>{(catalog?.languages || [{ id: 'auto', name: '自动' }]).map(language => <option key={language.id} value={language.id}>{language.name}</option>)}</select></label>
      <label className="field"><span className="field-label">情绪 / 风格 <small>选填，需音色支持</small></span>{provider?.protocol === 'minimax-tts' ? <select aria-label={`${prefix}情绪风格`} value={value.emotion || ''} onChange={e => update('emotion', e.target.value)}><option value="">自然表达</option>{(catalog?.emotions || []).map(emotion => <option key={emotion} value={emotion}>{{ happy: '开心', sad: '悲伤', angry: '生气', fearful: '害怕', disgusted: '厌恶', surprised: '惊讶', calm: '平静' }[emotion] || emotion}</option>)}</select> : <input disabled={provider?.protocol === 'doubao-tts' && provider.model === 'seed-icl-2.0'} aria-label={`${prefix}情绪风格`} value={value.emotion || ''} onChange={e => update('emotion', e.target.value)} placeholder={provider?.model === 'seed-icl-2.0' ? '复刻音色沿用默认语气' : '例如，用亲切自然的语气'}/>}</label>
      <label className="field"><span className="field-label">采样率</span><select aria-label={`${prefix}采样率`} value={value.sampleRate || 24000} onChange={e => update('sampleRate', +e.target.value)}>{(provider?.protocol === 'minimax-tts' ? [16000, 24000, 32000, 44100] : [16000, 24000, 32000, 44100, 48000]).map(rate => <option key={rate} value={rate}>{rate} Hz</option>)}</select></label>
      <label className="inline-check speech-subtitles"><input aria-label={`${prefix}请求字幕时间戳`} type="checkbox" checked={value.subtitles !== false} onChange={e => update('subtitles', e.target.checked)}/>请求字幕时间戳</label></>}
    </>}
  </div>;
}

export const speechDefaults = provider => ({ voice: SPEECH_CATALOGS[provider?.protocol]?.voice || '', speed: 1, volume: 1, pitch: 0, emotion: '', language: 'auto', format: 'mp3', sampleRate: 24000, subtitles: true });

export default function SpeechSettings({ settings, call, run }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const providers = settings.providers.filter(provider => TTS_PROTOCOLS.includes(provider.protocol));
  const presets = settings.speechPresets || [];
  const selected = providers.find(provider => provider.id === draft?.providerId);
  const create = () => {
    const provider = providers.find(item => item.id === settings.bindings.tts) || providers[0];
    setDraft({ id: crypto.randomUUID(), name: '', providerId: provider?.id || '', ...speechDefaults(provider) });
  };
  const save = () => run(async () => {
    if (!draft.name.trim()) throw new Error('请填写配音预设名称');
    if (!selected) throw new Error('请选择已保存的语音连接');
    if (!draft.voice.trim()) throw new Error('请填写音色 ID');
    setBusy(true);
    try {
      const next = presets.some(item => item.id === draft.id) ? presets.map(item => item.id === draft.id ? draft : item) : [...presets, draft];
      await call('updateSettings', { speechPresets: next, defaultSpeechPresetId: settings.defaultSpeechPresetId || draft.id });
      setDraft(null);
    } finally { setBusy(false); }
  }, '配音预设已保存');
  return <section className="surface setting-section" data-testid="speech-settings">
    <div className="setting-title"><div><h3>配音预设</h3><p>先在模型服务的“语音合成”页签添加豆包或 MiniMax，再保存常用声音。每次任务保留提交时的声音设置。</p></div><button className="button primary" disabled={!providers.length} onClick={create}><Plus size={18}/>新增配音预设</button></div>
    <label className="field"><span className="field-label">默认配音预设</span><select aria-label="默认配音预设" value={settings.defaultSpeechPresetId || ''} onChange={e => run(() => call('updateSettings', { defaultSpeechPresetId: e.target.value }))}><option value="">每次选择</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
    {!providers.length && <p className="speech-notice">请到「模型服务 → 语音合成」添加豆包或 MiniMax 服务。</p>}
    <div className="template-list">{presets.map(preset => {
      const provider = providers.find(item => item.id === preset.providerId);
      return <article className="template-card" key={preset.id}><div><h4>{preset.name} {settings.defaultSpeechPresetId === preset.id && <span className="tiny-badge">默认</span>}</h4><p>{provider?.name || '连接已移除'} · {preset.voice} · {preset.speed || 1} 倍速</p></div><button className="button" onClick={() => setDraft({ ...preset })}><PencilSimple size={18}/>编辑</button><button className="icon-button" aria-label={`删除配音预设 ${preset.name}`} onClick={() => setDeleting(preset)}><Trash size={19}/></button></article>;
    })}</div>
    {draft && <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-modal="true" aria-label="配音预设"><header><h2>{presets.some(item => item.id === draft.id) ? '编辑配音预设' : '新增配音预设'}</h2><button className="icon-button" disabled={busy} aria-label="关闭配音预设" onClick={() => setDraft(null)}><X size={22}/></button></header><div className="modal-form"><label className="field"><span className="field-label">预设名称</span><input aria-label="配音预设名称" value={draft.name} maxLength={60} autoFocus onChange={e => setDraft({ ...draft, name: e.target.value })}/></label><label className="field"><span className="field-label">语音服务</span><select aria-label="配音预设语音服务" value={draft.providerId} onChange={e => { const provider = providers.find(item => item.id === e.target.value); setDraft({ ...draft, providerId: e.target.value, ...speechDefaults(provider) }); }}><option value="">选择已保存的语音连接</option>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></label><ProviderHelp provider={selected} call={call} run={run}/><SpeechFields value={draft} onChange={setDraft} provider={selected} prefix="预设"/><p className="field-note">音色 ID 需与所选服务及模型匹配。保存预设不会生成音频。</p></div><div className="modal-actions"><button className="button" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="button primary" disabled={busy} onClick={save}><FloppyDisk size={18}/>{busy ? '保存中…' : '保存配音预设'}</button></div></section></div>}
    {deleting && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="删除配音预设"><header><h2>删除配音预设</h2></header><p>确认移除「{deleting.name}」？已生成的配音和任务记录会保留。</p><div className="modal-actions"><button className="button" onClick={() => setDeleting(null)}>取消</button><button className="button danger" onClick={() => run(async () => { await call('updateSettings', { speechPresets: presets.filter(item => item.id !== deleting.id), defaultSpeechPresetId: settings.defaultSpeechPresetId === deleting.id ? '' : settings.defaultSpeechPresetId }); setDeleting(null); }, '配音预设已删除')}><CheckCircle size={18}/>确认删除</button></div></section></div>}
  </section>;
}
