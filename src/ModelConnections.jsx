import React, { useEffect, useRef, useState } from 'react';
import { Plus, PencilSimple, Trash, X, CheckCircle, FloppyDisk, ArrowsClockwise, Info, WarningCircle } from '@phosphor-icons/react';
import { MODEL_GROUPS, MODEL_PLATFORMS, providerPlatform, platformDraft } from '../shared/model-settings.mjs';
import ProviderHelp from './ProviderHelp.jsx';
import './model-credentials.css';

const Field = ({ label, hint, children }) => <label className="field"><span className="field-label">{label}{hint && <small>{hint}</small>}</span>{children}</label>;
const Button = ({ children, primary, ...props }) => <button type="button" className={`button ${primary ? 'primary' : ''}`} {...props}>{children}</button>;

function Dialog({ title, onClose, closeDisabled = false, children }) {
  useEffect(() => {
    const escape = event => { if (!closeDisabled && event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose, closeDisabled]);
  return <div className="modal-backdrop"><section className="modal model-dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" disabled={closeDisabled} onClick={onClose}><X size={22}/></button></header>{children}</section></div>;
}

export default function ModelConnections({ settings, call, run, notify, renderAccount }) {
  const [groupId, setGroupId] = useState('text');
  const [draft, setDraft] = useState(null);
  const [platformId, setPlatformId] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const [credentialError, setCredentialError] = useState('');
  const [testing, setTesting] = useState('');
  const [deleting, setDeleting] = useState(null);
  const group = MODEL_GROUPS.find(item => item.id === groupId);
  const providers = settings.providers.filter(item => group.protocols.includes(item.protocol));
  const platforms = MODEL_PLATFORMS.filter(item => item.group === groupId);
  const platform = MODEL_PLATFORMS.find(item => item.id === platformId);
  const editing = draft && settings.providers.some(item => item.id === draft.id);
  const primaryBinding = group.bindings[0][0];
  const patch = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const create = () => {
    const first = platforms[0];
    setPlatformId(first.id);
    setDraft(platformDraft(first, crypto.randomUUID()));
    setAdvanced(false);
    setCredentialError('');
    setMakeDefault(!settings.bindings[primaryBinding]);
  };
  const edit = provider => {
    setPlatformId(providerPlatform(provider)?.id || platforms[0].id);
    setDraft({ ...provider, key: '' });
    setAdvanced(false);
    setCredentialError('');
    setMakeDefault(false);
  };
  const switchPlatform = id => {
    const selected = MODEL_PLATFORMS.find(item => item.id === id);
    setPlatformId(id);
    setCredentialError('');
    // New platform = new empty credential fields; never carry a key across sites.
    setDraft(current => ({ ...platformDraft(selected, current.id), ...(current.name.trim() && current.name !== platform?.label ? { name: current.name } : {}) }));
  };
  const fetchModels = () => run(async () => {
    const snapshot = draft;
    if (!snapshot.baseUrl.trim()) throw new Error('请先填写服务地址。');
    setFetching(true);
    try {
      const result = await call('fetchProviderModels', snapshot);
      if (!result.models?.length) throw new Error('平台没有返回模型，请核对服务地址和密钥。');
      setDraft(current => current && ['id', 'protocol', 'baseUrl', 'key'].every(key => current[key] === snapshot[key])
        ? { ...current, models: result.models, catalog: result.catalog } : current);
    } finally { setFetching(false); }
  });
  const save = () => run(async () => {
    if (saveInFlight.current || fetching) return;
    if (!draft.baseUrl.trim()) throw new Error('请填写服务地址。');
    if (!draft.model.trim()) throw new Error('请选择或填写模型名称。');
    if (!draft.hasKey && !draft.key.trim()) throw new Error('请先通过上方入口获取 API Key，再粘贴到这里。');
    if (!Number.isFinite(+draft.timeoutMs) || +draft.timeoutMs < 1000 || +draft.timeoutMs > 3600000) throw new Error('超时时间应为 1–3600 秒。');
    saveInFlight.current = true;
    setSaving(true);
    setCredentialError('');
    try {
      try {
        await call('saveProvider', { ...draft, name: draft.name.trim() || `${platform.label} · ${draft.model}` });
      } catch (error) {
        if (!error?.code?.startsWith('CREDENTIAL_STORAGE_')) throw error;
        setCredentialError(error.message || '请检查当前系统账户的安全存储，然后重新尝试保存。');
        return;
      }
      if (makeDefault) {
        const current = await call('getState');
        await call('updateSettings', { bindings: { ...current.settings.bindings, [primaryBinding]: draft.id } });
      }
      setDraft(null);
      notify(makeDefault ? '连接已保存，并已设为此功能的默认服务' : '连接已保存');
    } finally { saveInFlight.current = false; setSaving(false); }
  });
  const closeDraft = () => { if (!saveInFlight.current) setDraft(null); };
  const test = provider => run(async () => {
    setTesting(provider.id);
    try {
      const result = await call('testProvider', provider.id);
      if (result?.ok === false) throw new Error(result.error || result.message || '检查失败');
      notify(result?.message || '配置检查完成');
    } finally { setTesting(''); }
  });
  return <>
    <section className="surface setting-section model-connections" data-testid="model-connections">
      <div className="setting-title"><div><h3>模型服务</h3><p>先选要做的事情，再选择服务平台、填写密钥。已保存的配置会自动归类。</p></div></div>
      <div className="model-category-tabs" role="tablist" aria-label="模型用途">
        {MODEL_GROUPS.map(item => <button type="button" key={item.id} role="tab" aria-selected={item.id === groupId} aria-controls="model-category-panel" id={`model-tab-${item.id}`} onClick={() => setGroupId(item.id)}>{item.label}<span>{settings.providers.filter(provider => item.protocols.includes(provider.protocol)).length}</span></button>)}
      </div>
      <div role="tabpanel" id="model-category-panel" aria-labelledby={`model-tab-${groupId}`}>
        <div className="model-category-heading"><div><h4>{group.label}</h4><p>{group.description}</p></div><Button primary onClick={create}><Plus size={18}/>添加{group.label}服务</Button></div>
        <div className="provider-list">{providers.map(provider => {
          const selected = group.bindings.filter(([key]) => settings.bindings[key] === provider.id).map(([, label]) => label);
          return <article className="provider-card model-service-card" key={provider.id}>
            <div className="model-service-main"><div className="provider-info"><strong>{provider.name}<span className="tiny-badge">{provider.hasKey ? '密钥已保存' : '待填写密钥'}</span></strong><span>{provider.model} · {providerPlatform(provider)?.label || '已有服务'}</span><small>{selected.length ? `当前用于：${selected.join('、')}` : '已保存，可在下方选择使用'}</small></div><div className="model-service-actions"><Button disabled={testing === provider.id} onClick={() => test(provider)}><CheckCircle size={17}/>{testing === provider.id ? '检查中…' : '检查配置'}</Button><button className="icon-button" aria-label={`编辑连接 ${provider.name}`} onClick={() => edit(provider)}><PencilSimple size={19}/></button><button className="icon-button" aria-label={`删除连接 ${provider.name}`} onClick={() => setDeleting(provider)}><Trash size={19}/></button></div></div>
            <ProviderHelp provider={provider} call={call} run={run}/>
          </article>;
        })}</div>
        {!providers.length && <div className="model-empty"><strong>还没有{group.label}服务</strong><p>点击上方添加，选择平台后跟随提示完成配置。</p></div>}
        <div className="model-defaults"><h4>此功能使用哪个服务</h4><div className="binding-grid">{group.bindings.map(([key, label]) => <Field key={key} label={label}><select aria-label={`${label}连接`} value={settings.bindings[key] || ''} onChange={event => {
          const id = event.target.value;
          run(async () => { const latest = await call('getState'); await call('updateSettings', { bindings: { ...latest.settings.bindings, [key]: id } }); });
        }}><option value="">{key === 'rewrite' ? '跟随参考图理解服务' : '请选择服务'}</option>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></Field>)}</div></div>
        {groupId === 'speech' && <p className="field-note"><Info size={16}/>连接保存后，点击左侧“配音预设”选择音色和语速。</p>}
      </div>
    </section>
    {groupId === 'video' && renderAccount}
    {draft && <Dialog title={editing ? '编辑模型服务' : `添加${group.label}服务`} onClose={closeDraft} closeDisabled={saving}>
      <fieldset className="modal-form model-save-form" disabled={saving} aria-busy={saving}>
        <Field label="配置名称" hint="给这个连接起一个容易辨认的名称"><input aria-label="连接名称" value={draft.name} placeholder="例如：图片生成主服务" onChange={event => patch('name', event.target.value)}/></Field>
        <Field label="服务平台"><select aria-label="服务平台" value={platformId} disabled={editing || saving || fetching} onChange={event => switchPlatform(event.target.value)}>{platforms.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>
        <div className="platform-guide"><strong>① 在平台开通服务并获取密钥</strong><ProviderHelp provider={draft} call={call} run={run}/><p>{platform?.custom ? '使用 CPA、Fengsha 等服务时，填写该平台提供的服务地址和密钥。支持标准 OpenAI 兼容接口。' : '下方入口在浏览器中打开。请使用同一平台账号的密钥，账号有余额且已开通对应服务后才能生成。'}</p>{draft.protocol.startsWith('minimax-') && <p>当前服务地址：{draft.baseUrl}。国内与国际账号的密钥不通用，可在高级设置中核对地址。</p>}</div>
        {platform?.custom && <Field label="服务地址" hint="由你购买服务的平台提供"><input aria-label="接口基础地址" placeholder="https://你的服务地址/v1" value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value, models: [] })}/></Field>}
        <Field label="② 粘贴 API Key" hint={draft.hasKey ? '已保存，留空保持不变' : '仅在本机加密保存'}><input aria-label="API Key" type="password" autoComplete="new-password" value={draft.key} placeholder={draft.hasKey ? '留空保留已保存密钥' : '粘贴平台提供的密钥'} onChange={event => patch('key', event.target.value)}/></Field>
        <Field label="③ 选择模型" hint={draft.catalog || platform?.models?.length ? '平台预设目录，实际可用性取决于账号权限' : '可从平台读取，也可手工填写'}><div className="model-picker"><input aria-label="模型名称" list="provider-model-options" value={draft.model} placeholder="获取后选择，或填写平台提供的模型名" onChange={event => patch('model', event.target.value)}/><datalist id="provider-model-options">{[...new Set([...(draft.models || []), ...(platform?.models || [])])].map(model => <option key={model} value={model}/>)}</datalist><Button disabled={fetching || saving} onClick={fetchModels}><ArrowsClockwise size={17}/>{fetching ? '读取中…' : '获取模型'}</Button></div></Field>
        {draft.protocol === 'doubao-tts' && <Field label="豆包资源 ID" hint="开通服务时获得，需与音色版本一致"><input aria-label="豆包资源 ID" value={draft.resourceId || ''} onChange={event => patch('resourceId', event.target.value)}/></Field>}
        <details className="model-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>高级设置 · 服务地址与等待时间</summary><div>
          {!platform?.custom && <Field label="服务地址" hint="平台已自动填写；已有任务的连接修改地址需另建服务"><input aria-label="接口基础地址" value={draft.baseUrl} onChange={event => patch('baseUrl', event.target.value)}/></Field>}
          <Field label="最长等待时间（秒）"><input aria-label="请求超时秒数" type="number" min="1" max="3600" value={draft.timeoutMs / 1000} onChange={event => patch('timeoutMs', +event.target.value * 1000)}/></Field>
          {draft.protocol === 'oairegbox-video' && <><Field label="账号访问令牌（可选）" hint="用于余额和消费记录，不是 API 调用令牌"><input aria-label="OAIREGBOX 账号访问令牌" type="password" autoComplete="new-password" value={draft.accountToken || ''} disabled={draft.clearAccountToken} placeholder={draft.hasAccountToken ? '已保存，留空保留' : '在上方“账号访问令牌”入口获取'} onChange={event => patch('accountToken', event.target.value)}/></Field>{draft.hasAccountToken && <label className="inline-check"><input type="checkbox" checked={Boolean(draft.clearAccountToken)} onChange={event => patch('clearAccountToken', event.target.checked)}/>移除已保存的账号访问令牌</label>}</>}
          <p className="field-note">接入方式已根据平台自动选择。编辑现有服务会保留原来的接入方式和已保存密钥。</p>
        </div></details>
        <label className="inline-check model-bind-check"><input type="checkbox" checked={makeDefault} onChange={event => setMakeDefault(event.target.checked)}/>保存后用于{group.bindings[0][1]}{settings.bindings[primaryBinding] && settings.bindings[primaryBinding] !== draft.id ? '（会替换当前默认服务）' : ''}</label>
      </fieldset>
      {credentialError && <div className="model-credential-error" role="alert" data-testid="credential-storage-error">
        <WarningCircle size={21}/><div><strong>本机密钥保存失败</strong><p>{credentialError}</p><p>当前填写的内容保留在这个窗口，处理后可直接重试。</p></div>
      </div>}
      <div className="modal-actions"><Button disabled={saving} onClick={closeDraft}>取消</Button><Button primary data-testid="save-model-service" disabled={saving || fetching} onClick={save}>{credentialError ? <ArrowsClockwise size={18}/> : <FloppyDisk size={18}/>} {saving ? '保存中…' : credentialError ? '重新尝试保存' : '保存服务'}</Button></div>
    </Dialog>}
    {deleting && <Dialog title="删除模型服务" onClose={() => setDeleting(null)}><p>确认删除“{deleting.name}”？使用此服务的功能需要重新选择。已有任务记录会保留。</p><div className="modal-actions"><Button onClick={() => setDeleting(null)}>取消</Button><button className="button danger" onClick={() => run(async () => { await call('deleteProvider', deleting.id); setDeleting(null); }, '连接已删除')}>删除连接</button></div></Dialog>}
  </>;
}
