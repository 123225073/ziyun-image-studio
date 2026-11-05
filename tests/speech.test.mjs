import test from 'node:test';
import assert from 'node:assert/strict';
import { runProvider } from '../electron/providers.mjs';
import { maxSpeechText, normalizeSpeechOptions, speechCacheKey, SPEECH_CATALOGS } from '../shared/speech.mjs';

const mp3 = Buffer.from('ID3speech-fixture-not-a-real-recording');
const wav = Buffer.alloc(48);
wav.write('RIFF');
wav.write('WAVE', 8);

function context(protocol, fetch) {
  return {
    provider: { id: 'voice-provider', protocol, baseUrl: 'https://tts.example.invalid', key: 'do-not-print-secret', model: SPEECH_CATALOGS[protocol].models[0], timeoutMs: 1000 },
    fetch,
  };
}

const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const miniResponse = (data = {}, extra = {}) => jsonResponse({ base_resp: { status_code: 0 }, data: { audio: mp3.toString('hex'), status: 2, ...data }, extra_info: { audio_length: 1400 }, ...extra });
const doubaoFrames = (...frames) => frames.map(frame => JSON.stringify(frame)).join('\n');

test('voice options use per-service defaults and cache fingerprints exclude credentials', () => {
  const provider = context('minimax-tts').provider;
  assert.equal(normalizeSpeechOptions({}, provider).voice, 'Chinese (Mandarin)_Reliable_Executive');
  assert.equal(maxSpeechText(provider), 9999);
  assert.equal(maxSpeechText(context('doubao-tts').provider), 1500);
  const key = speechCacheKey(provider, {}, '同一文案');
  assert.equal(key, speechCacheKey({ ...provider, key: 'another-secret' }, { speed: 1 }, '同一文案'));
  assert(!key.includes('do-not-print-secret'));
  assert.notEqual(key, speechCacheKey(provider, { speed: 1.1 }, '同一文案'));
  assert.notEqual(key, speechCacheKey({ ...provider, model: 'speech-2.6-hd' }, {}, '同一文案'));
  assert.throws(() => normalizeSpeechOptions({ speed: 2.1 }, provider), /语速/);
  assert.throws(() => normalizeSpeechOptions({ format: 'pcm' }, provider), /MP3/);
  assert.throws(() => normalizeSpeechOptions({ pitch: 0.5 }, provider), /整数/);
  assert.throws(() => normalizeSpeechOptions({ volume: 0.4 }, context('doubao-tts').provider), /音量/);
});

test('new voice catalogs are explicit presets without pretending to authenticate the service', async () => {
  for (const protocol of ['doubao-tts', 'minimax-tts']) {
    let calls = 0;
    const ctx = context(protocol, async () => { calls++; throw new Error('Must not call a generic model endpoint'); });
    const result = await runProvider('models', {}, ctx);
    assert.equal(result.catalog, true);
    assert.deepEqual(result.models, SPEECH_CATALOGS[protocol].models);
    assert.equal(calls, 0);
  }
});

test('Doubao sends API-key/resource headers and joins all chunks only after terminal success', async () => {
  let request;
  const frames = doubaoFrames(
    { code: 0, data: mp3.subarray(0, 6).toString('base64') },
    { code: 0, data: mp3.subarray(6).toString('base64'), sentence: { text: '你好', words: [{ word: '你', startTime: 0.1, endTime: 0.4 }, { word: '好', startTime: 0.4, endTime: 0.9 }] } },
    { code: 20000000, data: null },
  );
  const ctx = context('doubao-tts', async (url, options) => {
    request = { url, ...options };
    const data = Buffer.from(frames);
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < data.length; offset += 7) controller.enqueue(data.subarray(offset, offset + 7));
      controller.close();
    } }));
  });
  const result = await runProvider('tts', { prompt: '你好', speed: 1.2, volume: 0.8, language: 'zh-cn', emotion: '用亲切的语气' }, ctx);
  assert.equal(request.url, 'https://tts.example.invalid/api/v3/tts/unidirectional');
  assert.equal(request.headers['X-Api-Key'], 'do-not-print-secret');
  assert.equal(request.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert(!request.headers.Authorization);
  assert.match(request.headers['X-Api-Request-Id'], /^[\w-]{36}$/);
  const body = JSON.parse(request.body).req_params;
  assert.equal(body.text, '你好');
  assert.equal(body.speaker, 'zh_female_vv_uranus_bigtts');
  assert.equal(body.audio_params.speech_rate, 20);
  assert.equal(body.audio_params.loudness_rate, -20);
  assert.equal(body.audio_params.enable_subtitle, true);
  assert.deepEqual(JSON.parse(body.additions), { context_texts: ['用亲切的语气'], explicit_language: 'zh-cn' });
  assert.deepEqual(result.bytes, mp3);
  assert.equal(result.mime, 'audio/mpeg');
  assert.deepEqual(result.segments, [{ text: '你', start: 0.1, end: 0.4 }, { text: '好', start: 0.4, end: 0.9 }]);
});

test('Doubao never treats audio without the final 20000000 marker as complete', async () => {
  const ctx = context('doubao-tts', async () => new Response(doubaoFrames({ code: 0, data: mp3.toString('base64') })));
  await assert.rejects(runProvider('tts', { prompt: '你好' }, ctx), error => error.unknown && /缺少完成状态/.test(error.message));
});

test('Doubao stream failure after a partial audio block rejects rather than saving partial audio', async () => {
  const ctx = context('doubao-tts', async () => new Response(doubaoFrames(
    { code: 0, data: mp3.toString('base64') },
    { code: 45000000, message: 'do-not-print-secret upstream contents' },
  )));
  await assert.rejects(runProvider('tts', { prompt: '你好' }, ctx), error => !error.unknown && !error.message.includes('do-not-print-secret') && /45000000/.test(error.message));
  ctx.fetch = async () => new Response('{"code":0,"data":"unfinished');
  await assert.rejects(runProvider('tts', { prompt: '你好' }, ctx), error => error.unknown);
});

test('Doubao permits selected clone resources and reports an incompatible style before billing', async () => {
  let calls = 0;
  const ctx = context('doubao-tts', async (_url, options) => {
    calls++;
    assert.equal(options.headers['X-Api-Resource-Id'], 'seed-icl-2.0');
    assert.equal(JSON.parse(options.body).req_params.speaker, 'S_my_voice');
    return new Response(doubaoFrames({ code: 0, data: mp3.toString('base64') }, { code: 20000000 }));
  });
  ctx.provider.resourceId = 'seed-icl-2.0';
  await runProvider('tts', { prompt: '你好', voice: 'S_my_voice' }, ctx);
  await assert.rejects(runProvider('tts', { prompt: '你好', voice: 'S_my_voice', emotion: 'happy' }, ctx), /不支持/);
  assert.equal(calls, 1);
});

test('MiniMax uses the documented nonstreaming hexadecimal audio and voice parameters', async () => {
  let request;
  const ctx = context('minimax-tts', async (url, options) => { request = { url, ...options }; return miniResponse(); });
  const result = await runProvider('tts', { prompt: '你好 world', voice: 'my-voice', speed: 0.9, volume: 1.3, pitch: -2, language: 'zh-cn', emotion: 'calm' }, ctx);
  assert.equal(request.url, 'https://tts.example.invalid/v1/t2a_v2');
  assert.equal(request.headers.Authorization, 'Bearer do-not-print-secret');
  const body = JSON.parse(request.body);
  assert.deepEqual(body.voice_setting, { voice_id: 'my-voice', speed: 0.9, vol: 1.3, pitch: -2, emotion: 'calm' });
  assert.equal(body.stream, false);
  assert.equal(body.output_format, 'hex');
  assert.equal(body.language_boost, 'Chinese');
  assert.equal(body.subtitle_enable, true);
  assert.deepEqual(result.bytes, mp3);
  assert.equal(result.duration, 1.4);
});

test('MiniMax downloads subtitle JSON without credentials and converts milliseconds to seconds', async () => {
  const ctx = context('minimax-tts', async (url, options) => {
    if (url.includes('/t2a_v2')) return miniResponse({ subtitle_file: 'https://media.example.invalid/captions.json' });
    assert.equal(options.headers, undefined);
    assert.equal(options.credentials, 'omit');
    return jsonResponse([{ text: '你好', time_begin: 100, time_end: 1000 }]);
  });
  const result = await runProvider('tts', { prompt: '你好' }, ctx);
  assert.deepEqual(result.segments, [{ text: '你好', start: 0.1, end: 1 }]);
});

test('subtitle download failure keeps complete paid audio and returns a warning', async () => {
  let calls = 0;
  const ctx = context('minimax-tts', async url => {
    calls++;
    if (url.includes('/t2a_v2')) return miniResponse({ subtitle_file: 'https://media.example.invalid/captions.json' });
    throw new TypeError('Network interruption');
  });
  const result = await runProvider('tts', { prompt: '你好' }, ctx);
  assert.deepEqual(result.bytes, mp3);
  assert.match(result.subtitleWarning, /已保存配音/);
  assert.equal(calls, 2);
});

test('MiniMax business rejections are sanitized and incomplete success is unknown', async () => {
  const ctx = context('minimax-tts', async () => miniResponse({}, { base_resp: { status_code: 1004, status_msg: 'do-not-print-secret' } }));
  await assert.rejects(runProvider('tts', { prompt: '你好' }, ctx), error => !error.unknown && !error.message.includes('do-not-print-secret'));
  for (const data of [{ audio: 'not-hex' }, { status: 1 }, { audio: Buffer.from('<html>failed</html>').toString('hex') }]) {
    ctx.fetch = async () => miniResponse(data);
    await assert.rejects(runProvider('tts', { prompt: '你好' }, ctx), error => error.unknown);
  }
  ctx.fetch = async () => jsonResponse({ data: { audio: mp3.toString('hex'), status: 2 } });
  await assert.rejects(runProvider('tts', { prompt: '你好' }, ctx), error => error.unknown);
});

test('new TTS network interruption and 5xx are unknown and never automatically retried', async () => {
  for (const protocol of ['doubao-tts', 'minimax-tts']) {
    for (const reply of [() => { throw new TypeError('Network interrupted'); }, () => new Response('upstream', { status: 500 })]) {
      let calls = 0;
      const ctx = context(protocol, async () => { calls++; return reply(); });
      await assert.rejects(runProvider('tts', { prompt: '你好' }, ctx), error => error.unknown && !error.message.includes('do-not-print-secret'));
      assert.equal(calls, 1);
    }
  }
});

test('caller cancellation and parameter errors prevent paid submission', async () => {
  let calls = 0;
  const ctx = context('minimax-tts', async () => { calls++; return miniResponse(); });
  await assert.rejects(runProvider('tts', { prompt: 'a'.repeat(10000) }, ctx), /10000/);
  await assert.rejects(runProvider('tts', { prompt: '你好', emotion: 'whisper' }, ctx), /2.6/);
  await assert.rejects(runProvider('tts', { prompt: '你好', speed: 10 }, ctx), /语速/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runProvider('tts', { prompt: '你好' }, { ...ctx, signal: controller.signal }), /取消/);
  assert.equal(calls, 0);
});

test('OpenAI legacy request stays identical while explicit new speed and WAV settings are sent', async () => {
  const requests = [];
  const ctx = context('openai-tts', async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return new Response(body.response_format === 'wav' ? wav : mp3);
  });
  await runProvider('tts', { prompt: '你好' }, ctx);
  assert.deepEqual(requests[0], { model: 'tts-1', input: '你好', voice: 'alloy', response_format: 'mp3' });
  const result = await runProvider('tts', { prompt: '你好', speed: 1.2, format: 'wav' }, ctx);
  assert.equal(requests[1].speed, 1.2);
  assert.equal(requests[1].response_format, 'wav');
  assert.equal(result.mime, 'audio/wav');
  await assert.rejects(runProvider('tts', { prompt: '你好', emotion: 'happy' }, ctx), /仅支持/);
  assert.equal(requests.length, 2);
});
