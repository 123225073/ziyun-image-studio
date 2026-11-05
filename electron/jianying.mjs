import fs, { constants } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { normalizeTimeline, timelineDuration, tracks } from '../shared/timeline.mjs';
import { runMedia, toSrt } from './render.mjs';
const uuid = () => randomUUID().toUpperCase();
const micros = seconds => Math.round(seconds * 1000000);
const image = file => /\.(png|jpe?g|webp|gif|bmp)$/i.test(file);
const slash = file => file.replace(/\\/g, '/');
async function hash(file) { const digest = createHash('sha256'); for await (const part of createReadStream(file)) digest.update(part); return digest.digest('hex'); }

// Interoperable plain draft structure, following pyJianYingDraft and the local
// book studio exporter. No dependency on either application at runtime.
export function buildJianyingDraft(input, media, name = '子云混剪') {
  const timeline = normalizeTimeline(input);
  const [width, height] = timeline.ratio === '16:9' ? [1920, 1080] : timeline.ratio === '1:1' ? [1080, 1080] : [1080, 1920];
  const materials = Object.fromEntries('ai_translates audio_balances audio_effects audio_fades audio_track_indexes audios beats canvases chromas color_curves digital_humans drafts effects flowers green_screens handwrites hsl images log_color_wheels loudnesses manual_deformations masks material_animations material_colors multi_language_refs placeholders plugin_effects primary_color_wheels realtime_denoises shapes smart_crops smart_relights sound_channel_mappings speeds stickers tail_leaders text_templates texts time_marks transitions video_effects video_trackings videos vocal_beautifys vocal_separations'.split(' ').map(key => [key, []]));
  const platform = { app_id: 3704, app_source: 'lv', app_version: '5.9.0', os: 'windows' };
  const draft = { id: uuid(), name, version: 360000, new_version: '110.0.0', source: 'default', fps: 30, duration: micros(timelineDuration(timeline.clips)), canvas_config: { width, height, ratio: 'original' }, color_space: 0, create_time: Math.floor(Date.now()/1000), update_time: Math.floor(Date.now()/1000), path: '', platform, last_modified_platform: platform, config: { maintrack_adsorb: false, material_save_mode: 0, attachment_info: [], subtitle_taskinfo: [], lyrics_taskinfo: [], system_font_list: [], video_mute: false, subtitle_sync: true, lyrics_sync: true, multi_language_mode: 'none', multi_language_current: 'none', multi_language_main: 'none', multi_language_list: [], export_range: null }, materials, tracks: [], relationships: [], keyframe_graph_list: [], keyframes: Object.fromEntries('adjusts audios effects filters handwrites stickers texts videos'.split(' ').map(key => [key, []])), render_index_track_mode_on: false, free_render_index_mode_on: false, cover: null, extra_info: null, mutable_config: null, group_container: null, static_cover_image_path: '' };
  for (const track of tracks) {
    const lanes = [];
    for (const clip of timeline.clips.filter(item => item.track === track.id).sort((a,b) => a.start-b.start)) {
      const type = clip.track === 'picture' ? 'video' : clip.track === 'subtitle' ? 'text' : 'audio';
      const id = uuid();
      if (type === 'text') {
        const size = timeline.fontSize / 1080 * 100;
        const content = { text: clip.text, styles: [{ range: [0, clip.text.length], size, fill: { alpha: 1, content: { render_type: 'solid', solid: { alpha: 1, color: [1,1,1] } } }, strokes: [{ content: { solid: { alpha: 1, color: [.12,.12,.12] } }, width: 2/timeline.fontSize }] }] };
        materials.texts.push({ id, type: 'text', content: JSON.stringify(content), font_name: 'Microsoft YaHei', font_title: 'Microsoft YaHei', font_path: '', font_id: '', font_resource_id: '', font_source_platform: 0, font_size: size, alignment: 1, typesetting: 0, letter_spacing: 0, line_spacing: .02, line_feed: 1, line_max_width: .9, force_apply_line_max_width: false, check_flag: 15, text_color: '#ffffff', text_alpha: 1, global_alpha: 1, border_width: 2/timeline.fontSize, border_color: '#202020', border_alpha: 1, background_alpha: 0, background_style: 0, has_shadow: false, words: { start_time: [], end_time: [], text: [] } });
      } else {
        const file = media[clip.path];
        if (!file) throw new Error('时间线素材未准备完整。');
        const base = { id, local_material_id: uuid(), path: slash(file.path), duration: micros(file.duration || 10800) };
        if (type === 'audio') materials.audios.push({ ...base, type: 'extract_music', name: path.basename(clip.path), music_id: id, app_id: 0, category_id: '', category_name: 'local', check_flag: 3, copyright_limit_type: 'none', effect_id: '', formula_id: '', source_platform: 0, wave_points: [] });
        else materials.videos.push({ ...base, type: image(clip.path) ? 'photo' : 'video', material_id: id, material_name: path.basename(clip.path), width: file.width, height: file.height, media_path: '', crop: { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 }, crop_ratio: 'free', crop_scale: 1, category_id: '', category_name: 'local', check_flag: 63487, audio_fade: null, has_audio: false });
      }
      const speed = uuid(); materials.speeds.push({ id: speed, type: 'speed', mode: 0, speed: 1, curve_speed: null });
      const segment = { id: uuid(), material_id: id, target_timerange: { start: micros(clip.start), duration: micros(clip.start+clip.duration)-micros(clip.start) }, source_timerange: type === 'text' ? null : { start: micros(clip.sourceIn || 0), duration: micros(clip.duration) }, speed: 1, volume: type === 'video' ? 0 : clip.volume ?? 1, last_nonzero_volume: clip.volume || 1, visible: true, reverse: false, is_tone_modify: false, extra_material_refs: [speed], common_keyframes: [], keyframe_refs: [], enable_adjust: true, enable_color_curves: true, enable_color_wheels: true, enable_lut: true, track_attribute: 0, track_render_index: 0 };
      if (type !== 'audio') segment.clip = { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: type === 'text' ? -.8 : 0 } };
      if (type !== 'audio') segment.uniform_scale = { on: true, value: 1 };
      let lane = lanes.find(lane => lane.segments.every(other => other.target_timerange.start+other.target_timerange.duration <= segment.target_timerange.start));
      if (!lane) { lane = { id: uuid(), type, name: track.name + (lanes.length ? ` ${lanes.length+1}` : ''), attribute: 0, flag: 0, is_default_name: false, segments: [] }; lanes.push(lane); draft.tracks.push(lane); }
      lane.segments.push(segment);
    }
  }
  draft.tracks.forEach((track,index) => track.segments.forEach(segment => { segment.render_index = index; }));
  return draft;
}

export async function exportJianying(input, { root, name, ffmpeg }) {
  const timeline = normalizeTimeline(input);
  if (!timeline.clips.some(clip => clip.track === 'picture')) throw new Error('请至少添加一个画面片段。');
  if (!path.isAbsolute(root || '')) throw new Error('请选择剪映设置中显示的草稿根目录。');
  root = path.resolve(root);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('请选用真实文件夹作为草稿根目录。');
  for (const file of ['draft_content.json', 'draft_info.json', 'draft_meta_info.json']) if (await fs.stat(path.join(root, file)).catch(() => null)) throw new Error('选中的是单个作品文件夹，请选择存放多个作品的草稿根目录。');
  const media = {};
  for (const file of new Set(timeline.clips.map(clip => clip.path).filter(Boolean))) {
    if (!(await fs.stat(file)).isFile()) throw new Error(`素材不存在：${path.basename(file)}`);
    const { stderr } = await runMedia(ffmpeg, ['-hide_banner', '-i', file], { allowFailure: true });
    const size = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
    const time = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
    const duration = time ? +time[1]*3600 + +time[2]*60 + +time[3] : 0;
    const related = timeline.clips.filter(clip => clip.path === file);
    if (related.some(clip => ['voice','music'].includes(clip.track)) && !/Stream .*Audio:/.test(stderr)) throw new Error(`素材缺少音轨：${path.basename(file)}`);
    if (related.some(clip => clip.track === 'picture') && !size) throw new Error(`素材缺少画面：${path.basename(file)}`);
    if (!image(file) && (!duration || related.some(clip => clip.sourceIn+clip.duration > duration+.08))) throw new Error(`片段裁剪超出素材时长：${path.basename(file)}`);
    media[file] = { duration, width: +(size?.[1] || 0), height: +(size?.[2] || 0) };
  }
  const folder = `子云-${String(name || '混剪').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,40)}-${uuid().slice(0,8)}`;
  const directory = path.join(root, folder);
  await fs.mkdir(directory); await fs.mkdir(path.join(directory, 'materials'));
  const copied = [];
  try {
    for (const [source, item] of Object.entries(media)) {
      item.path = path.join(directory, 'materials', uuid() + path.extname(source));
      await fs.copyFile(source, item.path, constants.COPYFILE_EXCL);
      const sha256 = await hash(source);
      if (await hash(item.path) !== sha256) throw new Error('素材复制校验失败。');
      copied.push({ file: path.relative(directory,item.path), bytes: (await fs.stat(item.path)).size, sha256 });
    }
    const draft = buildJianyingDraft(timeline, media, folder); draft.path = slash(directory);
    const meta = { draft_id: draft.id, draft_name: folder, draft_fold_path: slash(directory), draft_root_path: slash(root), draft_cover: '', draft_is_invisible: false, draft_type: '', draft_new_version: draft.new_version, tm_duration: draft.duration, tm_draft_create: Date.now()*1000, tm_draft_modified: Date.now()*1000, tm_draft_removed: 0, draft_materials: [0,1,2,3,6,7,8].map(type => ({ type, value: [] })), draft_materials_copied_info: [], draft_segment_extra_info: [], draft_cloud_materials: [] };
    for (const file of ['draft_content.json','draft_info.json']) await fs.writeFile(path.join(directory,file), JSON.stringify(draft), { flag: 'wx' });
    await fs.writeFile(path.join(directory,'draft_meta_info.json'), JSON.stringify(meta), { flag: 'wx' });
    await fs.writeFile(path.join(directory,'captions.srt'), toSrt(timeline.clips.filter(clip => clip.track==='subtitle').map(clip => ({ text: clip.text, start: clip.start, end: clip.start+clip.duration }))), { flag: 'wx' });
    await fs.writeFile(path.join(directory,'ziyun-export.json'), JSON.stringify({ version: 1, draftId: draft.id, files: copied, status: 'written-not-app-verified' }, null, 2), { flag: 'wx' });
    return { directory, name: folder, tracks: draft.tracks.length };
  } catch (error) { throw new Error(`剪映草稿未完成：${directory}。${error.message}`); }
}
