import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {sniffMedia} from './providers.mjs';
import {pixelBounds, templateDraft, templateEditReferences} from '../shared/template-edit.mjs';
import {jpegOrientation, orientPixels} from './template-orientation.mjs';

const require = createRequire(import.meta.url);
const imageCodec = () => require('electron').nativeImage;
const format = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'};
const maxInputBytes = 20 * 1024 * 1024;

// Keep the exact source that was submitted, including through a download retry
// after an external image has been moved or edited. Identical inputs share a file.
async function snapshotBytes(directory, bytes, extension) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const target = path.join(directory, digest + extension);
  try {
    const existing = await fs.readFile(target);
    if (!existing.equals(bytes)) throw new Error('保存的参考素材损坏，请核查本地项目数据。');
    return target;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(directory, randomUUID()+'.part');
  try {
    await fs.writeFile(temporary,bytes,{flag:'wx'});
    try {await fs.link(temporary,target);}
    catch(error) {
      if(error.code!=='EEXIST') throw error;
      if(!bytes.equals(await fs.readFile(target))) throw new Error('保存的参考素材与提交内容不一致。');
    }
  } finally {
    await fs.unlink(temporary).catch(()=>{});
  }
  return target;
}

async function snapshotInput(directory, file, checkImage, codec) {
  const checked = await checkImage(file);
  if ((await fs.stat(checked)).size > maxInputBytes) throw new Error('模板调试参考图每张最多 20 MB，请缩小后再试。');
  const bytes = await fs.readFile(checked);
  return snapshotStudioReference(directory,bytes,codec);
}

export async function snapshotStudioReference(directory,bytes,codec=imageCodec()) {
  if (bytes.length>maxInputBytes) throw new Error('参考图每张最多 20 MB，请缩小后再试。');
  const extension = format[sniffMedia(bytes)?.mime];
  if (!extension) throw new Error('参考图支持 PNG、JPEG 或 WebP 图片。');
  const image=await decode(codec,bytes);
  const size=image.getSize();
  const original=await snapshotBytes(directory,bytes,extension);
  if (jpegOrientation(bytes)===1) return {original,reference:original,size};
  // The provider derives its request ratio from the raw file header. Rotate
  // pixels before submitting so both the requested ratio and supplied image
  // use the same orientation the user saw on the canvas.
  const upright=image.toPNG();
  const compact=upright.length>maxInputBytes;
  const encoded=compact?image.toJPEG(95):upright;
  if (encoded.length>maxInputBytes) throw new Error('按拍摄方向校正后的图片超过 20 MB，请缩小后再试。');
  return {original,reference:await snapshotBytes(directory,encoded,compact?'.jpg':'.png'),size};
}

let webpDecoder;
async function decodeWebp(codec, bytes) {
  webpDecoder ||= (async () => {
    const {init, default:decode} = await import('@jsquash/webp/decode.js');
    const wasm = await fs.readFile(require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm'));
    await init(await WebAssembly.compile(wasm));
    return decode;
  })();
  const frame = await (await webpDecoder)(bytes);
  // Electron uses premultiplied BGRA for native bitmaps on Windows and macOS.
  const bgra = Buffer.allocUnsafe(frame.data.length);
  for (let i=0; i<bgra.length; i+=4) {
    const a=frame.data[i+3];
    bgra[i]=Math.round(frame.data[i+2]*a/255);
    bgra[i+1]=Math.round(frame.data[i+1]*a/255);
    bgra[i+2]=Math.round(frame.data[i]*a/255);
    bgra[i+3]=a;
  }
  return codec.createFromBitmap(bgra,{width:frame.width,height:frame.height});
}

async function decode(codec, bytes) {
  let image;
  try {
    const webp=bytes.length>=12 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
    image = webp ? await decodeWebp(codec,bytes) : codec.createFromBuffer(bytes);
  } catch {
    throw new Error('无法解码图片，文件可能损坏，请检查图片内容。');
  }
  const size = image.getSize();
  if (image.isEmpty() || !size.width || !size.height) throw new Error('无法解码图片，文件可能损坏，请检查图片内容。');
  const direction=jpegOrientation(bytes);
  if(direction===1) return image;
  const oriented=orientPixels(image.toBitmap(),size.width,size.height,direction);
  return codec.createFromBitmap(oriented.bitmap,{width:oriented.width,height:oriented.height});
}

export async function assertStudioImageDecodable(bytes, codec = imageCodec()) {
  return (await decode(codec, bytes)).getSize();
}

// The guide is a separate visual reference. Its dotted borders are never
// drawn onto the base used for compositing or shown as part of a finished image.
function regionGuide(codec, base, regions) {
  const {width, height} = base.getSize();
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const bitmap = base.resize({width: w, height: h}).toBitmap();
  const dot = (x, y) => {
    const value = (Math.floor((x + y) / 5) % 2) * 255;
    const offset = (y * w + x) * 4;
    bitmap.fill(value, offset, offset + 3);
    bitmap[offset + 3] = 255;
  };
  for (const region of regions) {
    const {left, top, right, bottom} = pixelBounds(region, w, h);
    for (let y = top; y < bottom; y++) {
      for (let i = 0; i < Math.min(3, right-left); i++) { dot(left+i, y); dot(right-1-i, y); }
    }
    for (let x = left; x < right; x++) {
      for (let i = 0; i < Math.min(3, bottom-top); i++) { dot(x, top+i); dot(x, bottom-1-i); }
    }
  }
  return codec.createFromBitmap(bitmap, {width: w, height: h}).toPNG();
}

export function saveTemplateDraft(service, input) {
  return service.serializeSubmission(() => {
    service.assertOpen();
    const draft = templateDraft(input);
    const key=draft.combination ? 'templateCombinationDraft' : 'templateDraft';
    if (JSON.stringify(service.state[key]) !== JSON.stringify(draft)) {
      service.state[key] = draft;
      service.changed();
    }
    return structuredClone(draft);
  });
}

export function enqueueTemplateEdit(service, input, checkImage, codec) {
  return service.serializeSubmission(async () => {
    service.assertOpen();
    if (typeof input?.requestId !== 'string' || !input.requestId || input.requestId.length > 100) throw new Error('调试请求编号无效，请重新提交。');
    const existing = service.state.jobs.find(item => item.snapshot?.templateEdit?.requestId === input.requestId);
    if (existing) return existing.id;
    const draft = templateDraft(input);
    if (!draft.basePath) throw new Error('请选择要调试的底图。');
    const ready = draft.regions.filter(item => item.note.trim() || item.referencePath);
    if (ready.length !== draft.regions.length) throw new Error('请为每个圈选区域填写要求或添加参考图，也可删除未使用的区域。');
    const plan = templateEditReferences(draft);
    const onlyBase = plan.mode === 'regions-from-base' || plan.mode === 'from-base';
    const originals = onlyBase ? [] : plan.originals;
    const combinationPrompt = plan.usePrompt && !onlyBase ? draft.combination.prompt.trim() : '';
    if (!ready.length && !draft.instruction.trim() && !combinationPrompt) throw new Error('请填写整图修改要求或圈选要修改的区域。');
    const provider = service.provider('image');
    const directory = path.join(service.dataDir, 'template-inputs');
    await fs.mkdir(directory, {recursive: true});
    const activeCodec = codec || imageCodec();
    const source = await snapshotInput(directory, draft.basePath, checkImage, activeCodec);
    const files=new Map([[draft.basePath,source]]);
    const references=[];
    for(const file of originals) {
      if(!files.has(file)) files.set(file,await snapshotInput(directory,file,checkImage,activeCodec));
      references.push(files.get(file).reference);
    }
    let baseIndex=references.indexOf(source.reference)+1;
    if(!baseIndex && plan.mode!=='from-originals'){references.push(source.reference);baseIndex=references.length;}
    const instructions = [];
    if (combinationPrompt) {
      instructions.push('下列组合要求中的图号与实际附图的前 '+originals.length+' 张逐一对应。');
      instructions.push('组合生成提示词：'+combinationPrompt);
    }
    instructions.push(plan.mode==='from-originals'?'按以上组合素材和最新要求重新生成一张独立成图。':`第 ${baseIndex} 张图是本次调试的底图。输出一张独立成图。`);
    if (ready.length) {
      const base = await decode(activeCodec, await fs.readFile(source.original));
      const guide = regionGuide(activeCodec, base, ready);
      references.push(await snapshotBytes(directory, guide, '.png'));
      instructions.push(`第 ${references.length} 张图是当前底图的区域定位图。虚线仅指示修改边界，不得出现在成图中。按底图的构图和比例逐区编辑，区域外保持原样。`);
      if (draft.instruction.trim()) instructions.push('适用于各选区的补充要求：' + draft.instruction.trim());
      for (const [index, item] of ready.entries()) {
        const coords = [item.x,item.y,item.w,item.h].map(value => (value*100).toFixed(2)+'%');
        const description = [`区域 ${index+1}（距左 ${coords[0]}、距上 ${coords[1]}、宽 ${coords[2]}、高 ${coords[3]}）`];
        if (item.referencePath) {
          const ref = await snapshotInput(directory, item.referencePath, checkImage, activeCodec);
          // Preserve separate role slots even when a user supplies the same file twice.
          references.push(ref.reference);
          description.push(`仅本区使用第 ${references.length} 张参考图。`);
        }
        if (item.note.trim()) description.push(item.note.trim());
        instructions.push(description.join(' '));
      }
    } else if(draft.instruction.trim()) instructions.push('本次修改意见：'+draft.instruction.trim());
    if(references.length>16) throw new Error('本次组合素材与选区参考图合计超过 16 张，请减少区域附件或组合素材后再生成。');
    service.assertOpen();
    const job = service.newJob('image', {
      feature: 'template-edit', templateEdit: {requestId: input.requestId, originalPath: draft.basePath, sourceSnapshot:source.original, editSize:source.size, regions: ready,
        ...(draft.combination?{combinationId:draft.combination.id,combinationPrompt:draft.combination.prompt}:{})},
      row: {name:'模板调试', code:'模板调试', count:1, ratio:'source', resolution:'2K'},
      outputDir:service.state.settings.templateOutputDir || '',autoExport:Boolean(service.state.settings.templateOutputDir), provider,
    }, {rowId: 'template-edit-'+randomUUID(), referencePaths:references, prompt:instructions.join('\n')});
    service.state[draft.combination?'templateCombinationDraft':'templateDraft'] = draft;
    service.state.jobs.push(job);
    service.changed();
    service.schedule();
    return job.id;
  });
}

export function mergeRegionPixels(original, generated, width, height, regions) {
  if (original.length !== width*height*4 || generated.length !== original.length) throw new Error('图片像素与原图大小不匹配，无法合并修改区域。');
  const merged = Buffer.from(original);
  for (const region of regions) {
    const {left, top, right, bottom} = pixelBounds(region, width, height);
    for (let y = top; y < bottom; y++) {
      const offset = (y*width+left)*4;
      generated.copy(merged, offset, offset, (y*width+right)*4);
    }
  }
  return merged;
}

export async function finishTemplateRegions(job, bytes, codec = imageCodec()) {
  const regions = job.snapshot.templateEdit.regions;
  const source = await decode(codec, await fs.readFile(job.snapshot.templateEdit.sourceSnapshot || job.referencePaths[0]));
  const {width,height} = source.getSize();
  const edited = (await decode(codec, bytes)).resize({width,height,quality:'best'});
  const merged = mergeRegionPixels(source.toBitmap(), edited.toBitmap(), width, height, regions);
  return codec.createFromBitmap(merged,{width,height}).toPNG();
}
