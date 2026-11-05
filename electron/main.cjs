const {app,BrowserWindow,ipcMain,dialog,shell,safeStorage,protocol,net}=require('electron');
const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');const {pathToFileURL}=require('node:url');const {Readable}=require('node:stream');const {randomUUID}=require('node:crypto');
protocol.registerSchemesAsPrivileged([{scheme:'studio-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
let win,service,vault={},vaultFile,quitting=false,unsaved=false;
const root=path.resolve(__dirname,'..');
app.setName('子云影像工坊');
if(process.env.ZIYUN_DATA_DIR)app.setPath('userData',path.resolve(process.env.ZIYUN_DATA_DIR));
const dataDir=app.getPath('userData');
async function persistVault(){await fsp.mkdir(dataDir,{recursive:true});const temp=vaultFile+'.tmp';await fsp.writeFile(temp,JSON.stringify(vault),{mode:0o600});await fsp.rename(temp,vaultFile);}
function keyFor(id){if(!vault[id])return '';if(!safeStorage.isEncryptionAvailable())throw new Error('Windows安全存储不可用，无法读取模型密钥。');return safeStorage.decryptString(Buffer.from(vault[id],'base64'));}
const accountVaultId=id=>'oairegbox-account:'+id;
async function saveProvider(provider){
 const {oairegboxBase,h3Model}=await import('../shared/oairegbox.mjs');
 if(!provider||typeof provider!=='object')throw new Error('模型配置无效。');
 const id=String(provider.id||randomUUID());if(!/^[\w-]{1,100}$/.test(id))throw new Error('连接编号无效。');const state=await service.getState();const previous=state.settings.providers.find(p=>p.id===id);
 const allowed=['openai-chat','openai-images','openai-tts','doubao-tts','minimax-tts','minimax-video','replicate-video','oairegbox-video'];if(!allowed.includes(provider.protocol))throw new Error('请选择支持的接入协议。');
 const url=new URL(provider.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('服务地址格式无效。');
 const isOairegbox=provider.protocol==='oairegbox-video';
 const baseUrl=isOairegbox?oairegboxBase(provider.baseUrl):url.href.replace(/\/$/,'');
 const accountId=accountVaultId(id),oldAccount=vault[accountId];
 const newAccount=isOairegbox?String(provider.accountToken||'').trim():'';
 if(isOairegbox&&!h3Model(provider.model))throw new Error('请选择 OAIREGBOX H3 型号。');
 if(isOairegbox&&provider.key?.trim()&&!provider.key.trim().startsWith('sk-'))throw new Error('请在 API Key 填写 sk- 开头的调用令牌。');
 if(newAccount&&(newAccount.startsWith('sk-')||newAccount.length>4096||/\s/.test(newAccount)))throw new Error('请填写个人设置中的账号访问令牌。');
 if(!provider.name?.trim()||!provider.model?.trim())throw new Error('请填写连接名称和模型标识。');
 const referenced=state.jobs.filter(j=>j.providerId===id);
 if(previous&&referenced.length&&(previous.baseUrl!==baseUrl||previous.protocol!==provider.protocol))throw new Error('此连接已有任务历史，修改地址或协议请新建连接，避免旧任务把密钥发往其他地址。');
 if(previous&&referenced.some(j=>['queued','planning','running','saving','unknown'].includes(j.status))&&(provider.key?.trim()||previous.model!==provider.model))throw new Error('此连接还有未完成或状态未知的任务；更换密钥或模型请新建连接。');
 const old=vault[id];
 if(!old&&!provider.key?.trim())throw new Error('请填写 API Key。');
 if((provider.key?.trim()||newAccount)&&!safeStorage.isEncryptionAvailable())throw new Error('系统安全存储不可用，未保存凭据。');
 try{
  if(provider.key?.trim())vault[id]=safeStorage.encryptString(provider.key.trim()).toString('base64');
  if(!isOairegbox||provider.clearAccountToken)delete vault[accountId];
  else if(newAccount)vault[accountId]=safeStorage.encryptString(newAccount).toString('base64');
  await persistVault();
  const publicProvider={id,name:provider.name.trim(),protocol:provider.protocol,baseUrl,model:provider.model.trim(),timeoutMs:Number(provider.timeoutMs)||180000,hasKey:true,...(isOairegbox?{hasAccountToken:Boolean(vault[accountId])}:{})};
  if(provider.protocol==='doubao-tts'){
   publicProvider.resourceId=String(provider.resourceId||provider.model||'seed-tts-2.0').trim();
   if(!/^[a-zA-Z0-9._-]{1,120}$/.test(publicProvider.resourceId))throw new Error('豆包资源ID格式无效。');
  }
  await service.updateSettings({providers:[...state.settings.providers.filter(p=>p.id!==id),publicProvider]});
  return publicProvider;
 }catch(e){
  if(old)vault[id]=old;else delete vault[id];
  if(oldAccount)vault[accountId]=oldAccount;else delete vault[accountId];
  await persistVault().catch(()=>{});
  throw e;
 }
}
async function removeProvider(id){const state=await service.getState();if(state.jobs.some(j=>j.providerId===id&&['running','saving','queued','planning','unknown'].includes(j.status)))throw new Error('此连接仍有未完成或状态未知的任务，请先核对任务后再删除。');if(state.settings.speechPresets?.some(p=>p.providerId===id))throw new Error('请先删除或更换使用此连接的配音预设。');const bindings={...state.settings.bindings};for(const k of Object.keys(bindings))if(bindings[k]===id)bindings[k]='';await service.updateSettings({providers:state.settings.providers.filter(p=>p.id!==id),bindings});delete vault[id];delete vault[accountVaultId(id)];await persistVault();}
const selectedPaths=new Set();
async function allowedPaths(){const s=await service.getState();const sectionMedia=sections=>(Array.isArray(sections)?sections:Object.values(sections||{})).flatMap(seg=>[...(seg.paths||[]),seg.audioPath,...(seg.shots||[]).map(shot=>shot.path)]).filter(Boolean);const files=[...selectedPaths,...(s.montageDrafts||[]).flatMap(d=>[d.config?.openingPath,d.config?.masterAudioPath,...(d.timeline?.clips||[]).map(c=>c.path)]),...(s.montageSetup?.sections||[]).flatMap(section=>section.paths||[]),s.montageSetup?.masterAudioPath,s.montageSetup?.openingPath,...s.assets.map(a=>a.path),...(s.montageAssets||[]).flatMap(a=>[a.path,...(a.shots||[]).map(shot=>shot.thumbnailPath)]),...s.rows.flatMap(r=>r.sourcePaths||[]),...s.jobs.flatMap(j=>[j.localPath,...(j.referencePaths||[]),j.snapshot?.config?.openingPath,j.snapshot?.config?.masterAudioPath,...sectionMedia(j.snapshot?.config?.segments),...(j.timeline?.clips||[]).map(c=>c.path),...(j.snapshot?.config?.timeline?.clips||[]).map(c=>c.path)]),...s.formulas.flatMap(f=>[f.openingPath,f.masterAudioPath,...sectionMedia(f.sections)])].filter(Boolean);return new Set(files.map(p=>path.resolve(p).toLowerCase()));}
function checkSender(event){if(!win||event.sender.id!==win.webContents.id||event.senderFrame!==win.webContents.mainFrame)throw new Error('此窗口没有操作权限。');}
function mediaHeaders(file){const ext=path.extname(file).toLowerCase();return {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg'}[ext];}
async function setup(){
 if(!app.requestSingleInstanceLock()){if(process.argv.includes('--configure-cpa')){process.stderr.write('请先关闭应用，再导入测试配置。\n');app.exit(1);}else app.quit();return;}
 app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
 vaultFile=path.join(dataDir,process.platform==='darwin'?'credentials.keychain.json':'credentials.dpapi.json');try{vault=JSON.parse(await fsp.readFile(vaultFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('加密配置无法读取，请保留数据目录并检查文件。');}
 const {StudioService}=await import('./service.mjs');const {runProvider,sniffMedia,readOairegboxDashboard}=await import('./providers.mjs');const {renderMontage,readMontageTimeline,prepareMontageTimeline,mediaDuration,resolveFfmpeg,runMedia}=await import('./render.mjs');
 const {scanMontageFolder}=await import('./montage-library.mjs');
 const {TTS_PROTOCOLS}=await import('../shared/speech.mjs');
 const {normalizeTimeline}=await import('../shared/timeline.mjs');
 const {OAIREGBOX_BASE,OAIREGBOX_CONSOLE,oairegboxBase}=await import('../shared/oairegbox.mjs');
 const ffmpegPath=await resolveFfmpeg(app.isPackaged?process.resourcesPath:root,dataDir);
 const providerRunner=async(op,payload,context)=>runProvider(op,payload,{...context,inspectDuration:(file,signal)=>mediaDuration(ffmpegPath,file,signal),provider:{...context.provider,key:keyFor(context.provider.id)}});
 const concatSpeech=async(files,output,options,signal)=>{
  const directory=path.dirname(output);
  const list=path.join(directory,`${path.basename(output)}.txt`);
  if(files.some(file=>path.dirname(file)!==directory||!/^[a-f0-9]+\.(mp3|wav)$/.test(path.basename(file))))throw new Error('配音拼接文件位置无效。');
  await fsp.writeFile(list,files.map(file=>`file '${path.basename(file)}'`).join('\n'));
  const temporary=path.join(directory,`${path.basename(output)}.part`);
  try{
   await runMedia(ffmpegPath,['-hide_banner','-loglevel','error','-y','-f','concat','-safe','1','-i',path.basename(list),'-ar',String(options.sampleRate),'-ac','1','-c:a',options.format==='wav'?'pcm_s16le':'libmp3lame','-f',options.format==='wav'?'wav':'mp3',path.basename(temporary)],{cwd:directory,signal});
   await fsp.rename(temporary,output);
  }finally{await fsp.unlink(list).catch(()=>{});await fsp.unlink(temporary).catch(()=>{});}
 };
 service=await StudioService.create({dataDir,providerRunner,inspectAudio:(file,signal)=>mediaDuration(ffmpegPath,file,signal),concatSpeech,montageScanner:(folder,options)=>scanMontageFolder(folder,{...options,ffmpegPath,indexDir:path.join(dataDir,'montage-index')}),videoDownloadFetch:(url,options)=>net.fetch(url,{...options,credentials:'omit'}),renderRunner:async(config,context)=>{const s=await service.getState();const segments=(config.segments||[]).map(seg=>({...seg,paths:[...(seg.paths||[]),...s.assets.filter(a=>(seg.assetIds||[]).includes(a.id)).map(a=>a.path)]}));return renderMontage({...config,segments},{...context,ffmpegPath});},onChange:s=>{if(win&&!win.isDestroyed())win.webContents.send('studio:changed',s);}});
 service.prepareTimeline=config=>prepareMontageTimeline(config,{},ffmpegPath);
 protocol.handle('studio-media',async request=>{
  try{const url=new URL(request.url);const file=path.resolve(url.searchParams.get('path')||'');if(!(await allowedPaths()).has(file.toLowerCase())||!mediaHeaders(file))return new Response('Denied',{status:403});const stat=await fsp.stat(file);if(!stat.isFile())return new Response('Missing',{status:404});const handle=await fsp.open(file,'r');const bytes=Buffer.alloc(32);await handle.read(bytes,0,32,0);await handle.close();if(!sniffMedia(bytes))return new Response('Invalid media',{status:415});
   const range=request.headers.get('range');let start=0,end=stat.size-1,status=200;const headers={'Content-Type':mediaHeaders(file),'Accept-Ranges':'bytes','Cache-Control':'no-store'};
   if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match)return new Response('',{status:416});if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}else{start=Math.max(0,stat.size-Number(match[2]));}if(start>end||start>=stat.size)return new Response('',{status:416,headers:{'Content-Range':`bytes */${stat.size}`}});status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;}
   headers['Content-Length']=String(end-start+1);return new Response(Readable.toWeb(fs.createReadStream(file,{start,end})),{status,headers});
  }catch{return new Response('Missing',{status:404});}
 });
 if(process.argv.includes('--configure-cpa')){
  const input=process.env.ZIYUN_CONFIG_PIPE?require('node:net').createConnection(process.env.ZIYUN_CONFIG_PIPE):process.stdin;if(input!==process.stdin)input.setTimeout(15000,()=>input.destroy(new Error('本机配置通道超时。')));let text='';for await(const chunk of input){text+=chunk.toString();if(Buffer.byteLength(text)>131072){input.destroy();throw new Error('配置输入过大。');}}const config=JSON.parse(text);if(!Array.isArray(config.providers)||config.providers.length>8)throw new Error('配置格式错误。');for(const p of config.providers)await saveProvider(p);await service.updateSettings({bindings:config.bindings||{}});await service.close();process.stdout.write('CPA_CONFIGURED\n');app.exit(0);return;
 }
 const methods=new Set(['getState','reorderRows','saveRowCode','saveMontageSetup','createMontageDraft','updateSettings','saveRow','deleteRow','importFiles','scanFolder','enqueueImages','enqueueVideo','enqueueMontage','enqueueSpeech','planMontage','editMontageShot','retryJobs','selectJobs','setPaused','exportJobs','saveFormula','describe','rewritePrompt','deleteFailedImages','archiveImages','saveTimeline','openTimeline','enqueueTimeline']);
 ipcMain.handle('studio:call',async(event,method,...args)=>{try{checkSender(event);if(method==='saveProvider')return {ok:true,value:await saveProvider(args[0])};if(method==='deleteProvider'){await removeProvider(args[0]);return {ok:true};}if(method==='fetchProviderModels'){
    const draft=args[0] || {};
    const state=await service.getState();
    const saved=state.settings.providers.find(item=>item.id===draft.id);
    const address=new URL(draft.baseUrl);
    if(!['http:','https:'].includes(address.protocol)||address.username||address.password||address.search||address.hash)throw new Error('服务地址格式无效。');
    const baseUrl=draft.protocol==='oairegbox-video'?oairegboxBase(draft.baseUrl):address.href.replace(/\/$/,'');
    const sameConnection=saved&&saved.baseUrl===baseUrl&&saved.protocol===draft.protocol;
    const key=draft.key?.trim()||(sameConnection?keyFor(saved.id):'');
    if(!key)throw new Error('请填写当前接口的 API Key。');
    return {ok:true,value:await runProvider('models',{}, {provider:{baseUrl,protocol:draft.protocol,key,model:draft.model||'',resourceId:draft.resourceId,timeoutMs:15000}})};
   }if(method==='readOairegboxDashboard'){
    const id=args[0];
    const p=(await service.getState()).settings.providers.find(item=>item.id===id&&item.protocol==='oairegbox-video');
    if(id&&!p)throw new Error('请先保存 OAIREGBOX 视频连接。');
    return {ok:true,value:await readOairegboxDashboard({baseUrl:p?.baseUrl||OAIREGBOX_BASE,key:p?keyFor(p.id):'',accountToken:p?keyFor(accountVaultId(p.id)):''})};
   }if(method==='openProviderHelp'){
    const {providerHelpUrl}=await import('../shared/model-settings.mjs');
    const input=args[0]||{};
    await shell.openExternal(providerHelpUrl({protocol:input.protocol,baseUrl:input.baseUrl},input.page));
    return {ok:true};
   }if(method==='openH3Guide'){
    const guide=args[0]===true?'ref-en.txt':'base-en.txt';
    await shell.openExternal('https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/'+guide);
    return {ok:true};
   }if(method==='openOairegboxPage'){
    const routes={home:'/',register:'/register',topup:'/console/topup',token:'/console/token',logs:'/console/log',profile:'/console/personal'};
    const route=Object.hasOwn(routes,args[0])?routes[args[0]]:null;
    if(!route)throw new Error('未知的 OAIREGBOX 页面。');
    await shell.openExternal(OAIREGBOX_CONSOLE+route);
    return {ok:true};
   }if(method==='testProvider'||method==='models'){const s=await service.getState();const p=s.settings.providers.find(p=>p.id===(typeof args[0]==='string'?args[0]:args[0]?.id));if(!p)throw new Error('请先保存连接。');const result=await providerRunner('models',{}, {provider:p});return {ok:true,value:{ok:true,message:TTS_PROTOCOLS.includes(p.protocol)?'语音配置已校验，型号来自官方目录。账号权限请通过生成试听验证。':`已连接，返回${result.models?.length||0}个模型。此检查不代表所有生成能力通过。`,models:result.models,detail:result.text}};}
   if(method==='scanMontageLibrary'){
    const input={...args[0]};
    if(!input.assetIds?.length){
     if(!input.folder){const result=await dialog.showOpenDialog(win,{title:'选择混剪素材文件夹',properties:['openDirectory']});if(result.canceled)return {ok:true,value:{assets:[]}};input.folder=result.filePaths[0];selectedPaths.add(input.folder);}
     const state=await service.getState();
     const folder=path.resolve(input.folder);
     if(!selectedPaths.has(folder)&&!(state.montageFolders||[]).includes(folder))throw new Error('请通过文件夹选择器导入混剪素材。');
    }
    return {ok:true,value:await service.scanMontageLibrary(input)};
   }
   if(method==='enqueueMontage'||method==='planMontage'||method==='createMontageDraft'){
    const allowed=await allowedPaths();
    const config=args[0]||{};
    const files=[config.masterAudioPath,config.openingPath,...(config.segments||[]).flatMap(segment=>[segment.audioPath,...(segment.paths||[]),...(segment.shots||[]).map(shot=>shot.path)])].filter(Boolean);
    if(files.some(file=>!allowed.has(path.resolve(file).toLowerCase())))throw new Error('请先导入混剪素材和配音。');
   }
   if(method==='openTimeline'){
    const record=await service.openTimeline(args[0]);
    if(!record.timeline)record.timeline=await readMontageTimeline(service.completedMontage(args[0]),ffmpegPath);
    record.timeline=normalizeTimeline(record.timeline);
    for(const clip of record.timeline.clips)if(clip.path)selectedPaths.add(clip.path);
    return {ok:true,value:record};
   }
   if(method==='timelineMediaDuration'){
    const file=path.resolve(args[0]);
    if(!(await allowedPaths()).has(file.toLowerCase()))throw new Error('请先导入素材。');
    return {ok:true,value:await mediaDuration(ffmpegPath,file)};
   }
   if(method==='saveTimeline'||method==='enqueueTimeline'||method==='exportJianying'){
    const allowed=await allowedPaths();
    for(const clip of args[1]?.clips||[])if(clip.path&&!allowed.has(path.resolve(clip.path).toLowerCase()))throw new Error('请先导入时间轴素材。');
   }
   if(method==='exportJianying'){
    const record=await service.openTimeline(args[0]);
    const state=await service.getState();
    const root=state.settings.jianyingDraftRoot;
    if(!root)throw new Error('请先选择剪映草稿根目录。');
    const {exportJianying}=await import('./jianying.mjs');
    const result=await exportJianying(args[1],{root,name:record.name,ffmpeg:ffmpegPath});
    await service.saveTimeline(args[0],args[1]);
    return {ok:true,value:result};
   }
   if(method==='setUnsaved'){unsaved=Boolean(args[0]);return {ok:true};}if(!methods.has(method))throw new Error('不支持的操作。');if(method==='updateSettings'&&args[0]?.providers)throw new Error('连接请通过专用保存操作维护。');const value=await service[method](...args);if(method==='scanFolder')for(const p of value)selectedPaths.add(p);return {ok:true,value};
  }catch(e){return {ok:false,error:typeof e.message==='string'?e.message:'操作失败。'};}});
 const isDirectory=async dir=>path.isAbsolute(dir||'')&&(await fsp.stat(dir).catch(()=>null))?.isDirectory();
 async function imageDefaultPath(){
  const {settings,rows}=await service.getState();
  if(await isDirectory(settings.lastImageDirectory))return settings.lastImageDirectory;
  for(const row of rows.slice().reverse()){
   const source=row.sourcePaths?.[0];
   if(source&&await isDirectory(path.dirname(source)))return path.dirname(source);
  }
 }
 ipcMain.handle('studio:files',async(event,kind)=>{
  checkSender(event);
  const images=['png','jpg','jpeg','webp','gif','bmp'];
  const extensions=kind==='h3-reference'?[...images,'mp4','mov','mp3','wav']:kind==='video'?['mp4','mov','webm']:kind==='media'?[...images,'mp4','mov','webm']:kind==='audio'?['mp3','wav','m4a','aac','ogg']:images;
  const defaultPath=kind==='image'?await imageDefaultPath():undefined;
  const result=await dialog.showOpenDialog(win,{title:'选择素材文件',...(defaultPath?{defaultPath}:{}),properties:['openFile','multiSelections'],filters:[{name:'素材文件',extensions}]});
  if(result.canceled||!result.filePaths.length)return [];
  if(kind==='image')await service.updateSettings({lastImageDirectory:path.dirname(result.filePaths[0])});
  for(const file of result.filePaths)selectedPaths.add(file);
  return result.filePaths;
 });
 ipcMain.handle('studio:reference-drop',async(event,paths)=>{
  try{checkSender(event);const result=await service.prepareReferenceDrop(paths);for(const file of result.sourcePaths)selectedPaths.add(file);await service.updateSettings({lastImageDirectory:path.dirname(result.sourcePaths[0])});return {ok:true,value:result};}
  catch(error){return {ok:false,error:error.message||'拖入图片失败。'};}
 });
 ipcMain.handle('studio:folder',async(event,purpose)=>{
  checkSender(event);
  const defaultPath=purpose==='image'?await imageDefaultPath():undefined;
  const result=await dialog.showOpenDialog(win,{title:'选择文件夹',...(defaultPath?{defaultPath}:{}),properties:['openDirectory','createDirectory']});
  const selected=result.canceled?null:result.filePaths[0];
  if(selected)selectedPaths.add(selected);
  if(selected&&purpose==='image')await service.updateSettings({lastImageDirectory:selected});
  return selected;
 });
 ipcMain.handle('studio:open-output',async(event,ids)=>{
  checkSender(event);
  const {settings,jobs}=await service.getState();
  let directory=settings.outputDir;
  if(Array.isArray(ids)){
   const selected=new Set(ids);
   const matching=jobs.filter(job=>selected.has(job.id)&&job.kind==='image'&&job.status==='succeeded').reverse();
   directory='';
   for(const key of ['exportedPath','localPath']){
    for(const job of matching){
     const file=job[key];
     if(path.isAbsolute(file||'')&&(await fsp.stat(file).catch(()=>null))?.isFile()){directory=path.dirname(file);break;}
    }
    if(directory)break;
   }
  }
  if(!await isDirectory(directory))throw new Error('输出文件夹不存在或暂不可访问。');
  if(await shell.openPath(directory))throw new Error('无法打开输出文件夹。');
 });
 ipcMain.handle('studio:reveal',async(event,file)=>{checkSender(event);if(!file||!(await allowedPaths()).has(path.resolve(file).toLowerCase()))throw new Error('只允许打开项目中已登记的素材。');shell.showItemInFolder(path.resolve(file));});
 ipcMain.handle('studio:window',(event,action)=>{checkSender(event);if(action==='minimize')win.minimize();else if(action==='maximize')win.isMaximized()?win.unmaximize():win.maximize();else if(action==='close')win.close();});
 win=new BrowserWindow({width:1513,height:1035,minWidth:1050,minHeight:680,title:'子云影像工坊',backgroundColor:'#fafbfa',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:!app.isPackaged||process.env.ZIYUN_SMOKE==='1'}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,url)=>{if(url!==win.webContents.getURL())event.preventDefault();});
 win.once('ready-to-show',()=>win.show());const dev=process.env.ZIYUN_DEV_URL;if(dev){const u=new URL(dev);if(u.hostname!=='127.0.0.1')throw new Error('开发服务器仅允许本机地址。');await win.loadURL(dev);}else await win.loadFile(path.join(root,'dist','index.html'));
 win.on('close',event=>{if(!quitting){event.preventDefault();quitSafely();}});
}
async function quitSafely(){
 if(quitting)return;
 const state=await service.getState();
 const active=state.jobs.filter(job=>['running','planning','saving','queued'].includes(job.status));
 if(service.preparingDraft){if(win&&!win.isDestroyed())await dialog.showMessageBox(win,{type:'info',message:'正在准备混剪草稿，请先停止后续任务，等待当前配音和素材处理完成后再退出。'});return;}
 if((active.length||unsaved)&&win&&!win.isDestroyed()){
  const result=await dialog.showMessageBox(win,{
   type:'question',title:unsaved?'修改尚未保存':'任务尚未结束',
   message:unsaved?'有未保存的行配置或时间轴修改。':`还有${active.length}个任务未结束。`,
   detail:(unsaved?'请返回保存行配置或时间轴草稿。继续退出会放弃这些修改。\n':'')+'任务记录将保存；已提交的远端请求可能仍会执行和计费，重新启动后会核对原任务。',
   buttons:['留在应用',unsaved?'放弃未保存修改并退出':'保存并退出'],defaultId:0,cancelId:0,
  });
  if(result.response!==1)return;
 }
 quitting=true;await service.close();app.quit();
}
app.whenReady().then(setup).catch(e=>{const message=e.message||'启动失败';if(process.argv.includes('--configure-cpa')){process.stderr.write('安全配置导入失败。\n');app.exit(1);}else{dialog.showErrorBox('子云影像工坊无法启动',message);app.exit(1);}});
app.on('before-quit',event=>{if(service&&!quitting){event.preventDefault();quitSafely();}});app.on('window-all-closed',()=>{if(quitting)app.quit();});
