import { montageReviewCombination } from '../../shared/montage-review.mjs';

// Legacy speech/render tests still exercise the real review receipt and gate.
// This provider response is local; no outside model or paid service is used.
export const withMontageReview = runner => async (operation, payload, ...rest) => {
  if (operation === 'rewrite' && payload.systemPrompt?.includes('你是中文短视频旁白的逻辑校对员')) return { text: JSON.stringify({ status: 'pass', summary: '本机测试校对通过', issues: [] }) };
  return runner(operation, payload, ...rest);
};

export async function approvedMontage(service, config) {
  const settings = service.state.settings;
  const id = 'fixture-montage-review';
  if (!settings.providers.some(provider => provider.id === id)) await service.updateSettings({ providers: [...settings.providers, { id, name: '本机校对fixture', protocol: 'openai-chat', model: 'fixture', baseUrl: 'http://127.0.0.1:1' }] });
  const setup = { mode: 'sections', sections: config.segments.map((segment, index) => ({ section: segment.section || String(index + 1), candidates: [segment.text], paths: segment.paths || [], assetIds: segment.assetIds || [] })) };
  const checked = await service.reviewMontageCombinations({ setup, indices: [0], providerId: id });
  const combo = montageReviewCombination(setup, 0);
  return { ...config, ...combo, segments: combo.segments.map((segment, index) => ({ ...config.segments[index], ...segment })), setup, reviewSourceKey: checked.sourceKey, reviewIndex: 0 };
}

export const reviewAndPlan = async (service, config) => service.planMontage(await approvedMontage(service, config));
export const reviewAndEnqueue = async (service, config) => service.enqueueMontage(await approvedMontage(service, config));
