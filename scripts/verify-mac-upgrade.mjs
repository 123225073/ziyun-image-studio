import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron, expect} from '@playwright/test';

// Exercise the same implicit profile selection as a user opening the app in
// Finder. Only a new, disposable GitHub-hosted Mac may use this default path.
assert.equal(process.platform, 'darwin');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const data = path.join(os.homedir(), 'Library', 'Application Support', pkg.productName);
await fs.mkdir(data); // Never open or modify a pre-existing profile.
const env = {...process.env, ZIYUN_SMOKE:'1'};
for (const key of ['ZIYUN_DATA_DIR','ZIYUN_DEV_URL','ELECTRON_RUN_AS_NODE']) delete env[key];
const fixture = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'ziyun-mac-update-'));
const applicationDir = path.join(fixture, 'Applications');
await fs.mkdir(applicationDir);
const bundle = path.join(applicationDir, pkg.productName+'.app');
const executablePath = path.join(bundle, 'Contents', 'MacOS', pkg.productName);
const oldBundle = process.argv[2];
const newBundle = path.resolve(process.env.ZIYUN_TEST_EXE, '../../..');
for (const source of [oldBundle, newBundle]) {
  const id = execFileSync('/usr/libexec/PlistBuddy',
    ['-c','Print :CFBundleIdentifier',path.join(source,'Contents','Info.plist')], {encoding:'utf8'}).trim();
  assert.equal(id, pkg.build.appId);
}
const external = path.join(fixture, '已选的素材.png');
const exportDir = path.join(fixture, '原有导出');
await fs.mkdir(exportDir);
const token = randomBytes(24).toString('hex');
const model = 'offline-upgrade-fixture';
let image, imageCalls = 0, modelCalls = 0;
const server = http.createServer(async (req,res) => {
  for await (const ignored of req) {} // consume the complete upload
  const validKey = req.headers.authorization === 'Bearer '+token;
  let payload;
  if (validKey && req.url === '/v1/images/edits' && req.method === 'POST') {
    imageCalls++;
    payload = {data:[{b64_json:image.toString('base64')}]};
  }
  if (validKey && req.url === '/v1/models' && req.method === 'GET') {
    modelCalls++;
    payload = {data:[{id:model}]};
  }
  res.writeHead(payload ? 200 : 403, {'content-type':'application/json'});
  res.end(JSON.stringify(payload || {error:'Unexpected test request'}));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let app, page;
const executables = new Set();
async function within(name, action, ms) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action),new Promise((_,reject) => {
      timer = setTimeout(() => reject(new Error(name+' timed out after '+ms+' ms')),ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function stage(name, action, ms=45000) {
  console.log('MAC_UPGRADE_BEGIN',name);
  try {
    const result = await within(name,action,ms);
    console.log('MAC_UPGRADE_OK',name);
    return result;
  } catch (error) {
    // Only existence and the process names of possible system dialogs are
    // relevant; never print a vault entry, window title or form contents.
    const exists = file => fs.stat(path.join(data,file)).then(() => true,() => false);
    const markers = {database:await exists('studio.sqlite'),vault:await exists('credentials.keychain.json')};
    let prompts = [];
    try {
      const processes = execFileSync('ps',['-A','-o','comm='],{encoding:'utf8',timeout:4000});
      prompts = [...new Set(processes.split('\n').map(p => path.basename(p.trim()))
        .filter(p => ['SecurityAgent','SecurityAgentHelper','CoreServicesUIAgent'].includes(p)))];
    } catch {}
    console.error('MAC_UPGRADE_FAILED', name, JSON.stringify({markers,systemAgentsRunning:prompts}));
    if (name.includes('Keychain')) console.error('Check macOS access approval for this phase. Presence of a system agent alone cannot prove a prompt or loss of a credential.');
    throw error;
  }
}
async function launch(version) {
  app = await electron.launch({executablePath,env,timeout:60000});
  executables.add(app.process());
  page = await app.firstWindow();
  await page.getByTestId('add-row').waitFor();
  const info = await app.evaluate(({app}) => ({version:app.getVersion(),packaged:app.isPackaged,
    profile:app.getPath('userData'),mock:app.commandLine.hasSwitch('use-mock-keychain')}));
  assert.deepEqual(info, {version,packaged:true,profile:data,mock:false});
}
const call = (method,...args) => page.evaluate(([method,args]) => window.studio.call(method,...args), [method,args]);
async function close() {
  if (app) { await app.close(); app = undefined; }
}
function stopFixtureChildren() {
  // All entries were obtained from our own Playwright launches in this
  // disposable runner. A failure must remain visible even if a modal window
  // prevents normal shutdown; never search for processes by application name.
  for (const child of executables) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
try {
  await stage('install verified old bundle',() => execFileSync('ditto', [oldBundle,bundle],{timeout:60000}),65000);
  // The two ad-hoc builds have distinct signatures. Grant only these binaries
  // access to a synthetic Safe Storage item on this disposable runner, as a
  // user can approve both versions in the macOS Keychain prompt.
  await stage('prepare test-only Keychain access for both installed versions',() => {
    const item=['-s',pkg.productName+' Safe Storage','-a',pkg.productName];
    try {
      execFileSync('security',['find-generic-password',...item],{stdio:'ignore',timeout:5000});
      throw new Error('A Safe Storage item already exists; refusing to modify it.');
    } catch (error) { if (error.status !== 44) throw error; }
    execFileSync('security',['add-generic-password',...item,'-w',randomBytes(24).toString('base64'),
      '-T',executablePath,'-T',process.env.ZIYUN_TEST_EXE],{stdio:'ignore',timeout:10000});
  });
  await stage('open old application and verify default profile',() => launch(process.env.PREVIOUS_VERSION),75000);
  image = Buffer.from(await stage('create fixture image',() => page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 96;
    canvas.getContext('2d').fillRect(0,0,64,96);
    return canvas.toDataURL('image/png').split(',')[1];
  })), 'base64');
  await fs.writeFile(external,image);
  await stage('old native Keychain save',() => call('saveProvider',{id:'legacy-upgrade',name:'旧版连接',protocol:'openai-images',
    baseUrl:`http://127.0.0.1:${server.address().port}/v1`, model, key:token}));
  await stage('persist legacy output and model settings',() =>
    call('updateSettings',{bindings:{image:'legacy-upgrade'},defaultTemplateId:'',outputDir:exportDir,autoExport:false}));
  const row = await stage('persist legacy row',() => call('saveRow',
    {code:'A01',name:'升级前的任务',sourcePaths:[external],userPrompt:'保留原先的图片和文案',count:1}));
  await stage('submit local fixture task in old version',() => call('enqueueImages',[row.id]));
  await stage('old application generating local fixture',() =>
    expect.poll(async () => (await call('getState')).jobs[0]?.status, {timeout:30000}).toBe('succeeded'));
  const original = await stage('read old successful task',() => call('getState'));
  const job = original.jobs[0];
  assert.equal(imageCalls,1);
  assert.ok(job.localPath.startsWith(data+path.sep));
  const originalResult = await fs.readFile(job.localPath);
  assert.ok(originalResult.length > 0);
  await stage('quit old application',close,20000);

  const vault = path.join(data,'credentials.keychain.json');
  const encrypted = await fs.readFile(vault);
  assert.ok(encrypted.length && !encrypted.includes(token));
  await stage('replace application at original location',async () => {
    await fs.rename(bundle,path.join(fixture,'previous.app'));
    execFileSync('ditto',[newBundle,bundle],{timeout:60000});
  },65000);
  await stage('open new application and verify default profile',() => launch(pkg.version),75000);
  const restored = await stage('read upgraded database',() => call('getState'));
  await expect(page.locator(`tr[data-row-id="${row.id}"]`)).toBeVisible();
  assert.equal(restored.rows.length,1);
  assert.equal(restored.rows[0].id,row.id);
  assert.equal(restored.rows[0].userPrompt,row.userPrompt);
  assert.deepEqual(restored.rows[0].sourcePaths,[external]);
  assert.equal(restored.jobs.length,1);
  assert.equal(restored.jobs[0].id,job.id);
  assert.equal(restored.jobs[0].status,'succeeded');
  assert.equal(restored.jobs[0].localPath,job.localPath);
  assert.equal(restored.settings.outputDir,exportDir);
  assert.equal(restored.settings.bindings.image,'legacy-upgrade');
  assert.deepEqual(restored.settings.providers,original.settings.providers);
  assert.deepEqual(await fs.readFile(external),image);
  assert.deepEqual(await fs.readFile(job.localPath),originalResult);
  assert.deepEqual(await fs.readFile(vault),encrypted);
  console.log('MAC_UPGRADE_OK persisted row, successful task, source and result bytes, output directory, provider settings, and original encrypted vault');
  const catalog = await stage('new native Keychain access using previous credential',
    () => call('fetchProviderModels',restored.settings.providers[0]));
  assert.ok(catalog.models.includes(model));
  assert.equal(modelCalls,1);
  assert.equal(imageCalls,1);
  await stage('quit upgraded application',close,20000);
  console.log(`MAC_UPGRADE_PASS ${process.arch} ${process.env.PREVIOUS_VERSION} -> ${pkg.version}: same app path and default profile, task, generated result, source, output settings and Keychain connection verified.`);
} finally {
  try { await within('fixture shutdown',close,5000); }
  catch { stopFixtureChildren(); }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
