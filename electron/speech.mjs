import { randomUUID } from 'node:crypto';
import { normalizeSpeechOptions } from '../shared/speech.mjs';

const MAX_AUDIO = 50 * 1024 * 1024;
const MAX_RESPONSE = 150 * 1024 * 1024;

function speechError(message, unknown = false) {
  return Object.assign(new Error(message), { code: unknown ? 'PROVIDER_UNKNOWN' : 'PROVIDER_ERROR', unknown });
}

function endpoint(provider, route) {
  let url;
  try { url = new URL(provider.baseUrl); } catch { throw speechError('请填写有效的语音服务地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw speechError('语音服务地址格式无效。');
  return url.href.replace(/\/+$/, '').replace(/\/v[12]$/, '') + route;
}

async function readBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw speechError('语音服务返回内容超过本机接收上限。', true);
  }
  if (!response.body) return Buffer.alloc(0);
  const parts = [];
  let length = 0;
  for await (const part of response.body) {
    length += part.byteLength;
    if (length > limit) throw speechError('语音服务返回内容超过本机接收上限。', true);
    parts.push(part);
  }
  return Buffer.concat(parts, length);
}

function audioResult(bytes, options, extra = {}) {
  const mp3 = bytes.length >= 3 && (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0));
  const wav = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  if (!bytes.length || bytes.length > MAX_AUDIO || !(options.format === 'wav' ? wav : mp3)) throw speechError('远端已响应，但文件内容不是有效的目标音频；请先核对配音记录再决定重新生成。', true);
  return { bytes, mime: options.format === 'wav' ? 'audio/wav' : 'audio/mpeg', ...extra };
}

function segmentsFrom(items, unit = 1) {
  if (!Array.isArray(items)) return [];
  const segments = items.flatMap(item => {
    const text = String(item.word ?? item.text ?? '').trim();
    const start = Number(item.startTime ?? item.time_begin ?? item.start) / unit;
    const end = Number(item.endTime ?? item.time_end ?? item.end) / unit;
    return text && Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end > start ? [{ text, start, end }] : [];
  });
  const unique = new Map(segments.map(segment => [`${segment.start}:${segment.end}:${segment.text}`, segment]));
  return [...unique.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw speechError('远端音频编码不完整，状态未知，请核对配音记录。', true);
  return Buffer.from(value, 'base64');
}

function doubaoOptions(options, provider) {
  const resourceId = String(provider.resourceId || provider.model);
  if (!['seed-tts-2.0', 'seed-icl-2.0'].includes(resourceId)) throw speechError('请选择豆包语音合成2.0或声音复刻2.0资源。');
  if (options.emotion && resourceId === 'seed-icl-2.0') throw speechError('豆包复刻音色当前不支持此语气指令，请清空语气后提交。');
  const additions = {};
  if (options.emotion) additions.context_texts = [options.emotion];
  if (options.pitch) additions.post_process = { pitch: options.pitch };
  if (options.language === 'yue') additions.explicit_dialect = 'yue';
  else if (options.language !== 'auto') additions.explicit_language = options.language;
  return {
    resourceId,
    parameters: {
      speaker: options.voice,
      audio_params: {
        format: options.format, sample_rate: options.sampleRate,
        speech_rate: Math.round((options.speed - 1) * 100),
        loudness_rate: Math.round((options.volume - 1) * 100),
        enable_subtitle: options.subtitles,
      },
      ...(Object.keys(additions).length ? { additions: JSON.stringify(additions) } : {}),
    },
  };
}

function parseDoubao(bytes, options) {
  const frames = bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { throw speechError('豆包返回的音频流不完整，状态未知，请核对配音记录。', true); }
  });
  const parts = [], words = [];
  let complete = false, length = 0;
  for (const frame of frames) {
    if (complete) throw speechError('豆包音频结束后收到额外数据，状态未知。', true);
    if (![0, 20000000].includes(frame.code)) throw speechError(`豆包拒绝合成，请核对音色权限、资源、文案和额度（状态码 ${Number.isInteger(frame.code) ? frame.code : '未知'}）。`, Number(frame.code) >= 50000000);
    if (frame.data) {
      const part = decodeBase64(frame.data);
      length += part.length;
      if (length > MAX_AUDIO) throw speechError('合成音频超过本机接收上限。', true);
      parts.push(part);
    }
    if (frame.sentence?.words) words.push(...frame.sentence.words);
    if (frame.code === 20000000) complete = true;
  }
  if (!complete) throw speechError('豆包音频流缺少完成状态，已接收内容未作为成功音频保存，请核对配音记录。', true);
  const segments = segmentsFrom(words);
  return audioResult(Buffer.concat(parts, length), options, {
    segments,
    ...(options.subtitles && !segments.length ? { subtitleWarning: '已保存配音，服务未提供可用字幕时间信息。' } : {}),
  });
}

function miniMaxBody(text, options, provider) {
  if (text.length >= 10000) throw speechError('MiniMax单次文案须少于10000字符，请按完整语义分段。');
  const emotions = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'];
  if (options.emotion && !emotions.includes(options.emotion)) throw speechError('MiniMax请选择支持的情绪，或使用自动语气。');
  if (['fluent', 'whisper'].includes(options.emotion) && !provider.model.startsWith('speech-2.6-')) throw speechError('此语气仅支持MiniMax speech-2.6系列，请更换模型或语气。');
  if (![8000, 16000, 22050, 24000, 32000, 44100].includes(options.sampleRate)) throw speechError('MiniMax请选择其支持的采样率，最高44100Hz。');
  const language = { 'zh-cn': 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', yue: 'Chinese,Yue', auto: 'auto' }[options.language];
  return {
    model: provider.model, text, stream: false, output_format: 'hex', language_boost: language,
    voice_setting: {
      voice_id: options.voice, speed: options.speed, vol: options.volume, pitch: options.pitch,
      ...(options.emotion ? { emotion: options.emotion } : {}),
    },
    audio_setting: { format: options.format, sample_rate: options.sampleRate, channel: 1 },
    subtitle_enable: options.subtitles, subtitle_type: 'sentence',
  };
}

async function miniMaxResult(bytes, options, context, signal) {
  let json;
  try { json = JSON.parse(bytes.toString('utf8')); } catch { throw speechError('MiniMax返回内容未完整接收或解析，状态未知。', true); }
  if (!Number.isInteger(json.base_resp?.status_code)) throw speechError('MiniMax返回结果缺少有效状态，状态未知，请核对配音记录。', true);
  if (json.base_resp.status_code !== 0) throw speechError('MiniMax拒绝合成，请核对音色、模型、文案和账号额度。', json.base_resp.status_code === 1000);
  if (json.data?.status !== 2) throw speechError('MiniMax没有返回完整合成结果，状态未知，请核对配音记录。', true);
  const hex = json.data?.audio;
  if (typeof hex !== 'string' || hex.length % 2 || !/^[a-fA-F0-9]+$/.test(hex)) throw speechError('MiniMax返回的音频编码不完整，状态未知。', true);
  const extra = { segments: [] };
  if (Number.isFinite(json.extra_info?.audio_length) && json.extra_info.audio_length > 0) extra.duration = json.extra_info.audio_length / 1000;
  const result = audioResult(Buffer.from(hex, 'hex'), options, extra);
  const subtitleFile = json.data.subtitle_file;
  if (options.subtitles && !subtitleFile) result.subtitleWarning = '已保存配音，服务未提供可用字幕时间信息。';
  if (options.subtitles && subtitleFile) {
    try {
      const url = new URL(subtitleFile);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid subtitle URL');
      const response = await (context.fetch || globalThis.fetch)(url.href, { signal, redirect: 'follow', credentials: 'omit' });
      if (!response.ok) throw new Error('Subtitle unavailable');
      const subtitle = JSON.parse((await readBody(response, 8 * 1024 * 1024)).toString('utf8'));
      result.segments = segmentsFrom(Array.isArray(subtitle) ? subtitle : subtitle.subtitles, 1000);
      if (!result.segments.length) result.subtitleWarning = '已保存配音，服务未提供可用字幕时间信息。';
    } catch {
      // The audio is already complete. Subtitle download failure must not cause
      // a second paid synthesis of an otherwise valid, reusable recording.
      result.subtitleWarning = '已保存配音，字幕时间信息暂未取得，可稍后对齐。';
    }
  }
  return result;
}

export async function runSpeech(payload, context = {}) {
  const { provider = {} } = context;
  if (!provider.key || !provider.model) throw speechError('请先配置语音服务的模型和密钥。');
  const text = String(payload.prompt ?? payload.text ?? '').trim();
  if (!text) throw speechError('请填写需要合成的文案。');
  const options = normalizeSpeechOptions(payload, provider);
  let route, body, headers;
  if (provider.protocol === 'doubao-tts') {
    const settings = doubaoOptions(options, provider);
    route = '/api/v3/tts/unidirectional';
    body = { req_params: { text, ...settings.parameters } };
    headers = { 'X-Api-Key': provider.key, 'X-Api-Resource-Id': settings.resourceId, 'X-Api-Request-Id': randomUUID() };
  } else if (provider.protocol === 'minimax-tts') {
    route = '/v1/t2a_v2';
    body = miniMaxBody(text, options, provider);
    headers = { Authorization: `Bearer ${provider.key}` };
  } else throw speechError('此连接不支持所选语音协议。');
  const url = endpoint(provider, route);
  const timeout = AbortSignal.timeout(Math.min(900000, Math.max(1000, Number(provider.timeoutMs) || 180000)));
  const signal = AbortSignal.any([context.signal, timeout].filter(Boolean));
  if (signal.aborted) throw speechError('语音任务已取消。');
  let submitted = false;
  try {
    submitted = true;
    const response = await (context.fetch || globalThis.fetch)(url, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal, redirect: 'error',
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      throw speechError(`语音服务返回HTTP ${response.status}，请核对权限、额度或服务状态。`, response.status >= 500);
    }
    const bytes = await readBody(response, MAX_RESPONSE);
    if (provider.protocol === 'doubao-tts') return parseDoubao(bytes, options);
    return await miniMaxResult(bytes, options, context, signal);
  } catch (error) {
    if (error.code?.startsWith('PROVIDER_')) throw error;
    throw speechError(submitted ? '语音请求中断或超时，远端可能已合成，状态未知，请先核对服务记录。' : '语音请求未提交。', submitted);
  }
}
