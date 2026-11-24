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
async function launch(version) {
  app = await electron.launch({executablePath,env,timeout:60000});
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
try {
  execFileSync('ditto', [oldBundle,bundle]);
  await launch(process.env.PREVIOUS_VERSION);
  image = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 96;
    canvas.getContext('2d').fillRect(0,0,64,96);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await fs.writeFile(external,image);
  await call('saveProvider',{id:'legacy-upgrade',name:'旧版连接',protocol:'openai-images',
    baseUrl:`http://127.0.0.1:${server.address().port}/v1`, model, key:token});
  await call('updateSettings',{bindings:{image:'legacy-upgrade'},defaultTemplateId:'',outputDir:exportDir,autoExport:false});
  const row = await call('saveRow',{code:'A01',name:'升级前的任务',sourcePaths:[external],userPrompt:'保留原先的图片和文案',count:1});
  await call('enqueueImages',[row.id]);
  await expect.poll(async () => (await call('getState')).jobs[0]?.status, {timeout:30000}).toBe('succeeded');
  const original = await call('getState');
  const job = original.jobs[0];
  assert.equal(imageCalls,1);
  assert.ok(job.localPath.startsWith(data+path.sep));
  const originalResult = await fs.readFile(job.localPath);
  assert.ok(originalResult.length > 0);
  await close();

  const vault = path.join(data,'credentials.keychain.json');
  const encrypted = await fs.readFile(vault);
  assert.ok(encrypted.length && !encrypted.includes(token));
  await fs.rename(bundle,path.join(fixture,'previous.app'));
  execFileSync('ditto',[newBundle,bundle]);
  await launch(pkg.version);
  const restored = await call('getState');
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
  const catalog = await call('fetchProviderModels',restored.settings.providers[0]);
  assert.ok(catalog.models.includes(model));
  assert.equal(modelCalls,1);
  assert.equal(imageCalls,1);
  console.log(`MAC_UPGRADE_PASS ${process.arch} ${process.env.PREVIOUS_VERSION} -> ${pkg.version}: same app path and default profile, task, generated result, source, output settings and Keychain connection verified.`);
} finally {
  await close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
