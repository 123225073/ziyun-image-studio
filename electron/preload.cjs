const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('studio',{
 call:async(method,...args)=>{
  const result=await ipcRenderer.invoke('studio:call',method,...args);
  if(result.ok)return result.value;
  // Electron omits custom Error properties across contextBridge. A plain
  // rejection lets the form distinguish a local vault error from validation.
  if(typeof result.code==='string'&&result.code.startsWith('CREDENTIAL_STORAGE_')){
   throw {message:result.error,code:result.code,retryable:result.retryable===true};
  }
  throw new Error(result.error);
 },
 onChange:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('studio:changed',listener);return()=>ipcRenderer.removeListener('studio:changed',listener);},
 chooseFiles:kind=>ipcRenderer.invoke('studio:files',kind),chooseFolder:purpose=>ipcRenderer.invoke('studio:folder',purpose),
 importDroppedImages:async files=>{const paths=Array.from(files).map(file=>webUtils.getPathForFile(file));const result=await ipcRenderer.invoke('studio:reference-drop',paths);if(!result.ok)throw new Error(result.error);return result.value;},
 openOutput:ids=>ipcRenderer.invoke('studio:open-output',ids),
 mediaUrl:file=>`studio-media://local/?path=${encodeURIComponent(file)}`,
 reveal:file=>ipcRenderer.invoke('studio:reveal',file),window:action=>ipcRenderer.invoke('studio:window',action),
});
