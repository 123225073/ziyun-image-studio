import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// Only disposable credentials are used. No screenshot, trace, request header,
// ciphertext or form value is written to the acceptance report.
const root = path.resolve(import.meta.dirname, '..');
await fs.mkdir(path.join(root,'test-output'), { recursive:true });
const output = await fs.mkdtemp(path.join(root,'test-output','credential-storage-'));
const data = path.join(output,'workspace');
const vaultFile = path.join(data, process.platform === 'darwin' ? 'credentials.keychain.json' : 'credentials.dpapi.json');
const tokens = Array.from({length:3}, () => randomBytes(32).toString('hex'));
const [legacyToken, firstToken, replacementToken] = tokens;
const legacyId = 'legacy-credential-check';
const env = { ...process.env, ZIYUN_DATA_DIR:data, ZIYUN_SMOKE:'1' };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.ZIYUN_TEST_EXE || createRequire(import.meta.url)('electron');
let app, child, page, expectedToken, requests = 0, authenticated = 0, logLeak = false, pageErrors = 0, stage = 0;
const containsToken = value => tokens.some(token => String(value).includes(token));
const scrub = value => tokens.reduce((message, token) => message.replaceAll(token,'[REDACTED]'), String(value));
const inspectLog = value => { if (containsToken(value)) logLeak = true; };
const server = http.createServer((req,res) => {
  requests++;
  const ok = req.method === 'GET' && ['/v1/models','/retry/v1/models'].includes(req.url) &&
    Boolean(expectedToken && req.headers.authorization === `Bearer ${expectedToken}`);
  if (ok) authenticated++;
  res.writeHead(ok ? 200 : 401, {'Content-Type':'application/json'});
  res.end(JSON.stringify(ok ? {data:[{id:'catalog-returned-model'}]} : {error:'Unexpected test request'}));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`, baseUrl = origin + '/v1';
const call = (method,...args) => page.evaluate(([method,args]) => window.studio.call(method,...args),[method,args]);
const button = (scope,name) => scope.getByRole('button',{name,exact:true});
const editor = title => page.getByRole('dialog',{name:title,exact:true});
const getState = async () => {
  const state = await call('getState');
  assert.ok(!containsToken(JSON.stringify(state)),'A credential appeared in public state');
  return state;
};
const credentialBytes = () => fs.readFile(vaultFile);
async function launch() {
  // Providing executablePath to _electron.launch skips Playwright's Chromium
  // loader. Also check the actual switches before the first encryption call.
  app = await electron.launch({executablePath,args:process.env.ZIYUN_TEST_EXE ? [] : [root],env,timeout:60000});
  child=app.process();
  app.on('console', message => inspectLog(message.text()));
  for (const stream of [child.stdout,child.stderr]) stream?.on('data', chunk => inspectLog(chunk.toString()));
  page = await app.firstWindow();
  await page.waitForLoadState('load');
  page.setDefaultTimeout(20000);
  page.on('console', message => inspectLog(message.text()));
  page.on('pageerror', error => { pageErrors++; inspectLog(error.message); });
  await page.getByTestId('add-row').waitFor();
  const native = await app.evaluate(async ({app,safeStorage}) => ({
    real: !app.commandLine.hasSwitch('use-mock-keychain') && app.commandLine.getSwitchValue('password-store') !== 'basic',
    available:await safeStorage.isAsyncEncryptionAvailable(),
  }));
  assert.ok(native.real,'The browser was started with a mock keychain or basic password storage');
  assert.ok(native.available,'Native asynchronous secure storage is unavailable on this test runner');
  await page.getByTestId('settings-nav').click();
  await page.getByRole('tab',{name:/图片生成/}).click();
}
async function close() {
  if (!app) return;
  if (child.exitCode!==null || child.signalCode) { app=undefined; child=undefined; page=undefined; return; }
  // This exact isolated userData will reopen immediately on the next launch.
  await app.evaluate(({app}) => app.releaseSingleInstanceLock()).catch(() => {});
  let timer;
  const exited=new Promise((resolve,reject) => {
    if (child.exitCode!==null || child.signalCode) { resolve(); return; }
    child.once('exit',resolve);
    timer=setTimeout(() => reject(new Error('The isolated application did not exit')),20000);
  });
  try { await Promise.all([app.close(),exited]); }
  finally { clearTimeout(timer); app=undefined; child=undefined; page=undefined; }
}
async function installFaultController() {
  await app.evaluate(({safeStorage},file) => {
    const state = { mode:'normal', syncCalls:0, checks:0, encrypts:0, decrypts:0, denied:0, writeFailures:0 };
    globalThis.__credentialCheck = state;
    const available = safeStorage.isAsyncEncryptionAvailable.bind(safeStorage);
    const encrypt = safeStorage.encryptStringAsync.bind(safeStorage);
    const decrypt = safeStorage.decryptStringAsync.bind(safeStorage);
    safeStorage.isEncryptionAvailable = () => { state.syncCalls++; return false; };
    safeStorage.encryptString = safeStorage.decryptString = () => { state.syncCalls++; throw new Error('Unexpected synchronous credential operation'); };
    safeStorage.isAsyncEncryptionAvailable = async () => {
      state.checks++;
      if (state.mode === 'unavailable') return false;
      return available();
    };
    safeStorage.encryptStringAsync = async text => {
      state.encrypts++;
      if (state.mode === 'denied') { state.denied++; throw new Error('Test operating system denied keychain access'); }
      return encrypt(text);
    };
    safeStorage.decryptStringAsync = async bytes => { state.decrypts++; return decrypt(bytes); };
    const fileSystem = process.getBuiltinModule('node:fs/promises');
    const rename = fileSystem.rename;
    fileSystem.rename = async (source,target) => {
      if (state.mode === 'fail-delete-write' && target === file) {
        state.mode='normal'; state.writeFailures++;
        const error=new Error('Test vault replacement denied'); error.code='EACCES'; throw error;
      }
      return rename.call(fileSystem,source,target);
    };
  }, vaultFile);
}
const mode = value => app.evaluate((_,value) => { globalThis.__credentialCheck.mode=value; },value);
const stats = () => app.evaluate(() => ({...globalThis.__credentialCheck}));
async function fetchSaved(id,expected) {
  const provider=(await getState()).settings.providers.find(item => item.id === id);
  assert.ok(provider,'Saved provider is missing');
  const before=requests; expectedToken=expected;
  try {
    const result=await call('fetchProviderModels',provider);
    assert.ok(result.models.includes('catalog-returned-model'),'Saved key could not fetch the model catalog');
    assert.equal(requests,before+1);
    assert.equal(authenticated,requests,'Incorrect credential reached the local model endpoint');
  } finally { expectedToken=undefined; }
}
async function assertFailurePreserved(dialog,previous,beforeVault,expected) {
  const error=dialog.getByTestId('credential-storage-error');
  await error.waitFor();
  assert.equal(await error.getAttribute('role'),'alert');
  assert.match(await error.innerText(),/本机密钥|系统安全存储|钥匙串/);
  assert.ok(!containsToken(await error.innerText()),'Error message disclosed the entered credential');
  assert.equal(await dialog.getByLabel('连接名称',{exact:true}).inputValue(),expected.name);
  assert.equal(await dialog.getByLabel('接口基础地址',{exact:true}).inputValue(),expected.baseUrl);
  assert.equal(await dialog.getByLabel('模型名称',{exact:true}).inputValue(),expected.model);
  const keptKey=await dialog.getByLabel('API Key',{exact:true}).evaluate((field,value) => field.value===value,replacementToken);
  assert.ok(keptKey,'Retry form lost its entered key');
  const state=(await getState()).settings;
  assert.ok(isDeepStrictEqual(state.providers,previous.providers) && isDeepStrictEqual(state.bindings,previous.bindings),'Failed save changed an existing connection or binding');
  assert.ok(beforeVault.equals(await credentialBytes()),'Failed save replaced the original encrypted vault');
}
try {
  stage=1;
  // Generate a genuine legacy payload, then start a fresh process to load it.
  await launch();
  const legacy={id:legacyId,name:'兼容连接',protocol:'openai-images',baseUrl,model:'legacy-picked-model',timeoutMs:180000,hasKey:true};
  await call('saveProvider',{...legacy,key:legacyToken});
  await call('updateSettings',{bindings:{image:legacyId}});
  // Reproduce the previous application's own temp-file + rename publication,
  // inside its isolated main process and only over its single seeded record.
  const legacyWritten=await app.evaluate(async ({app,safeStorage},{file,id,value,parent}) => {
    const fs=process.getBuiltinModule('node:fs/promises'), path=process.getBuiltinModule('node:path');
    if (app.getPath('userData')!==parent || path.dirname(file)!==parent) throw new Error('Unexpected fixture path');
    const previous=JSON.parse(await fs.readFile(file,'utf8'));
    if (Object.keys(previous).length!==1 || !Object.hasOwn(previous,id)) throw new Error('Unexpected fixture contents');
    const bytes=safeStorage.encryptString(value);
    if (!bytes.length || bytes.includes(Buffer.from(value))) return false;
    const temp=file+'.legacy-fixture.tmp';
    await fs.writeFile(temp,JSON.stringify({[id]:bytes.toString('base64')}),{flag:'wx',mode:0o600});
    await fs.rename(temp,file);
    return true;
  },{file:vaultFile,id:legacyId,value:legacyToken,parent:data});
  assert.ok(legacyWritten,'Legacy native encryption did not yield a protected payload');
  await close();
  stage=2;
  await launch(); await installFaultController();
  await fetchSaved(legacyId,legacyToken);
  assert.ok((await stats()).decrypts>0,'Legacy payload did not use native async decryption');
  await button(page,'添加图片生成服务').click();
  let dialog=editor('添加图片生成服务');
  await dialog.getByLabel('连接名称',{exact:true}).fill('异步保存验收');
  await dialog.getByLabel('接口基础地址',{exact:true}).fill(baseUrl);
  await dialog.getByLabel('API Key',{exact:true}).fill(firstToken);
  await dialog.getByLabel('模型名称',{exact:true}).fill('user-picked-model');
  expectedToken=firstToken;
  await button(dialog,'获取模型').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#provider-model-options option')].some(option => option.value==='catalog-returned-model'));
  expectedToken=undefined;
  assert.equal(await dialog.getByLabel('模型名称',{exact:true}).inputValue(),'user-picked-model','Fetching models changed the manual selection');
  await dialog.getByTestId('save-model-service').click(); await dialog.waitFor({state:'hidden'});
  const saved=(await getState()).settings.providers.find(item => item.name==='异步保存验收');
  assert.ok(saved?.hasKey && saved.model==='user-picked-model');
  let counts=await stats();
  assert.ok(counts.encrypts>0 && counts.decrypts>0 && counts.syncCalls===0,'Save/read used a deprecated synchronous method');
  assert.ok(!containsToken((await credentialBytes()).toString()),'A credential appeared in the on-disk vault');

  stage=3;
  await close(); await launch(); await installFaultController();
  await fetchSaved(legacyId,legacyToken); await fetchSaved(saved.id,firstToken);
  const previous=(await getState()).settings, beforeVault=await credentialBytes();
  await button(page,'编辑连接 异步保存验收').click(); dialog=editor('编辑模型服务');
  const updated={name:'重试后的连接',baseUrl,model:'another-user-picked-model'};
  await dialog.getByLabel('连接名称',{exact:true}).fill(updated.name);
  await dialog.getByLabel('接口基础地址',{exact:true}).fill(updated.baseUrl);
  await dialog.getByLabel('模型名称',{exact:true}).fill(updated.model);
  await dialog.getByLabel('API Key',{exact:true}).fill(replacementToken);
  await mode('unavailable'); await dialog.getByTestId('save-model-service').click();
  await assertFailurePreserved(dialog,previous,beforeVault,updated);
  await mode('denied'); await button(dialog,'重新尝试保存').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="save-model-service"]').disabled);
  assert.equal((await stats()).denied,1,'Native refusal was not exercised');
  await assertFailurePreserved(dialog,previous,beforeVault,updated);
  await mode('normal'); await button(dialog,'重新尝试保存').click(); await dialog.waitFor({state:'hidden'});
  const recovered=(await getState()).settings.providers.find(item => item.id===saved.id);
  assert.ok(recovered?.hasKey && recovered.name===updated.name && recovered.model===updated.model && recovered.baseUrl===updated.baseUrl,'Retry did not preserve the complete connection');
  await fetchSaved(saved.id,replacementToken);

  stage=4;
  const beforeDelete=(await getState()).settings, deleteVault=await credentialBytes();
  await mode('fail-delete-write');
  const refused=await page.evaluate(async id => {try{await window.studio.call('deleteProvider',id);return false;}catch(error){return error.code==='CREDENTIAL_STORAGE_WRITE_FAILED';}},saved.id);
  assert.ok(refused,'A failed vault replacement must reject deleteProvider with a storage error');
  assert.equal((await stats()).writeFailures,1);
  const afterDelete=(await getState()).settings;
  assert.ok(isDeepStrictEqual(beforeDelete.providers,afterDelete.providers) && isDeepStrictEqual(beforeDelete.bindings,afterDelete.bindings),'Failed delete removed connection metadata or bindings');
  assert.ok(deleteVault.equals(await credentialBytes()),'Failed delete modified the vault');
  await fetchSaved(saved.id,replacementToken); counts=await stats();
  assert.equal(counts.syncCalls,0);
  await close(); await launch(); await installFaultController();
  await fetchSaved(saved.id,replacementToken); await fetchSaved(legacyId,legacyToken);
  assert.equal((await getState()).settings.providers.length,2);
  assert.ok(!containsToken((await credentialBytes()).toString()) && !logLeak,'Credential leaked to a monitored application log or vault plaintext');
  assert.equal(pageErrors,0);
  const result={passed:true,packaged:Boolean(process.env.ZIYUN_TEST_EXE),macOS:process.platform==='darwin',windows:process.platform==='win32',nativeAsyncAvailable:true,mockKeychain:false,legacyCiphertextRead:true,restartAuthenticated:true,failedSavesPreserved:true,retrySaved:true,failedDeletePreserved:true,manualModelPreserved:true,publicStateAndLogsClean:true,authenticatedRequests:authenticated};
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
  console.log('CREDENTIAL_STORAGE_UI_PASS',output);
} catch(error) {
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:false,stage,loggedCredential:logLeak,authenticatedRequests:authenticated},null,2));
  throw new Error(scrub(error?.message || 'Credential acceptance failed'));
} finally {
  try { await close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
