import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';

const run = promisify(execFile);
const product = '子云影像工坊';
const bundleId = 'com.ziyun.imagestudio';
const stagePrefix = '.ziyun-app-update-';
const stageName = /^\.ziyun-app-update-[A-Za-z0-9]{6}$/;
const candidateName = product + '.app';
// RENAME_SWAP exchanges complete bundles atomically on the installation volume.
const swapScript = `ObjC.import("stdio");
function run(paths) {
  if ($.renamex_np(paths[0], paths[1], 2) !== 0) throw Error("Cannot exchange bundles");
}`;
const plist = (bundle, key) => run('/usr/libexec/PlistBuddy',
  ['-c', 'Print :' + key, path.join(bundle, 'Contents', 'Info.plist')], {timeout: 10000})
  .then(result => result.stdout.trim());

async function applicationRoots() {
  const roots = await Promise.all(['/Applications', path.join(os.homedir(), 'Applications')].map(
    directory => fs.realpath(directory).catch(() => undefined)));
  return roots.filter(Boolean);
}

async function runningBundle(executablePath) {
  const exe = await fs.realpath(executablePath);
  const bundle = path.resolve(exe, '../../..');
  if (!bundle.endsWith('.app') || exe !== path.join(bundle, 'Contents', 'MacOS', product)) {
    throw new Error('请从「应用程序」中的子云影像工坊启动更新。');
  }
  return bundle;
}

async function installedBundle(executablePath) {
  const bundle = await runningBundle(executablePath);
  const roots = await applicationRoots();
  if (!roots.includes(path.dirname(bundle))) {
    throw new Error('请先将工坊移至「应用程序」，推出安装镜像，再从「应用程序」启动更新。');
  }
  return bundle;
}

async function inode(file) {
  const stat = await fs.lstat(file, {bigint: true});
  if (!stat.isDirectory()) throw new Error('待更新的应用包位置已变更。');
  return stat.ino.toString();
}

async function checkAtomicExchange(stage) {
  const first = path.join(stage, 'swap-check-a');
  const second = path.join(stage, 'swap-check-b');
  await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
  const original = await inode(first);
  try {
    await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', swapScript, first, second], {timeout:15000});
    if (await inode(second) !== original) throw new Error('Swap failed');
  } catch {
    throw new Error('当前安装位置无法安全替换应用，请从 GitHub 发布页下载安装。');
  }
  await Promise.all([fs.rmdir(first), fs.rmdir(second)]);
}

async function markDownload(dmg, installed) {
  // A programmatic network download may lack the Finder/Browser quarantine
  // attribute. Preserve the source metadata or mark it as an internet download.
  const key = 'com.apple.quarantine';
  const source = await run('/usr/bin/xattr', ['-p', key, dmg]).catch(() => undefined);
  const quarantine = source?.stdout.trim() ||
    ['0081', Math.floor(Date.now() / 1000).toString(16), 'ZiyunStudio', randomUUID()].join(';');
  await run('/usr/bin/xattr', ['-w', key, quarantine, installed]);
}

async function signature(bundle) {
  const {stderr} = await run('/usr/bin/codesign', ['--display', '--verbose=4', bundle], {timeout:15000});
  const hash = stderr.match(/^CDHash=([0-9a-f]{40,64})$/mi)?.[1];
  const team = stderr.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (!hash || !team) throw new Error('无法读取工坊的签名身份。');
  return {hash:hash.toLowerCase(), team};
}

async function stageDiskImage(dmgPath, destination, version, arch) {
  const mount = await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-dmg-'));
  let attached = false;
  try {
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-noautoopen', '-nobrowse',
      '-mountpoint', mount, dmgPath], {timeout: 180000});
    attached = true;
    const source = path.join(mount, product + '.app');
    await inode(source);
    await run('/usr/bin/ditto', [source, destination], {timeout: 300000});
    const [id, release, name] = await Promise.all(
      ['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleExecutable'].map(key => plist(destination, key)));
    if (id !== bundleId || release !== version || name !== product) throw new Error('安装包中的应用或版本与发布记录不符。');
    const executable = path.join(destination, 'Contents', 'MacOS', product);
    const {stdout} = await run('/usr/bin/file', ['-b', executable], {timeout: 10000});
    const cpu = arch === 'arm64' ? /\barm64\b/ : /\bx86_64\b/;
    if (!cpu.test(stdout)) throw new Error('安装包与本机芯片不匹配。');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination], {timeout: 180000});
    await markDownload(dmgPath, destination);
  } finally {
    // Never recursively remove a mount point. A detach failure leaves the
    // read-only volume available to the operating system for safe ejection.
    try {
      if (attached) await run('/usr/bin/hdiutil', ['detach', mount], {timeout: 45000});
    } finally { await fs.rmdir(mount).catch(() => {}); }
  }
}

export async function prepareMacInstall({dmgPath, version, arch, executablePath = process.execPath}) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch) ||
      !/^\d+\.\d+\.\d+$/.test(version) || !path.isAbsolute(dmgPath)) throw new Error('无效的 Mac 更新信息。');
  const target = await installedBundle(executablePath);
  const original = await inode(target);
  if (await plist(target, 'CFBundleIdentifier') !== bundleId) throw new Error('当前应用与更新包不匹配。');
  const parent = path.dirname(target);
  let stage;
  try { stage = await fs.mkdtemp(path.join(parent, stagePrefix)); }
  catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
    throw new Error('工坊没有权限更新此位置。可将工坊移到个人「应用程序」后重新打开，或从发布页下载安装。');
  }
  const candidate = path.join(stage, candidateName);
  let helper, stopped;
  try {
    await checkAtomicExchange(stage);
    await stageDiskImage(dmgPath, candidate, version, arch);
    const {team} = await signature(target);
    if (team !== 'not set') {
      // Once the installed app has an Apple team, later releases must be
      // Developer ID Application builds from that same team.
      if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('当前应用的签名团队无法核验。');
      const requirement = 'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' +
        ' and certificate leaf[subject.OU] = "' + team + '"';
      try { await run('/usr/bin/codesign', ['--verify', '--strict', '-R=' + requirement, candidate], {timeout:60000}); }
      catch { throw new Error('新版应用的开发者签名与已安装版本不匹配。'); }
    }
    const replacement = await inode(candidate);
    const receiptPath = path.join(stage, 'receipt.json');
    const receipt = {target, original, replacement};
    await fs.writeFile(receiptPath, JSON.stringify(receipt), {flag:'wx', mode:0o600});
    const script = await fs.readFile(new URL('./mac-install-helper.sh', import.meta.url), 'utf8');
    return {
      async start(drafts) {
        if (helper) throw new Error('正在安装更新。');
        if (await inode(target) !== original) throw new Error('当前应用的位置或版本已变更，请重新检查更新。');
        const carryDrafts = drafts !== undefined && drafts !== null;
        if (carryDrafts) {
          const pendingReceipt = path.join(stage, 'pending.json');
          await fs.writeFile(pendingReceipt, JSON.stringify({...receipt, drafts}), {flag:'wx', mode:0o600});
          await fs.rename(pendingReceipt, receiptPath);
        }
        const child = spawn('/bin/sh', ['-c', script, 'ziyun-update', String(process.pid),
          target, stage, original, replacement, swapScript, carryDrafts ? '1' : '0'],
        {detached:true, stdio:'ignore', cwd:os.tmpdir()});
        await once(child, 'spawn');
        helper = child;
        stopped = once(helper, 'exit');
        helper.unref();
      },
      async discard() {
        // The caller still owns the live original process. The helper only
        // exchanges bundles after that process has completely exited.
        if (helper && helper.exitCode === null && helper.signalCode === null) {
          helper.kill('SIGTERM');
          await stopped;
        }
        if (await inode(target) === original) await fs.rm(stage, {recursive:true, force:true});
      },
    };
  } catch (error) {
    await fs.rm(stage, {recursive:true, force:true});
    throw error;
  }
}

async function pendingReceipts(parent, directBundle, hint) {
  const matches = [];
  for (const entry of await fs.readdir(parent, {withFileTypes:true}).catch(() => [])) {
    if (!entry.isDirectory() || !stageName.test(entry.name) || (hint && hint !== entry.name)) continue;
    const stage = path.join(parent, entry.name);
    try {
      const stat = await fs.lstat(stage);
      if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) continue;
      const receiptPath = path.join(stage, 'receipt.json');
      const file = await fs.lstat(receiptPath);
      if (!file.isFile() || file.uid !== stat.uid || (file.mode & 0o077) !== 0) continue;
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      const previous = path.join(stage, candidateName);
      const target = receipt.target;
      if (typeof target !== 'string' || !target.endsWith('.app') || path.dirname(target) !== parent) continue;
      if (directBundle && directBundle !== target) continue;
      const current = await inode(target);
      const priorBundle = await inode(previous);
      const restoredPath = path.join(stage, 'rolled-back');
      const rolledBack = receipt.original === current && receipt.replacement === priorBundle && await fs.lstat(restoredPath)
        .then(marker => marker.isFile(), () => false);
      if (!rolledBack && !(receipt.replacement === current && receipt.original === priorBundle)) continue;
      matches.push({stage, target, current, previous, priorBundle, receipt, receiptPath, rolledBack, restoredPath});
    } catch { /* Leave incomplete and concurrently removed receipts alone. */ }
  }
  return matches;
}

// Only called after a usable window has opened. Apple's first approved launch
// can run from an AppTranslocation copy of the bundle. Correlate that copy
// with an installed signed application and its exact pending file identities.
export async function confirmMacInstall() {
  if (process.platform !== 'darwin') return;
  const bundle = await runningBundle(process.execPath).catch(() => undefined);
  if (!bundle) return;
  const roots = await applicationRoots();
  const direct = roots.includes(path.dirname(bundle));
  const translocated = /\/AppTranslocation\/[0-9a-f-]{36}\/d\/[^/]+\.app$/i.test(bundle);
  if (!direct && !translocated) return;
  const hint = process.argv.find(arg => arg.startsWith('--ziyun-update-stage='))?.split('=')[1];
  let matches = (await Promise.all((direct ? [path.dirname(bundle)] : roots).map(
    parent => pendingReceipts(parent, direct ? bundle : undefined, stageName.test(hint) ? hint : undefined)))).flat();
  if (!direct && matches.length) {
    const {hash} = await signature(bundle);
    const sameSignature = [];
    for (const match of matches) {
      const installed = await signature(match.target).catch(() => undefined);
      if (installed?.hash === hash) sameSignature.push(match);
    }
    matches = sameSignature;
  }
  // If the original location is ambiguous, a later direct launch can still
  // collect the unmodified receipt and its saved drafts.
  if (matches.length !== 1) return;
  const {stage, target, current, previous, priorBundle, receipt, receiptPath, rolledBack, restoredPath} = matches[0];
  if (await inode(target) !== current || await inode(previous) !== priorBundle) return;
  let drafts;
  const started = path.join(stage, 'started');
  try {
    await fs.writeFile(started, current, {flag:'wx', mode:0o600});
    drafts = receipt.drafts;
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  try {
    await fs.rm(previous, {recursive:true});
    if (rolledBack) await fs.unlink(restoredPath);
    await fs.unlink(receiptPath);
    await fs.unlink(started);
    await fs.rmdir(stage);
  } catch { /* A later successful launch can retry cleanup. */ }
  return drafts;
}
