import fs from 'node:fs/promises';
import path from 'node:path';

// Native dialog preferences are kept separately from project configuration.
// Cancelled dialogs never replace the last successfully selected directory.
export async function createDialogPaths({ file, dialog, window, fallback, legacyImageDirectory }) {
  let directories = {};
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) directories = saved;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  let writes = Promise.resolve();
  async function existingDirectory(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return undefined;
    let candidate = value;
    while (true) {
      if ((await fs.stat(candidate).catch(() => null))?.isDirectory()) return candidate;
      const parent = path.dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
  async function defaultDirectory(key) {
    return await existingDirectory(directories[key])
      || (key === 'image' ? await existingDirectory(await legacyImageDirectory?.()) : undefined)
      || await existingDirectory(await fallback?.(key));
  }
  async function remember(key, selected, kind = 'directory') {
    if (!/^[a-z0-9-]{1,60}$/.test(key) || typeof selected !== 'string' || !path.isAbsolute(selected)) return;
    directories[key] = kind === 'file' ? path.dirname(selected) : selected;
    const content = JSON.stringify(directories, null, 2);
    writes = writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + '.tmp', content);
      await fs.rename(file + '.tmp', file);
    });
    await writes;
  }
  async function open(key, options) {
    const defaultPath = await defaultDirectory(key);
    const result = await dialog.showOpenDialog(window(), { ...options, ...(defaultPath ? { defaultPath } : {}) });
    if (!result.canceled && result.filePaths?.length) await remember(key, result.filePaths[0], options.properties?.includes('openDirectory') ? 'directory' : 'file');
    return result;
  }
  async function save(key, options) {
    const directory = await defaultDirectory(key);
    const defaultPath = directory ? path.join(directory, path.basename(options.defaultPath || '')) : options.defaultPath;
    const result = await dialog.showSaveDialog(window(), { ...options, ...(defaultPath ? { defaultPath } : {}) });
    if (!result.canceled && result.filePath) await remember(key, result.filePath, 'file');
    return result;
  }
  return { open, save, remember };
}
