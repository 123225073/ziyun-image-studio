// Explicitly invoked development probe. Never bundled and never runs at app startup.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProvider,downloadMedia,sniffMedia,imageDimensions} from '../electron/providers.mjs';
import {readAuthorizedConfig,resolveModels} from './configure-cpa.mjs';

async function stdinConfig() {
  let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>65536)throw new Error('输入过大。');}return JSON.parse(input);
}
async function main() {
  const argv=process.argv.slice(2);const wrapped=argv[0]==='--authorized-wrapper';
  const config=await resolveModels(wrapped?await readAuthorizedConfig(argv[1]):await stdinConfig());
  const paths=argv.slice(wrapped?2:0);const source=paths.find(x=>!x.startsWith('--'));
  const modelsOnly=argv.includes('--models-only');
  console.log(JSON.stringify({stage:'models',models:config.models,selectedVision:config.model||null,selectedImage:config.imageModel||null}));
  if(modelsOnly)return;
  if(!source || !path.isAbsolute(source))throw new Error('需要明确指定本机参考原图绝对路径。');
  // Check readability before spending tokens; no source file is overwritten.
  await readFile(source);
  const base={baseUrl:config.apiBase||config.baseUrl,key:config.apiKey||config.key,timeoutMs:600000};
  if(!config.model)throw new Error('未找到已确认的视觉候选型号。');
  const description=await runProvider('describe',{referencePaths:[source]}, {provider:{...base,protocol:'openai-chat',model:config.model}});
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','test-output','cpa-live');
  await mkdir(root,{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  await writeFile(path.join(root,`vision-${stamp}.txt`),description.text,'utf8');
  console.log(JSON.stringify({stage:'vision',ok:true,model:config.model,characters:description.text.length}));
  if(argv.includes('--vision-only'))return;
  if(!config.imageModel)throw new Error('账号模型列表没有已配置生图型号，不发起试错生成。');
  const started=Date.now();
  const result=await runProvider('image',{referencePaths:[source],ratio:'1:1',resolution:'1K',quality:'low',prompt:'用这张参考图作图片编辑测试：保留主要主体与整体风格，画面边缘增加一道细蓝色边框。生成一张 1:1 图片。不要添加其他文字。'}, {provider:{...base,protocol:'openai-images',model:config.imageModel}});
  const first=result.images[0];const media=first.bytes?first:await downloadMedia(first.url,{kind:'image',timeoutMs:180000});
  const target=path.join(root,`reference-edit-${stamp}.${media.mime==='image/jpeg'?'jpg':media.mime==='image/webp'?'webp':'png'}`);
  await writeFile(target,media.bytes,{flag:'wx'});
  console.log(JSON.stringify({stage:'image-reference-edit',ok:true,model:config.imageModel,bytes:media.bytes.length,...imageDimensions(sniffMedia(media.bytes),first.requestedSize),elapsedMs:Date.now()-started,output:target}));
}
main().catch(e=>{console.error(JSON.stringify({ok:false,code:typeof e.code==='string'?e.code:'CPA_TEST_FAILED',unknown:!!e.unknown,message:e.code?.startsWith?.('PROVIDER_')?e.message:'本机 CPA 验证未完成；请核对已授权配置、模型与参考素材。私密配置未输出。'}));process.exitCode=1;});
