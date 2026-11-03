const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('studio',{
 call:async(method,...args)=>{const r=await ipcRenderer.invoke('studio:call',method,...args);if(!r.ok)throw new Error(r.error);return r.value;},
 onChange:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('studio:changed',listener);return()=>ipcRenderer.removeListener('studio:changed',listener);},
 chooseFiles:kind=>ipcRenderer.invoke('studio:files',kind),chooseFolder:purpose=>ipcRenderer.invoke('studio:folder',purpose),
 openOutput:ids=>ipcRenderer.invoke('studio:open-output',ids),
 mediaUrl:file=>`studio-media://local/?path=${encodeURIComponent(file)}`,
 reveal:file=>ipcRenderer.invoke('studio:reveal',file),window:action=>ipcRenderer.invoke('studio:window',action),
});
