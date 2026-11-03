// Reads an explicitly approved existing client-settings JSON in-process.
// Secrets travel only through child stdin to Electron safeStorage, never argv/stdout/files.
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Reuses only the existing approved wrapper's local read-only credential segment.
// Do not import/run its later network/setup actions.
export async function readAuthorizedConfig(wrapperPath) {
  const code=`import ast,json,sys\nfrom pathlib import Path\np=Path(sys.argv[1])\nif p.name!='reuse-cpa.py': raise RuntimeError('unsupported wrapper')\nt=ast.parse(p.read_text(encoding='utf-8'))\ncut=next(i for i,n in enumerate(t.body) if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='remote_models' for x in n.targets))\nns={'__file__':str(p),'__name__':'authorized_local_read'}\nexec(compile(ast.Module(body=t.body[:cut],type_ignores=[]),str(p),'exec'),ns)\njson.dump({'baseUrl':ns['base'],'key':ns['secret']},sys.stdout)\n`;
  const child=spawn('python',['-c',code,path.resolve(wrapperPath)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let result='';let overflow=false;
  child.stdout.on('data',b=>{if(Buffer.byteLength(result)+b.length>65536){overflow=true;child.kill();}else result+=b.toString();});child.stderr.resume();
  const status=await new Promise((resolve,reject)=>{child.on('error',()=>reject(new Error('现有批准配置包装器无法启动。')));child.on('exit',resolve);});
  if(status!==0 || overflow) throw new Error('现有批准配置无法只读解密；未提取其他凭据。');
  let config;try{config=JSON.parse(result);}catch{throw new Error('现有包装器没有返回有效配置。');}
  if(typeof config.key!=='string'||!config.key||typeof config.baseUrl!=='string')throw new Error('现有配置不完整。');
  return config;
}
export async function resolveModels(config) {
  const {runProvider}=await import('../electron/providers.mjs');
  const {models}=await runProvider('models',{}, {provider:{protocol:'openai-chat',baseUrl:config.apiBase||config.baseUrl,key:config.apiKey||config.key,timeoutMs:60000}});
  const preferred=['gpt-4.1-mini','gpt-4o-mini','gemini-3-flash','gemini-3.5-flash-lite','gpt-4.1','gpt-5.1','gpt-5','gpt-4o'];
  const model=config.customModel||config.model||preferred.find(m=>models.includes(m));
  const imageModel=config.imageModel||(models.includes('gpt-image-2')?'gpt-image-2':undefined);
  return {...config,model,imageModel,models};
}

export function makeProviders(config) {
  const baseUrl=config.apiBase || config.baseUrl;
  const key=config.apiKey || config.key;
  if(typeof baseUrl!=='string' || typeof key!=='string' || !key.trim()) throw new Error('原配置缺少客户端服务地址或 API 密钥；不读取服务器凭据。');
  const url=new URL(baseUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw new Error('原配置地址格式无效。');
  const chatModel=config.customModel || config.model;
  const imageModel=config.imageModel;
  const providers=[];
  if(chatModel) providers.push({id:'cpa-vision',name:'CPA 语言/视觉（本机配置）',protocol:'openai-chat',baseUrl,model:chatModel,key,timeoutMs:180000});
  if(imageModel) providers.push({id:'cpa-image',name:'CPA 图片（本机配置）',protocol:'openai-images',baseUrl,model:imageModel,key,timeoutMs:600000});
  if(!providers.length) throw new Error('原配置未指定模型，请在原工具中保存模型后再导入。');
  return {providers,bindings:{...(chatModel?{vision:'cpa-vision'}:{}),...(imageModel?{image:'cpa-image'}:{})}};
}

async function main() {
  const source=process.argv[2];
  const wrapped=source==='--authorized-wrapper';
  if(!source || (source.startsWith('--')&&!wrapped) || (wrapped&&!process.argv[3])) throw new Error('用法：node scripts/configure-cpa.mjs <现有客户端配置.json> [应用.exe]，或 --authorized-wrapper <已批准 reuse-cpa.py> [应用.exe]。密钥不得放在命令参数中。');
  const config=await resolveModels(wrapped?await readAuthorizedConfig(process.argv[3]):JSON.parse(await readFile(path.resolve(source),'utf8')));
  const payload=makeProviders(config);
  const require=createRequire(import.meta.url);
  const installed=process.argv[wrapped?4:3];
  const exe=installed || process.env.ZIYUN_ELECTRON_BINARY || require('electron');
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const args=installed?['--configure-cpa']:['.','--configure-cpa'];
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  // Windows GUI executables do not reliably inherit stdin. An ephemeral local named
  // pipe preserves the process-only transfer without creating a plaintext file.
  let server;let served=false;
  if(process.platform==='win32') {
    const pipeName=`\\\\.\\pipe\\ziyun-cpa-${randomUUID()}`;
    server=createServer(socket=>{if(served){socket.destroy();return;}served=true;socket.on('error',()=>{});socket.end(JSON.stringify(payload));server.close();});
    await new Promise((resolve,reject)=>{server.once('error',()=>reject(new Error('无法建立本机安全导入管道。')));server.listen(pipeName,resolve);});
    env.ZIYUN_CONFIG_PIPE=pipeName;
  }
  let output='';let code;
  try {
    const child=spawn(exe,args,{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    // Never replay arbitrary Electron output; only honor its explicit safe import result.
    child.stdout.on('data',b=>{if(output.length<8192)output+=b.toString();});child.stderr.resume();
    child.stdin.on('error',()=>{});
    child.stdin.end(server?undefined:JSON.stringify(payload));
    code=await new Promise((resolve,reject)=>{child.on('error',()=>reject(new Error('无法启动应用完成安全导入。')));child.on('exit',resolve);});
  } finally {if(server?.listening)server.close();}
  if(code!==0 || !output.includes('CPA_CONFIGURED')) throw new Error('安全导入未完成；请关闭应用后重试，并核对主进程支持 --configure-cpa。');
  console.log(`已通过 Windows 加密存储导入 ${payload.providers.length} 项模型配置；未创建明文密钥副本。`);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{console.error('CPA 导入失败；请核对现有客户端配置文件、模型及应用状态。密钥未输出。');process.exitCode=1;});
