export const tracks = [
  {id:'picture', name:'画面'},
  {id:'voice', name:'配音'},
  {id:'music', name:'音乐 / 音效'},
  {id:'subtitle', name:'字幕'},
];

export const timelineDuration = clips => clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);

export function normalizeTimeline(input) {
  if (!input || !Array.isArray(input.clips) || input.clips.length > 150) throw new Error('时间轴最多支持 150 个片段。');
  const ids = new Set();
  const clips = input.clips.map(clip => {
    if (!tracks.some(track => track.id === clip.track) || typeof clip.id !== 'string' || !clip.id || ids.has(clip.id)) {
      throw new Error('时间轴包含无效或重复的片段。');
    }
    ids.add(clip.id);
    const {start, duration} = clip;
    const sourceIn = clip.sourceIn ?? 0;
    if (![start,duration,sourceIn].every(Number.isFinite) || start < 0 || sourceIn < 0 || duration < .001 || start + duration > 2400.001) {
      throw new Error('片段起点和入点必须非负，成片最多 40 分钟。');
    }
    if (clip.track === 'subtitle') {
      const text = String(clip.text || '').replace(/[\u0000-\u0008\u000b-\u001f]/g,'').trim().replace(/\n\s*\n/g,'\n');
      if (!text || text.length > 500) throw new Error('每条字幕须填写 1–500 字。');
      return {id:clip.id, track:clip.track, start, duration, text};
    }
    if (typeof clip.path !== 'string' || !clip.path) throw new Error('片段缺少素材文件。');
    const volume = Number(clip.volume ?? 1);
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('音量须在 0–100% 之间。');
    return {id:clip.id,track:clip.track,start,duration,sourceIn,path:clip.path,volume};
  });
  for (const track of ['picture','subtitle']) {
    const ordered = clips.filter(clip => clip.track === track).sort((a,b)=>a.start-b.start);
    for (let i=1;i<ordered.length;i++) {
      if (ordered[i].start < ordered[i-1].start + ordered[i-1].duration - 0.001) {
        throw new Error(`${tracks.find(item=>item.id===track).name}轨中的片段不能重叠。`);
      }
    }
  }
  const fontSize = Number(input.fontSize ?? 30);
  if (!Number.isInteger(fontSize) || fontSize < 12 || fontSize > 72) throw new Error('字幕字号须在 12–72 之间。');
  return {ratio:['9:16','16:9','1:1'].includes(input.ratio)?input.ratio:'9:16',fontSize,clips,flattened:Boolean(input.flattened)};
}
