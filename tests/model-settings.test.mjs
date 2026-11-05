import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_GROUPS, MODEL_PLATFORMS, platformDraft, providerGroup, providerPlatform, providerHelpUrl } from '../shared/model-settings.mjs';

test('each existing protocol has one clear task category', () => {
  const protocols = MODEL_GROUPS.flatMap(group => group.protocols);
  assert.equal(new Set(protocols).size, 8);
  assert.equal(protocols.length, 8);
  for (const platform of MODEL_PLATFORMS) assert.equal(providerGroup(platform).id, platform.group);
});

test('domestic and international MiniMax credentials go to their own consoles', () => {
  for (const region of ['cn', 'io']) {
    const provider = { protocol: 'minimax-tts', baseUrl: `https://api.minimax.${region}` };
    assert.equal(providerHelpUrl(provider, 'key'), `https://platform.minimax.${region}/console/keys`);
  }
  assert.equal(providerHelpUrl({ protocol: 'doubao-tts', baseUrl: 'https://openspeech.bytedance.com' }, 'key'), 'https://console.volcengine.com/speech/new/setting/apikeys');
});

test('custom compatible providers open their own platform without guessing key routes', () => {
  const provider = { protocol: 'openai-images', baseUrl: 'https://cpa.fengsha.online/v1' };
  assert.equal(providerPlatform(provider).custom, true);
  assert.equal(providerHelpUrl(provider, 'console'), 'https://cpa.fengsha.online');
  assert.throws(() => providerHelpUrl(provider, 'key'));
  assert.throws(() => providerHelpUrl({ ...provider, baseUrl: 'javascript:alert(1)' }, 'console'));
  assert.throws(() => providerHelpUrl({ ...provider, baseUrl: 'https://secret@example.com' }, 'console'));
});

test('platform defaults contain no inherited credentials and keep supported speech parameters', () => {
  const draft = platformDraft(MODEL_PLATFORMS.find(item => item.id === 'doubao'), 'fixture');
  assert.equal(draft.key, '');
  assert.equal(draft.hasKey, false);
  assert.equal(draft.resourceId, 'seed-tts-2.0');
  assert.equal(draft.protocol, 'doubao-tts');
  assert.equal(draft.model, 'seed-tts-2.0');
});
