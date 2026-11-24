import path from 'node:path';
import {open,mkdir} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {sniffMedia} from './providers.mjs';
import {assertStudioImageDecodable,snapshotStudioReference} from './template-studio.mjs';
import {jpegOrientation} from './template-orientation.mjs';
import {findCoverLayout} from './cover-layout.mjs';
import {withCoverBoardRenderer} from './cover-board.mjs';
import {cleanBatchReplaceDraft, matchingPictures, readCoverTitles} from '../shared/batch-replace.mjs';
import {imageRowCategories, categoryOutputDirectory} from '../shared/image-rows.mjs';
export {batchReplacePaths} from '../shared/batch-replace.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const basename = file => path.basename(file);
const activeStates = new Set(['queued','planning','running','saving','unknown']);

async function loadImage(file) {
  if (!path.isAbsolute(file)) throw new Error('请从本机选择图片文件。');
  const handle = await open(file,'r').catch(() => {throw new Error(`找不到图片：${basename(file)}。请重新选择。`);});
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error(`参考图不是普通文件或超过 20 MB：${basename(file)}`);
    const bytes = await handle.readFile();
    if (!['image/png','image/jpeg','image/webp'].includes(sniffMedia(bytes).mime))
      throw new Error(`混批参考图支持 PNG、JPEG、WebP：${basename(file)}`);
    return bytes;
  } finally {await handle.close();}
}

async function identify(file,codec,directory) {
  const bytes = await loadImage(file);
  const id=digest(bytes);
  if(directory && jpegOrientation(bytes)!==1) {
    // 0.7 jobs store EXIF-corrected model inputs. Use the same image identity
    // when comparing a phone photo with those historic frozen references.
    await mkdir(directory,{recursive:true});
    const saved=await snapshotStudioReference(directory,bytes,codec);
    return {id,referenceId:path.parse(saved.reference).name};
  }
  await assertStudioImageDecodable(bytes,codec);
  return {id,referenceId:id};
}

async function freezeInputs(dataDir, spec, items,codec) {
  const directory=path.join(dataDir,'cover-inputs');
  await mkdir(directory,{recursive:true});
  const sources=new Map([[spec.draft.templatePath,spec.templateId]]);
  for(const item of items) for(const image of [item.person,...item.pictures]) if(image) sources.set(image.path,image.id);
  const immutable=new Map();
  for(const [file,id] of sources) {
    const bytes=await loadImage(file);
    if(digest(bytes)!==id) throw new Error(`候选图片“${basename(file)}”已变化，请重新预览。`);
    const saved=await snapshotStudioReference(directory,bytes,codec);
    immutable.set(file,saved.reference);
  }
  return immutable;
}

async function prepare(input,codec,dataDir,jobs) {
  const draft = cleanBatchReplaceDraft(input);
  const count = Number(draft.count);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('每批张数应为 1–100 的整数。');
  if (!['1K','2K','4K'].includes(draft.resolution)) throw new Error('请选择支持的分辨率。');
  if (!draft.templatePath) throw new Error('请先选定一张封面模板。');
  const titles = draft.titlesEnabled ? readCoverTitles(draft.titles) : [{title:'',note:''}];
  if (!titles.length) throw new Error('请按一行一条填写封面标题，或关闭标题替换。');
  const slots = draft.slots.map((s,position) => ({...s,position})).filter(s => s.enabled);
  if (!draft.titlesEnabled && !draft.peopleEnabled && !slots.length) throw new Error('请至少启用一种替换内容。');
  if (1 + Number(draft.peopleEnabled) + slots.length > 16) throw new Error('每张封面最多可使用 16 张参考图，请减少配图位置。');
  const ids = new Map();
  async function assets(values, role) {
    if (!values.length) throw new Error(`请给“${role}”添加候选图片，或关闭这个替换项。`);
    const result = new Map();
    for (const a of values) {
      if (!ids.has(a.path)) ids.set(a.path, await identify(a.path,codec,path.join(dataDir,'cover-inputs')));
      const {id,referenceId} = ids.get(a.path);
      const prior = result.get(id);
      if (prior) prior.tag += ' ' + a.tag;
      else result.set(id, {...a, id, referenceId, filename: path.parse(a.path).name});
    }
    return [...result.values()];
  }
  const {id:templateId} = await identify(draft.templatePath,codec);
  const people = draft.peopleEnabled ? await assets(draft.people,'人物') : [null];
  for (const slot of slots) slot.assets = await assets(slot.assets, slot.name);
  const oldSources=new Map();
  if(slots.length+Number(draft.peopleEnabled)===15) {
    for(const job of jobs) {
      const record=job.snapshot?.replacement;
      if(record?.templateId!==templateId || !legacyFull(record,job)) continue;
      const file=record.pictures.at(-1)?.path;
      if(!file || oldSources.has(file)) continue;
      // The original path is only a hypothesis. Even if it still exists,
      // the complete 0.7 key must authenticate the bytes before using them.
      const source=ids.get(file) || await identify(file,codec,path.join(dataDir,'cover-inputs')).catch(()=>null);
      oldSources.set(file,source);
    }
  }
  return {draft,titles,people,slots,templateId,count,oldSources};
}

// Mixed-radix traversal walks the available combinations lazily. The offset from
// earlier positions distributes faces and inserts while retaining a bijection.
function* titleCombinations(spec, title, offset) {
  const {pools:picturePools,noteFallback}=matchingPictures(spec.slots,title.note);
  const pools = [spec.people, ...picturePools];
  const total = pools.reduce((n,pool) => n * BigInt(pool.length),1n);
  for (let rank = 0n; rank < total; rank++) {
    let n = rank, shift = offset;
    const selected = pools.map(pool => {
      const radix = BigInt(pool.length), digit = Number(n % radix);
      n /= radix;
      const asset = pool[(digit + shift) % pool.length];
      shift += digit;
      return asset;
    });
    const [person, ...images] = selected;
    const pictures = images.map((asset,i) => ({...asset,position:spec.slots[i].position,name:spec.slots[i].name}));
    const key = digest(JSON.stringify([spec.templateId,title.title,person?.id || '',pictures.map(a=>[a.position,a.id])]));
    yield {key,contentKey:contentKey(spec.templateId,title.title,person?.referenceId,pictures.map(a=>a.referenceId)),...title,person,pictures,noteFallback};
  }
}

// Keep the original job key for 0.7 records. The second key is independent
// of disabled positions, labels, filenames and duplicate copies of the same asset.
function contentKey(templateId,title,personId,pictureIds) {
  return digest(JSON.stringify([templateId,title,personId || '',pictureIds]));
}

function historicalContentKey(job,record) {
  if(record.contentKey) return record.contentKey;
  const files=job.referencePaths?.slice(record.reviewId || record.roles ? 2 : 1);
  if(!files || !Array.isArray(record.pictures) || files.length!==Number(Boolean(record.person))+record.pictures.length) return '';
  const hashes=files.map(file=>path.parse(file).name);
  if(hashes.some(hash=>!/^[a-f0-9]{64}$/.test(hash))) return '';
  return contentKey(record.templateId,record.title,record.person ? hashes.shift() : '',hashes);
}

function legacyFull(record,job) {
  return !record.contentKey && job.referencePaths?.length===16 && record.pictures?.length+Number(Boolean(record.person))===15 &&
    Boolean(record.reviewId || record.roles);
}

function frozenPrefix(title,hasPerson,hashes) {
  return JSON.stringify([title,hasPerson,...hashes]);
}

// A 0.7 job with all 16 image inputs carries 14 original assets plus a
// full-size copy of the last asset inside the board. Its old SHA nevertheless
// authenticates all 15 *source files* and their original physical slot indexes.
const legacyPositions=new WeakMap();

function verifyLegacyFull(record,templateId,item,budget) {
  const ids=item.pictures.map(asset=>asset.id);
  const head=[templateId,item.title,item.person?.id || ''];
  const verify=positions=>positions?.length===ids.length && positions.every(Number.isInteger) &&
    digest(JSON.stringify([...head,ids.map((id,i)=>[positions[i],id])]))===record.key;
  if(verify(legacyPositions.get(record)) || verify(item.pictures.map(v=>v.position))) return true;
  const numbered=record.pictures.map(p=>Number(p.name?.match(/^(?:配图位|画中画)\s*(\d+)$/)?.[1])-1);
  if(verify(numbered)) return true;
  if(budget.remaining<=0) return false;
  const n=ids.length, plain=Array.from({length:n},(_,i)=>i);
  if(verify(plain)) return true;
  // Try the older physical layouts when a user added/removed disabled rows.
  // A different source at the old path never matches just because its name,
  // thumbnail or the other fourteen inputs are unchanged.
  for(let gap=1;gap<=16;gap++) for(let at=0;at<n;at++) {
    if(--budget.remaining<=0) return false;
    if(verify(plain.map(i=>i<at ? i : i+gap))) return true;
  }
  // Bounded exact recovery for scattered disabled positions. An exhausted
  // budget leaves the candidate unverified; it cannot be auto-submitted.
  const positions=Array(n);
  function search(at,next,remaining) {
    if(budget.remaining<=0) return false;
    if(at===n) return remaining===0 && --budget.remaining>=0 && verify(positions);
    for(let skipped=0;skipped<=remaining;skipped++) {
      positions[at]=next+skipped;
      if(search(at+1,next+skipped+1,remaining-skipped)) return true;
    }
    return false;
  }
  for(let extra=2;extra<=4;extra++) if(search(0,0,extra)) return true;
  return false;
}

function combinationStatus(history,templateId,item,verify=true,oldSources) {
  if(history.keys.has(item.key)) {
    const legacy=history.fullByKey.get(item.key);
    if(legacy) {legacy.contentKey=item.contentKey;history.keys.add(item.contentKey);}
    return 'used';
  }
  if(history.keys.has(item.contentKey)) return 'used';
  if(!history.full.size || item.pictures.length+Number(Boolean(item.person))!==15) return 'new';
  const assets=[item.person,...item.pictures].filter(Boolean);
  const hashes=item.referencePaths?.length===16 ? item.referencePaths.slice(2).map(file=>path.parse(file).name)
    : assets.slice(0,14).map(asset=>asset.referenceId || asset.id);
  const prefix=frozenPrefix(item.title,Boolean(item.person),hashes);
  const uncertain=[];
  for(const record of history.full.get(prefix) || []) {
    if(record.contentKey) continue;
    const oldLast=oldSources?.get(record.pictures.at(-1)?.path);
    if(verify && oldLast && oldLast.id!==item.pictures.at(-1).id) {
      const pictures=[...item.pictures.slice(0,-1),{...item.pictures.at(-1),...oldLast}];
      if(verifyLegacyFull(record,templateId,{...item,pictures},history.budget)) {
        const originalHashes=[...hashes,oldLast.referenceId],person=record.person ? originalHashes.shift() : '';
        record.contentKey=contentKey(templateId,item.title,person,originalHashes);
        history.keys.add(record.contentKey);
        if(record.contentKey===item.contentKey) return 'used';
        continue;
      }
    }
    if(verify && verifyLegacyFull(record,templateId,item,history.budget)) {
      record.contentKey=item.contentKey;history.keys.add(item.contentKey);
      return 'used';
    }
    uncertain.push(history.locations.get(record));
  }
  if(uncertain.length) {item.historyMatches=uncertain;return 'unverified';}
  delete item.historyMatches;return 'new';
}

function pendingHistoryItem(item) {
  return {key:item.key,title:item.title,person:item.person?.path || '',pictures:item.pictures.map(p=>({name:p.name,path:p.path})),history:item.historyMatches||[]};
}

function occupiedKeys(jobs,templateId) {
  const occupied=new Set(),full=new Map(),fullByKey=new Map(),locations=new Map();
  for(const job of jobs) {
    const record=job.snapshot?.replacement;
    if(record?.templateId!==templateId) continue;
    if(!occupiesCombination(job)) continue;
    occupied.add(record.key);
    const stable=historicalContentKey(job,record);
    if(stable) occupied.add(stable);
    else if(legacyFull(record,job)) {
      const prefix=frozenPrefix(record.title,Boolean(record.person),job.referencePaths.slice(2).map(file=>path.parse(file).name));
      if(!full.has(prefix)) full.set(prefix,[]);
      full.get(prefix).push(record);
      fullByKey.set(record.key,record);locations.set(record,{batchId:job.rowId,slot:job.slot});
    }
  }
  return {keys:occupied,full,fullByKey,locations,budget:{remaining:30000}};
}

function occupiesCombination(job) {
  return activeStates.has(job.status) || job.status==='succeeded' || Boolean(job.localPath) ||
    (job.status==='failed' && Boolean(job.result?.images?.length));
}

function reviewToken(draft,items,layout,unverified=[]) {
  const parts=[draft,items.map(item=>[item.key,false])];
  if(layout) parts.push(layout);
  if(unverified.length) parts.push(unverified.map(v=>v.key));
  return digest(JSON.stringify(parts));
}

function plan(spec, jobs) {
  const occupied=occupiedKeys(jobs,spec.templateId), items=[], considered=new Set(), pending=[];
  let streams=spec.titles.map((title,i)=>titleCombinations(spec,title,i));
  while(streams.length && items.length<spec.count) {
    const nextRound=[];
    for(const stream of streams) {
      const step=stream.next();
      if(step.done) continue;
      nextRound.push(stream);
      const item=step.value;
      if(considered.has(item.contentKey)) continue;
      considered.add(item.contentKey);
      const status=combinationStatus(occupied,spec.templateId,item,true,spec.oldSources);
      if(status==='unverified') pending.push(item);
      if(status!=='new') continue;
      items.push({...item,repeated:false});
      if(items.length===spec.count) break;
    }
    streams=nextRound;
  }
  const unverified=[];
  for(const item of pending) {
    // A later candidate can prove the old SHA and release its distinct siblings.
    const status=combinationStatus(occupied,spec.templateId,item,false);
    if(status==='unverified') unverified.push(pendingHistoryItem(item));
    else if(status==='new' && items.length<spec.count) items.push({...item,repeated:false});
  }
  return {items,unverified,token:reviewToken(spec.draft,items,spec.layout,unverified),requested:spec.count,
    freshCount:items.length,availableCount:items.length,repeatCount:0,shortageCount:spec.count-items.length,uniqueOnly:true};
}

export function migrateCoverPreview(state) {
  const draftSlots=state.batchReplaceDraft?.slots;
  if(draftSlots) {
    const enabled=draftSlots.map((slot,i)=>({slot,i})).filter(({slot})=>slot.enabled);
    for(const job of state.jobs) {
      const record=job.snapshot?.replacement;
      if(!record || !legacyFull(record,job) || enabled.length!==record.pictures.length) continue;
      if(enabled.every(({slot},i)=>slot.assets?.some(asset=>(asset.path || asset)===record.pictures[i].path)))
        legacyPositions.set(record,enabled.map(({i})=>i));
    }
  }
  const review=state.batchReplacePreview;
  if(!review || (review.uniqueOnly && Array.isArray(review.unverified))) return;
  const seen=occupiedKeys(state.jobs,review.templateId);
  const items=[],unverified=[];
  for(const item of review.items) {
    item.contentKey ||= historicalContentKey(item,{...item,templateId:review.templateId,reviewId:review.id}) ||
      contentKey(review.templateId,item.title,item.person?.id,item.pictures.map(p=>p.id));
    if(item.repeated) continue;
    const status=combinationStatus(seen,review.templateId,item);
    if(status==='unverified') unverified.push(pendingHistoryItem(item));
    if(status!=='new') continue;
    seen.keys.add(item.key);seen.keys.add(item.contentKey);
    items.push(item);
  }
  Object.assign(review,{items,unverified,token:items.length===review.items.length && !unverified.length ? review.token : reviewToken(review.draft,items,undefined,unverified),uniqueOnly:true,freshCount:items.length,
    availableCount:items.length,repeatCount:0,shortageCount:Math.max(0,review.requested-items.length)});
}

function coverSources(spec, item, immutable) {
  return [{path:immutable.get(spec.draft.templatePath),label:'固定版式模板'},
    ...(item.person ? [{path:immutable.get(item.person.path),label:'替换人物',person:true}] : []),
    ...item.pictures.map((asset,index)=>({path:immutable.get(asset.path),label:`配图 ${index+1} · ${asset.name}`}))];
}

function coverPrompt(item,sources,layout) {
  const lines=[
    '先读图1这张固定模板：辨认主标题、副标题和角标各自的字号、断行、对齐与留白；定位主角的轮廓、朝向和遮挡关系，分清人物与独立嵌图；逐一识别嵌图的位置、边框、裁切和叠压次序。此解读只用于作图。输出一张可直接发布的中文封面。',
    '图1决定成品画幅和版式。沿用底色、字型、字重、描边、装饰与元素的相对位置。只替换本组合指定的区域，保留其他人物、文字和图形。',
    ...(layout ? ['此模板已识别的布局如下，请结合图1核对文字层级、人物和配图边界：\n'+layout] : []),
    '图2是本张封面的组合参考图，标明素材用途。若其中已有局部修订，把该修订应用到图1的对应位置，其余版式沿用图1。不要把素材板的白底、边框、标签、拼接网格或额外示例印在成品上。',
    item.title ? `封面文案：${JSON.stringify(item.title)}。逐字使用，按原模板标题的主次安排断行和字级，保留模板中未被替换的标签。禁止自行编写副标题或宣传语。文字清晰，避开人脸和重要截图内容。` : '保留模板中的全部文案。'
  ];
  if(item.pictures.length>1) lines.push('逐一对应多个嵌图位置。名称中写明方位、设备或用途时，按该特征定位；名称相同或只给编号时，按图1从上到下、同一行从左到右的顺序对应配图1、配图2。每份素材只进入指定位置。');
  sources.slice(1).forEach((source,index)=>{
    const ref=index < 14 ? `图${index+3}` : '图2底部的原始尺寸附图';
    lines.push(source.person ? `${ref}用于替换人物，保留五官、肤色、妆发和辨识度，只替换图1主角轮廓内的主体，匹配人物在模板中的大小、方向、遮挡与光照，保留旁人和截图里的人像。`
      : `${ref}用于模板的“${source.label}”配图位，只更新该位置边框或设备屏幕以内的画面，不与其他嵌图位互换。不挪动模板原有外框、遮挡和背景。保留宽高比、截图的字样、数值和界面，不虚构、不拉伸裁掉关键信息。`);
  });
  if(item.note && item.pictures.length && !item.noteFallback) lines.push('配图备注（仅用于安排已有素材）：'+item.note+'。不要在封面印出备注或补画素材中不存在的信息。');
  return lines.join('\n');
}

async function createReview(service,spec,selection) {
  const immutable=await freezeInputs(service.dataDir,spec,selection.items,service.imageCodec);
  const id=randomUUID(), items=[];
  const directory=path.join(service.dataDir,'cover-inputs');
  const boards=new Map();
  if(selection.items.length) await withCoverBoardRenderer(service,async render=>{
    for(const [index,item] of selection.items.entries()) {
      const sources=coverSources(spec,item,immutable);
      if(!boards.has(item.key)) {
        const bytes=await render(item.title,sources);
        boards.set(item.key,(await snapshotStudioReference(directory,bytes,service.imageCodec)).reference);
      }
      const board=boards.get(item.key),prompt=coverPrompt(item,sources,spec.layout);
      const referencePaths=[sources[0].path,board,...sources.slice(1,15).map(v=>v.path)];
      items.push({...item,slotId:String(index),id:id+':'+index,prompt,defaultPrompt:prompt,boardPath:board,
        referencePaths,roles:[sources[0].label,'组合素材参考',...sources.slice(1,15).map(v=>v.label)]});
    }
  });
  return {...selection,id,requestId:id,draft:spec.draft,templateId:spec.templateId,items};
}

export function batchReviewPaths(state) {
  return [...(state.batchReplacePreview?.items||[]).flatMap(item=>item.referencePaths||[]),
    ...state.jobs.map(job=>job.snapshot?.replacement?.revision?.path).filter(Boolean)];
}

function checkReviewJobs(review,jobs) {
  const seen=occupiedKeys(jobs,review.templateId);
  if(!review.uniqueOnly || review.items.some(item=>item.repeated || combinationStatus(seen,review.templateId,item)!=='new'))
    throw new Error('组合使用记录已变化，请重新预览。');
}

function checkedPrompt(value) {
  if(typeof value!=='string' || value.length>30000) throw new Error('每张封面的提示词限 30000 字。');
  return value;
}

function existingBatch(jobs, requestId) {
  const originals = jobs.filter(job=>job.attempt===1 && job.snapshot?.replacement?.requestId===requestId);
  if (!originals.length) return null;
  return {batchId:originals[0].rowId,jobIds:originals.map(j=>j.id),reusedCount:originals.filter(j=>j.snapshot.replacement.repeated).length};
}

export const batchReplaceMethods = {
  async saveBatchReplaceDraft(input) {
    this.assertOpen();
    this.state.batchReplaceDraft = cleanBatchReplaceDraft(input);
    this.changed();
    return this.state.batchReplaceDraft;
  },
  async previewBatchReplace(input,{requireCurrentDraft=false}={}) {
    this.assertOpen();
    const submitted=JSON.stringify(cleanBatchReplaceDraft(input));
    const stillCurrent=()=>!requireCurrentDraft || submitted===JSON.stringify(this.state.batchReplaceDraft);
    return this.serializeSubmission(async()=>{
      if(!stillCurrent())return null;
      const spec=await prepare(input,this.imageCodec,this.dataDir,this.state.jobs);
      if(!stillCurrent())return null;
      spec.layout=findCoverLayout(this.state,spec.templateId);
      const selection=plan(spec,this.state.jobs);
      if(this.state.batchReplacePreview?.token===selection.token) return this.state.batchReplacePreview;
      const review=await createReview(this,spec,selection);
      this.assertOpen();
      if(!stillCurrent())return null;
      this.state.batchReplacePreview=review;
      if(!requireCurrentDraft)this.state.batchReplaceDraft=spec.draft;
      this.changed();
      return review;
    });
  },
  async saveBatchPreviewPrompt(id,prompt) {
    return this.serializeSubmission(()=>{
      this.assertOpen();
      const item=this.state.batchReplacePreview?.items.find(v=>v.id===id);
      if(!item) throw new Error('这张组合已过期，请重新预览。');
      item.prompt=checkedPrompt(prompt);this.changed();
      return true;
    });
  },
  async applyBatchEdit({id,path:file,prompt}) {
    return this.serializeSubmission(async()=>{
      this.assertOpen();
      const item=this.state.batchReplacePreview?.items.find(v=>v.id===id);
      const job=this.state.jobs.find(v=>v.snapshot?.feature==='batch-replace' && v.status==='succeeded' && 'result:'+v.id===id);
      if(!item && !job) throw new Error('未找到原组合或成品，请返回当前批次核对。');
      checkedPrompt(prompt);
      if(job) {
        const current=job.snapshot.replacement.revision;
        const currentFile=current?.path || job.localPath, currentPrompt=current?.prompt ?? job.prompt;
        if(file===currentFile && prompt===currentPrompt) return null;
        const generated=this.state.jobs.some(candidate=>candidate.status==='succeeded' && candidate.localPath===file &&
          candidate.snapshot?.templateEdit?.combinationId===id && candidate.snapshot.templateEdit.combinationPrompt===prompt);
        if(!generated) throw new Error('请在 02 使用当前提示词生成本张修订图，再从结果中应用。');
      }
      const directory=path.join(this.dataDir,'cover-inputs');
      await mkdir(directory,{recursive:true});
      const {reference}=await snapshotStudioReference(directory,await loadImage(file),this.imageCodec);
      this.assertOpen();
      if(item){item.boardPath=reference;item.referencePaths[1]=reference;item.prompt=prompt;}
      else job.snapshot.replacement.revision={path:reference,prompt};
      this.changed();
      return item ? this.state.batchReplacePreview : null;
    });
  },
  async exportBatchRevision(id,directory) {
    this.assertOpen();
    const job=this.state.jobs.find(v=>v.id===id && v.snapshot?.feature==='batch-replace');
    const revision=job?.snapshot.replacement.revision;
    if(!revision || !path.isAbsolute(directory)) throw new Error('请选择修订成品和导出目录。');
    const saved=await this.exportOne({...job,localPath:revision.path},directory,{mode:'direct'});
    revision.exportedPath=saved;this.changed();return saved;
  },
  async enqueueBatchReplace(input, options={}) {
    return this.serializeSubmission(async () => {
      this.assertOpen();
      const {mode='fresh',requestId,token} = options;
      if (typeof requestId!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw new Error('缺少有效批次编号，请重新预览。');
      const existing = existingBatch(this.state.jobs,requestId);
      if (existing) return existing;
      const draft=cleanBatchReplaceDraft(input);
      const assertCurrentDraft=()=>{
        if(options.requireCurrentDraft && JSON.stringify(draft)!==JSON.stringify(this.state.batchReplaceDraft))
          throw new Error('批量配置已更改，请核对当前模板后重新预览。');
      };
      assertCurrentDraft();
      let preview=this.state.batchReplacePreview;
      const sameDraft=preview && JSON.stringify(preview.draft)===JSON.stringify(draft);
      if(token && (!sameDraft || token!==preview.token)) throw new Error('候选素材或组合使用记录已变化，请重新预览。');
      if(token || sameDraft) checkReviewJobs(preview,this.state.jobs);
      else {
        const prepared=await prepare(input,this.imageCodec,this.dataDir,this.state.jobs);
        prepared.layout=findCoverLayout(this.state,prepared.templateId);
        preview=await createReview(this,prepared,plan(prepared,this.state.jobs));
      }
      const spec={draft,count:Number(draft.count),templateId:preview.templateId};
      if (!['fresh','remaining'].includes(mode)) throw new Error('新批次只生成未使用的组合，请重新预览。');
      const items = preview.items;
      if (!items.length) throw new Error(preview.unverified?.length ? '当前组合的旧版历史待核对，未提交生成。' : '当前没有可提交的组合，请增加候选或等待正在生成的任务完成。');
      const provider = this.provider('image');
      const batchId = 'replace-' + randomUUID();
      const imageBatch = {folder:`封面混批_${new Date().toISOString().slice(0,10)}_${batchId.slice(-12)}`};
      const row = {id:batchId,name:'封面混批',code:'混批',ratio:'source',count:items.length,resolution:spec.draft.resolution};
      const settings = this.state.settings;
      const outputCategory = spec.draft.outputCategory;
      if (outputCategory && !settings.imageCategoryDirectories?.[outputCategory] && !imageRowCategories(this.state.rows).includes(outputCategory)) throw new Error('当前没有这个分类的任务或目录，请重新选择输出位置。');
      const outputDir = outputCategory ? categoryOutputDirectory(outputCategory, settings) : '';
      const autoExport = Boolean(outputDir && settings.autoExport);
      if(items.some(item=>!item.prompt.trim())) throw new Error('请为每个待生成组合填写完整提示词。');
      const jobs = items.map((item,slot)=>{
        const replacement = {requestId,templateId:spec.templateId,outputCategory,key:item.key,contentKey:item.contentKey,title:item.title,note:item.note,
          person:item.person?.path || '', pictures:item.pictures.map(a=>({name:a.name,path:a.path})),repeated:item.repeated};
        replacement.reviewId=preview.id; replacement.slotId=item.slotId; replacement.roles=item.roles;
        return this.newJob('image',{feature:'batch-replace',row,imageBatch,provider,replacement,outputDir,autoExport},
          {rowId:batchId,slot,prompt:item.prompt,referencePaths:[...item.referencePaths]});
      });
      this.assertOpen();
      assertCurrentDraft();
      if(!options.requireCurrentDraft)this.state.batchReplaceDraft = spec.draft;
      this.state.batchReplacePreview=null;
      this.state.jobs.push(...jobs);
      this.changed(); this.schedule();
      return {batchId,jobIds:jobs.map(j=>j.id),reusedCount:0};
    });
  }
};

export function assertReplacementRetry(jobs,job) {
  const record=job.snapshot?.replacement;
  if(!record) return;
  // A retry may complete a slot from a previously confirmed 0.7 batch. It
  // still cannot reserve a combination another batch already produced.
  const siblings=jobs.filter(other=>other.rowId!==job.rowId);
  const occupied=occupiedKeys(siblings,record.templateId);
  const targetKey=historicalContentKey(job,record);
  if(occupied.keys.has(record.key) || occupied.keys.has(targetKey))
    throw new Error('这个组合已在其他槽位生成或排队，请查看对应批次。');
  if(job.referencePaths?.length!==16 || record.pictures.length+Number(Boolean(record.person))!==15) return;
  const refs=job.referencePaths.slice(2);
  for(const other of siblings) {
    const candidate=other.snapshot?.replacement;
    if(!occupiesCombination(other) || candidate?.templateId!==record.templateId || candidate.title!==record.title ||
      Boolean(candidate.person)!==Boolean(record.person) || candidate.pictures.length!==record.pictures.length ||
      other.referencePaths?.length!==16 || (targetKey && historicalContentKey(other,candidate))) continue;
    if(refs.every((file,i)=>path.parse(file).name===path.parse(other.referencePaths[i+2]).name))
      throw new Error('旧版满额组合的历史待核对，无法确认最后一张素材是否已经生成，本次未提交重试。');
  }
}
