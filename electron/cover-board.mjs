import {fileURLToPath, pathToFileURL} from 'node:url';

export async function withCoverBoardRenderer(service, work) {
  if (service.renderCoverBoard) return work(service.renderCoverBoard);
  const {BrowserWindow} = await import('electron');
  const window = new BrowserWindow({show:false, skipTaskbar:true,
    webPreferences:{nodeIntegration:false, contextIsolation:true, sandbox:true, backgroundThrottling:false}});
  try {
    await window.loadFile(fileURLToPath(new URL('./cover-board.html',import.meta.url)));
    return await work(async (title, sources) => {
      const input = {title, sources:sources.map(({path,label})=>({url:pathToFileURL(path).href,label}))};
      const encoded = await window.webContents.executeJavaScript('window.drawCoverBoard(' + JSON.stringify(input) + ')');
      return Buffer.from(encoded,'base64');
    });
  } finally {if (!window.isDestroyed()) window.destroy();}
}
