import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron, expect} from '@playwright/test';

// The preceding public-installer test created the entire user profile on this
// disposable Mac. Never open an existing profile on someone's workstation.
assert.equal(process.platform, 'darwin');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const pkg = JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
const data = path.join(os.homedir(),'Library','Application Support',pkg.productName);
const vault = path.join(data,'credentials.keychain.json');
const baseline = path.resolve(process.argv[2]);
const dmg = path.resolve(process.argv[3]);
const name = path.basename(dmg);
assert.equal(name,`ZiyunStudio-${pkg.version}-mac-${process.arch}.dmg`);
const scratch = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP,'one-click-'));
const applications = path.join(os.homedir(),'Applications');
const bundle = path.join(applications,pkg.productName+'.app');
const executablePath = path.join(bundle,'Contents','MacOS',pkg.productName);
await fs.mkdir(applications,{recursive:true});
await fs.mkdir(bundle); // Fail before copying over any pre-existing app.
execFileSync('/usr/bin/ditto',[baseline,bundle]);
const env = {...process.env, ZIYUN_SMOKE:'1'};
for (const key of ['ZIYUN_DATA_DIR','ZIYUN_DEV_URL','ELECTRON_RUN_AS_NODE']) delete env[key];
const trace = path.join(scratch,'fetch-trace');
const browserUrl = `https://github.com/123225073/ziyun-image-studio/releases/download/v${pkg.version}/${name}`;
const apiUrl = 'https://api.github.com/repos/123225073/ziyun-image-studio/releases?per_page=100&page=1';
async function sha(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const asset = {id:1,name,browser_download_url:browserUrl,state:'uploaded',size:(await fs.stat(dmg)).size,digest:'sha256:'+await sha(dmg)};
const published = [{tag_name:'v'+pkg.version,prerelease:false,draft:false,published_at:new Date().toISOString(),assets:[asset]}];

// Observe the normal LaunchServices relaunch without modifying the app or
// requiring screen-recording or Accessibility access. Termination is limited
// to the exact path and PID of the newly observed fixture.
const swift = path.join(scratch,'observe.swift');
const observe = path.join(scratch,'observe');
await fs.writeFile(swift,`import AppKit
import CoreGraphics
let args = CommandLine.arguments
let target = URL(fileURLWithPath: args[1]).standardizedFileURL
let apps = NSWorkspace.shared.runningApplications.filter {
  !$0.isTerminated
}
for app in apps {
  if args.count == 3 && args[2] == "describe" {
    if app.bundleIdentifier == "com.ziyun.imagestudio" {
      print(app.processIdentifier, app.isFinishedLaunching, app.bundleURL?.path ?? "?", app.executableURL?.path ?? "?")
    }
    continue
  }
  guard app.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == target.resolvingSymlinksInPath().path else { continue }
  print(app.processIdentifier)
  if args.count == 3 && String(app.processIdentifier) == args[2] { _ = app.terminate() }
}
if args.count == 3 && args[2] == "describe",
   let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] {
  for window in windows {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    if ["CoreServicesUIAgent","SecurityAgent","子云影像工坊"].contains(owner) {
      print("window",owner,window[kCGWindowName as String] ?? "(not available)")
    }
  }
}
`);
execFileSync('/usr/bin/xcrun',['swiftc',swift,'-o',observe],{timeout:60000});
const installedPids = () => execFileSync(observe,[bundle],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);
function diagnostic(command, args) {
  try { return execFileSync(command,args,{encoding:'utf8',timeout:12000,stdio:['ignore','pipe','pipe']}).trim(); }
  catch (error) { return [error.status,String(error.stdout || ''),String(error.stderr || '')].join(' ').trim(); }
}
async function diagnoseRelaunch() {
  console.error('Installed version and inode:',(await fs.stat(bundle)).ino,diagnostic('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(bundle,'Contents','Info.plist')]));
  console.error('LaunchServices (pid, ready, bundle, executable):',diagnostic(observe,[bundle,'describe']));
  console.error('Quarantine:',diagnostic('/usr/bin/xattr',['-p','com.apple.quarantine',bundle]));
  console.error('Gatekeeper:',diagnostic('/usr/sbin/spctl',['--assess','--type','execute','--verbose=3',bundle]));
  for (const name of await fs.readdir(applications)) {
    if (!name.startsWith('.ziyun-app-update-')) continue;
    const stage = path.join(applications,name);
    const receipt = JSON.parse(await fs.readFile(path.join(stage,'receipt.json'),'utf8').catch(() => '{}'));
    console.error('Update stage:',await fs.readdir(stage),{original:receipt.original,replacement:receipt.replacement});
  }
  const processes = diagnostic('/bin/ps',['-axo','pid,ppid,state,comm']);
  console.error('Related processes:',processes.split('\n').filter(line => line.includes(pkg.productName) || /CoreServicesUIAgent|SecurityAgent|\/usr\/bin\/open$/.test(line)).join('\n'));
  const predicate = '(process == "syspolicyd" OR process == "CoreServicesUIAgent" OR process == "lsd" OR process == "runningboardd") AND (eventMessage CONTAINS[c] "com.ziyun.imagestudio" OR eventMessage CONTAINS "子云影像")';
  const log = diagnostic('/usr/bin/log',['show','--style','compact','--last','3m','--predicate',predicate]);
  console.error('macOS assessment events:',log.split('\n').slice(-24).join('\n'));
}
let app, page;
async function launch(version) {
  app = await electron.launch({executablePath,env,timeout:60000});
  page = await app.firstWindow();
  await page.getByTestId('add-row').waitFor();
  const actual = await app.evaluate(({app}) => [app.isPackaged,app.getVersion(),app.getPath('userData')]);
  assert.deepEqual(actual,[true,version,data]);
}
const state = () => page.evaluate(() => window.studio.call('getState'));
try {
  await launch('0.0.1');
  const oldPid = String(app.process().pid);
  console.log('Baseline LaunchServices registration:',diagnostic(observe,[bundle,'describe']));
  await page.locator('tr[data-row-id]').first().click();
  const quantity = page.getByRole('spinbutton',{name:'生成数量'});
  await quantity.fill('2');
  await expect(page.getByTestId('row-panel').getByText('未保存',{exact:true})).toBeVisible();

  // Substitute only the network transport through Playwright's privileged
  // process handle. The production release lookup, download, hash, installer,
  // permissions checks, shutdown, replacement and relaunch all execute.
  await app.evaluate(({net},fixture) => {
    const fs = process.getBuiltinModule('node:fs');
    const {Readable} = process.getBuiltinModule('node:stream');
    net.fetch = async (url) => {
      const requested = String(url);
      if (requested === fixture.apiUrl) return Response.json(fixture.published);
      if (requested !== fixture.browserUrl) throw new Error('Unexpected update URL: '+requested);
      fs.appendFileSync(fixture.trace,'download\n');
      return new Response(Readable.toWeb(fs.createReadStream(fixture.dmg)),{
        headers:{'content-type':'application/octet-stream','content-length':String(fixture.asset.size)}
      });
    };
  },{apiUrl,browserUrl,asset,published,dmg,trace});
  const versions = page.getByRole('button',{name:/版本管理，当前/});
  await versions.click();
  const dialog = page.getByRole('dialog',{name:'版本管理'});
  const update = dialog.getByRole('button',{name:'检查并更新'});
  await update.click();
  await expect(dialog.getByText(/先保存/)).toBeVisible();
  assert.equal(app.process().exitCode,null);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'保存本行'}).click();
  await expect(page.getByTestId('row-panel').getByText('已保存',{exact:true})).toBeVisible();
  const before = await state();
  assert.equal(before.rows.length,1);
  assert.equal(before.rows[0].count,2);
  const job = before.jobs[0];
  assert.equal(job.status,'succeeded');
  const source = before.rows[0].sourcePaths[0];
  const contents = await Promise.all([source,job.localPath,vault].map(sha));
  const traceBefore = await fs.readFile(trace,'utf8').catch(() => '');
  await versions.click();
  const leaving = app.waitForEvent('close',{timeout:155000});
  leaving.catch(() => {});
  await update.click();
  // Preserve the in-app diagnostic when an expected shutdown did not happen.
  try { await leaving; }
  catch (error) {
    console.error('Update dialog:',await dialog.innerText({timeout:3000}).catch(() => 'already closed'));
    throw error;
  }
  app = undefined;
  assert.equal(await fs.readFile(trace,'utf8'),traceBefore+'download\n');
  let relaunched;
  const began = Date.now();
  let observed = false;
  try {
    await expect.poll(async () => {
      relaunched = installedPids().find(pid => pid !== oldPid);
      // Production acknowledges the new renderer only after its first IPC
      // handshake. Finder's ready flag alone varies between macOS releases.
      const stages = (await fs.readdir(applications)).filter(name => name.startsWith('.ziyun-app-update-'));
      if (!observed && Date.now() - began > 9000) {
        observed = true;
        console.log('Launch in progress:',diagnostic(observe,[bundle,'describe']),'stages:',stages.length);
      }
      return Boolean(relaunched) && stages.length === 0;
    },{timeout:80000,message:'Expected macOS relaunch and first-window confirmation at the original application path'}).toBe(true);
  } catch (error) {
    await diagnoseRelaunch();
    throw error;
  }
  const trustedBundle = path.resolve(process.env.ZIYUN_TEST_EXE,'../../..');
  const asar = path.join('Contents','Resources','app.asar');
  assert.equal(await sha(path.join(bundle,asar)),await sha(path.join(trustedBundle,asar)));
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
  execFileSync(observe,[bundle,relaunched]);
  await expect.poll(() => installedPids().includes(relaunched),{timeout:20000}).toBe(false);
  await launch(pkg.version);
  const after = await state();
  assert.deepEqual(after.rows,before.rows);
  assert.deepEqual(after.jobs.map(j => [j.id,j.status,j.localPath]),before.jobs.map(j => [j.id,j.status,j.localPath]));
  assert.deepEqual(after.settings.providers,before.settings.providers);
  assert.deepEqual(after.settings.bindings,before.settings.bindings);
  assert.equal(after.settings.outputDir,before.settings.outputDir);
  assert.deepEqual(await Promise.all([source,job.localPath,vault].map(sha)),contents);
  await expect(page.locator(`tr[data-row-id="${before.rows[0].id}"]`)).toBeVisible();
  console.log(`ONE_CLICK_UPDATE_PASS ${process.arch} → ${pkg.version}; unsaved edit retained, downloaded correct DMG once, installed, macOS relaunched, old project, source, result, settings and encrypted vault preserved`);
} finally {
  if (app) await app.close();
}
