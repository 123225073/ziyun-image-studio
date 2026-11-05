import React from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { providerHelpLinks } from '../shared/model-settings.mjs';

export default function ProviderHelp({ provider, call, run }) {
  const links = providerHelpLinks(provider);
  return <div className="provider-help" aria-label="平台配置帮助">
    {links.map(([page, label, url]) => <button type="button" className="provider-help-link" key={page} title={`在浏览器中打开：${url}`} onClick={() => run(() => call('openProviderHelp', { protocol: provider.protocol, baseUrl: provider.baseUrl, page }))}><ArrowSquareOut size={15}/>{label}</button>)}
    {!links.length && <span className="muted">填写服务地址后，可在这里打开对应平台获取密钥。</span>}
  </div>;
}
