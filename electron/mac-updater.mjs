import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {downloadMacUpdate, macUpdateArch, resolveMacUpdate} from './mac-update-download.mjs';
import {prepareMacInstall} from './mac-install.mjs';

// Download and stage while the existing app is still usable. Take the
// exclusive shutdown lock only after everything required is on this Mac.
export function createMacUpdater({app, fetchImpl, progress, assertIdle, flushDrafts, shutdown}) {
  let operation;
  let controller;
  let finalizing = false;

  async function install(signal) {
    const arch = macUpdateArch(process.arch, app.runningUnderARM64Translation);
    progress({phase:'checking'});
    const release = await resolveMacUpdate({version:app.getVersion(), arch, fetchImpl, signal});
    const {latest, comparison} = release;
    if (comparison !== 'update') return {latest, comparison};
    assertIdle();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-update-'));
    let staged;
    try {
      progress({phase:'downloading', latest, percent:0});
      let lastPercent = 0;
      const dmgPath = await downloadMacUpdate({
        asset:release.asset, directory, fetchImpl, signal,
        onProgress({received, total}) {
          const percent = Math.floor(100 * received / total);
          if (percent !== lastPercent) progress({phase:'downloading', latest, percent});
          lastPercent = percent;
        },
      });
      signal.throwIfAborted();
      progress({phase:'verifying', latest});
      staged = await prepareMacInstall({dmgPath, version:latest, arch});
      await fs.rm(directory, {recursive:true, force:true});
      signal.throwIfAborted();
      const drafts = await flushDrafts(latest);
      signal.throwIfAborted();
      assertIdle();
      finalizing = true;
      progress({phase:'restarting', latest});
      await staged.start(drafts);
      await shutdown();
      staged = null; // The detached installer owns its staging directory now.
      return {latest, comparison};
    } finally {
      try { await staged?.discard(); }
      finally { await fs.rm(directory, {recursive:true, force:true}); }
    }
  }

  return {
    get finalizing() { return finalizing; },
    start() {
      if (operation) return operation;
      controller = new AbortController();
      operation = install(controller.signal).finally(() => {
        operation = undefined;
        controller = undefined;
        finalizing = false;
      });
      return operation;
    },
    cancel() {
      if (operation && !finalizing) controller.abort(new Error('更新已取消。'));
    },
    async cancelAndWait() {
      this.cancel();
      await operation?.catch(() => {});
    },
  };
}
