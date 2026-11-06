import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function storageError(code, platform) {
  const help = platform === 'darwin'
    ? '请解锁登录钥匙串，并在 macOS 询问时允许子云影像工坊访问。随后重试，仍不可用时请重新打开应用。'
    : platform === 'win32'
      ? '请使用保存密钥时的 Windows 用户账户，随后重试；如仍不可用，请重新打开应用。'
      : '请解锁系统密钥存储，随后重试；如仍不可用，请重新打开应用。';
  const messages = {
    CREDENTIAL_STORAGE_UNAVAILABLE: '系统安全存储不可用。' + help,
    CREDENTIAL_STORAGE_TEMPORARILY_UNAVAILABLE: '系统暂时无法访问已保存的密钥。' + help,
    CREDENTIAL_STORAGE_DECRYPT_FAILED: '系统未能解密已保存的密钥。' + help,
    CREDENTIAL_STORAGE_WRITE_FAILED: '凭据文件未能保存。请检查本机数据目录的可用空间和写入权限，然后重试。',
  };
  return Object.assign(new Error(messages[code]), { code, retryable: true });
}

function temporary(error) {
  // Electron 45.2.1 rejects with a message for OSCrypt's temporarily_unavailable
  // flag. Keep native messages out of IPC; they need not be safe to display.
  return error?.isTemporarilyUnavailable === true || /temporarily unavailable/i.test(error?.message || '');
}

export function checkCredentialDestination(previous, next, hasStoredKey, replacingSecret) {
  if (!hasStoredKey) return;
  // The settings and ciphertext live in different files. Requiring a fresh ID
  // for a different recipient keeps an interrupted save from pairing one site's
  // old ciphertext with another site's new address, including legacy records.
  if (!previous?.baseUrl || previous.protocol !== next.protocol ||
      new URL(previous.baseUrl).origin !== new URL(next.baseUrl).origin ||
      (replacingSecret && previous.baseUrl !== next.baseUrl)) {
    throw new Error('更换已保存密钥的服务地址或接入协议，请新建连接并填写对应的密钥。');
  }
}

// The JSON layout and per-platform filename stay compatible with existing
// installations. Plaintext exists only in the scope of the requesting operation.
export async function openCredentialVault({ file, safeStorage, platform = process.platform }) {
  let records = Object.create(null);
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.values(value).some(cipher => typeof cipher !== 'string' || !cipher)) throw new Error();
    records = Object.assign(Object.create(null), value);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('加密配置无法读取，请保留数据目录并检查文件。');
  }
  let pending = Promise.resolve();
  function serialize(work) {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  }
  async function verifyAvailable() {
    try {
      if (platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error();
      if (await safeStorage.isAsyncEncryptionAvailable()) return;
    } catch (error) {
      if (temporary(error)) throw storageError('CREDENTIAL_STORAGE_TEMPORARILY_UNAVAILABLE', platform);
    }
    throw storageError('CREDENTIAL_STORAGE_UNAVAILABLE', platform);
  }
  async function encrypt(value) {
    await verifyAvailable();
    try {
      const bytes = await safeStorage.encryptStringAsync(value);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.equals(Buffer.from(value, 'utf8'))) throw new Error();
      return bytes.toString('base64');
    } catch (error) {
      throw storageError(temporary(error) ? 'CREDENTIAL_STORAGE_TEMPORARILY_UNAVAILABLE' : 'CREDENTIAL_STORAGE_UNAVAILABLE', platform);
    }
  }
  async function stage(next) {
    const temp = file + '.' + randomUUID() + '.tmp';
    let created = false;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const handle = await fs.open(temp, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
      } finally { await handle.close(); }
      return temp;
    } catch {
      if (created) await fs.unlink(temp).catch(() => {});
      throw storageError('CREDENTIAL_STORAGE_WRITE_FAILED', platform);
    }
  }
  async function publish(temp, next) {
    try { await fs.rename(temp, file); }
    catch { throw storageError('CREDENTIAL_STORAGE_WRITE_FAILED', platform); }
    records = next;
  }
  async function decrypt(id) {
    if (!Object.hasOwn(records, id)) return '';
    await verifyAvailable();
    let decoded;
    try {
      decoded = await safeStorage.decryptStringAsync(Buffer.from(records[id], 'base64'));
      if (!decoded || typeof decoded.result !== 'string' || !decoded.result) throw new Error();
    } catch (error) {
      throw storageError(temporary(error) ? 'CREDENTIAL_STORAGE_TEMPORARILY_UNAVAILABLE' : 'CREDENTIAL_STORAGE_DECRYPT_FAILED', platform);
    }
    if (decoded.shouldReEncrypt) {
      const next = Object.assign(Object.create(null), records, { [id]: await encrypt(decoded.result) });
      const temp = await stage(next);
      try { await publish(temp, next); }
      finally { await fs.unlink(temp).catch(() => {}); }
    }
    return decoded.result;
  }
  function keyFor(id) {
    return serialize(() => decrypt(id));
  }
  function readForProvider(expected, resolveCurrent, ids) {
    return serialize(async () => {
      const current = resolveCurrent(expected.id);
      if (!current || current.id !== expected.id || current.baseUrl !== expected.baseUrl || current.protocol !== expected.protocol) {
        throw Object.assign(new Error('连接已更改或删除，请重新选择连接后再试。'), {
          code: 'CREDENTIAL_STORAGE_CONNECTION_CHANGED', retryable: true,
        });
      }
      const keys = [];
      for (const id of ids) keys.push(await decrypt(id));
      return keys;
    });
  }
  function transaction(prepare) {
    return serialize(async () => {
      const next = Object.assign(Object.create(null), records);
      const metadata = await prepare({
        has: id => Object.hasOwn(next, id),
        set: async (id, value) => { next[id] = await encrypt(value); },
        remove: id => { delete next[id]; },
      });
      const changed = JSON.stringify(next) !== JSON.stringify(records);
      const temp = changed ? await stage(next) : null;
      try {
        const result = await metadata.commit();
        // Keep the original vault intact until all validation and the settings
        // write succeed. A failed rename cannot discard previous credentials.
        if (temp) await publish(temp, next);
        return result;
      } catch (error) {
        try { await metadata.rollback(); }
        catch { throw storageError('CREDENTIAL_STORAGE_WRITE_FAILED', platform); }
        throw error;
      } finally {
        if (temp) await fs.unlink(temp).catch(() => {});
      }
    });
  }
  return { keyFor, readForProvider, transaction };
}
