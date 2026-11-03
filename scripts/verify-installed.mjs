import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const executablePath = process.env.ZIYUN_TEST_EXE || path.join(
  process.env.LOCALAPPDATA, 'Programs', pkg.productName, `${pkg.productName}.exe`,
);
const dataDir = await mkdtemp(path.join(tmpdir(), 'ziyun-installed-'));
const env = { ...process.env, ZIYUN_DATA_DIR: dataDir, ZIYUN_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;

let application;
let passed = false;
try {
  console.log('Launching installed application.');
  application = await electron.launch({ executablePath, env, timeout: 60000 });
  assert.deepEqual(await application.evaluate(({ app }) => ({
    version: app.getVersion(), packaged: app.isPackaged,
  })), { version: pkg.version, packaged: true });
  let page = await application.firstWindow({ timeout: 30000 });
  await page.getByTestId('add-row').click({ timeout: 30000 });
  await page.waitForFunction(async () => (await window.studio.call('getState')).rows.length === 1, null, { timeout: 15000 });
  console.log('Saved a workspace row. Restarting application.');
  await application.close();
  application = await electron.launch({ executablePath, env, timeout: 60000 });
  page = await application.firstWindow({ timeout: 30000 });
  const state = await page.evaluate(() => window.studio.call('getState'));
  assert.equal(state.rows.length, 1);
  assert.equal(state.settings.providers.length, 0);
  console.log('Installed application starts and saves workspace data.');
  passed = true;
} finally {
  if (process.env.CI === 'true' && passed) {
    const closed = application.waitForEvent('close', { timeout: 10000 });
    await Promise.all([
      closed,
      application.evaluate(({ app }) => { setTimeout(() => app.quit(), 100); }),
    ]);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
    // Windows runners may retain Playwright's transport after Electron exits.
    process.exit(0);
  }
  try { await application?.close(); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}
