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
try {
  application = await electron.launch({ executablePath, env, timeout: 60000 });
  assert.deepEqual(await application.evaluate(({ app }) => ({
    version: app.getVersion(), packaged: app.isPackaged,
  })), { version: pkg.version, packaged: true });
  let page = await application.firstWindow();
  await page.getByTestId('add-row').click();
  await page.waitForFunction(async () => (await window.studio.call('getState')).rows.length === 1);
  await application.close();
  application = await electron.launch({ executablePath, env, timeout: 60000 });
  page = await application.firstWindow();
  const state = await page.evaluate(() => window.studio.call('getState'));
  assert.equal(state.rows.length, 1);
  assert.equal(state.settings.providers.length, 0);
  console.log('Installed application starts and saves workspace data.');
} finally {
  try { await application?.close(); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}
