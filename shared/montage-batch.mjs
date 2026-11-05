// Fixed workflow: one candidate from each enabled section, in visible order.
export const splitTexts = value => String(value || '').split(/\r?\n\s*---\s*\r?\n|\r?\n/).map(text => text.trim()).filter(Boolean);
export function batchChoices(sections) {
  return sections.filter(section => section.enabled !== false).map(section => {
    const texts = [...new Set(splitTexts(section.candidates))];
    const variants = section.candidateMode === 'files'
      ? (texts.length === 1 ? [...new Set(section.paths || [])].map(file => ({ text: texts[0], paths: [file], assetIds: [] })) : [])
      : texts.map(text => ({ text, paths: section.paths || [], assetIds: section.assetIds || [] }));
    return { ...section, texts, variants };
  });
}
export const sectionCapacity = section => batchChoices([{ ...section, enabled: true }])[0].variants.length;
export function batchCapacity(sections) {
  const rows = batchChoices(sections);
  return rows.length ? rows.reduce((total, row) => Math.min(Number.MAX_SAFE_INTEGER, total * row.variants.length), 1) : 0;
}
export function batchCombinations(sections, limit = 100) {
  return Array.from({ length: Math.min(batchCapacity(sections), limit) }, (_, index) => batchCombinationAt(sections,index));
}
export function batchCombinationAt(sections,index) {
  const rows = batchChoices(sections), capacity = batchCapacity(sections);
  if (!Number.isSafeInteger(index) || index < 0 || index >= capacity) throw new Error('组合序号超出有效范围。');
  let cursor = index;
  const segments = rows.map(row => {
    const variant = row.variants[cursor % row.variants.length];
    cursor = Math.floor(cursor / row.variants.length);
    return { section: row.section, ...variant };
  });
  return { segments, masterText: segments.map(segment => segment.text).join('\n') };
}

const characters = value => Array.from(String(value || '').replace(/[\s\p{P}\p{S}]/gu, ''));
// Preserve one complete voice track. Section timing uses provider timestamps
// only when their transcript agrees with the full copy; otherwise mark estimates.
export function alignSections(segments, duration, cues = []) {
  const text = segments.flatMap(segment => characters(segment.text));
  if (!text.length || !Number.isFinite(duration) || duration <= 0) throw new Error('完整配音或文案无效。');
  const valid = cues.filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start && cue.end <= duration + .1).sort((a, b) => a.start - b.start);
  const cueText = valid.flatMap(cue => characters(cue.text));
  const aligned = cueText.join('') === text.join('') && valid.every((cue, i) => !i || cue.start >= valid[i - 1].end - .001);
  const boundaries = [0];
  let offset = 0;
  for (const segment of segments.slice(0, -1)) {
    offset += characters(segment.text).length;
    let boundary = duration * offset / text.length;
    if (aligned) {
      let consumed = 0;
      for (const cue of valid) {
        const length = characters(cue.text).length;
        if (length && consumed + length >= offset) { boundary = cue.start + (cue.end - cue.start) * (offset - consumed) / length; break; }
        consumed += length;
      }
    }
    boundaries.push(boundary);
  }
  boundaries.push(duration);
  return { estimated: !aligned, segments: segments.map((segment, index) => {
    const start = boundaries[index], end = boundaries[index + 1];
    const local = aligned ? valid.filter(cue => cue.start >= start - .001 && cue.end <= end + .001) : [];
    const complete = local.flatMap(cue => characters(cue.text)).join('') === characters(segment.text).join('');
    return { ...segment, start, duration: end - start, audioCues: complete ? local.map(cue => ({ ...cue, start: Math.max(0, cue.start - start), end: Math.min(end, cue.end) - start })) : [] };
  }) };
}
