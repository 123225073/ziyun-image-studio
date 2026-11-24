export const emptyTemplateDraft = () => ({basePath: '', instruction: '', regions: []});

export function templateEditReferences(draft) {
  const combo = draft.combination;
  const originals = combo?.originalReferencePaths || [];
  const changedPrompt = Boolean(combo?.prompt.trim() && combo.prompt.trim() !== combo.entryPrompt.trim());
  const finished = combo?.kind === 'batch-result';
  const usePrompt = Boolean(originals.length && combo.prompt.trim() && (!finished || changedPrompt));
  const imageCount = originals.length + Number(!originals.includes(draft.basePath)) +
    Number(draft.regions.length > 0) + draft.regions.filter(area => area.referencePath).length;
  let mode = 'originals-and-base';
  if (imageCount > 16) {
    if (draft.regions.length) mode = 'regions-from-base';
    else if (usePrompt) mode = 'from-originals';
    else mode = 'from-base';
  }
  return {mode, usePrompt, changedPrompt, originals};
}

export function templateInputPaths(draft) {
  return [draft?.basePath,draft?.combination?.entryPath,...(Array.isArray(draft?.combination?.originalReferencePaths) ? draft.combination.originalReferencePaths : []),
    ...(Array.isArray(draft?.regions) ? draft.regions.map(region => region?.referencePath) : [])].filter(Boolean);
}

export function templateDraft(input = {}) {
  if (!Array.isArray(input.regions ?? []) || (input.regions?.length || 0) > 12) throw new Error('每次可圈选最多 12 个区域。');
  const seen = new Set();
  const regions = (input.regions || []).map(region => {
    if (!region || ![region.x, region.y, region.w, region.h].every(Number.isFinite) ||
        region.x < 0 || region.y < 0 || region.w <= 0 || region.h <= 0 ||
        region.x + region.w > 1.000001 || region.y + region.h > 1.000001) throw new Error('圈选位置超出底图，请重新圈选。');
    if (!region.id || seen.has(region.id)) throw new Error('圈选区域编号重复，请重新圈选。');
    seen.add(region.id);
    return {id: String(region.id), x: region.x, y: region.y, w: region.w, h: region.h,
      note: String(region.note || ''), referencePath: String(region.referencePath || '')};
  });
  const draft={basePath: String(input.basePath || ''), instruction: String(input.instruction || ''), regions};
  if(input.combination) {
    const combo=input.combination;
    if(typeof combo.id!=='string' || !combo.id || !Array.isArray(combo.originalReferencePaths) ||
      combo.originalReferencePaths.length>16 || combo.originalReferencePaths.some(file=>typeof file!=='string'||!file))
      throw new Error('组合素材无效，请从批量替换重新打开此组合。');
    draft.combination={id:combo.id,...(combo.kind==='batch-result'?{kind:combo.kind}:{}),entryPath:String(combo.entryPath || ''),entryPrompt:String(combo.entryPrompt || ''),
      prompt:String(combo.prompt ?? ''),originalReferencePaths:[...combo.originalReferencePaths]};
  }
  return draft;
}

export function pixelBounds(region, width, height) {
  return {
    left: Math.max(0, Math.floor(region.x * width)), top: Math.max(0, Math.floor(region.y * height)),
    right: Math.min(width, Math.ceil((region.x + region.w) * width)),
    bottom: Math.min(height, Math.ceil((region.y + region.h) * height)),
  };
}
