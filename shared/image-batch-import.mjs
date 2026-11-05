import {nextImageRowCode} from './image-rows.mjs';

export const IMAGE_BATCH_SHEET = '任务';
export const IMAGE_BATCH_LIMITS = Object.freeze({fileBytes:10*1024*1024,expandedBytes:32*1024*1024,archiveEntries:200,sheets:5,rows:500,columns:13,cellCharacters:12000,totalCharacters:2000000});
export const IMAGE_BATCH_COLUMNS = Object.freeze([
  {key:'code',title:'编号',width:14,defaultText:'沿用最后一行分类递增',help:'可留空自动编号，例如 A01、A02。已存在的编号不能重复。'},
  {key:'name',title:'类型名称',width:20,defaultText:'未命名类型',help:'填写易识别的素材类型名称，可留空后在应用里补充。'},
  {key:'sourceInput',title:'参考素材路径',width:42,defaultText:'导入后再选择',help:'本地图片或图片文件夹。可用绝对路径，或相对本 Excel 所在文件夹的路径；不需要把图片嵌入 Excel。'},
  {key:'referencePrompt',title:'参考提示词',width:54,defaultText:'空白',help:'已填写时优先保留，绝不自动反推覆盖。单元格内可以换行。'},
  {key:'userPrompt',title:'用户要求',width:54,defaultText:'空白',help:'本行图片生成要求，导入不会自动生成图片。'},
  {key:'autoDescribe',title:'自动反推',width:13,defaultText:'不反推',help:'仅填 X 表示开启。只有参考提示词为空时才调用一次视觉服务，取本行第一张参考图。'},
  {key:'describeInstructions',title:'反推要求',width:44,defaultText:'应用默认描述要求',help:'可选，指定反推时关注的主体、构图等；不会覆盖用户要求。'},
  {key:'count',title:'生成数量',width:13,defaultText:'1',help:'可选，1–100 的整数。'},
  {key:'ratio',title:'图片比例',width:15,defaultText:'跟随原图',help:'跟随原图、9:16、16:9、1:1、3:4、4:3。'},
  {key:'resolution',title:'分辨率',width:13,defaultText:'1K',help:'可选：1K、2K、4K。'},
  {key:'template',title:'项目规范',width:28,defaultText:'当前默认项目规范',help:'可填应用中现有规范的名称或 ID；填“不使用模板”表示不套用。'},
  {key:'folderName',title:'保存子目录',width:30,defaultText:'按类型名称自动创建',help:'可选的输出子目录，不能填写绝对路径或 ..。序号和批次由应用添加。'},
  {key:'outputLocation',title:'导出位置',width:22,defaultText:'系统输出目录',help:'留空或填写“系统输出目录”沿用底部输出根目录；填写“原目录子图”时，参考素材路径必须为单个类型目录，使用其中母图，结果写回该目录/子图。此模式无需填写保存子目录。'},
]);

const text = value => String(value ?? '').trim();
export const isLocalImageBatchPath = value => {
  const cleaned=text(value).replace(/^"(.*)"$/,'$1');
  return !/[\u0000-\u001f]/.test(cleaned)&&!/^\w+:\/\//.test(cleaned)&&!/^[/\\]{2}/.test(cleaned);
};
export const imageBatchCodeKey = value => {
  const valueText=text(value).toUpperCase(),match=valueText.match(/^([A-Z]+)(\d+)[.。．]?$/);
  return match?`${match[1]}${BigInt(match[2])}`:valueText;
};

// Pure validation: no provider calls, writes, or file access occur here.
export function normalizeImageBatchRow(raw,{existingRows=[],settings={}}={}) {
  const errors=[],warnings=[],defaultedFields=[];
  const get=key=>{const value=text(raw[key]);if(!value)defaultedFields.push(key);return value;};
  let code=get('code');
  if(!code){try{code=nextImageRowCode(existingRows)}catch(error){errors.push(error.message)}}
  if(!code||code.length>40||/[\u0000-\u001f]/.test(code))errors.push('编号应为 1–40 个字符，不能含换行或控制字符。');
  if(code&&existingRows.some(row=>imageBatchCodeKey(row.code)===imageBatchCodeKey(code)))errors.push(`编号 ${code} 已存在，请修改或留空自动编号。`);
  const name=get('name');if(name.length>200)errors.push('类型名称不能超过 200 个字符。');
  const referencePrompt=get('referencePrompt'),userPrompt=get('userPrompt'),describeInstructions=get('describeInstructions');
  for(const [label,value] of [['参考提示词',referencePrompt],['用户要求',userPrompt],['反推要求',describeInstructions]])if(value.length>IMAGE_BATCH_LIMITS.cellCharacters)errors.push(`${label}不能超过 ${IMAGE_BATCH_LIMITS.cellCharacters} 个字符。`);
  const autoValue=get('autoDescribe');
  if(autoValue&&!/^x$/i.test(autoValue))errors.push('自动反推仅填写 X，留空表示关闭。');
  const autoDescribe=/^x$/i.test(autoValue)&&!referencePrompt;
  if(/^x$/i.test(autoValue)&&referencePrompt)warnings.push('已填写参考提示词，本行保留手工内容，不调用反推。');
  const countInput=get('count'),count=countInput?Number(countInput):1;
  if(!Number.isInteger(count)||count<1||count>100)errors.push('生成数量应为 1–100 的整数。');
  const ratioInput=get('ratio').replace(/：/g,':'),ratio=!ratioInput||['跟随原图','source'].includes(ratioInput)?'source':ratioInput;
  if(!['source','9:16','16:9','1:1','3:4','4:3'].includes(ratio))errors.push('图片比例应为跟随原图、9:16、16:9、1:1、3:4 或 4:3。');
  const resolution=get('resolution').toUpperCase()||'1K';if(!['1K','2K','4K'].includes(resolution))errors.push('分辨率仅支持 1K、2K、4K。');
  const templateInput=get('template'),templates=settings.templates||[];
  let templateId=settings.defaultTemplateId||'';
  if(['无','不使用模板'].includes(templateInput))templateId='';
  else if(templateInput){const exact=templates.find(item=>item.id===templateInput),named=templates.filter(item=>item.name===templateInput);if(exact)templateId=exact.id;else if(named.length===1)templateId=named[0].id;else errors.push(named.length?'项目规范名称重复，请改填规范 ID。':`找不到项目规范“${templateInput}”，请填写现有名称或 ID。`);}
  if(templateId&&!templates.some(item=>item.id===templateId))errors.push('当前默认项目规范已不存在，请在全局设置中重新选择。');
  const folderName=get('folderName');
  if(folderName.length>240||/^[\\/]|^[a-z]:/i.test(folderName)||/[<>:"|?*\u0000-\u001f]/.test(folderName)||folderName.split(/[\\/]/).some(part=>part==='..'||part==='.'))errors.push('保存子目录不能包含绝对路径、.. 或文件名非法字符。');
  const sourceInput=get('sourceInput');
  if(!isLocalImageBatchPath(sourceInput))errors.push('参考素材路径必须是本机图片或文件夹路径，不支持网络共享或设备路径。');
  if(autoDescribe&&!sourceInput)errors.push('自动反推需要填写参考素材路径。');
  const outputLocation=get('outputLocation')||'系统输出目录';
  if(!['系统输出目录','原目录子图'].includes(outputLocation))errors.push('导出位置应留空、填写“系统输出目录”或“原目录子图”。');
  if(outputLocation==='原目录子图'&&!sourceInput)errors.push('原目录子图模式需要填写单个类型目录的参考素材路径。');
  if(outputLocation==='原目录子图'&&folderName)errors.push('原目录子图模式固定保存到类型目录/子图，请清空保存子目录。');
  return {values:{code,name,sourceMode:'single',sourcePaths:[],referencePrompt,userPrompt,count,ratio,resolution,templateId,folderName},sourceInput,outputLocation,autoDescribe,describeInstructions,defaultedFields,templateName:templates.find(item=>item.id===templateId)?.name||'不使用模板',errors,warnings};
}
