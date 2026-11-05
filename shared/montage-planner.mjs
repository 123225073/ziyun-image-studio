const IMAGE = /\.(png|jpe?g|webp|bmp)$/i;
const round = value => Math.round(value * 1000) / 1000;

function words(text) {
  const value = String(text || '').toLowerCase().replace(/这个|这样|我们|可以|产品|能够|使用|一个|它的|就是|非常|进行|相关|这里|自己|东西|一些|时候/g, ' ');
  const result = new Set(value.match(/[a-z0-9]+(?:[-.][a-z0-9]+)*/g) || []);
  for (const run of value.match(/[\p{Script=Han}]+/gu) || []) {
    if (run.length === 1) result.add(run);
    for (let size = 2; size <= Math.min(4, run.length); size++) {
      for (let i = 0; i <= run.length - size; i++) result.add(run.slice(i, i + size));
    }
  }
  return result;
}

function overlap(query, text) {
  const tokens = words(text);
  let score = 0;
  for (const token of query) if (tokens.has(token)) score += token.length > 2 ? 2 : 1;
  return score;
}

function tieOrder(id, seed) {
  let hash = 2166136261;
  for (const char of `${seed}:${id}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function candidatesFor(segment, assets) {
  const paths = new Set(segment.paths || []);
  const ids = new Set(segment.assetIds || []);
  return assets.filter(asset => (!paths.size && !ids.size) || paths.has(asset.path) || ids.has(asset.id))
    .flatMap(asset => (asset.shots || []).map(shot => ({ ...shot, path: asset.path, assetId: asset.id, kind: asset.kind, name: asset.name, category: asset.category, productId: shot.productId || asset.productId || '', assetDuration: asset.duration })));
}

function rank(text, candidates, { productId, manualSelection = false, semanticIds } = {}) {
  const query = words(text);
  const preferred = new Map((semanticIds || []).map((id, index) => [id, index]));
  return candidates.filter(shot => (!productId || shot.productId === productId || shot.generic === true) && (semanticIds === undefined || manualSelection || preferred.has(shot.id))).map(shot => {
    const evidence = [shot.description, ...(shot.tags || [])].filter(Boolean).join(' ');
    const visualScore = overlap(query, evidence);
    const categoryScore = overlap(query, `${shot.name || ''} ${shot.category || ''}`);
    const score = visualScore * 4 + categoryScore;
    const semanticMatched = preferred.has(shot.id);
    const manualFallback = manualSelection && score === 0 && !semanticMatched;
    return { ...shot, semanticMatched, semanticOrder: preferred.get(shot.id), score: manualFallback ? 1 : score, reviewed: !manualFallback && Boolean(evidence) && ['visual', 'manual'].includes(shot.analysis), reason: semanticMatched ? `按句意推荐：${evidence.slice(0, 160) || '请预览确认实际画面。'}` : manualFallback ? '用户手选素材，请预览确认内容与旁白一致。' : evidence ? evidence.slice(0, 180) : '仅根据目录和文件名召回，需要确认实际画面。' };
  }).filter(shot => shot.semanticMatched || shot.score > 0).sort((a, b) => Number(b.semanticMatched) - Number(a.semanticMatched) || (a.semanticOrder ?? 0) - (b.semanticOrder ?? 0) || b.score - a.score || tieOrder(a.id, 0) - tieOrder(b.id, 0));
}

export function montageUtterances(segment, duration = Number(segment.duration)) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('请先读取配音实际时长。');
  const cues = segment.audioCues || segment.cues;
  if (Array.isArray(cues) && cues.length) {
    const valid = cues.filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start && cue.start >= 0 && cue.end <= duration + .1).sort((a, b) => a.start - b.start);
    if (valid.length) {
      const grouped = [];
      let current;
      for (const cue of valid) {
        if (!current) current = { text: '', start: cue.start, end: cue.end };
        current.text += cue.text || '';
        current.end = cue.end;
        if (/[。！？!?；;，,]$/.test(current.text) || current.end - current.start >= 5) {
          grouped.push(current);
          current = null;
        }
      }
      if (current) grouped.push(current);
      return grouped.map((unit, index) => ({ ...unit, start: index ? unit.start : 0, end: grouped[index + 1]?.start ?? duration }));
    }
  }
  const parts = String(segment.text || '').split(/(?<=[。！？!?；;，,])|\n/).map(text => text.trim()).filter(Boolean);
  const total = parts.reduce((sum, text) => sum + text.length, 0);
  let cursor = 0;
  return parts.map((text, index) => {
    const start = cursor;
    cursor = index === parts.length - 1 ? duration : cursor + duration * text.length / total;
    return { text, start, end: cursor };
  });
}

function validLockedShot(shot, candidates) {
  const original = candidates.find(candidate => candidate.id === shot.id && candidate.path === shot.path);
  if (!original || !Number.isFinite(shot.duration) || shot.duration <= 0 || !Number.isFinite(shot.sourceIn) || shot.sourceIn < original.sourceIn - .001) return false;
  return original.kind === 'image' || IMAGE.test(original.path) || shot.sourceIn + shot.duration <= original.sourceIn + original.duration + .001;
}

// The plan carries provenance and needsReview flags. Rendering uses only the
// resolved paths and time ranges, never model-invented file names.
export function planMontage(config, { assets = [] } = {}) {
  const missing = [];
  const warnings = [];
  const used = new Set();
  const segments = (config.segments || []).map((segment, index) => {
    const section = segment.section || String(index + 1);
    const duration = Number(segment.duration);
    if (!segment.duration) {
      missing.push({ section, text: segment.text, reason: '请先生成或导入配音，读取实际时长后再匹配镜头。' });
      return { ...segment, shots: [] };
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('混剪段落时长须为 0–600 秒。');
    const candidates = candidatesFor(segment, assets);
    const locked = (segment.shots || []).filter(shot => shot.locked);
    if (locked.length) {
      if (!locked.every(shot => validLockedShot(shot, candidates))) {
        missing.push({ section, text: segment.text, reason: '锁定镜头已失效或超出源素材范围，请重新选择。' });
        return { ...segment, duration, shots: [] };
      }
      const lockedDuration = locked.reduce((sum, shot) => sum + shot.duration, 0);
      if (Math.abs(lockedDuration - duration) < .05) return { ...segment, duration, shots: locked };
    }
    const shots = [];
    for (const [unitIndex, unit] of montageUtterances(segment, duration).entries()) {
      let remaining = unit.end - unit.start;
      const kept = locked.filter(shot => shot.text === unit.text || (!shot.text && unitIndex === 0));
      for (const shot of kept) {
        if (shot.duration > remaining + .02) {
          missing.push({ section, text: unit.text, reason: '锁定镜头长于当前配音范围，请调整镜头或解锁后重新匹配。' });
          remaining = 0;
          break;
        }
        shots.push(shot);
        used.add(shot.id);
        remaining -= shot.duration;
      }
      const manualSelection = Boolean(segment.paths?.length);
      const matches = Array.isArray(config.semanticMatches) ? config.semanticMatches.filter(match => String(match.section) === String(section)) : null;
      const semantic = matches?.find(match => match.text === unit.text) || matches?.find(match => match.text === segment.text);
      const semanticIds = matches ? Array.isArray(semantic?.shotIds) ? semantic.shotIds : [] : undefined;
      const ranked = rank(unit.text, candidates, { productId: segment.productId || config.productId, manualSelection, semanticIds });
      while (remaining > .02) {
        const fresh = ranked.filter(shot => !used.has(shot.id));
        const available = fresh.length ? fresh : manualSelection ? ranked.filter(shot => shot.kind === 'image') : [];
        const fitting = available.filter(shot => shot.kind === 'image' || shot.duration >= Math.min(remaining, .5));
        const quality = fitting.filter(shot => fitting[0]?.semanticMatched ? shot.semanticMatched : shot.score >= (fitting[0]?.score || 0) * .6);
        const candidate = quality.length ? quality[Math.abs(Math.floor(Number(config.seed) || 0)) % quality.length] : null;
        if (!candidate) {
          missing.push({ section, text: unit.text, reason: ranked.length ? '相关镜头的可用时长不足，请补充素材或手工选择。' : '没有找到能支持这句话的素材，请补充描述或选择镜头。' });
          break;
        }
        const useDuration = Math.min(remaining, candidate.kind === 'image' ? remaining : candidate.duration, fitting.length > 1 ? 5 : remaining);
        used.add(candidate.id);
        shots.push({ id: candidate.id, assetId: candidate.assetId, path: candidate.path, thumbnailPath: candidate.thumbnailPath, sourceIn: candidate.sourceIn, duration: round(useDuration), text: unit.text, description: candidate.description, reason: candidate.reason, needsReview: !candidate.reviewed || candidate.speaking === true, speaking: candidate.speaking === true, locked: false });
        remaining -= useDuration;
      }
    }
    if (shots.some(shot => shot.needsReview && !shot.speaking)) warnings.push(`${section}段含仅按文件名或目录匹配的画面，请预览确认。`);
    if (shots.some(shot => shot.speaking)) warnings.push(`${section}段包含人物说话画面，请确认静音后配旁白是否合适；该步骤没有重做口型。`);
    return { ...segment, duration, shots, paths: segment.paths || [] };
  });
  const signature = JSON.stringify(segments.map(segment => ({ text: segment.text, shots: segment.shots.map(shot => [shot.id, shot.path, shot.sourceIn, shot.duration]) })));
  return { segments, missing, warnings: [...new Set(warnings)], seed: config.seed || 0, signature };
}
