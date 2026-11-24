export const defaultBatchReplaceDraft = () => ({
  templatePath: '', titlesEnabled: true, titles: '', peopleEnabled: false, people: [],
  slots: [{name: '画中画', enabled: false, assets: []}], count: 10, resolution: '1K', outputCategory:''
});

const text = value => String(value || '').trim();

function cleanAssets(values) {
  const byPath = new Map();
  for (const entry of Array.isArray(values) ? values : []) {
    const path = text(typeof entry === 'string' ? entry : entry?.path);
    if (path && !byPath.has(path)) byPath.set(path, {path, tag: text(entry?.tag)});
  }
  return [...byPath.values()];
}

export function cleanBatchReplaceDraft(input = {}) {
  const base = defaultBatchReplaceDraft();
  return {
    templatePath: text(input.templatePath), titlesEnabled: input.titlesEnabled !== false,
    titles: String(input.titles ?? ''), peopleEnabled: Boolean(input.peopleEnabled), people: cleanAssets(input.people),
    slots: (Array.isArray(input.slots) ? input.slots : base.slots).map((s, i) => ({
      name: text(s?.name) || `配图位 ${i + 1}`, enabled: Boolean(s?.enabled), assets: cleanAssets(s?.assets)
    })),
    count: input.count ?? base.count, resolution: text(input.resolution) || base.resolution, outputCategory:text(input.outputCategory).normalize('NFKC').toUpperCase()
  };
}

export function batchReplacePaths(input) {
  const d = cleanBatchReplaceDraft(input);
  return [d.templatePath, ...d.people.map(a => a.path), ...d.slots.flatMap(s => s.assets.map(a => a.path))].filter(Boolean);
}

export function readCoverTitles(value) {
  const titles = new Map();
  for (const line of String(value).split(/\r?\n/)) {
    const raw = line.trim().replace(/^\s*\d{1,4}\s*[.．、)]\s*/, '').trim();
    if (!raw) continue;
    const remark = raw.match(/[（(]\s*配图\s*[:：]\s*([^()（）]*)\s*[)）]\s*$/);
    const title = (remark ? raw.slice(0, remark.index) : raw).trim();
    if (!title) throw new Error('有一行只填写了配图备注，请补上封面标题。');
    const note = remark?.[1]?.trim() || '';
    titles.set(JSON.stringify([title, note]), {title, note});
  }
  return [...titles.values()];
}

const keywords = [
  ['咨询','客咨','客资','询单','私信','消息'], ['流量','浏览','播放','曝光','阅读'],
  ['档期','排期','日历'], ['涨粉','粉丝'], ['收入','收益','营收'],
  ['界面','功能页']
];
const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/(?:放|配)?[一二两三四五六七八九十\d]+张/g,'')
  .replace(/(截图|配图|图片|画中画|真实)/g,'').replace(/[\s\p{P}\d]/gu,'');

function matchScore(note, label) {
  const a = normalize(note), b = normalize(label);
  if (!a || !b) return 0;
  const subjects = keywords.filter(group=>group.some(w=>a.includes(w)));
  if (subjects.length && !subjects.some(group=>group.some(w=>b.includes(w)))) return 0;
  if (b.includes(a)) return 100 + a.length;
  if (b.length >= 2 && a.includes(b)) return 60 + b.length;
  const subjectMatches = subjects.filter(group=>group.some(w=>b.includes(w))).length;
  if(!subjectMatches) return 0;
  return 4*subjectMatches + [['同城','本地'],['对比','前后']].filter(group=>
    group.some(w=>a.includes(w)) && group.some(w=>b.includes(w))).length;
}

export function matchingPictures(slots, note) {
  if (!note || !slots.length) return {pools:slots.map(s => s.assets),noteFallback:false};
  let matched = false;
  const pools = slots.map(slot => {
    const scored = slot.assets.map(asset => {
      // Explicit per-image labels override a convenient but broad slot name.
      const namedSubject = keywords.some(group=>group.some(w=>normalize(asset.filename).includes(w)));
      const score = asset.tag ? matchScore(note, asset.tag) :
        (namedSubject ? matchScore(note,asset.filename) : matchScore(note,asset.filename) || matchScore(note,slot.name));
      return {asset,score};
    });
    const top = Math.max(0, ...scored.map(s => s.score));
    if (!top) return slot.assets;
    matched = true;
    return scored.filter(s => s.score === top).map(s => s.asset);
  });
  return {pools,noteFallback:!matched};
}
