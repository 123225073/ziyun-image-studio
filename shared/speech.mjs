export const TTS_PROTOCOLS = ['openai-tts', 'doubao-tts', 'minimax-tts'];

const languages = [
  { id: 'auto', name: '自动识别' }, { id: 'zh-cn', name: '中文普通话' },
  { id: 'en', name: '英语' }, { id: 'ja', name: '日语' },
  { id: 'ko', name: '韩语' }, { id: 'yue', name: '粤语' },
];

export const SPEECH_CATALOGS = {
  'openai-tts': {
    baseUrl: 'https://api.openai.com', models: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'],
    voice: 'alloy', voices: [{ id: 'alloy', name: 'Alloy' }], formats: ['mp3', 'wav'], languages, maxText: 4000,
  },
  'doubao-tts': {
    baseUrl: 'https://openspeech.bytedance.com', models: ['seed-tts-2.0', 'seed-icl-2.0'],
    resourceId: 'seed-tts-2.0', voice: 'zh_female_vv_uranus_bigtts',
    voices: [{ id: 'zh_female_vv_uranus_bigtts', name: '豆包女声 VV' }], formats: ['mp3', 'wav'], languages, maxText: 1500,
  },
  'minimax-tts': {
    baseUrl: 'https://api.minimax.io',
    models: ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'],
    voice: 'Chinese (Mandarin)_Reliable_Executive',
    voices: [
      { id: 'Chinese (Mandarin)_Reliable_Executive', name: '普通话 · 稳重男声' },
      { id: 'Chinese (Mandarin)_News_Anchor', name: '普通话 · 新闻女声' },
    ],
    formats: ['mp3', 'wav'], languages, maxText: 9999,
    emotions: ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'],
  },
};

function numberOption(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}须在 ${min} 至 ${max} 之间。`);
  return number;
}

export function normalizeSpeechOptions(input = {}, provider = {}) {
  const catalog = SPEECH_CATALOGS[provider.protocol] || SPEECH_CATALOGS['openai-tts'];
  const voice = String(input.voice ?? catalog.voice).trim();
  if (!voice || voice.length > 200 || /[\r\n\0]/.test(voice)) throw new Error('请填写有效的音色 ID。');
  const format = String(input.format || 'mp3').toLowerCase();
  if (!catalog.formats.includes(format)) throw new Error('请选择 MP3 或 WAV 音频格式。');
  const pitch = numberOption(input.pitch, 0, -12, 12, '音调');
  if (!Number.isInteger(pitch)) throw new Error('音调须为整数。');
  const language = String(input.language || 'auto');
  if (!languages.some(item => item.id === language)) throw new Error('请选择支持的配音语言。');
  const emotion = String(input.emotion || '').trim();
  if (emotion.length > 500) throw new Error('语气或风格指令过长。');
  const sampleRate = numberOption(input.sampleRate, 24000, 8000, 48000, '采样率');
  if (![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)) throw new Error('请选择支持的音频采样率。');
  const options = {
    voice,
    speed: numberOption(input.speed, 1, 0.5, 2, '语速'),
    volume: numberOption(input.volume, 1, provider.protocol === 'doubao-tts' ? 0.5 : 0.1, provider.protocol === 'minimax-tts' ? 10 : 2, '音量'),
    pitch, emotion, language, format, sampleRate, subtitles: input.subtitles !== false,
  };
  if (provider.protocol === 'openai-tts' && (options.volume !== 1 || options.pitch !== 0 || options.emotion || options.language !== 'auto')) throw new Error('当前OpenAI兼容配音仅支持音色、语速和格式，请使用自动语言并清空语气、音量及音调调整。');
  return options;
}

// Return a stable, browser-compatible fingerprint. The service hashes this
// string with SHA-256 before using it as a persistent file or cache key.
export function speechCacheKey(provider, options, text) {
  return JSON.stringify({
    version: 1, providerId: provider.id || '', protocol: provider.protocol,
    baseUrl: provider.baseUrl, model: provider.model, resourceId: provider.resourceId || '',
    text: String(text), options: normalizeSpeechOptions(options, provider),
  });
}

// The Doubao value is an application batching policy because its current V3
// HTTP page does not specify a total text cap. It is not a vendor quota.
export function maxSpeechText(provider = {}) {
  return SPEECH_CATALOGS[provider.protocol]?.maxText || 4000;
}
