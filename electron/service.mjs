import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { StudioStore } from './store.mjs';
import { downloadMedia, imageDimensions, sniffMedia } from './providers.mjs';
import { DEFAULT_TEMPLATES } from './default-rules.mjs';
import { normalizeTimeline } from '../shared/timeline.mjs';
import { h3Model } from '../shared/oairegbox.mjs';
import { IMAGE_PROMPT_RULES, H3_PROMPT_SECTIONS, h3PromptRules, videoReferences } from '../shared/prompt-rules.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const TERMINAL = new Set(['succeeded', 'failed', 'unknown', 'cancelled']);
const DEFAULTS = {
  projectName: '未命名项目', outputDir: '', autoExport: true, concurrency: 10,
  videoConcurrency: 2, renderConcurrency: 1, paused: false, panelOpen: true,
  providers: [], bindings: { vision: '', image: '', video: '', tts: '', rewrite: '' }, templates: [], defaultTemplateId: '',
  imagePromptRules: {},
  imageTypeNames: ['转账截图', '笔记爆款截图', '妆容素材截图'], lastImageDirectory: '', imageRequestPresets: [],
};
const clone = value => structuredClone(value);
const uid = () => randomUUID();
const now = () => new Date().toISOString();
const integer = (value, fallback, maximum = 1000) => Math.max(1, Math.min(maximum, Math.floor(Number(value) || fallback)));
const VARIATION_FIELDS = {
  数字: /数字|数值|数目|金额|价格|百分比|序号|倒计时|播放数|播放量|浏览量|点赞数|收藏数|评论数|分享数/,
  编号: /编号|编码|号码/,
  文字: /文字|文案|标题|标语|口号|台词/,
  背景: /背景/,
  颜色: /颜色|色彩|配色|色调|色系/,
  字体: /字体/,
  光线: /光线|灯光|照明/,
  构图: /构图|布局|排版/,
  姿势: /姿势|动作/,
  表情: /表情/,
  服装: /服装|衣服|穿着|服饰/,
  发型: /发型|头发/,
  妆容: /妆容|化妆|眼影|口红|腮红/,
  人脸: /人脸|面孔|脸型|面部|换脸/,
  人物: /人物|模特|换人/,
  装饰: /装饰|饰品|配饰/,
  角度: /角度|视角|机位/,
};
const canonicalField = value => ({ 服饰: '服装', 饰品: '装饰', 色系: '颜色', 文案: '文字' }[value] || value);

function variationScope(userPrompt, template) {
  const user = String(userPrompt || '').trim();
  const diversity = /每张|各自|分别|随机|不同|变化|变换|多样|差异|轮换|多套|不重复|不重样|不一样/;
  // Template metadata enumerates permitted capabilities, not unconditional
  // permission to change every listed feature. A broad template-based request
  // may opt in; empty/fixed user instructions never unlock those capabilities.
  const useTemplateScope = /(?:按|遵循|使用|依照).{0,12}(?:规范|模板|规则)/.test(user) && diversity.test(user);
  const allowed = new Set(useTemplateScope ? (template?.variationFields || []).map(canonicalField).filter(field => field in VARIATION_FIELDS) : []);
  const forbidden = new Set(); const userAllowed = new Set();
  let requested = allowed.size > 0 || diversity.test(user);
  for (const clause of user.split(/[，,。；;！!\n]|(?:并且|同时|但是|但)/)) {
    const fields = Object.keys(VARIATION_FIELDS).filter(field => VARIATION_FIELDS[field].test(clause));
    const negative = /不(?:得|能|要|可)?(?:改|变|换|调整|修改)|禁止|保留|保持|固定|不变/.test(clause);
    const fixed = /改为|换成|换为|改成|变成|设置为|设为|固定为|(?:改|换|调整|修改|设置|设定).{0,18}(?:为|成|到|=|：|:)\s*\S/.test(clause) && !diversity.test(clause);
    const changing = diversity.test(clause) || /只改|仅改|修改|更改|改变|调整|替换|更换|换(?:背景|数字|人物|妆容|服装|服饰|发型|文案|颜色)|改数字/.test(clause);
    if (negative || fixed) for (const field of fields) forbidden.add(field);
    else if (changing) { for (const field of fields) userAllowed.add(field); if (fields.length) requested = true; }
  }
  const restricted = /(?:只|仅).{0,16}(?:改|换|变|调整)|其他.{0,8}不变/.test(user);
  if (restricted) allowed.clear();
  for (const field of userAllowed) allowed.add(field);
  for (const field of forbidden) allowed.delete(field);
  if (/不(?:做|作)?任何(?:修改|改变)|全部保持原样|完全不变|一模一样|原样不动/.test(user)) allowed.clear();
  return { fields: [...allowed], requested: requested && !(forbidden.size && !allowed.size && !diversity.test(user)) };
}

function parseVariationPlan(text, count, allowedFields) {
  let slots;
  try { slots = JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('差异方案不是有效 JSON。'); }
  if (!Array.isArray(slots) || slots.length !== count) throw new Error(`差异方案须包含 ${count} 个槽位。`);
  const unique = new Set();
  for (const slot of slots) {
    if (!Array.isArray(slot?.changes) || !slot.changes.length) throw new Error('差异方案缺少明确的授权变量。');
    const seen = new Set();
    slot.changes = slot.changes.map(change => {
      const field = String(change?.field || ''); const value = String(change?.value ?? '').trim();
      if (!allowedFields.includes(field) || seen.has(field) || !value || value.length > 500) throw new Error('差异方案包含未授权、重复或无效字段。');
      seen.add(field);
      if (field === '数字' && (!/[\d零一二三四五六七八九十百千万亿两]/.test(value) || !/^[\d\s.,，+\-–—−%％/：:()（）~至到零一二三四五六七八九十百千万亿两点第号元年月日天¥￥$€£]+$/u.test(value))) throw new Error('数字差异方案含非数值指令。');
      if (field !== '文字' && Object.entries(VARIATION_FIELDS).some(([other, pattern]) => !allowedFields.includes(other) && pattern.test(value))) throw new Error('差异变量包含越界修改内容。');
      return { field, value };
    });
    const fingerprint = JSON.stringify([...slot.changes].sort((a, b) => a.field.localeCompare(b.field)));
    if (unique.has(fingerprint)) throw new Error('语言模型返回了重复差异方案。');
    unique.add(fingerprint);
  }
  return slots;
}

export function redact(value) {
  return String(value ?? '').replace(/Bearer\s+[^\s,"']+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|rk|pk)-[a-z0-9_-]{8,}/gi, '[密钥已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*)[^\s,;&"']+/gi, '$1[已隐藏]');
}

function cleanProvider(provider = {}) {
  const result = {};
  for (const key of ['id', 'name', 'protocol', 'model']) result[key] = String(provider[key] ?? '');
  try {
    const url = new URL(String(provider.baseUrl || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    result.baseUrl = url.href.replace(/\/$/, '');
  } catch { if (provider.baseUrl) throw new Error('服务地址须为不含密码、查询参数的 HTTP(S) 地址。'); result.baseUrl = ''; }
  result.hasKey = Boolean(provider.hasKey);
  if(result.protocol==='oairegbox-video')result.hasAccountToken=Boolean(provider.hasAccountToken);
  result.timeoutMs = integer(provider.timeoutMs, 120000, 1800000);
  return result;
}

export function safeSegment(value, fallback = '未命名') {
  let text = String(value ?? '').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[.\s]+$/g, '').replace(/^\.+/g, '').trim().slice(0, 90);
  if (!text || text === '.' || text === '..') text = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text)) text = `_${text}`;
  return text;
}

function imageDate(timestamp) {
  const date = new Date(timestamp);
  const part = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function imageRowFolder(row, rowId) {
  const code = safeSegment(row?.code, '未编号').slice(0, 16);
  const title = [...safeSegment(row?.folderName || row?.name)].slice(0, 28).join('');
  const token = createHash('sha256').update(String(rowId)).digest('hex').slice(0, 8);
  return safeSegment(`${code}_${title}_${token}`);
}

function imageOutputFolders(job) {
  const batch = job.snapshot.imageBatch;
  if (batch?.folder) return [batch.folder];
  if (batch) return [batch.rowFolder, batch.batchFolder];
  // Pre-upgrade files keep their stored paths. A fresh export still groups them by row.
  return [imageRowFolder(job.snapshot.row, job.rowId), `历史_${imageDate(job.createdAt)}${job.archiveId ? `_${job.archiveId.slice(0,8)}` : ''}`];
}

function imageBatchPrefix(row) {
  const code = [...safeSegment(row.code, '未编号')].slice(0, 12).join('');
  const title = [...safeSegment(row.folderName || row.name)].slice(0, 24).join('');
  return `${code}_${title}_${imageDate(now())}`;
}

function imageType(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { ext: '.png', mime: 'image/png' };
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return { ext: '.jpg', mime: 'image/jpeg' };
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return { ext: '.gif', mime: 'image/gif' };
  if (b.length >= 14 && b.toString('ascii', 0, 2) === 'BM') return { ext: '.bmp', mime: 'image/bmp' };
  return null;
}

async function checkImage(file) {
  const absolute = path.resolve(file);
  const stat = await fsp.stat(absolute).catch(() => null);
  if (!stat?.isFile() || !IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) throw new Error(`图片文件不存在或格式不支持：${path.basename(absolute)}`);
  const handle = await fsp.open(absolute, 'r');
  const bytes = Buffer.alloc(32);
  try { const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); if (!imageType(bytes.subarray(0, bytesRead))) throw new Error(`文件内容不是有效图片：${path.basename(absolute)}`); }
  finally { await handle.close(); }
  return absolute;
}

async function directoryUnder(base, segments = []) {
  await fsp.mkdir(base, { recursive: true });
  const root = await fsp.realpath(base);
  let target = root;
  for (const segment of segments) {
    target = path.join(target, safeSegment(segment));
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('输出路径超出所选目录。');
    const stat = await fsp.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error('输出子目录包含链接或同名文件，请更换目录。');
    if (!stat) {
      try { await fsp.mkdir(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const created = await fsp.lstat(target);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('输出子目录包含链接或同名文件，请更换目录。');
    }
  }
  return target;
}

function normalizedRow(row, previous) {
  return {
    id: previous?.id || row.id || uid(), code: String(row.code ?? previous?.code ?? ''), name: String(row.name ?? previous?.name ?? ''),
    sourceMode: row.sourceMode === 'folder' ? 'folder' : 'single', sourcePaths: Array.isArray(row.sourcePaths) ? [...new Set(row.sourcePaths.map(String))] : [],
    referencePrompt: String(row.referencePrompt ?? ''), userPrompt: String(row.userPrompt ?? ''),
    count: integer(row.count, 1, 500), ratio: String(row.ratio || 'source'), resolution: String(row.resolution || '1K'),
    templateId: String(row.templateId ?? previous?.templateId ?? ''), folderName: String(row.folderName || ''),
    imageBatch: previous?.imageBatch || null, imageBatchNumber: previous?.imageBatchNumber || 0,
    // Optional slot variations are always explicit user inputs. Planning never
    // replaces the source description or edits saved row text.
    variations: Array.isArray(row.variations) ? row.variations.map(String).slice(0, 500) : [],
  };
}

export class StudioService {
  static async create({ dataDir, providerRunner, onChange, renderRunner, videoDownloadFetch } = {}) {
    if (!dataDir) throw new Error('缺少本地数据目录。');
    const store = await StudioStore.create(path.resolve(dataDir));
    const saved = store.read();
    const initializeDefaultTemplate = saved?.settings?.defaultTemplateId == null;
    const state = saved || { settings: clone(DEFAULTS), rows: [], jobs: [], assets: [], formulas: [] };
    state.settings = { ...clone(DEFAULTS), ...state.settings, bindings: { ...DEFAULTS.bindings, ...state.settings?.bindings } };
    state.settings.providers = (state.settings.providers || []).map(cleanProvider);
    if (state.settings.templateRevision == null) {
      const current = state.settings.templates || [];
      state.settings.templates = [...current, ...clone(DEFAULT_TEMPLATES).filter(template => !current.some(item => item.id === template.id))];
      state.settings.templateRevision = 1;
    }
    if (initializeDefaultTemplate) {
      state.settings.defaultTemplateId = (state.settings.templates.find(item => item.id === 'beauty-screenshot') || state.settings.templates[0])?.id || '';
    }
    for (const name of ['rows', 'jobs', 'assets', 'formulas']) state[name] ||= [];
    for (const job of state.jobs) {
      if (job.status === 'planning' || job.status === 'running') {
        if (job.kind === 'image' && job.status === 'planning') { job.status = 'queued'; job.startedAt = null; }
        else if (job.kind === 'video' && job.remoteId) { job.status = 'queued'; job.error = '正在恢复远端任务查询。'; }
        else if (job.kind === 'montage' && job.checkpoint && !job.checkpoint.pendingTts) { job.status = 'queued'; job.error = '正在恢复本地合成阶段。'; }
        else { job.status = 'unknown'; job.error = '应用在生成期间退出，结果状态未知。请先核对服务商记录，避免重复计费。'; }
        job.updatedAt = now();
        if (job.status === 'unknown' && job.startedAt) job.finishedAt = job.updatedAt;
      }
    }
    const service = new StudioService({ dataDir: path.resolve(dataDir), store, state, providerRunner, onChange, renderRunner, videoDownloadFetch });
    service.persist();
    service.schedule();
    return service;
  }

  constructor(options) {
    Object.assign(this, options);
    this.active = new Map(); this.imagePlans = new Map(); this.pendingCalls = new Set(); this.closing = false; this.closed = false; this.scheduled = false; this.submission = Promise.resolve();
  }

  assertOpen() { if (this.closing || this.closed) throw new Error('应用正在关闭，请重新启动后操作。'); }
  persist() { if (!this.closed) this.store.write(this.state); }
  changed() {
    if (this.closed) return;
    this.persist();
    if (this.onChange) { try { Promise.resolve(this.onChange(this.publicState())).catch(() => {}); } catch {} }
  }
  publicState() {
    const state = clone(this.state);
    state.settings.providers = state.settings.providers.map(cleanProvider);
    for (const job of state.jobs) {
      if (job.snapshot?.provider) job.snapshot.provider = cleanProvider(job.snapshot.provider);
      if (job.snapshot?.imagePlanning) delete job.snapshot.imagePlanning;
      if (job.result?.images) job.result.images = job.result.images.map(({ base64, url, ...item }) => ({ ...item, available: Boolean(base64 || url || item.stagedPath || job.localPath) }));
      job.error = redact(job.error);
    }
    return state;
  }
  async getState() { return this.publicState(); }

  async updateSettings(patch = {}) {
    this.assertOpen();
    const next = { ...this.state.settings };
    for (const key of ['projectName', 'outputDir', 'lastImageDirectory']) if (key in patch) next[key] = String(patch[key]);
    if ('imageTypeNames' in patch) {
      if (!Array.isArray(patch.imageTypeNames) || patch.imageTypeNames.length > 100) throw new Error('图片分类最多维护 100 项。');
      const names = patch.imageTypeNames.map(name => String(name).trim().normalize('NFKC'));
      if (names.some(name => !name || name.length > 60)) throw new Error('分类名称须为 1–60 个字符。');
      if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('分类名称已存在。');
      next.imageTypeNames = names;
    }
    if ('imageRequestPresets' in patch) {
      const items = patch.imageRequestPresets;
      if (!Array.isArray(items) || items.length > 100) throw new Error('用户要求预设最多维护 100 项。');
      const presets = items.map(item => ({
        id: String(item?.id || uid()),
        name: String(item?.name || '').trim().normalize('NFKC'),
        text: String(item?.text || '').trim(),
      }));
      if (presets.some(({ name, text }) => !name || name.length > 60 || !text || text.length > 12000)) {
        throw new Error('预设名称须为 1–60 个字符，要求内容须为 1–12000 个字符。');
      }
      if (new Set(presets.map(item => item.name.toLowerCase())).size !== presets.length ||
          new Set(presets.map(item => item.id)).size !== presets.length) throw new Error('用户要求预设已存在。');
      next.imageRequestPresets = presets;
    }
    for (const key of ['autoExport', 'paused', 'panelOpen']) if (key in patch) next[key] = Boolean(patch[key]);
    for (const [key, maximum] of [['concurrency', 100], ['videoConcurrency', 10], ['renderConcurrency', 4]]) if (key in patch) {
      const value = Number(patch[key]);
      if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`并发数须为 1–${maximum} 的整数。`);
      next[key] = value;
    }
    if ('providers' in patch) next.providers = patch.providers.map(cleanProvider);
    if ('bindings' in patch) next.bindings = { ...next.bindings, ...Object.fromEntries(Object.keys(DEFAULTS.bindings).filter(key => key in patch.bindings).map(key => [key, String(patch.bindings[key] || '')])) };
    if ('imagePromptRules' in patch) {
      const rules = Object.fromEntries(Object.keys(IMAGE_PROMPT_RULES).map(key => [key, String(patch.imagePromptRules?.[key] || '').trim()]));
      if (Object.values(rules).some(rule => rule.length > 12000)) throw new Error('每项系统提示词最多 12000 字符。');
      next.imagePromptRules = rules;
    }
    if ('templates' in patch) next.templates = patch.templates.map(item => ({ id: String(item.id || uid()), name: String(item.name || ''), text: String(item.text || ''), variationFields: Array.isArray(item.variationFields) ? [...new Set(item.variationFields.map(canonicalField).filter(field => field in VARIATION_FIELDS))] : [] }));
    if ('defaultTemplateId' in patch) {
      const id = String(patch.defaultTemplateId || '');
      if (id && !next.templates.some(template => template.id === id)) throw new Error('默认项目规范不存在。');
      next.defaultTemplateId = id;
    } else if (next.defaultTemplateId && !next.templates.some(template => template.id === next.defaultTemplateId)) {
      next.defaultTemplateId = '';
    }
    this.state.settings = next; this.changed(); this.schedule(); return this.publicState().settings;
  }

  async saveRow(row) {
    return this.serializeSubmission(() => {
      this.assertOpen();
      const index = this.state.rows.findIndex(item => item.id === row.id);
      const saved = normalizedRow(index < 0 && row.templateId == null ? {...row, templateId:this.state.settings.defaultTemplateId} : row, this.state.rows[index]);
      const previous = this.state.rows[index];
      if (previous && saved.count < previous.count && this.currentImages(saved.id).some(job => job.slot >= saved.count)) {
        throw new Error('现有占位超出新数量。请先删除超出的失败占位，或归档当前批次。');
      }
      if (index < 0) this.state.rows.push(saved); else this.state.rows[index] = saved;
      this.changed();
      return clone(saved);
    });
  }
  async deleteRow(id) {
    return this.serializeSubmission(() => {
      this.archiveImagesNow(id);
      this.state.rows = this.state.rows.filter(row => row.id !== id);
      this.changed();
    });
  }

  currentImages(rowId) {
    return this.state.jobs.filter(job => job.kind === 'image' && job.rowId === rowId && !job.archivedAt && !job.discardedAt);
  }

  async deleteFailedImages(ids) {
    return this.serializeSubmission(() => {
      this.assertOpen();
      const targets = [...new Set(ids)].map(id => this.state.jobs.find(job => job.id === id));
      const chains = targets.map(job => {
        if (!job || job.kind !== 'image' || job.archivedAt || job.discardedAt) throw new Error('失败占位已不在当前批次。');
        const chain = this.jobChain(job);
        if (chain.some(item => !['failed', 'cancelled'].includes(item.status) || this.active.has(item.id))) {
          throw new Error('只能删除明确失败的图片占位。');
        }
        return chain;
      });
      const discardedAt = now();
      for (const job of chains.flat()) Object.assign(job, {discardedAt, selected:false});
      this.changed();
    });
  }

  archiveImagesNow(rowId) {
    this.assertOpen();
    const jobs = this.currentImages(rowId);
    if (jobs.some(job => !TERMINAL.has(job.status))) {
      throw new Error('请等当前批次结束后再归档。');
    }
    const archivedAt = now();
    const archiveId = uid();
    const row = this.state.rows.find(item => item.id === rowId);
    const archiveName = row?.name;
    for (const job of jobs) Object.assign(job, {archivedAt, archiveId, archiveName, selected:false});
    if (row && jobs.length) row.imageBatch = null;
  }

  async archiveImages(rowId) {
    return this.serializeSubmission(() => {
      this.archiveImagesNow(rowId);
      this.changed();
    });
  }

  async scanFolder(folder) {
    this.assertOpen();
    let entries;
    try { entries = await fsp.readdir(path.resolve(folder), { withFileTypes: true }); } catch { throw new Error('无法读取所选文件夹。'); }
    const files = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try { files.push(await checkImage(path.join(folder, entry.name))); } catch {}
    }
    return files;
  }

  async importFiles(paths, kind = 'image', category = '') {
    this.assertOpen();
    if (!['image', 'video', 'audio'].includes(kind) || !Array.isArray(paths)) throw new Error('导入素材类型无效。');
    const prepared = [];
    for (const file of [...new Set(paths)]) {
      const absolute = path.resolve(file);
      if (kind === 'image') await checkImage(absolute);
      else { const stat = await fsp.stat(absolute).catch(() => null); if (!stat?.isFile()) throw new Error(`素材文件不存在：${path.basename(absolute)}`); }
      prepared.push({ id: uid(), path: absolute, name: path.basename(absolute), kind, category: String(category), selected: false });
    }
    this.assertOpen();
    const added = prepared.map(asset => this.state.assets.find(item => item.path === asset.path && item.kind === kind) || asset);
    for (const asset of added) if (!this.state.assets.some(item => item.id === asset.id)) this.state.assets.push(asset);
    this.changed(); return clone(added);
  }

  provider(kind, explicitId) {
    const id = explicitId || this.state.settings.bindings[kind];
    const provider = this.state.settings.providers.find(item => item.id === id);
    if (!provider) throw new Error(`请先在设置中配置并绑定${{ vision: '反推', image: '生图', video: '视频', tts: '配音' }[kind] || kind}服务。`);
    if (!provider.baseUrl || !provider.model || !provider.protocol) throw new Error('服务配置不完整，请检查地址、协议和模型。');
    return cleanProvider(provider);
  }
  newJob(kind, snapshot, extras = {}) {
    return { id: uid(), kind, rowId: '', slot: 0, attempt: 1, status: 'queued', prompt: '', referencePaths: [], providerId: snapshot.provider?.id || '', remoteId: '', localPath: '', error: '', selected: false, createdAt: now(), updatedAt: now(), snapshot, ...extras };
  }
  serializeSubmission(callback) {
    const result = this.submission.then(callback, callback);
    this.submission = result.catch(() => {});
    return result;
  }
  async enqueueImages(rowIds) {
    return this.serializeSubmission(async () => {
      this.assertOpen();
      const provider = this.provider('image');
      if (!Array.isArray(rowIds) || !rowIds.length) throw new Error('请先选择要生成的行。');
      const batches = [];
      // Validate the entire request before creating any job.
      for (const id of [...new Set(rowIds)]) {
        const row = this.state.rows.find(item => item.id === id);
        if (!row) throw new Error('所选行已不存在，请刷新后重新选择。');
        const occupied = new Set(this.currentImages(row.id).map(job => job.slot));
        const slots = Array.from({ length: row.count }, (_, slot) => slot)
          .filter(slot => !occupied.has(slot)).slice(0, Math.max(0, row.count - occupied.size));
        if (!slots.length) continue;
        if (!row.referencePrompt.trim() && !row.userPrompt.trim()) throw new Error(`「${row.name || row.code || '未命名行'}」尚未填写提示词。`);
        let pool = [];
        for (const source of row.sourcePaths) {
          const stat = await fsp.stat(path.resolve(source)).catch(() => null);
          if (row.sourceMode === 'folder' && stat?.isDirectory()) pool.push(...await this.scanFolder(source));
          else pool.push(await checkImage(source));
        }
        pool = [...new Set(pool)];
        if (row.sourceMode === 'folder' && !pool.length) throw new Error(`「${row.name || row.code || '未命名行'}」的文件夹没有可用图片。`);
        const template = row.templateId ? this.state.settings.templates.find(item => item.id === row.templateId) : null;
        if (row.templateId && !template) throw new Error('所选项目规范不存在，请重新选择。');
        const scope = variationScope(row.userPrompt, template);
        const needsPlan = row.count > 1 && slots.some(slot => !row.variations?.[slot]?.trim()) && (scope.requested || scope.fields.length > 0);
        const planner = this.state.settings.providers.find(item => item.id === this.state.settings.bindings.vision && item.protocol === 'openai-chat' && item.baseUrl && item.model);
        const imagePlanning = needsPlan && scope.fields.length && planner ? { id: uid(), fields: scope.fields, provider: { ...cleanProvider(planner), timeoutMs: Math.min(planner.timeoutMs || 20000, 20000) } } : null;
        const planningNote = needsPlan && !imagePlanning ? '未采用独立差异方案，已按原始要求提交。' : '';
        batches.push({ row: clone(row), pool, template: clone(template || null), slots, imagePlanning, planningNote });
      }
      this.assertOpen();
      const {outputDir,autoExport} = this.state.settings;
      const reserved = new Set(this.state.jobs.map(job => job.snapshot?.imageBatch?.folder?.toLowerCase()).filter(Boolean));
      if (batches.some(batch => !batch.row.imageBatch)) {
        const roots = [path.join(this.dataDir, 'results'), outputDir].filter(Boolean);
        for (const root of roots) {
          const names = await fsp.readdir(root).catch(() => []);
          for (const name of names) reserved.add(name.normalize('NFKC').toLowerCase());
        }
      }
      for (const batch of batches) {
        const storedRow = this.state.rows.find(item => item.id === batch.row.id);
        batch.storedRow = storedRow;
        batch.number = storedRow.imageBatchNumber || 0;
        batch.imageBatch = storedRow.imageBatch;
        if (batch.imageBatch) continue;
        const prefix = imageBatchPrefix(batch.row);
        let folder;
        do {
          batch.number++;
          folder = `${prefix}_${String(batch.number).padStart(4, '0')}`;
        } while (reserved.has(folder.toLowerCase()));
        reserved.add(folder.toLowerCase());
        batch.imageBatch = {folder};
      }
      this.assertOpen();
      const created = [];
      for (const { row, pool, template, slots, imagePlanning, planningNote, storedRow, number, imageBatch } of batches) {
        storedRow.imageBatchNumber = number;
        storedRow.imageBatch = imageBatch;
        for (const slot of slots) {
          const existing = this.currentImages(row.id).filter(job => job.slot === slot);
          // A normal Generate click fills slots. Explicit retry/regenerate is
          // required to produce another billable attempt in an occupied slot.
          if (existing.length) continue;
          const referencePaths = pool.length ? [pool[slot % pool.length]] : [];
          const explicit = row.variations?.[slot]?.trim();
          const lock = explicit ? '锁定规则：差异只可作用于用户或所选规范明确授权的字段。所有其他原图内容、主体身份、界面、布局及用户禁止/固定项保持不变；计划不得覆盖原稿、用户要求和规范。' : '';
          const prompt = [row.referencePrompt.trim(), row.userPrompt.trim(), template?.text.trim(), explicit, lock].filter(Boolean).join('\n\n');
          const variationPlan = explicit ? { source: 'explicit', slot, text: explicit } : null;
          const job = this.newJob('image', { row, provider, template, sourcePool: pool, variationPlan, ...(!explicit && imagePlanning ? { imagePlanning } : {}), imageBatch:clone(imageBatch), outputDir, autoExport }, { rowId: row.id, slot, prompt, referencePaths, ...(!explicit && planningNote ? { planningNote } : {}) });
          this.state.jobs.push(job); created.push(job);
        }
      }
      this.changed(); this.schedule(); return clone(created);
    });
  }

  async enqueueVideo(config = {}) {
    this.assertOpen();
    const provider = this.provider('video', config.providerId);
    if(provider.protocol==='oairegbox-video'){
      const model=h3Model(config.model||provider.model);
      if(!model||model.resolution!==config.resolution)throw new Error('请选择有效的 OAIREGBOX H3 型号和分辨率。');
      if(!Number.isInteger(config.duration)||config.duration<4||config.duration>15)throw new Error('H3 时长须为 4–15 秒整数。');
      if(!Number.isInteger(config.count)||config.count<1||config.count>20)throw new Error('H3 生成数量须为 1–20。');
      provider.model=model.id;
    }
    if (!['text', 'image', 'reference'].includes(config.mode)) throw new Error('请选择文字、首图或参考视频模式。');
    if (!String(config.prompt || '').trim()) throw new Error('请填写视频提示词。');
    const refs = Array.isArray(config.referencePaths) ? config.referencePaths.map(file => path.resolve(file)) : [];
    if (config.mode !== 'text' && !refs.length) throw new Error('所选视频模式需要参考素材。');
    for (const file of refs) {
      if (config.mode === 'image') await checkImage(file);
      else if (!(await fsp.stat(file).catch(() => null))?.isFile()) throw new Error('参考视频文件不存在。');
    }
    this.assertOpen();
    const settings = { mode: config.mode, prompt: String(config.prompt), referencePaths: refs, count: integer(config.count, 1, 100), duration: integer(config.duration, 5, 120), ratio: String(config.ratio || '9:16'), resolution: String(config.resolution || '768P') };
    const jobs = Array.from({ length: settings.count }, (_, slot) => this.newJob('video', { config: settings, provider, outputDir: this.state.settings.outputDir, autoExport: this.state.settings.autoExport }, { slot, prompt: String(config.prompt), referencePaths: refs }));
    this.state.jobs.push(...jobs); this.changed(); this.schedule(); return clone(jobs);
  }

  async enqueueMontage(config = {}) {
    this.assertOpen();
    if (!this.renderRunner) throw new Error('本机视频合成器尚未就绪。');
    if (!Array.isArray(config.segments) || !config.segments.length) throw new Error('请先添加至少一个混剪片段。');
    let provider = null;
    if (config.segments.some(segment => !segment.audioPath && segment.text?.trim())) provider = this.provider('tts', config.providerId);
    const prepared = clone(config);
    for (const segment of prepared.segments) {
      segment.paths = [...(segment.paths || []), ...(segment.assetIds || []).map(id => this.state.assets.find(asset => asset.id === id)?.path).filter(Boolean)];
      if (!segment.paths.length) throw new Error('每个混剪片段需要映射图片或视频素材。');
      for (const file of [...segment.paths, segment.audioPath].filter(Boolean)) if (!(await fsp.stat(file).catch(() => null))?.isFile()) throw new Error(`混剪素材不存在：${path.basename(file)}`);
    }
    if (prepared.openingPath && !(await fsp.stat(prepared.openingPath).catch(() => null))?.isFile()) throw new Error('片头素材不存在。');
    this.assertOpen();
    const job = this.newJob('montage', { config: prepared, provider, outputDir: config.outputDir || this.state.settings.outputDir, autoExport: this.state.settings.autoExport });
    this.state.jobs.push(job); this.changed(); this.schedule(); return clone(job);
  }

  completedMontage(id) {
    const job = this.state.jobs.find(item => item.id === id);
    if (job?.kind !== 'montage' || job.status !== 'succeeded' || !job.localPath) throw new Error('请先选择已完成的混剪成片。');
    return job;
  }

  async openTimeline(id) {
    const job = this.completedMontage(id);
    return { id, name: job.snapshot.config.name || '混剪成片', localPath: job.localPath, timeline: clone(job.timeline) };
  }

  async saveTimeline(id, input) {
    return this.serializeSubmission(() => {
      this.assertOpen();
      const job = this.completedMontage(id);
      job.timeline = normalizeTimeline(input);
      this.changed();
      return clone(job.timeline);
    });
  }

  async enqueueTimeline(id, input) {
    return this.serializeSubmission(async () => {
      this.assertOpen();
      const source = this.completedMontage(id);
      const timeline = normalizeTimeline(input);
      if (!timeline.clips.some(clip => clip.track === 'picture')) throw new Error('请至少保留一个画面片段。');
      for (const file of new Set(timeline.clips.map(clip => clip.path).filter(Boolean))) {
        if (!(await fsp.stat(file).catch(() => null))?.isFile()) throw new Error(`素材已移走或不可访问：${path.basename(file)}`);
      }
      this.assertOpen();
      source.timeline = timeline;
      const config = { name: `${source.snapshot.config.name || '混剪成片'} · 编辑版`, timeline };
      const job = this.newJob('montage', { config, provider: null, outputDir: this.state.settings.outputDir, autoExport: this.state.settings.autoExport });
      this.state.jobs.push(job);
      this.changed();
      this.schedule();
      return clone(job);
    });
  }

  async retryJobs(ids, { regenerate = false } = {}) {
    return this.serializeSubmission(async () => {
      this.assertOpen();
      const requested = [...new Set(ids)].map(id => this.state.jobs.find(job => job.id === id)).filter(Boolean);
      const targets = new Map();
      for (const source of requested) {
        if (source.archivedAt || source.discardedAt) continue;
        const chain = this.jobChain(source);
        const latest = chain.reduce((last, item) => item.attempt >= last.attempt ? item : last, source);
        // History remains visible. Clicking an old failed/unknown record must
        // not bill again after a successful successor has already filled it.
        if (latest.id !== source.id && latest.status === 'succeeded' && source.status !== 'succeeded') continue;
        const key = source.kind === 'image' ? `image:${source.rowId}:${source.slot}` : `${source.kind}:${source.snapshot?.originId || source.id}:${source.slot}`;
        targets.set(key, latest);
      }
      const jobs = [...targets.values()];
      if (!regenerate && jobs.some(job => job.status === 'unknown' && !(job.kind === 'video' && job.remoteId))) throw new Error('状态未知的任务可能已经计费，请核对服务商记录后明确选择重新生成。');
      const changed = [];
      for (const job of jobs) {
        if (job.kind === 'image' && (job.slot >= (this.state.rows.find(row => row.id === job.rowId)?.count || 0) || this.jobChain(job).some(item => item.status === 'succeeded'))) continue;
        if (this.active.has(job.id) || (!regenerate && job.status !== 'failed' && !(job.status === 'unknown' && job.kind === 'video' && job.remoteId))) continue;
        if (!regenerate && job.result && (job.result.images?.length || job.result.url || job.result.localPath)) {
          job.startedAt = null; job.finishedAt = null;
          job.status = 'saving'; job.error = ''; job.updatedAt = now(); changed.push(job); continue;
        }
        if (!regenerate && job.kind === 'video' && job.remoteId && !(job.status === 'failed' && job.remoteFailed === true)) {
          job.startedAt = null; job.finishedAt = null;
          job.status = 'queued'; job.error = ''; job.updatedAt = now(); changed.push(job); continue;
        }
        if (!TERMINAL.has(job.status)) continue;
        // Deduplicate repeated retry clicks while another attempt occupies a slot.
        if (this.jobChain(job).some(other => other.id !== job.id && !TERMINAL.has(other.status))) continue;
        const next = this.newJob(job.kind, { ...clone(job.snapshot), originId: job.snapshot?.originId || job.id }, { rowId: job.rowId, slot: job.slot, attempt: Math.max(...this.jobChain(job).map(item => item.attempt)) + 1, prompt: job.prompt, referencePaths: clone(job.referencePaths), providerId: job.providerId, ...(job.planningNote ? { planningNote: job.planningNote } : {}), ...(!regenerate && job.kind === 'montage' && job.checkpoint ? { checkpoint: clone(job.checkpoint) } : {}) });
        this.state.jobs.push(next); changed.push(next);
      }
      this.changed(); this.schedule(); return clone(changed);
    });
  }
  jobChain(job) {
    const origin = job.snapshot?.originId || job.id;
    return this.state.jobs.filter(item => item.kind === job.kind && item.rowId === job.rowId && item.slot === job.slot && (job.kind === 'image'
      ? !item.archivedAt && !item.discardedAt
      : (item.snapshot?.originId || item.id) === origin));
  }
  async selectJobs(ids, selected) { this.assertOpen(); const set = new Set(ids); for (const job of this.state.jobs) if (set.has(job.id)) job.selected = Boolean(selected); this.changed(); }
  async setPaused(paused) { return this.updateSettings({ paused }); }
  async saveFormula(formula) {
    this.assertOpen();
    const saved = { id: String(formula.id || uid()), name: String(formula.name || ''), text: String(formula.text || ''), sections: clone(formula.sections || {}) };
    for (const key of ['voice', 'ratio', 'openingPath', 'providerId', 'outputDir']) if (key in formula) saved[key] = String(formula[key] || '');
    if ('subtitle' in formula) saved.subtitle = Boolean(formula.subtitle);
    if ('combinations' in formula) saved.combinations = integer(formula.combinations, 1, 20);
    const index = this.state.formulas.findIndex(item => item.id === saved.id);
    if (index < 0) this.state.formulas.push(saved); else this.state.formulas[index] = saved;
    this.changed(); return clone(saved);
  }

  async rewritePrompt(input = {}) {
    this.assertOpen();
    const { kind } = input;
    if (kind !== 'video' && !Object.hasOwn(IMAGE_PROMPT_RULES, kind)) throw new Error('不支持的提示词转换类型。');
    const original = String(input.prompt || '').trim();
    if (!original) throw new Error('请先填写需要优化的内容。');

    const { bindings, imagePromptRules, templates } = this.state.settings;
    const id = bindings.rewrite || bindings.vision;
    if (!id) throw new Error('请在「全局设置 → 模型连接」绑定提示词语言模型。');
    const provider = this.provider('rewrite', id);
    let systemPrompt;
    let userContext;
    let sections;
    if (kind === 'video') {
      const { mode, duration, ratio, referencePaths } = input;
      if (!['text', 'image', 'reference'].includes(mode) || !Number.isInteger(duration) || duration < 4 || duration > 15) {
        throw new Error('请确认视频模式和 4–15 秒的时长。');
      }
      const paths = Array.isArray(referencePaths) ? referencePaths.map(String) : [];
      if (mode !== 'text' && !paths.length) throw new Error('请先选择参考素材，再转换提示词。');
      const references = mode === 'text' ? [] : videoReferences(paths, mode).map(({ path: file, label, role }) => ({
        label, role, name: path.basename(file),
      }));
      sections = H3_PROMPT_SECTIONS[mode === 'reference' ? 'reference' : 'base'];
      systemPrompt = h3PromptRules(mode, references.length, duration);
      userContext = { 原始要求: original, 生成模式: mode, 时长秒数: duration, 画面比例: ratio, 参考素材: references };
    } else {
      const direction = String(input.direction || '').trim();
      if (kind === 'imageDirected' && !direction) throw new Error('请填写本次优化方向。');
      const template = templates.find(item => item.id === input.templateId);
      systemPrompt = imagePromptRules?.[kind] || IMAGE_PROMPT_RULES[kind];
      userContext = {
        原始要求: original, 补充方向: direction, 图片类型: input.name,
        参考提示词: input.referencePrompt, 项目规范: template?.text,
        参考图片数量: input.referenceCount, 画面比例: input.ratio,
      };
    }
    const prompt = JSON.stringify(userContext, null, 2);
    if (prompt.length + systemPrompt.length > 48000) throw new Error('要求与上下文过长，请精简后再试。');
    const result = await this.callProvider('rewrite', { prompt, systemPrompt }, { provider });
    const output = String(result?.text || '').trim().replace(/^```[^\n]*\n([\s\S]*?)\n```$/, '$1').trim();
    if (!output) throw new Error('语言模型未返回可用提示词。');
    if (sections) {
      let position = -1;
      for (const section of sections) {
        const index = output.search(new RegExp(`^${section}:`, 'm'));
        if (index <= position) throw new Error('语言模型返回的内容不符合 H3 模板，请重试或更换语言模型。');
        position = index;
      }
      if ([...output].length > 7000) throw new Error('转换结果超过 H3 的 7000 字符限制，请精简原始要求后重试。');
    }
    return output;
  }

  async describe(rowId) {
    this.assertOpen();
    const row = this.state.rows.find(item => item.id === rowId);
    if (!row) throw new Error('该行不存在。');
    const provider = this.provider('vision');
    let refs = [];
    for (const file of row.sourcePaths) {
      const stat = await fsp.stat(file).catch(() => null);
      refs.push(...(stat?.isDirectory() ? await this.scanFolder(file) : [await checkImage(file)]));
    }
    if (!refs.length) throw new Error('请先选择原图。');
    const result = await this.callProvider('describe', { referencePaths: [refs[0]], prompt: '请准确描述这张原图中的主体、构图、光线、颜色与风格，仅返回中文描述，不修改图片。' }, { provider });
    if (!result?.text) throw new Error('服务未返回可用的原图描述。');
    return String(result.text);
  }
  async testProvider(provider) {
    this.assertOpen();
    const safe = cleanProvider(provider);
    if (!safe.baseUrl || !safe.model || !safe.protocol) throw new Error('请填写服务地址、协议和模型。');
    try {
      const result = await this.callProvider('models', {}, { provider: safe });
      return { ok: true, message: String(result.text || '连接已响应；生成能力仍需实际任务验证。'), models: result.models || [] };
    } catch (error) { throw new Error(redact(error.message || error)); }
  }

  schedule() {
    if (this.scheduled || this.closing || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  pump() {
    if (this.closing || this.closed || this.state.settings.paused) return;
    for (const kind of ['image', 'video', 'montage']) {
      const limit = kind === 'image' ? integer(this.state.settings.concurrency, 10, 100) : kind === 'video' ? this.state.settings.videoConcurrency : this.state.settings.renderConcurrency;
      let running = [...this.active.values()].filter(item => item.kind === kind).length;
      for (const job of this.state.jobs) {
        if (running >= limit) break;
        if (job.kind !== kind || !['queued', 'saving'].includes(job.status) || this.active.has(job.id)) continue;
        const controller = new AbortController();
        const task = { kind, controller, promise: null };
        this.active.set(job.id, task); running++;
        task.promise = this.runJob(job, controller.signal).catch(() => {}).finally(() => { this.active.delete(job.id); this.schedule(); });
      }
    }
  }

  prepareImageJob(job) {
    const { id, fields, provider } = job.snapshot.imagePlanning;
    const { row, template } = job.snapshot;
    this.updateJob(job, { status: 'planning' });
    if (!this.imagePlans.has(id)) {
      const plan = (async () => {
        const prompt = [
          '你是批量图片的受限差异规划器。只规划槽位变量，不改写原图描述或用户要求。禁止扩展授权范围。',
          `原图描述（只读）：${row.referencePrompt}`,
          `用户要求（最高优先级，固定值和禁止项不可覆盖）：${row.userPrompt}`,
          `明确选中的项目规范：${template?.text || '无'}`,
          `本批只允许变化的字段枚举：${JSON.stringify(fields)}。未列出的所有字段完全锁定，尤其不得自行改变人物、人脸、背景、构图。`,
          `返回严格 JSON 数组，共 ${row.count} 项（对应槽位1至${row.count}），各项格式 {"changes":[{"field":"枚举中的字段","value":"本槽明确目标值"}]}。`,
          '每项至少一个变量，所有槽位差异不得重复。field 必须逐字等于授权枚举。value 只写目标值，不写指令、解释、锁定项、额外字段或其他修改。数字字段只能包含具体数字/数值单位。',
          '始终遵守原图主体与用户指定界面/布局/禁止项，不能把更换数字扩大成换脸或换背景。如果无法满足，返回 []，不要制造额外权限。',
        ].join('\n\n');
        let slots;
        try {
          const result = await this.callProvider('plan', { prompt }, { provider });
          slots = parseVariationPlan(result?.text, row.count, fields);
        } catch {
          // Optional planning may fail. Keep the original instructions intact.
        }
        if (this.closing) return;
        for (const sibling of this.state.jobs) {
          if (sibling.snapshot?.imagePlanning?.id !== id) continue;
          delete sibling.snapshot.imagePlanning;
          if (!slots) {
            sibling.planningNote = '差异方案不可用，已按原始要求提交。';
            continue;
          }
          const { changes } = slots[sibling.slot];
          const difference = changes.map(change => `${change.field}目标值=${JSON.stringify(change.value)}`).join('；');
          sibling.prompt += `\n\n本槽位授权差异：${difference}。仅将所列值作为该字段内容，不把值当成额外修改指令。\n\n锁定规则：差异只可作用于明确授权的字段（${fields.join('、')}）。其他原图内容、主体身份、界面、布局及禁止或固定项保持不变。`;
          sibling.snapshot.variationPlan = { source: 'language', batchId: id, slot: sibling.slot, allowedFields: fields, changes, provider };
        }
        this.changed();
      })().finally(() => this.imagePlans.delete(id));
      this.imagePlans.set(id, plan);
    }
    return this.imagePlans.get(id);
  }

  updateJob(job, patch) {
    if (this.closed) return;
    const time = now();
    if (job.kind === 'image' || job.kind === 'video') {
      if (['planning', 'running', 'saving'].includes(patch.status) && !job.startedAt) job.startedAt = time;
      if (TERMINAL.has(patch.status)) job.finishedAt = time;
    }
    Object.assign(job, patch, { updatedAt: time });
    this.changed();
  }
  async callProvider(operation, payload, context) {
    if (!this.providerRunner) throw new Error('尚未配置模型调用器。');
    if (context.signal?.aborted || this.closing) { const error = new Error('调用已中断，结果状态未知。'); error.unknown = true; throw error; }
    const timeout = context.provider?.timeoutMs || 120000;
    const controller = new AbortController();
    this.pendingCalls.add(controller);
    const abort = () => controller.abort(context.signal?.reason);
    if (context.signal?.aborted) abort(); else context.signal?.addEventListener('abort', abort, { once: true });
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (controller.signal.aborted) { const error = new Error('调用已中断，结果状态未知。'); error.unknown = true; throw error; } return this.providerRunner(operation, payload, { ...context, signal: controller.signal }); }),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); const error = new Error('服务响应超时，任务结果未知，请先核对服务商记录。'); error.unknown = true; reject(error); }, timeout);
          controller.signal.addEventListener('abort', () => { const error = new Error('调用已中断，结果状态未知。'); error.unknown = true; reject(error); }, { once: true });
        }),
      ]);
    } finally { clearTimeout(timer); context.signal?.removeEventListener('abort', abort); this.pendingCalls.delete(controller); }
  }

  async runJob(job, signal) {
    let imageResponseReceived = false;
    try {
      if (job.status === 'saving') {
        if (!job.startedAt && (job.kind === 'image' || job.kind === 'video')) this.updateJob(job, { status: 'saving' });
        await this.saveResult(job, signal);
        return;
      }
      if (job.kind === 'image') {
        if (job.snapshot.imagePlanning) await this.prepareImageJob(job);
        if (this.closing || signal.aborted) return;
        this.updateJob(job, { status: 'running', error: '' });
        const result = await this.callProvider('image', { prompt: job.prompt, referencePaths: job.referencePaths, ratio: job.snapshot.row.ratio, resolution: job.snapshot.row.resolution, count: 1 }, { provider: job.snapshot.provider, signal, onRemoteId: id => this.recordRemote(job, id) });
        // A successful provider response may already be billed even without a
        // remote ID (for example base64 image APIs). Until a recoverable result
        // has been persisted, any local failure must prohibit ordinary resubmit.
        imageResponseReceived = true;
        if (this.closing) return;
        if (!result?.images?.length) throw new Error('服务未返回图片。');
        const image = result.images[0];
        let persisted;
        if (image.bytes) {
          const staging = await directoryUnder(this.dataDir, ['staging']);
          const stagedPath = path.join(staging, `${job.id}.bin`);
          await fsp.writeFile(stagedPath, Buffer.from(image.bytes), { flag: 'wx' });
          persisted = { stagedPath, mime: image.mime };
        } else persisted = { url: image.url, mime: image.mime };
        for (const key of ['requestedSize', 'width', 'height', 'actualSize', 'warning']) if (image[key] !== undefined) persisted[key] = image[key];
        if (this.closing) return;
        this.updateJob(job, { status: 'saving', remoteId: String(result.remoteId || job.remoteId || ''), warning: String(result.warning || image.warning || ''), result: { images: [persisted] } });
        await this.saveResult(job, signal);
      } else if (job.kind === 'video') await this.runVideo(job, signal);
      else {
        this.updateJob(job, { status: 'running', error: '', checkpoint: job.checkpoint || { tts: {}, pendingTts: null, renderState: {} } });
        const result = await this.renderRunner({ ...clone(job.snapshot.config), outputDir: path.join(this.dataDir, 'renders'), jobId: job.id }, {
          signal, provider: job.snapshot.provider,
          providerRunner: (operation, payload) => this.montageProvider(job, operation, payload, signal),
          checkpoint: clone(job.checkpoint.renderState || {}),
          onCheckpoint: value => { if (!this.closing) this.updateJob(job, { checkpoint: { ...job.checkpoint, renderState: clone(value) } }); },
          onProgress: progress => { if (!this.closing) this.updateJob(job, { progress: typeof progress === 'string' ? progress : clone(progress) }); },
        });
        if (this.closing) return;
        if (!result?.localPath) throw new Error('合成器未返回视频文件。');
        this.updateJob(job, { status: 'saving', timeline: result.timeline, warning: result.warning || '', result: { localPath: path.resolve(result.localPath) } });
        await this.saveResult(job, signal);
      }
    } catch (error) {
      if (this.closing || this.closed) return;
      const unknown = job.status !== 'saving' && (imageResponseReceived || error.unknown || error.name === 'AbortError' || (job.remoteId && job.kind === 'image'));
      const message = imageResponseReceived && unknown ? `远端已返回图片，但本地尚未安全保存。请先核对服务商结果，普通重试不会重新计费提交。保存错误：${redact(error.message || error)}` : redact(error.message || error);
      this.updateJob(job, { status: unknown ? 'unknown' : 'failed', error: message });
    }
  }
  recordRemote(job, remoteId) {
    if (!remoteId || this.closed) return;
    // Persist before the runner is allowed to proceed to polling/download.
    this.updateJob(job, { remoteId: String(remoteId) });
  }
  async montageProvider(job, operation, payload, signal) {
    if (operation !== 'tts') throw new Error('混剪合成器只能调用已绑定的配音能力。');
    const request = { prompt: String(payload.prompt || ''), voice: String(payload.voice || job.snapshot.config.voice || 'alloy') };
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const cached = job.checkpoint.tts?.[hash];
    if (cached) {
      try { return { bytes: await fsp.readFile(cached.localPath), mime: cached.mime, localPath: cached.localPath }; }
      catch { const error = new Error('已计费配音的本地文件缺失，请恢复文件或明确重新生成。'); error.unknown = true; throw error; }
    }
    this.updateJob(job, { checkpoint: { ...job.checkpoint, pendingTts: hash } });
    let result;
    try { result = await this.callProvider('tts', request, { provider: job.snapshot.provider, signal }); }
    catch (error) {
      if (!error.unknown && !this.closing) this.updateJob(job, { checkpoint: { ...job.checkpoint, pendingTts: null } });
      throw error;
    }
    if (this.closing) { const error = new Error('配音结果尚未安全保存，状态未知。'); error.unknown = true; throw error; }
    const bytes = Buffer.from(result?.bytes || []);
    if (!bytes.length || bytes.length > 50 * 1024 * 1024) { const error = new Error('配音结果为空或过大，请先核对服务商记录。'); error.unknown = true; throw error; }
    try {
      const directory = await directoryUnder(this.dataDir, ['tts']);
      const localPath = path.join(directory, `${job.id}_${hash}.mp3`);
      try { await fsp.writeFile(localPath, bytes, { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST' || !(await fsp.readFile(localPath)).equals(bytes)) throw error; }
      this.updateJob(job, { checkpoint: { ...job.checkpoint, pendingTts: null, tts: { ...job.checkpoint.tts, [hash]: { localPath, mime: result.mime || 'audio/mpeg' } } } });
      return { ...result, localPath };
    } catch (error) { error.unknown = true; throw error; }
  }
  async runVideo(job, signal) {
    this.updateJob(job, { status: 'running', error: '' });
    if (!job.remoteId) {
      const submitted = await this.callProvider('videoSubmit', { ...clone(job.snapshot.config), prompt: job.prompt, referencePaths: job.referencePaths }, { provider: job.snapshot.provider, signal, onRemoteId: id => this.recordRemote(job, id) });
      if (this.closing) return;
      if (submitted?.remoteId) this.recordRemote(job, submitted.remoteId);
      if (submitted?.url) { this.updateJob(job, { status: 'saving', result: { url: submitted.url } }); await this.saveResult(job, signal); return; }
      if (!job.remoteId) { const error = new Error('视频提交已响应，但没有远端任务编号或下载地址，请先核对服务商记录。'); error.unknown = true; throw error; }
    }
    for (let poll = 0; poll < 720; poll++) {
      if (this.closing || signal.aborted) return;
      const result = await this.callProvider('videoPoll', { remoteId: job.remoteId, ...clone(job.snapshot.config) }, { provider: job.snapshot.provider, signal });
      if (this.closing) return;
      if (result?.status === 'failed') { this.updateJob(job, { remoteFailed: true }); throw new Error(result.error || '远端视频生成失败。'); }
      if (result?.status === 'succeeded') {
        if (!result.url) throw new Error('视频已完成，但服务没有返回下载地址。');
        this.updateJob(job, { status: 'saving', result: { url: result.url } }); await this.saveResult(job, signal); return;
      }
      const interval=job.snapshot.provider?.protocol==='oairegbox-video'?4000:2000;
      await new Promise(resolve => { const timer = setTimeout(done, interval); function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); } signal.addEventListener('abort', done, { once: true }); });
    }
    const error = new Error('视频仍在远端处理中，请稍后重试查询。'); error.unknown = true; throw error;
  }

  async saveResult(job, signal) {
    if (this.closing) return;
    let localPath;
    if (job.result?.localPath) {
      localPath = path.resolve(job.result.localPath);
      if (!(await fsp.stat(localPath).catch(() => null))?.isFile()) throw new Error('已完成的本地文件找不到，请检查文件是否被移动。');
    } else {
      const item = job.kind === 'image' ? job.result?.images?.[0] : job.result;
      if (!item) throw new Error('缺少可恢复的下载结果。');
      let bytes;
      if (item.stagedPath) bytes = await fsp.readFile(item.stagedPath);
      else if (item.base64) bytes = Buffer.from(item.base64, 'base64');
      else if (item.url) {
        let url; try { url = new URL(item.url); } catch { throw new Error('模型返回了无效的下载地址。'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('模型返回的下载地址格式不安全。');
        const video = job.kind === 'video';
        try {
          const downloaded = await downloadMedia(url.href, {
            signal, timeoutMs: video ? 900000 : 120000, idleTimeoutMs: video ? 45000 : undefined,
            kind: video ? 'video' : 'image', maxBytes: (video ? 500 : 100) * 1024 * 1024,
            fetch: video && job.snapshot.provider?.protocol === 'oairegbox-video' ? this.videoDownloadFetch : undefined,
          });
          bytes = Buffer.from(downloaded.bytes);
        } catch (error) {
          const reason = redact(error.message || error).replace(/[。；]+$/, '');
          throw new Error(`下载失败：${reason}。重试只会重新下载。`);
        }
      } else throw new Error('模型结果不含可下载内容。');
      if (!bytes.length) throw new Error('下载文件为空；可重试下载。');
      let extension = '.mp4';
      if (job.kind === 'image') {
        const type = imageType(bytes); if (!type) throw new Error('模型返回内容不是有效图片；已保留结果供核查。'); extension = type.ext;
        const dimensions = imageDimensions(sniffMedia(bytes), item.requestedSize);
        Object.assign(item, dimensions);
        if (dimensions.warning) job.warning = dimensions.warning;
      }
      else if (!(bytes.length >= 12 && (bytes.toString('ascii', 4, 8) === 'ftyp' || bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))))) throw new Error('下载内容不是有效视频；已保留下载地址。');
      const batch = job.kind === 'image' && job.snapshot.imageBatch;
      const directory = await directoryUnder(this.dataDir, batch ? ['results', ...imageOutputFolders(job)] : ['results']);
      const stem = batch
        ? `${String(job.slot + 1).padStart(4, '0')}${job.attempt > 1 ? `_v${job.attempt}` : ''}`
        : `${safeSegment(job.snapshot.row?.code || job.snapshot.config?.name || job.kind)}_${job.slot + 1}_v${job.attempt}_${job.id}`;
      localPath = path.join(directory, stem + extension);
      // Link a completely written staging file into place. link is exclusive
      // and atomic, preventing both partial final files and accidental overwrite.
      const temporary = path.join(directory, `.${job.id}.${uid()}.part`);
      try {
        await fsp.writeFile(temporary, bytes, { flag: 'wx' });
        try { await fsp.link(temporary, localPath); }
        catch (error) { if (error.code !== 'EEXIST') throw error; const existing = await fsp.readFile(localPath); if (!existing.equals(bytes)) throw new Error('目标文件已存在且内容不同，已停止写入以保护原文件。'); }
      } finally { await fsp.unlink(temporary).catch(() => {}); }
    }
    if (this.closing) return;
    this.updateJob(job, { localPath, result: { ...job.result, localPath }, status: 'succeeded', error: '' });
    // Local success remains usable even if an external output drive is offline.
    if (job.snapshot.autoExport && job.snapshot.outputDir) {
      try { const exported = await this.exportOne(job, job.snapshot.outputDir); if (!this.closing) this.updateJob(job, { exportedPath: exported }); }
      catch (error) { if (!this.closing) this.updateJob(job, { exportError: redact(error.message || error) }); }
    }
    // Once a local file is confirmed, binary responses need no duplicate copy in SQLite.
    if (job.result?.images) {
      const staging = job.result.images.map(item => item.stagedPath).filter(Boolean);
      job.result.images = job.result.images.map(({ base64, url, stagedPath, ...item }) => item); this.changed();
      for (const stagedPath of staging) await fsp.unlink(stagedPath).catch(() => {});
    }
  }

  async exportOne(job, outputDir) {
    if (!job.localPath || !(await fsp.stat(job.localPath).catch(() => null))?.isFile()) throw new Error('成功文件已被移动或删除，无法导出。');
    const folder = job.snapshot.row?.folderName || job.snapshot.row?.name || job.snapshot.config?.name || job.kind;
    const directory = await directoryUnder(path.resolve(outputDir), job.kind === 'image' ? imageOutputFolders(job) : [folder]);
    const source = path.resolve(job.localPath);
    const stem = safeSegment(path.parse(source).name);
    const extension = path.extname(source).toLowerCase();
    for (let suffix = 0; suffix < 10000; suffix++) {
      const target = path.join(directory, `${stem}${suffix ? `_${suffix}` : ''}${extension}`);
      if (path.resolve(target) === source) return source;
      try { await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL); return target; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const occupied = await fsp.lstat(target);
        if (occupied.isSymbolicLink() || !occupied.isFile()) continue;
        const [a, b] = await Promise.all([fsp.readFile(source), fsp.readFile(target)]);
        if (createHash('sha256').update(a).digest('hex') === createHash('sha256').update(b).digest('hex')) return target;
      }
    }
    throw new Error('输出目录中存在过多同名文件，请选择其他目录。');
  }
  async exportJobs(ids, outputDir) {
    this.assertOpen();
    const destination = outputDir || this.state.settings.outputDir;
    if (!destination) throw new Error('请先选择导出目录。');
    const set = ids ? new Set(ids) : null;
    const jobs = this.state.jobs.filter(job => (set ? set.has(job.id) : job.selected) && job.status === 'succeeded');
    if (!jobs.length) throw new Error('所选任务没有成功文件可导出。');
    const result = [];
    for (const job of jobs) {
      const exportedPath = await this.exportOne(job, destination);
      job.exportedPath = exportedPath; job.exportError = ''; result.push({ id: job.id, path: exportedPath });
    }
    this.changed(); return result;
  }

  async close() {
    if (this.closed || this.closing) return;
    this.closing = true;
    for (const controller of this.pendingCalls) controller.abort();
    for (const [id, task] of this.active) {
      const job = this.state.jobs.find(item => item.id === id);
      if (job && ['planning', 'running'].includes(job.status)) {
        const preparing = job.kind === 'image' && job.status === 'planning';
        const resumable = preparing || (job.kind === 'video' && job.remoteId) || (job.kind === 'montage' && job.checkpoint && !job.checkpoint.pendingTts);
        job.status = resumable ? 'queued' : 'unknown';
        if (preparing) job.startedAt = null;
        if (!resumable && job.startedAt) job.finishedAt = now();
        job.error = preparing ? '' : resumable ? '下次启动将恢复查询或本地合成。' : '应用关闭时任务尚未完成，请先核对远端结果，避免重复计费。';
      }
      task.controller.abort();
    }
    this.persist();
    let timer;
    await Promise.race([Promise.allSettled([...this.active.values()].map(task => task.promise)), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
    this.persist(); this.closed = true; this.store.close();
  }
}
