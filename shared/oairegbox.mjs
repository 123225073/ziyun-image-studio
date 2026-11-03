export const OAIREGBOX_BASE='https://api.oairegbox.cc';
export const OAIREGBOX_CONSOLE='https://newapi-2.oairegbox.cc';
export const H3_MODELS=[
 {id:'minimax-h3-768p',label:'H3 标准 · 768P',resolution:'768P',pro:false,price:.15},
 {id:'minimax-h3-2k',label:'H3 标准 · 2K',resolution:'2K',pro:false,price:.20},
 {id:'minimax-h3-pro-768p',label:'H3 Pro · 768P',resolution:'768P',pro:true,price:.25},
 {id:'minimax-h3-pro-2k',label:'H3 Pro · 2K',resolution:'2K',pro:true,price:.33},
];
export const h3Model=id=>H3_MODELS.find(model=>model.id===id);
export const h3ReferenceLimits=model=>({image:model.pro?9:5,video:model.pro?1:0,audio:3});

export function h3ReferenceKind(file){
 if(/\.(png|jpe?g|webp)$/i.test(file))return 'image';
 if(/\.(mp4|mov)$/i.test(file))return 'video';
 if(/\.(mp3|wav)$/i.test(file))return 'audio';
 return '';
}

export function h3ReferenceError(model,mode,kinds,availableModels){
 if(mode==='image'){
  if(kinds.some(kind=>kind!=='image')||kinds.length>2)return `${model.id} 的首尾帧模式最多接受两张图片，分别作为首帧和尾帧。`;
  return '';
 }
 if(mode!=='reference')return '';
 if(kinds.some(kind=>!kind))return '参考素材支持 PNG/JPEG/WebP 图片、MP4/MOV 视频和 MP3/WAV 音频。';
 const limits=h3ReferenceLimits(model);
 const counts={image:0,video:0,audio:0};
 for(const kind of kinds)counts[kind]++;
 if(!model.pro&&(counts.video||counts.image>5)){
  const pro=H3_MODELS.filter(item=>item.pro&&(!availableModels||availableModels.includes(item.id)));
  const suggested=pro.find(item=>item.resolution===model.resolution)||pro[0];
  const canUsePro=counts.image<=9&&counts.video<=1&&counts.audio<=3;
  const reason=counts.video?`${model.id} 不支持参考视频。`:`${model.id} 最多支持 5 张参考图，本次共选了 ${counts.image} 张。`;
  const needsImage=counts.audio&&!counts.image?'参考音频还需搭配至少 1 张参考图。':'';
  if(canUsePro&&suggested)return `${reason} 请切换到 ${suggested.id}（最多 9 图、1 视频、3 音频），或减少素材。${needsImage}`;
  if(canUsePro&&!suggested)return `${reason} 请在平台为令牌开通 H3 Pro 型号，或减少素材。`;
  return `${reason} 请减少素材。H3 Pro 最多支持 9 图、1 视频、3 音频。`;
 }
 if(Object.keys(limits).some(kind=>counts[kind]>limits[kind])){
  return `${model.id} 最多支持 ${limits.image} 图、${limits.video} 视频、${limits.audio} 音频。当前选了 ${counts.image} 图、${counts.video} 视频、${counts.audio} 音频，请减少素材。`;
 }
 if(counts.audio&&!counts.image)return `${model.id} 的参考音频需要搭配至少 1 张参考图。请先添加图片，或与音频一起选择。`;
 return '';
}

export function oairegboxBase(value){
 const address=new URL(value);
 const hosts=['api.oairegbox.cc','newapi.oairegbox.cc','newapi-2.oairegbox.cc','gpt2api.oairegbox.cc'];
 if(address.protocol!=='https:'||address.port||!hosts.includes(address.hostname)||address.username||address.password||
    address.search||address.hash||!['','/','/v1','/v1/'].includes(address.pathname)){
  throw new Error('OAIREGBOX 连接仅支持平台文档列出的 HTTPS 接口。');
 }
 return address.origin;
}

export function h3Cost(price,duration,count){
 if(![price,duration,count].every(Number.isFinite)||price<0||
    !Number.isInteger(duration)||duration<4||duration>15||
    !Number.isInteger(count)||count<1||count>20)return null;
 const perVideo=price*duration;
 return {perVideo,total:perVideo*count};
}
