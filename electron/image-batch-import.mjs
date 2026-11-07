import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import ExcelJS from 'exceljs';
import {sniffMedia} from './providers.mjs';
import {inspectImageTypeFolder} from './image-folder-import.mjs';
import {IMAGE_BATCH_COLUMNS,IMAGE_BATCH_LIMITS,IMAGE_BATCH_SHEET,isLocalImageBatchPath,normalizeImageBatchRow} from '../shared/image-batch-import.mjs';

// ExcelJS already ships unzipper. Read its dependency so packaged builds use
// the same runtime dependency, rather than a development-only root package.
const require=createRequire(import.meta.url),unzipper=createRequire(require.resolve('exceljs'))('unzipper');
async function checkWorkbookArchive(filePath){
  let archive;try{archive=await unzipper.Open.file(filePath)}catch{throw new Error('Excel 文件无法读取，请用 Excel 另存为 .xlsx 后重试。');}
  if(archive.files.length>IMAGE_BATCH_LIMITS.archiveEntries)throw new Error('Excel 文件内部内容过多，请拆分文件或移除嵌入对象。');
  if(archive.files.some(entry=>/^(?:xl\/externalLinks\/)|(?:^|\/)vbaProject\.bin$/i.test(entry.path)))throw new Error('Excel 含外部链接或宏，请移除后另存为普通 .xlsx。');
  if(archive.files.reduce((total,entry)=>total+entry.uncompressedSize,0)>IMAGE_BATCH_LIMITS.expandedBytes)throw new Error('Excel 解压内容超过 32 MiB，请拆分文件或移除嵌入对象。');
  // Check actual streamed bytes as well as ZIP metadata before ExcelJS loads XML.
  let total=0;
  for(const entry of archive.files){
    if(entry.type==='Directory')continue;
    try{for await(const chunk of entry.stream()){total+=chunk.length;if(total>IMAGE_BATCH_LIMITS.expandedBytes)throw new Error('Excel 解压内容超过 32 MiB，请拆分文件或移除嵌入对象。');}}
    catch(error){if(error.message.includes('32 MiB'))throw error;throw new Error('Excel 文件内容损坏，请另存为 .xlsx 后重试。');}
  }
}

const imageExtensions=new Set(['.png','.jpg','.jpeg','.webp','.gif','.bmp']);
async function checkImageHeader(file){
  const handle=await fs.open(file,'r');
  try{const bytes=Buffer.alloc(64),read=await handle.read(bytes,0,bytes.length,0);if(sniffMedia(bytes.subarray(0,read.bytesRead))?.kind!=='image')throw new Error('参考文件内容不是有效图片。');}
  finally{await handle.close();}
}
async function defaultResolveSource(absolutePath){
  const stat=await fs.stat(absolutePath).catch(()=>null);
  if(!stat)throw new Error('参考素材路径不存在或无法访问。');
  if(stat.isFile()){
    if(!imageExtensions.has(path.extname(absolutePath).toLowerCase()))throw new Error('参考素材必须是 PNG、JPG、JPEG、WebP、GIF 或 BMP 图片。');
    await checkImageHeader(absolutePath);
    return {sourceMode:'single',sourcePaths:[absolutePath]};
  }
  if(!stat.isDirectory())throw new Error('参考素材必须是图片文件或文件夹。');
  const entries=await fs.readdir(absolutePath,{withFileTypes:true});
  const candidates=entries.filter(entry=>entry.isFile()&&imageExtensions.has(path.extname(entry.name).toLowerCase())).map(entry=>path.join(absolutePath,entry.name)).sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
  const sourcePaths=[];for(const file of candidates){try{await checkImageHeader(file);sourcePaths.push(file)}catch{}}
  if(!sourcePaths.length)throw new Error('参考素材文件夹中没有支持的图片。');
  if(sourcePaths.length>500)throw new Error('单行参考素材不能超过 500 张，请缩小文件夹范围。');
  return {sourceMode:'folder',sourcePaths};
}

function readCell(cell,errors){
  const value=cell.value;
  if(value==null)return '';
  if(typeof value==='object'){
    if('formula' in value||'sharedFormula' in value){errors.push(`${cell.address} 是公式，请先粘贴为纯文本或数值。`);return '';}
    if('hyperlink' in value){errors.push(`${cell.address} 含超链接，请改为普通本地路径或文字。`);return '';}
    if(Array.isArray(value.richText))return value.richText.map(part=>String(part.text||'')).join('');
    errors.push(`${cell.address} 不是普通文字或数值。`);return '';
  }
  if(!['string','number','boolean'].includes(typeof value)){errors.push(`${cell.address} 的内容格式不支持。`);return '';}
  return String(value);
}

export async function parseImageBatchWorkbook(filePath,{existingRows=[],settings={},resolveSource=defaultResolveSource}={}){
  if(!path.isAbsolute(filePath)||!isLocalImageBatchPath(filePath)||path.extname(filePath).toLowerCase()!=='.xlsx')throw new Error('请选择本机 .xlsx 格式的 Excel 文件。');
  const stat=await fs.stat(filePath).catch(()=>null);
  if(!stat?.isFile())throw new Error('Excel 文件不存在或无法访问。');
  if(stat.size>IMAGE_BATCH_LIMITS.fileBytes)throw new Error('Excel 文件不能超过 10 MiB，请移除嵌入图片或拆分文件。');
  await checkWorkbookArchive(filePath);
  const workbook=new ExcelJS.Workbook();
  try{await workbook.xlsx.readFile(filePath,{ignoreNodes:['drawing','picture','extLst']})}catch{throw new Error('Excel 文件无法读取，请用 Excel 另存为 .xlsx 后重试。');}
  if(workbook.worksheets.length>IMAGE_BATCH_LIMITS.sheets)throw new Error(`Excel 最多保留 ${IMAGE_BATCH_LIMITS.sheets} 个工作表。`);
  const sheet=workbook.getWorksheet(IMAGE_BATCH_SHEET);
  if(!sheet)throw new Error('找不到“任务”工作表，请下载模板并在“任务”表中填写。');
  if(sheet.rowCount>IMAGE_BATCH_LIMITS.rows+1)throw new Error(`“任务”表最多导入 ${IMAGE_BATCH_LIMITS.rows} 行，请拆分文件。`);
  if(sheet.columnCount>IMAGE_BATCH_LIMITS.columns)throw new Error(`“任务”表最多 ${IMAGE_BATCH_LIMITS.columns} 列，请使用模板中的列。`);
  const errors=[],warnings=[],rows=[],headers=new Map();let totalCharacters=0;
  for(let column=1;column<=sheet.columnCount;column++){
    const heading=readCell(sheet.getCell(1,column),errors).trim();
    const definition=IMAGE_BATCH_COLUMNS.find(item=>item.title===heading);
    if(!definition){if(heading)errors.push(`第 ${column} 列“${heading}”不在模板中。`);else if(sheet.getColumn(column).values.slice(2).some(value=>value!=null&&String(value).trim()))errors.push(`第 ${column} 列缺少标题。`);continue;}
    if([...headers.values()].includes(definition.key))errors.push(`列标题“${heading}”重复。`);
    headers.set(column,definition.key);
  }
  if(!headers.size)errors.push('“任务”表第一行需要模板中的中文列标题。');
  const occupied=existingRows.map(row=>({code:row.code}));
  const folderKey=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
  for(let excelRow=2;excelRow<=sheet.rowCount;excelRow++){
    const raw={},cellErrors=[];let hasContent=false;
    for(const [column,key]of headers){
      const cell=sheet.getCell(excelRow,column);if(cell.value!=null&&String(cell.value).trim())hasContent=true;
      const value=readCell(cell,cellErrors);
      if(value.length>IMAGE_BATCH_LIMITS.cellCharacters)cellErrors.push(`${cell.address} 超过 ${IMAGE_BATCH_LIMITS.cellCharacters} 个字符。`);
      totalCharacters+=value.length;if(totalCharacters>IMAGE_BATCH_LIMITS.totalCharacters)throw new Error('Excel 文本总量不能超过 200 万字符，请拆分文件。');
      raw[key]=value;
    }
    if(!hasContent&&!cellErrors.length)continue;
    const row={excelRow,...normalizeImageBatchRow(raw,{existingRows:occupied,settings})};
    row.errors.unshift(...cellErrors);
    if(row.sourceInput&&!row.errors.length){
      let sourceInput=row.sourceInput;
      if(sourceInput.startsWith('"')&&sourceInput.endsWith('"'))sourceInput=sourceInput.slice(1,-1);
      if(process.platform!=='win32'&&/^[a-z]:[\\/]/i.test(sourceInput))row.errors.push('此路径是 Windows 路径，请改为当前电脑的路径或相对路径。');
      else{
        row.resolvedSourcePath=path.resolve(path.dirname(filePath),sourceInput);
        try{
          if(!isLocalImageBatchPath(row.resolvedSourcePath))throw new Error('参考素材路径不支持网络共享或设备路径。');
          let source;
          if(row.outputLocation==='原目录子图'){
            row.outputMapping=await inspectImageTypeFolder(row.resolvedSourcePath);
            row.folderKey=folderKey(row.outputMapping.sourceFolder);
            const mothers=[];
            for(const motherPath of row.outputMapping.motherPaths){
              const resolved=await resolveSource(motherPath);
              if(resolved?.sourceMode==='folder'||resolved?.sourcePaths?.length!==1||folderKey(resolved.sourcePaths[0])!==folderKey(motherPath))throw new Error('母图解析结果发生变化，请重新选择 Excel。');
              mothers.push(motherPath);
            }
            source={sourceMode:'single',sourcePaths:mothers};
            row.values.referenceMode='all';
            row.values.folderName=row.outputMapping.outputPath;
            row.warnings.push(...(row.outputMapping.warnings||[]));
          }else source=await resolveSource(row.resolvedSourcePath);
          if(!source||!Array.isArray(source.sourcePaths)||!source.sourcePaths.length||source.sourcePaths.length>500||!source.sourcePaths.every(file=>typeof file==='string'&&path.isAbsolute(file)))throw new Error('参考素材路径未返回有效图片。');
          row.values.sourceMode=source.sourceMode==='folder'?'folder':'single';row.values.sourcePaths=[...new Set(source.sourcePaths)];
        }catch(error){row.errors.push(error.message||'无法读取参考素材。');}
      }
    }
    if(row.values.code&&!row.errors.length)occupied.push({code:row.values.code});
    rows.push(row);
  }
  if(!rows.length)warnings.push('“任务”表没有填写任务；“说明”和“示例”表不会导入。');
  const validCount=rows.filter(row=>!row.errors.length).length;
  return {filePath,rows,rowCount:rows.length,validCount,invalidCount:rows.length-validCount,reverseCount:rows.filter(row=>!row.errors.length&&row.autoDescribe).length,errors,warnings};
}

export async function writeImageBatchTemplate(filePath,{settings={}}={}){
  const workbook=new ExcelJS.Workbook();workbook.creator='子云影像工坊';
  const tasks=workbook.addWorksheet(IMAGE_BATCH_SHEET,{views:[{state:'frozen',xSplit:2,ySplit:1}]});
  tasks.columns=IMAGE_BATCH_COLUMNS.map(column=>({header:column.title,key:column.key,width:column.width,style:{numFmt:'@',alignment:{vertical:'top',wrapText:true}}}));
  const header=tasks.getRow(1);header.height=30;
  header.eachCell((cell,index)=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF126453'}};cell.font={bold:true,color:{argb:'FFFFFFFF'},size:11};cell.note=IMAGE_BATCH_COLUMNS[index-1].help;});
  tasks.autoFilter='A1:M1';
  tasks.dataValidations.add('F2:F501',{type:'list',allowBlank:true,formulae:['"X"'],showErrorMessage:true,error:'仅填 X 开启自动反推，留空关闭。'});
  tasks.dataValidations.add('H2:H501',{type:'whole',operator:'between',allowBlank:true,formulae:[1,100],showErrorMessage:true,error:'请输入 1–100 的整数。'});
  tasks.dataValidations.add('I2:I501',{type:'list',allowBlank:true,formulae:['"跟随原图,9:16,16:9,1:1,3:4,4:3"']});
  tasks.dataValidations.add('J2:J501',{type:'list',allowBlank:true,formulae:['"1K,2K,4K"']});
  tasks.dataValidations.add('M2:M501',{type:'list',allowBlank:true,formulae:['"系统输出目录,原目录子图"'],showErrorMessage:true,error:'请选择系统输出目录或原目录子图。'});
  const guide=workbook.addWorksheet('说明');guide.columns=[{width:22},{width:34},{width:100}];
  guide.addRow(['填写方式','只填写“任务”表','每行一个图片任务；可以在单元格内换行。示例不参与导入。']);
  guide.addRow(['导入方式','先预览，再确认','只新增任务，不覆盖现有行，不会自动生成图片。']);
  guide.addRow(['自动反推','填写 X 且参考提示词为空','确认导入时显示调用次数；手工提示词始终优先，反推失败行保留供重试。']);
  guide.addRow(['文件范围','本地 .xlsx','不需要嵌入图片；公式与超链接不支持，请粘贴为普通文字或数值。']);
  guide.addRow(['数量限制','500 行 / 10 MiB','每格最多 12000 字符，总文本最多 200 万字符。文件夹只读取直接包含的图片；原目录子图每行最多 16 张母图，会同时作为一组参考。']);
  guide.addRow([]);guide.addRow(['列名称','留空时采用','填写说明']);
  const defaultTemplate=(settings.templates||[]).find(item=>item.id===settings.defaultTemplateId);
  for(const column of IMAGE_BATCH_COLUMNS)guide.addRow([column.title,column.key==='template'?(defaultTemplate?.name||'不使用模板'):column.defaultText,column.help]);
  guide.addRow([]);guide.addRow(['当前项目规范','规范 ID','规范名称']);
  for(const template of settings.templates||[])guide.addRow(['可选规范',template.id,template.name]);
  guide.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};row.height=34;});
  for(const number of [1,7,22]){const row=guide.getRow(number);row.font={bold:true,color:{argb:'FF126453'}};}
  const example=workbook.addWorksheet('示例');example.columns=IMAGE_BATCH_COLUMNS.map(column=>({header:column.title,key:column.key,width:column.width,style:{numFmt:'@',alignment:{vertical:'top',wrapText:true}}}));
  example.addRow({code:'A01',name:'示例：手工提示词',sourceInput:'素材/参考图.png',referencePrompt:'白色背景中的商品包装，保留整体构图。',userPrompt:'替换包装颜色，保留其他内容。'});
  example.addRow({code:'A02',name:'示例：自动反推',sourceInput:'素材/参考图文件夹',userPrompt:'保持界面结构，调整指定图片。',autoDescribe:'X',describeInstructions:'重点描述主体和界面布局，使用中文。',count:3,ratio:'3:4',resolution:'2K',template:'不使用模板'});
  example.addRow({code:'B01',name:'示例：母图目录',sourceInput:'素材/B01-类型名称',userPrompt:'保留母图构图，按本行要求调整。',autoDescribe:'X',outputLocation:'原目录子图'});
  example.getRow(1).font={bold:true,color:{argb:'FF126453'}};for(const number of [2,3,4])example.getRow(number).height=65;
  await workbook.xlsx.writeFile(filePath);
  return {filePath};
}
