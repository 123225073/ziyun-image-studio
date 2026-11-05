// Selection offsets use the same UTF-16 indices as textarea.selectionStart/End.
// A quote is evidence for that exact occurrence, never a search-and-replace key.
const speechCharacters = value => String(value || '').replace(/[\s\p{P}\p{S}]/gu, '');
const splitSurrogate = (text, offset) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);

export function normalizeMontageBindings(text, input = [], { allowPending = false } = {}) {
  if (!Array.isArray(input) || input.length > 100) throw new Error('每条文案最多绑定 100 个文字范围。');
  const ids = new Set();
  const result = input.map(binding => {
    if (!binding || typeof binding.id !== 'string' || !binding.id || binding.id.length > 120 || ids.has(binding.id)) throw new Error('文字绑定编号无效或重复，请重新绑定。');
    ids.add(binding.id);
    if (typeof binding.folderPath !== 'string' || !binding.folderPath || binding.folderPath.length > 4096) throw new Error('请选择文字范围对应的素材子文件夹。');
    const base = { id: binding.id, folderPath: binding.folderPath, folderLabel: String(binding.folderLabel || '').slice(0, 300) };
    if (binding.materialEvidence) {
      const files = binding.materialEvidence.files;
      if (!Array.isArray(files) || !files.length || files.some(file => typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.fingerprint))) throw new Error('素材内容复核记录无效，请重新确认绑定。');
      base.materialEvidence = { files: files.map(file => ({ path: file.path, fingerprint: file.fingerprint })), checkedAt: String(binding.materialEvidence.checkedAt || '') };
    }
    if (binding.status === 'needs-review') {
      if (!allowPending) throw new Error('改写后的文字与素材目录还需确认，请重新选择对应文字范围。');
      return { ...base, start: 0, end: 0, quote: '', status: 'needs-review', previousQuote: String(binding.previousQuote || binding.quote || '').slice(0, 16000), reason: String(binding.reason || '文字已变化，请重新绑定。').slice(0, 2000) };
    }
    const { start, end, quote } = binding;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length || splitSurrogate(text, start) || splitSurrogate(text, end) || typeof quote !== 'string' || quote !== text.slice(start, end) || !speechCharacters(quote)) throw new Error('文字绑定范围与当前文案不一致，请重新选择文字，不能沿用旧位置。');
    return { ...base, start, end, quote, status: 'ready', ...(binding.reason ? { reason: String(binding.reason).slice(0, 2000) } : {}) };
  });
  const ready = result.filter(binding => binding.status === 'ready').sort((a, b) => a.start - b.start);
  if (ready.some((binding, index) => index && binding.start < ready[index - 1].end)) throw new Error('同一段文字不能重复绑定，请先删除重叠的范围。');
  return result.sort((a, b) => a.start - b.start);
}

export function candidateMontageBindings(section, index, raw, { strict = false } = {}) {
  const entry = section.candidateBindings?.[index];
  if (!entry || !entry.bindings?.length) return [];
  try {
    if (entry.textSnapshot !== raw) throw new Error('候选文案已修改，原文字范围需要重新绑定。');
    const bindings = normalizeMontageBindings(raw, entry.bindings);
    const prefix = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    return normalizeMontageBindings(trimmed, bindings.map(binding => {
      const start = Math.max(0, binding.start - prefix), end = Math.min(trimmed.length, binding.end - prefix);
      return { ...binding, start, end, quote: trimmed.slice(start, end) };
    }));
  } catch (error) {
    if (strict) throw error;
    return (Array.isArray(entry.bindings) ? entry.bindings : []).map(binding => ({ ...binding, start: 0, end: 0, quote: '', previousQuote: binding.quote || binding.previousQuote || '', status: 'needs-review', reason: error.message }));
  }
}

export function validateMontageCandidateBindings(setup) {
  for (const section of setup.sections || []) {
    if (setup.mode === 'master' || section.enabled === false || section.candidateBindings == null) continue;
    if (!Array.isArray(section.candidateBindings) || !Array.isArray(section.candidates) || section.candidateBindings.length > section.candidates.length) throw new Error('候选文案与文字绑定列表不一致。');
    section.candidateBindings.forEach((entry, index) => {
      if (entry != null && (typeof entry !== 'object' || !Array.isArray(entry.bindings))) throw new Error('候选文字绑定格式无效。');
      candidateMontageBindings(section, index, section.candidates[index], { strict: true });
    });
  }
  if (setup.mode === 'master' && setup.masterBindings?.length) normalizeMontageBindings(String(setup.masterText || '').trim(), setup.masterBindings);
}

export function montageBindingProblems(combo) {
  const problems = [];
  for (const segment of combo.segments || []) {
    try { normalizeMontageBindings(segment.text, segment.bindings || []); }
    catch (error) { problems.push({ section: segment.section, message: error.message }); }
  }
  return problems;
}

// These fragments describe pictures only. The complete narration is synthesized
// once, then alignSections maps the fragments onto its actual timestamps.
export function montageVisualFragments(segments, folders) {
  const lookup = new Map(folders.map(folder => [folder.path, folder]));
  return segments.flatMap(segment => {
    const bindings = normalizeMontageBindings(segment.text, segment.bindings || []);
    if (!bindings.length) return [{ ...segment }];
    const ranges = []; let cursor = 0;
    for (const binding of bindings) {
      if (binding.start > cursor) ranges.push({ start: cursor, end: binding.start });
      ranges.push(binding); cursor = binding.end;
    }
    if (cursor < segment.text.length) ranges.push({ start: cursor, end: segment.text.length });
    // Attach punctuation-only gaps to the adjoining visual range so a stop or
    // space cannot create a zero-length voice segment or require another asset.
    const units = [];
    for (const range of ranges) {
      if (!speechCharacters(segment.text.slice(range.start, range.end)) && units.length) units.at(-1).end = range.end;
      else units.push({ ...range });
    }
    if (units.length > 1 && !speechCharacters(segment.text.slice(units[0].start, units[0].end))) { units[1].start = 0; units.shift(); }
    return units.map((unit, index) => {
      const text = segment.text.slice(unit.start, unit.end);
      const base = { ...segment, section: `${segment.section}·${index + 1}`, sourceSection: segment.section, text, textStart: unit.start, textEnd: unit.end };
      delete base.bindings; delete base.shots; delete base.audioCues; delete base.audioPath;
      if (!unit.id) {
        if (!segment.paths?.length && !segment.assetIds?.length) throw new Error(`${segment.section} 段仍有未绑定素材的文字，请补充范围绑定或设置本段默认素材。`);
        return base;
      }
      const folder = lookup.get(unit.folderPath);
      if (!folder?.paths?.length) throw new Error('绑定目录没有可用图片，请重新扫描素材总目录。');
      return { ...base, bindingId: unit.id, folderPath: folder.path, selectionMode: 'folder-random', paths: [...folder.paths], assetIds: [] };
    });
  });
}
