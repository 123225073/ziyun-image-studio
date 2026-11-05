import { SPEECH_CATALOGS } from './speech.mjs';
import { OAIREGBOX_BASE, OAIREGBOX_CONSOLE } from './oairegbox.mjs';

export const MODEL_GROUPS = [
  { id: 'text', label: '文字与识图', description: '用于提示词优化、参考图理解和混剪素材识别。', protocols: ['openai-chat'], bindings: [['vision', '参考图理解'], ['rewrite', '提示词优化'], ['montageVision', '混剪素材识别']] },
  { id: 'image', label: '图片生成', description: '用于生成图片和参考图改图。', protocols: ['openai-images'], bindings: [['image', '图片生成']] },
  { id: 'video', label: '视频生成', description: '用于生成视频片头，选择你实际购买服务的平台。', protocols: ['oairegbox-video', 'minimax-video', 'replicate-video'], bindings: [['video', '视频生成']] },
  { id: 'speech', label: '语音合成', description: '用于文案配音。连接保存后，可在配音预设中选择音色和语速。', protocols: ['doubao-tts', 'minimax-tts', 'openai-tts'], bindings: [['tts', '语音配音']] },
];

export const MODEL_PLATFORMS = [
  { id: 'compatible-text', group: 'text', label: '其他服务平台', protocol: 'openai-chat', custom: true },
  { id: 'openai-text', group: 'text', label: 'OpenAI 官方', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', help: 'openai' },
  { id: 'compatible-image', group: 'image', label: '其他服务平台', protocol: 'openai-images', custom: true },
  { id: 'openai-image', group: 'image', label: 'OpenAI 官方', protocol: 'openai-images', baseUrl: 'https://api.openai.com/v1', help: 'openai' },
  { id: 'oairegbox', group: 'video', label: 'OAIREGBOX · H3', protocol: 'oairegbox-video', baseUrl: OAIREGBOX_BASE, help: 'oairegbox', timeoutMs: 600000 },
  { id: 'minimax-video-cn', group: 'video', label: 'MiniMax 国内', protocol: 'minimax-video', baseUrl: 'https://api.minimax.cn', help: 'minimax-cn', timeoutMs: 600000 },
  { id: 'minimax-video', group: 'video', label: 'MiniMax 国际', protocol: 'minimax-video', baseUrl: 'https://api.minimax.io', help: 'minimax', timeoutMs: 600000 },
  { id: 'replicate', group: 'video', label: 'Replicate', protocol: 'replicate-video', baseUrl: 'https://api.replicate.com', help: 'replicate', models: ['minimax/h3', 'minimax/h3-lite'], timeoutMs: 600000 },
  { id: 'doubao', group: 'speech', label: '豆包 · 火山引擎', protocol: 'doubao-tts', ...SPEECH_CATALOGS['doubao-tts'], help: 'doubao' },
  { id: 'minimax-speech-cn', group: 'speech', label: 'MiniMax 国内', protocol: 'minimax-tts', ...SPEECH_CATALOGS['minimax-tts'], baseUrl: 'https://api.minimax.cn', help: 'minimax-cn' },
  { id: 'minimax-speech', group: 'speech', label: 'MiniMax 国际', protocol: 'minimax-tts', ...SPEECH_CATALOGS['minimax-tts'], help: 'minimax' },
  { id: 'openai-speech', group: 'speech', label: 'OpenAI 官方', protocol: 'openai-tts', ...SPEECH_CATALOGS['openai-tts'], help: 'openai' },
  { id: 'compatible-speech', group: 'speech', label: '其他服务平台', protocol: 'openai-tts', custom: true },
];

// Only these public pages can be opened by the settings help buttons.
export const PLATFORM_HELP = {
  openai: [
    ['key', '获取 API Key', 'https://platform.openai.com/api-keys'],
    ['console', '余额与账单', 'https://platform.openai.com/settings/organization/billing/overview'],
    ['docs', '接入说明', 'https://platform.openai.com/docs/overview'],
  ],
  minimax: [
    ['key', '获取 API Key', 'https://platform.minimax.io/console/keys'],
    ['console', '余额与充值', 'https://platform.minimax.io/console/recharge-records'],
    ['docs', '模型与音色说明', 'https://platform.minimax.io/docs'],
  ],
  'minimax-cn': [
    ['key', '获取 API Key', 'https://platform.minimax.cn/console/keys'],
    ['console', '余额与充值', 'https://platform.minimax.cn/console/recharge-records'],
    ['docs', '模型与音色说明', 'https://platform.minimax.cn/docs'],
  ],
  doubao: [
    ['key', '获取语音 API Key', 'https://console.volcengine.com/speech/new/setting/apikeys'],
    ['activate', '开通语音服务', 'https://console.volcengine.com/speech/new/setting/activate'],
    ['voices', '查看音色', 'https://console.volcengine.com/speech/new/voices'],
    ['console', '用量统计', 'https://console.volcengine.com/speech/new/usage-statistics'],
    ['docs', '配置说明', 'https://docs.volcengine.com/docs/doubao-voice/console-guidance?lang=zh'],
  ],
  replicate: [
    ['key', '获取 API Token', 'https://replicate.com/account/api-tokens'],
    ['console', '用量与账单', 'https://replicate.com/account/billing'],
    ['docs', '接入说明', 'https://replicate.com/docs'],
  ],
  oairegbox: [
    ['key', '创建 API 令牌', `${OAIREGBOX_CONSOLE}/console/token`],
    ['register', '注册账号', `${OAIREGBOX_CONSOLE}/register`],
    ['console', '充值中心', `${OAIREGBOX_CONSOLE}/console/topup`],
    ['logs', '消费明细', `${OAIREGBOX_CONSOLE}/console/log`],
    ['account', '账号访问令牌', `${OAIREGBOX_CONSOLE}/console/personal`],
  ],
};

export const providerGroup = provider => MODEL_GROUPS.find(group => group.protocols.includes(provider?.protocol));

export function providerPlatform(provider) {
  const candidates = MODEL_PLATFORMS.filter(platform => platform.protocol === provider?.protocol);
  let host = '';
  try { host = new URL(provider.baseUrl).hostname; } catch {}
  const exact = candidates.find(platform => platform.baseUrl && new URL(platform.baseUrl).hostname === host);
  if (exact) return exact;
  if (host && candidates.length) return { ...(candidates.find(platform => platform.custom) || candidates[0]), label: '自定义服务', custom: true };
  return candidates.find(platform => platform.custom) || candidates[0];
}

export function platformDraft(platform, id) {
  return {
    id, name: platform.label, protocol: platform.protocol, baseUrl: platform.baseUrl || '',
    model: platform.models?.[0] || '', models: platform.models || [], resourceId: platform.resourceId || '',
    timeoutMs: platform.timeoutMs || 180000, key: '', hasKey: false,
  };
}

export function providerHelpLinks(provider) {
  const platform = providerPlatform(provider);
  if (platform?.custom) {
    try {
      const url = new URL(provider.baseUrl);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
        return [['console', '打开服务平台', url.origin]];
    } catch {}
    return [];
  }
  return PLATFORM_HELP[platform?.help] || [];
}

export function providerHelpUrl(provider, page) {
  const url = providerHelpLinks(provider).find(([key]) => key === page)?.[2];
  if (!url) throw new Error('当前平台没有此帮助入口。');
  return url;
}
