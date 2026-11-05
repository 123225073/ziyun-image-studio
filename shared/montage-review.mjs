import { batchCapacity, batchCombinationAt, splitTexts } from './montage-batch.mjs';

// This exact signature, rather than a row number alone, binds AI results to the
// candidate pool and the material mapping that the user actually reviewed.
export function montageReviewSignature(setup = {}) {
  const mode = setup.mode === 'master' ? 'master' : 'sections';
  const sections = (setup.sections || []).map(section => ({
    id: String(section.id || ''), section: String(section.section || ''),
    enabled: section.enabled !== false, candidateMode: section.candidateMode === 'files' ? 'files' : 'texts',
    candidates: mode === 'master' ? [] : splitTexts(section.candidates),
    paths: [...(section.paths || [])], assetIds: [...(section.assetIds || [])],
  }));
  return JSON.stringify({ version: 1, mode, masterText: mode === 'master' ? String(setup.masterText || '').trim() : '', sections });
}

export function montageReviewCombination(setup, index) {
  if (setup.mode !== 'master') return batchCombinationAt(setup.sections, index);
  const text = String(setup.masterText || '').trim();
  if (index !== 0 || !text) throw new Error('组合序号超出有效范围。');
  const active = setup.sections.filter(section => section.enabled !== false);
  return { masterText: text, segments: [{ section: '正文', text, paths: active.flatMap(section => section.paths || []), assetIds: active.flatMap(section => section.assetIds || []) }] };
}

export const montageReviewCapacity = setup => setup.mode === 'master' ? (String(setup.masterText || '').trim() ? 1 : 0) : batchCapacity(setup.sections);
