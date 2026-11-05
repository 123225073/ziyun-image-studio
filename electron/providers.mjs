import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { h3Model, h3ReferenceError, oairegboxBase } from '../shared/oairegbox.mjs';
import { normalizeSpeechOptions, SPEECH_CATALOGS, TTS_PROTOCOLS } from '../shared/speech.mjs';
import { runSpeech } from './speech.mjs';

const MB = 1024 * 1024;
const MAX_JSON = 96 * MB;
const imageSizes = {
  '1:1': ['1024x1024', '2048x2048', '4096x4096'],
  '16:9': ['1536x864', '2048x1152', '3840x2160'],
  '9:16': ['864x1536', '1152x2048', '2160x3840'],
  '4:3': ['1344x1008', '2048x1536', '3264x2448'],
  '3:4': ['1008x1344', '1536x2048', '2448x3264'],
  '3:2': ['1536x1024', '2016x1344', '3504x2336'],
  '2:3': ['1024x1536', '1344x2016', '2336x3504'],
  '21:9': ['1568x672', '2016x864', '3696x1584'],
  '9:21': ['672x1568', '864x2016', '1584x3696'],
  '2:1': ['1536x768', '2048x1024', '3840x1920'],
  '1:2': ['768x1536', '1024x2048', '1920x3840'],
};

function fail(message, code = 'PROVIDER_ERROR') {
  const e = new Error(message); e.code = code; return e;
}
function uncertain(message) {return Object.assign(fail(message,'PROVIDER_UNKNOWN'),{unknown:true});}
function endpoint(provider, route) {
  let u;
  try { u = new URL(provider.baseUrl); } catch { throw fail('请填写有效的服务地址。'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw fail('服务地址必须是无账号、无查询参数的 HTTP(S) 地址。');
  let base = u.href.replace(/\/+$/, '');
  if (/\/v[12]$/.test(base)) base = base.slice(0, -3);
  return base + route;
}
function safeUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw fail('服务返回了无效的媒体地址。'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw fail('服务返回的媒体地址不安全。');
  return u.href;
}
function throwAbort(signal) {
  if (signal?.aborted) throw fail('操作已取消。', 'ABORT_ERR');
}
async function boundedBody(response, maxBytes, onProgress) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) { await response.body?.cancel(); throw fail('服务返回的文件超过本机接收上限。'); }
  const chunks = []; let size = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw fail('服务返回的内容超过本机接收上限。'); }
      if (value.byteLength) onProgress?.();
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
async function request(context, route, body, { method = 'POST', binary = false, maxBytes = MAX_JSON, absolute = false, submit = false, userId, taskStatus = false, idleTimeoutMs } = {}) {
  const { provider, signal } = context;
  throwAbort(signal);
  const timeoutMs = Math.min(900000, Math.max(1000, Number(provider.timeoutMs) || 180000));
  const timeout = AbortSignal.timeout(timeoutMs);
  const idle = idleTimeoutMs ? new AbortController() : null;
  const combined = AbortSignal.any([signal, timeout, idle?.signal].filter(Boolean));
  let idleTimer;
  const resetIdle = idle && (() => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), idleTimeoutMs);
  });
  const url = absolute ? safeUrl(route) : endpoint(provider, route);
  const headers = absolute || !provider.key ? {} : { Authorization: `Bearer ${provider.key}` };
  if(userId)headers['New-Api-User']=String(userId);
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  let requestBody;
  try {requestBody=body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body);}catch{throw fail('请求参数无法编码，请检查输入内容。');}
  let successfulResponse=false;
  try {
    resetIdle?.();
    const response = await (context.fetch || globalThis.fetch)(url, {
      method, headers, body: requestBody,
      signal: combined, redirect: absolute ? 'follow' : 'error',
    });
    if (!response.ok) {
      const meanings = { 400: '请求参数或模型能力不匹配', 401: '密钥无效或已过期', 402: '账号余额不足', 403: '账号没有此项权限', 404: '接口或模型不存在', 422: '输入格式或内容被服务拒绝', 429: '服务限流或额度已用完' };
      const message = absolute ? `文件服务器返回 HTTP ${response.status}。` : `模型服务返回 HTTP ${response.status}：${meanings[response.status] || '服务暂时不可用'}。`;
      const e = fail(message, submit && response.status >= 500 ? 'PROVIDER_UNKNOWN' : 'PROVIDER_HTTP');
      e.status = response.status; e.unknown = e.code === 'PROVIDER_UNKNOWN';
      // A broken error-response stream must not obscure a definite HTTP rejection.
      try{await response.body?.cancel();}catch{}
      throw e;
    }
    successfulResponse=true;
    resetIdle?.();
    const bytes = await boundedBody(response, maxBytes, resetIdle);
    if (binary) return bytes;
    let json;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { throw fail('服务未返回有效 JSON，请核对协议和服务地址。', submit ? 'PROVIDER_UNKNOWN' : 'PROVIDER_ERROR'); }
    const terminalTaskError=taskStatus&&['failed','canceled','cancelled'].includes(String(json.status).toLowerCase());
    if ((!terminalTaskError&&json.error) || json.success===false || json.base_resp?.status_code) throw fail('服务拒绝了请求，请核对模型、输入能力和账号额度。');
    return json;
  } catch (e) {
    // Once the submit endpoint replied 2xx, receiving/parsing errors cannot prove
    // that generation did not happen. Never turn these into a resubmittable failure.
    if(submit&&successfulResponse) {
      if(e?.code==='PROVIDER_UNKNOWN'){e.unknown=true;throw e;}
      throw uncertain('远端已响应，但返回内容未能完整接收或解析；状态未知，请勿直接重复生成。');
    }
    if (typeof e?.code==='string' && e.code.startsWith('PROVIDER_')) { if (e.code === 'PROVIDER_UNKNOWN') e.unknown = true; throw e; }
    if (signal?.aborted) { const error = fail(submit ? '操作已停止；远端提交状态未知，请勿直接重复生成。' : '操作已取消。', submit ? 'PROVIDER_UNKNOWN' : 'ABORT_ERR'); error.unknown = submit; throw error; }
    if (idle?.signal.aborted) throw fail(`文件服务器超过 ${Math.round(idleTimeoutMs / 1000)} 秒未继续传输。`, 'PROVIDER_DOWNLOAD_IDLE');
    if (absolute && timeout.aborted) throw fail('下载达到总时限，文件尚未接收完整。', 'PROVIDER_DOWNLOAD_TIMEOUT');
    const error = fail(submit ? '请求中断或超时，远端可能已接收；状态未知，请勿直接重复提交。' : '连接中断或超时，请检查网络后重试查询或下载。', submit ? 'PROVIDER_UNKNOWN' : 'PROVIDER_NETWORK');
    error.unknown = submit; throw error;
  } finally { clearTimeout(idleTimer); }
}

export function sniffMedia(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii',12,16) === 'IHDR') return { mime:'image/png', kind:'image', width:b.readUInt32BE(16), height:b.readUInt32BE(20) };
  if (b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') {
    let width,height;const codec=b.toString('ascii',12,16);
    if(codec==='VP8X'&&b.length>=30) {width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3);}
    else if(codec==='VP8L'&&b.length>=25&&b[20]===0x2f) {const bits=b.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
    else if(codec==='VP8 '&&b.length>=30&&b.subarray(23,26).equals(Buffer.from([0x9d,1,0x2a]))) {width=b.readUInt16LE(26)&0x3fff;height=b.readUInt16LE(28)&0x3fff;}
    return { mime:'image/webp', kind:'image',width,height };
  }
  if(b.length>=10&&['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)))return {mime:'image/gif',kind:'image',width:b.readUInt16LE(6),height:b.readUInt16LE(8)};
  if(b.length>=26&&b.toString('ascii',0,2)==='BM')return {mime:'image/bmp',kind:'image',width:Math.abs(b.readInt32LE(18)),height:Math.abs(b.readInt32LE(22))};
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255) {
    let width, height;
    for (let i=2; i+9<b.length;) {
      if (b[i] !== 255) break; const marker=b[i+1];
      if (marker === 0xda || marker === 0xd9) break;
      const n=b.readUInt16BE(i+2); if(n<2) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) { height=b.readUInt16BE(i+5); width=b.readUInt16BE(i+7); break; }
      i+=n+2;
    }
    return { mime:'image/jpeg', kind:'image', width, height };
  }
  if (b.length>=12 && b.toString('ascii',4,8)==='ftyp') {
    const brand=b.toString('ascii',8,12);
    if(['heic','heix','hevc','hevx','mif1','msf1','avif','avis'].includes(brand)) throw fail('此 HEIF/AVIF 图片格式尚未适配，请先导入 PNG 或 JPEG。');
    if(['isom','iso2','iso4','iso5','iso6','mp41','mp42','avc1','hvc1','M4V ','qt  ','MSNV','dash'].includes(brand)) return { mime:brand==='qt  '?'video/quicktime':'video/mp4', kind:'video' };
    if(['M4A ','M4B ','F4A '].includes(brand))return {mime:'audio/mp4',kind:'audio'};
  }
  if(b.length>=4&&b.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return {mime:'video/webm',kind:'video'};
  if(b.length>=4&&b.toString('ascii',0,4)==='OggS')return {mime:'audio/ogg',kind:'audio'};
  if (b.length>=12 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WAVE') return { mime:'audio/wav', kind:'audio' };
  if(b.length>=3&&b[0]===255&&(b[1]&0xf6)===0xf0)return {mime:'audio/aac',kind:'audio'};
  if (b.length>=3 && (b.toString('ascii',0,3)==='ID3' || (b[0]===255 && (b[1]&0xe0)===0xe0&&(b[1]&6)!==0))) return { mime:'audio/mpeg', kind:'audio' };
  throw fail('文件内容不是支持的媒体格式，不能将错误页面当成媒体。');
}
async function localMedia(filename, maxBytes=30*MB) {
  if (!path.isAbsolute(filename)) throw fail('参考素材必须是本机绝对路径。');
  let bytes;
  try { const s=await stat(filename); if(!s.isFile() || s.size>maxBytes) throw fail('参考素材超过大小上限或不是普通文件。'); bytes=await readFile(filename); } catch(e) { if(typeof e.code==='string' && e.code.startsWith('PROVIDER_')) throw e; throw fail('无法读取参考素材，请重新选择文件。'); }
  if(bytes.length>maxBytes) throw fail('参考素材超过大小上限。');
  return { bytes, ...sniffMedia(bytes) };
}
function dataUrl(media) { return `data:${media.mime};base64,${media.bytes.toString('base64')}`; }
export function imageDimensions(media,requestedSize) {
  const {width,height}=media;
  const actualSize=width&&height?`${width}x${height}`:undefined;
  const warning=requestedSize&&actualSize&&actualSize!==requestedSize?`服务返回 ${actualSize}，与请求 ${requestedSize} 不同；已保留结果，请复核规格。`:requestedSize&&!actualSize?'当前图片格式无法核实像素尺寸；请复核实际输出规格。':'';
  return {requestedSize,width,height,actualSize,warning};
}
function prompt(payload) { const text=String(payload.prompt || '').trim(); if(!text) throw fail('请填写提示词或文案。'); return text; }
async function chat(operation, payload, context) {
  const parts=[];
  if(operation==='describe') {
    const paths=payload.referencePaths || []; if(!paths.length) throw fail('请先选择需要反推的原图。');
    if(paths.length>8) throw fail('一次反推最多读取 8 张原图。');
    parts.push({type:'text',text:'只描述附图原本可见的内容，生成可复用的中文参考提示词。客观记录主体、构图、颜色、文字与界面；不执行或加入任何用户修改要求，不猜测不可见信息。'});
    const direction=String(payload.describeInstructions||'').trim();
    if(direction.length>12000)throw fail('反推要求超过 12000 字，请精简后重试。');
    if(direction)parts.push({type:'text',text:`反推关注点（只用于描述可见原图，不修改图片）：\n${direction}`});
    for(const p of paths) { throwAbort(context.signal); const m=await localMedia(p); if(m.kind!=='image') throw fail('反推只接受图片。'); parts.push({type:'image_url',image_url:{url:dataUrl(m)}}); }
  } else parts.push({type:'text',text:prompt(payload)});
  const messages=operation==='rewrite'
    ? [{role:'system',content:payload.systemPrompt},{role:'user',content:prompt(payload)}]
    : [{role:'user',content:parts}];
  const body={model:context.provider.model,messages,stream:false};
  if(payload.json===true && operation==='plan') body.response_format={type:'json_object'};
  const json=await request(context,'/v1/chat/completions',body);
  const content=json.choices?.[0]?.message?.content;
  const text=typeof content==='string'?content:Array.isArray(content)?content.filter(x=>x.type==='text').map(x=>x.text).join('\n'):'';
  if(!text?.trim()) throw fail('语言模型没有返回可用文字。');
  return {text};
}
function imageSize(payload, provider, media) {
  const resolution=payload.resolution || '1K'; const index=['1K','2K','4K'].indexOf(resolution);
  if(index<0) throw fail('图片清晰度仅支持 1K、2K、4K。');
  const ratio=payload.ratio || 'source';
  // CPA also lists the unqualified 2.5 alias. Keep the user's model ID on the wire.
  if (/(?:^|\/)gpt-image-2\.5(?:$|-)/i.test(provider.model)) {
    const [width, height] = ratio === 'source'
      ? (media ? [media.width, media.height] : [1,1])
      : ratio.split(':').map(Number);
    const aspect = Math.max(width, height) / Math.min(width, height);
    if (!Number.isFinite(aspect) || aspect > 3 || width <= 0 || height <= 0) {
      throw fail('GPT Image 2.5 需要有效参考尺寸，长宽比范围为 1:3 至 3:1。');
    }
    const target = [aspect===1?1024:1536, 2048, 3840][index];
    const candidates = [];
    for (let long = 16; long <= 3840; long += 16) {
      for (const short of new Set([Math.floor(long / aspect / 16), Math.ceil(long / aspect / 16)])) {
        const edge = short * 16;
        if (!edge || edge > long || long / edge > 3 || long * edge < 655360 || long * edge > 8294400) continue;
        candidates.push({long, edge, error: Math.abs(long / edge / aspect - 1)});
      }
    }
    const exact = candidates.filter(size => size.error < 1e-8);
    const options = ratio !== 'source' && exact.length ? exact : candidates;
    options.sort((a,b) => (Math.abs(a.long-target) + a.error*target*2) - (Math.abs(b.long-target) + b.error*target*2));
    const {long, edge} = options[0];
    return width >= height ? `${long}x${edge}` : `${edge}x${long}`;
  }
  if(!/^gpt-image-2(?:$|-)/i.test(provider.model)) {
    if(index!==0) throw fail('当前 OpenAI 图片模型未声明支持此清晰度，请选择 1K 或更换已确认支持的模型。');
    const map={'1:1':'1024x1024','3:2':'1536x1024','2:3':'1024x1536'};
    if(ratio==='source') {
      if(!media?.width || !media?.height) throw fail('无法读取原图尺寸，请明确选择该模型支持的比例。');
      const exact=Object.entries(map).find(([r])=>{const [w,h]=r.split(':').map(Number);return Math.abs(media.width/media.height-w/h)<0.01;});
      if(!exact) throw fail('该模型无法保持此原图比例；请更换支持任意尺寸的模型或明确选择支持比例。');
      return exact[1];
    }
    if(!map[ratio]) throw fail('当前模型仅适配 1:1、3:2、2:3，不会静默更改所选比例。');
    return map[ratio];
  }
  if(ratio==='source') {
    if(!media?.width || !media?.height) throw fail('无法读取参考图尺寸；请明确选择比例。');
    const scale=[1536,2048,4096][index]/Math.max(media.width,media.height);
    const w=Math.max(16,Math.round(media.width*scale/16)*16),h=Math.max(16,Math.round(media.height*scale/16)*16);
    if(Math.max(w/h,h/w)>3) throw fail('原图长宽比超过当前模型支持范围。');
    return `${w}x${h}`;
  }
  if(!imageSizes[ratio]) throw fail('当前模型未适配所选图片比例。');
  return imageSizes[ratio][index];
}
async function images(payload, context) {
  const paths=payload.referencePaths || []; if(paths.length>16) throw fail('一次图片编辑最多支持 16 张参考图。');
  const refs=[]; for(const p of paths) { throwAbort(context.signal); const m=await localMedia(p,20*MB); if(!['image/png','image/jpeg','image/webp'].includes(m.mime)) throw fail('图片编辑参考素材仅适配 PNG、JPEG、WebP，请先转换格式。'); refs.push(m); }
  const size=imageSize(payload,context.provider,refs[0]);
  const fields={model:context.provider.model,prompt:prompt(payload),n:1,size};
  if(payload.quality!==undefined) {if(!['low','medium','high','auto'].includes(payload.quality))throw fail('不支持的图片质量参数。');fields.quality=payload.quality;}
  let body=fields, route='/v1/images/generations';
  if(refs.length) {
    route='/v1/images/edits'; body=new FormData();
    for(const [k,v] of Object.entries(fields)) body.append(k,String(v));
    refs.forEach((m,i)=>body.append(refs.length===1?'image':'image[]',new Blob([m.bytes],{type:m.mime}),`reference-${i+1}.${m.mime.split('/')[1]}`));
  }
  const json=await request(context,route,body,{submit:true});
  const result=[];
  for(const item of Array.isArray(json.data)?json.data:[]) {
    if(!item || typeof item!=='object')continue;
    if(item.b64_json) {
      if(typeof item.b64_json!=='string' || item.b64_json.length>90*MB || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.b64_json)) throw uncertain('远端已响应，但图片 Base64 内容无效；请核对服务记录后再决定重新生成。');
      const bytes=Buffer.from(item.b64_json,'base64');let m;try{m=sniffMedia(bytes);}catch{throw uncertain('远端已响应，但文件内容不是有效图片；请核对服务记录后再决定重新生成。');} if(m.kind!=='image') throw uncertain('服务返回内容不是图片，请核对服务记录后再决定重新生成。');
      result.push({bytes,mime:m.mime,...imageDimensions(m,size)});
    } else if(item.url) {let url;try{url=safeUrl(item.url);}catch{throw uncertain('远端已响应，但图片下载地址无效；请核对服务记录后再决定重新生成。');}result.push({url,requestedSize:size});}
  }
  if(!result.length) {const e=fail('生图接口没有返回图片；请先核对该平台的生图/编辑能力。','PROVIDER_UNKNOWN');e.unknown=true;throw e;}
  return {images:result,remoteId:json.id,warning:result.map(m=>m.warning).filter(Boolean).join('\n')};
}
async function videoInput(payload, context) {
  const mode=payload.mode || 'text'; if(!['text','image','reference'].includes(mode)) throw fail('不支持的视频输入模式。');
  const paths=payload.referencePaths || [];
  if(mode==='text' && paths.length) throw fail('文生视频不能附带参考素材，请切换输入模式。');
  if(mode==='image' && (paths.length<1 || paths.length>2)) throw fail('图生视频需要 1 张首帧图，可再附 1 张尾帧图。');
  if(mode==='reference' && !paths.length) throw fail('参考生视频需要图片、视频或音频素材。');
  const refs=[]; let total=0;
  for(const p of paths) { throwAbort(context.signal); const media=await localMedia(p,50*MB); total+=media.bytes.length; if(total*4/3>60*MB) throw fail('参考素材编码后接近接口 64MB 上限，请先缩小素材。'); refs.push(media); }
  const counts={image:0,video:0,audio:0};
  for(const m of refs) {
    counts[m.kind]++;
    if(!['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','audio/mpeg','audio/wav'].includes(m.mime))throw fail('H3 参考输入仅适配 PNG/JPEG/WebP、MP4/MOV 视频、MP3/WAV 音频，请先转换格式。');
    if(m.kind==='image' && m.bytes.length>30*MB || m.kind==='audio' && m.bytes.length>15*MB) throw fail('参考图片或音频超过服务大小上限。');
  }
  if(mode==='image' && refs.some(m=>m.kind!=='image')) throw fail('首尾帧模式只接受图片；视频素材请使用参考生视频。');
  if(counts.image>9 || counts.video>3 || counts.audio>3) throw fail('参考素材超过限制：最多 9 图、3 视频、3 音频。');
  if(counts.audio && !counts.image && !counts.video) throw fail('音频参考还需要搭配图片或视频。');
  const ratio=payload.ratio==='source'?'adaptive':payload.ratio || '16:9';
  if(!['adaptive','21:9','16:9','4:3','1:1','3:4','9:16'].includes(ratio)) throw fail('当前 H3 不支持所选视频比例。');
  if(mode==='image' && ratio!=='adaptive') throw fail('H3 图生视频始终跟随首帧比例；请选择“原图比例”，不能保证指定比例。');
  const lite=/(?:-|\/)(?:lite|highspeed|max)$/i.test(context.provider.model), min=/-max$/i.test(context.provider.model)?5:4;
  const duration=Number(payload.duration ?? 5); if(!Number.isInteger(duration)||duration<min||duration>15) throw fail(`当前 H3 时长必须为 ${min}–15 秒整数。`);
  const resolution=payload.resolution || '768P'; if(!(lite?['480P','768P']:['768P','2K']).includes(resolution)) throw fail('所选 H3 型号不支持此分辨率。');
  if(mode==='text' && ratio==='adaptive' || /lite/i.test(context.provider.model) && mode!=='image' && ratio==='adaptive') throw fail('此模式需要明确的视频比例。');
  return {mode,refs,ratio,duration,resolution};
}
async function videoSubmit(payload, context) {
  const {provider}=context; const v=await videoInput(payload,context); const text=prompt(payload); let json;
  if(provider.protocol==='oairegbox-video'){
    const model=h3Model(provider.model);
    if(!model||model.resolution!==v.resolution)throw fail('所选 OAIREGBOX H3 型号与分辨率不匹配。');
    if([...text].length>7000)throw fail('H3 提示词最多 7000 字符。');
    const body={model:model.id,prompt:text,duration:v.duration,ratio:v.ratio};
    if(v.mode==='image'){
      body.first_image=dataUrl(v.refs[0]);
      if(v.refs[1])body.last_image=dataUrl(v.refs[1]);
    }
    if(v.mode==='reference'){
      const images=v.refs.filter(m=>m.kind==='image'),videos=v.refs.filter(m=>m.kind==='video'),audio=v.refs.filter(m=>m.kind==='audio');
      const invalid=h3ReferenceError(model,v.mode,v.refs.map(media=>media.kind));
      if(invalid)throw fail(invalid);
      if(context.inspectDuration){
        let audioSeconds=0;
        for(const [i,media] of v.refs.entries()){
          if(media.kind==='image')continue;
          const duration=await context.inspectDuration(payload.referencePaths[i],context.signal);
          if(media.kind==='video'&&(duration<2||duration>5))throw fail('参考视频时长须为 2–5 秒。');
          if(media.kind==='audio')audioSeconds+=duration;
        }
        if(audioSeconds>15)throw fail('参考音频合计最多 15 秒。');
      }
      if(images.length)body.referenceImages=images.map(dataUrl);
      if(videos.length)body.referenceVideos=videos.map(dataUrl);
      if(audio.length)body.referenceAudios=audio.map(dataUrl);
    }
    json=await request(context,'/v1/videos',body,{submit:true});
    return recordSubmittedId(json.task_id??json.id,context);
  }
  if(provider.protocol==='minimax-video') {
    if(!/^MiniMax-H3(?:-Highspeed|-Lite|-Max)?$/.test(provider.model)) throw fail('此适配器使用 MiniMax H3 V2，请填写官方 H3 型号。');
    const content=[{type:'text',text}];
    v.refs.forEach((m,i)=>{const type=`${m.kind}_url`;const role=v.mode==='image'?(i?'last_frame':'first_frame'):`reference_${m.kind}`;content.push({type,[type]:{url:dataUrl(m)},role});});
    json=await request(context,'/v2/video_generation',{model:provider.model,content,ratio:v.ratio,duration:v.duration,resolution:v.resolution},{submit:true});
    return recordSubmittedId(json.task_id,context);
  }
  if(!['minimax/h3','minimax/h3-lite'].includes(provider.model)) throw fail('Replicate 适配仅支持 minimax/h3 或 minimax/h3-lite。');
  const input={prompt:text,ratio:v.ratio,duration:v.duration,resolution:v.resolution};
  if(v.mode==='image') {input.first_frame_image=dataUrl(v.refs[0]);if(v.refs[1])input.last_frame_image=dataUrl(v.refs[1]);}
  if(v.mode==='reference') for(const kind of ['image','video','audio']) {const refs=v.refs.filter(m=>m.kind===kind);if(refs.length)input[`reference_${kind}_urls`]=refs.map(dataUrl);}
  json=await request(context,`/v1/models/${provider.model}/predictions`,{input},{submit:true});
  return recordSubmittedId(json.id,context);
}
async function recordSubmittedId(raw,context) {
  if(!((typeof raw==='string'&&/^[\w-]{1,160}$/.test(raw))||(typeof raw==='number'&&Number.isSafeInteger(raw)&&raw>0)))throw uncertain('视频提交未返回有效任务编号，远端状态未知。');
  const remoteId=String(raw);
  try{await context.onRemoteId?.(remoteId);}catch{throw uncertain('远端已接收视频，但任务编号尚未安全保存，请先核对服务商记录。');}
  return {remoteId};
}
async function videoPoll(payload,context) {
  if(!payload.remoteId || !/^[\w-]{1,160}$/.test(String(payload.remoteId))) throw fail('视频任务编号无效。');
  const minimax=context.provider.protocol==='minimax-video';
  if(context.provider.protocol==='oairegbox-video'){
    const task=await request(context,`/v1/videos/${payload.remoteId}`,undefined,{method:'GET',taskStatus:true});
    const status=String(task.status||'').toLowerCase();
    if(['failed','canceled','cancelled'].includes(status))return {status:'failed',error:'OAIREGBOX 视频任务失败或已取消，可在平台核对详情。'};
    if(['completed','succeeded','success'].includes(status)){
      const url=task.video_url||task.data?.[0]?.url||task.metadata?.url;
      if(typeof url!=='string')throw fail('视频已完成，服务暂未返回下载地址，请保留任务编号重查。');
      return {status:'succeeded',url:safeUrl(url)};
    }
    if(['submitted','queued','pending','running','processing','in_progress','starting'].includes(status))return {status:'running'};
    throw fail('OAIREGBOX 返回了未知任务状态，请保留任务编号重查。');
  }
  const json=await request(context,minimax?`/v2/query/video_generation/${payload.remoteId}`:`/v1/predictions/${payload.remoteId}`,undefined,{method:'GET'});
  const task=minimax?json.task:json; if(!task?.status) throw fail('视频查询没有返回有效状态。');
  if(['failed','canceled','cancelled'].includes(task.status)) return {status:'failed',error:'远端视频任务失败或已取消，请核对素材规格、内容限制和账号记录。'};
  if(task.status==='succeeded') {const url=minimax?task.content?.url:Array.isArray(task.output)?task.output[0]:task.output;if(typeof url!=='string')throw fail('视频已完成，但服务没有返回下载地址；请保留任务编号重查。');return {status:'succeeded',url:safeUrl(url)};}
  if(!['queued','running','starting','processing'].includes(task.status)) throw fail('服务返回了无法识别的视频任务状态，请保留任务编号。');
  return {status:'running'};
}

export async function downloadMedia(url, {signal,timeoutMs=180000,idleTimeoutMs,fetch:fetchImpl,maxBytes=200*MB,kind} = {}) {
  const bytes=await request({provider:{timeoutMs},signal,fetch:fetchImpl},url,undefined,{method:'GET',binary:true,maxBytes,absolute:true,idleTimeoutMs});
  const media=sniffMedia(bytes); if(kind && media.kind!==kind) throw fail('下载的文件类型与任务类型不符。');
  return {bytes,mime:media.mime};
}

export async function readOairegboxDashboard({baseUrl,key='',accountToken='',fetch:fetchImpl}){
  const base=oairegboxBase(baseUrl);
  const read=(route,credential,userId)=>request({provider:{baseUrl:base,key:credential,timeoutMs:12000},fetch:fetchImpl},route,undefined,{method:'GET',maxBytes:8*MB,userId});
  const amount=value=>Number.isFinite(value)?value/500000:null;
  const pricesOf=json=>Object.fromEntries((Array.isArray(json?.data)?json.data:[]).flatMap(row=>{
    if(!h3Model(row.model_name)||row.billing_unit!=='second')return [];
    const multiplier=json.group_ratio?.minimax;
    const price=Number.isFinite(row.published_price)?row.published_price:
      Number.isFinite(row.model_price)&&Number.isFinite(multiplier)?row.model_price*multiplier:null;
    return Number.isFinite(price)&&price>=0?[[row.model_name,price]]:[];
  }));
  const values=await Promise.allSettled([
    read('/api/pricing',accountToken).then(pricesOf),
    key?read('/v1/models',key):null,
    key?read('/api/usage/token/',key):null,
    accountToken?read('/api/user/self',accountToken):null,
  ]);
  const [priceResult,modelResult,tokenResult,accountResult]=values;
  let prices=priceResult.value||{};
  let priceSource=Object.keys(prices).length?(accountToken?'account':'public'):'reference';
  if(priceSource==='account'&&!accountResult.value?.data?.username)priceSource='reference';
  if(accountToken&&priceSource==='reference'){
    prices=await read('/api/pricing','').then(pricesOf).catch(()=>({}));
    if(Object.keys(prices).length)priceSource='public';
  }
  const modelRows=modelResult.value?.data;
  const models=Array.isArray(modelRows)?modelRows.map(row=>row.id).filter(h3Model):null;
  const tokenData=tokenResult.value?.data;
  const token=tokenData?{remaining:amount(tokenData.total_available),used:amount(tokenData.total_used),unlimited:tokenData.unlimited_quota===true}:null;
  const data=accountResult.value?.data;
  const account=data&&typeof data.username==='string'?{name:data.username,group:typeof data.group==='string'?data.group:'',balance:amount(data.quota),used:amount(data.used_quota)}:null;
  let logs=null;
  if(account){
    const id=Number(data.id);
    const result=await read('/api/log/self?p=1&page_size=10&type=2',accountToken,Number.isSafeInteger(id)&&id>0?id:undefined).catch(()=>null);
    const items=result?.data?.items??result?.data;
    if(Array.isArray(items))logs=items.filter(item=>item.type==null||Number(item.type)===2).slice(0,10).map(item=>({
      time:Number.isFinite(item.created_at)?item.created_at:null,
      model:typeof item.model_name==='string'?item.model_name.slice(0,120):'',
      cost:amount(item.quota),
    }));
  }
  return {prices,priceSource,models,token,account,logs,refreshedAt:new Date().toISOString()};
}

export async function runProvider(operation,payload={},context={}) {
  throwAbort(context.signal);
  const p=context.provider;
  if(!p?.key || (!p.model && operation!=='models') || !p.baseUrl) throw fail('请先完整配置模型服务、地址、型号和密钥。');
  if(p.protocol==='oairegbox-video')oairegboxBase(p.baseUrl);
  if(operation==='models') {
    if(['doubao-tts','minimax-tts'].includes(p.protocol))return {models:[...SPEECH_CATALOGS[p.protocol].models],catalog:true,text:'显示官方语音型号目录，实际权限和音色需通过语音任务验证。'};
    const replicate=p.protocol==='replicate-video';
    if (replicate && !p.model) {
      const candidates = await Promise.allSettled(['minimax/h3','minimax/h3-lite'].map(model =>
        runProvider('models', {}, {...context, provider:{...p, model}})));
      const models = candidates.flatMap(result => result.status === 'fulfilled' ? result.value.models : []);
      if (!models.length) throw candidates[0].reason;
      return {text:'已查询可访问的 H3 模型。',models};
    }
    if(replicate && !['minimax/h3','minimax/h3-lite'].includes(p.model)) throw fail('Replicate 连接检查需要已适配的官方模型名。');
    const json=await request(context,replicate?`/v1/models/${p.model}`:'/v1/models',undefined,{method:'GET',maxBytes:8*MB});
    const models=replicate?(json.owner&&json.name?[`${json.owner}/${json.name}`]:[]):(Array.isArray(json.data)?json.data:[]).map(m=>m?.id).filter(x=>typeof x==='string'&&x.length<240);
    if(p.protocol==='minimax-video'){
      const official=['MiniMax-H3','MiniMax-H3-Highspeed','MiniMax-H3-Lite','MiniMax-H3-Max'];
      const listed=models.filter(model=>official.includes(model));
      if(!listed.length)return {models:official,catalog:true,text:'模型目录未列出视频型号，显示官方 H3 接口型号。'};
      return {models:listed,text:'已获取接口列出的视频型号。'};
    }
    if(p.protocol==='oairegbox-video')return {models:models.filter(h3Model),text:'已查询调用令牌可见的 H3 型号。'};
    if(!models.length) throw fail('连接已响应，但没有返回可用模型列表，请核对协议或权限。');
    return {text:p.model?(models.includes(p.model)?'连接成功，当前型号在模型列表中；生成能力仍需实际任务验证。':'连接成功，但当前型号未列出；请核对型号或账号权限。'):'连接成功，已获取模型列表。',models};
  }
  const compatible={describe:['openai-chat'],plan:['openai-chat'],rewrite:['openai-chat'],image:['openai-images'],videoSubmit:['minimax-video','replicate-video','oairegbox-video'],videoPoll:['minimax-video','replicate-video','oairegbox-video'],tts:TTS_PROTOCOLS};
  if(!compatible[operation]?.includes(p.protocol)) throw fail('此服务协议不支持所选操作，请检查独立能力绑定。');
  if(operation==='describe'||operation==='plan'||operation==='rewrite') return chat(operation,payload,context);
  if(operation==='image') return images(payload,context);
  if(operation==='videoSubmit') return videoSubmit(payload,context);
  if(operation==='videoPoll') return videoPoll(payload,context);
  if(p.protocol==='doubao-tts'||p.protocol==='minimax-tts')return runSpeech(payload,context);
  const options=normalizeSpeechOptions(payload,p);
  const body={model:p.model,input:prompt(payload),voice:options.voice,response_format:options.format};
  if(payload.speed!==undefined)body.speed=options.speed;
  const bytes=await request(context,'/v1/audio/speech',body,{binary:true,maxBytes:50*MB,submit:true});
  let media;try{media=sniffMedia(bytes);}catch{throw uncertain('远端已响应，但文件内容不是有效配音；请核对配音记录后再决定重新生成。');}
  const mime=options.format==='wav'?'audio/wav':'audio/mpeg';
  if(media.mime!==mime) throw uncertain('配音服务没有返回所选格式的音频，请核对配音记录后再决定重新生成。');
  return {bytes,mime};
}
