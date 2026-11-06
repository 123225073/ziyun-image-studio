import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { checkCredentialDestination, openCredentialVault } from '../electron/credential-vault.mjs';

// Isolated OS double: a readable old-format fixture and current-format fixture
// share one random test key. Native OS interoperability is checked by Electron.
function fakeStorage() {
  const key = randomBytes(32);
  function seal(value, version = 'v20') {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from(version), iv, cipher.getAuthTag(), encrypted]);
  }
  return {
    available: true, temporary: false, decryptions: 0, seal,
    isEncryptionAvailable() { return false; },
    encryptString() { throw new Error('Deprecated synchronous encryption'); },
    decryptString() { throw new Error('Deprecated synchronous decryption'); },
    async isAsyncEncryptionAvailable() { return this.available; },
    async encryptStringAsync(value) { return seal(value); },
    async decryptStringAsync(bytes) {
      this.decryptions++;
      if (this.temporary) throw new Error('safeStorage.decryptStringAsync is temporarily unavailable. Please try again.');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(3, 15));
      cipher.setAuthTag(bytes.subarray(15, 31));
      return { result: Buffer.concat([cipher.update(bytes.subarray(31)), cipher.final()]).toString('utf8'),
        shouldReEncrypt: bytes.subarray(0, 3).toString() === 'v10' };
    },
  };
}

async function fixture(t, platform = 'darwin') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ziyun-credential-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, platform === 'darwin' ? 'credentials.keychain.json' : 'credentials.dpapi.json');
  const storage = fakeStorage(), open = () => openCredentialVault({ file, safeStorage: storage, platform });
  return { file, storage, open, contents: () => fs.readFile(file, 'utf8') };
}
const noMetadata = () => ({ async commit() {}, async rollback() {} });
const store = (vault, id, secret) => vault.transaction(async edit => {
  await edit.set(id, secret);
  return noMetadata();
});

test('sync unavailable + async available saves on macOS and never writes the clear key', async t => {
  const { file, storage, open, contents } = await fixture(t);
  assert.equal(storage.isEncryptionAvailable(), false);
  const vault = await open(), secret = 'isolated-model-key';
  await store(vault, 'provider', secret);
  const bytes = await contents();
  assert.ok(!bytes.includes(secret) && !bytes.includes(Buffer.from(secret).toString('base64')));
  const restarted = await open();
  assert.equal(storage.decryptions, 0, 'opening the application does not decrypt or migrate credentials');
  assert.equal(await restarted.keyFor('provider'), secret);
  assert.equal(await contents(), bytes, 'reading a current key must not rewrite the vault');
  assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
});

test('reads old encrypted keys on demand, rotates only that key, and survives restart', async t => {
  const { file, storage, open, contents } = await fixture(t, 'win32');
  const old = { provider: storage.seal('old-api-key', 'v10').toString('base64'),
    'oairegbox-account:provider': storage.seal('old-account-token', 'v10').toString('base64') };
  await fs.writeFile(file, JSON.stringify(old));
  const vault = await open();
  assert.deepEqual(JSON.parse(await contents()), old);
  assert.equal(await vault.keyFor('provider'), 'old-api-key');
  const current = JSON.parse(await contents());
  assert.notEqual(current.provider, old.provider);
  assert.equal(current['oairegbox-account:provider'], old['oairegbox-account:provider']);
  assert.equal(await (await open()).keyFor('provider'), 'old-api-key');
  assert.deepEqual(JSON.parse(await contents()), current);
});

test('unavailable and denied operations keep ciphertext and metadata, then permit a fresh retry', async t => {
  const { storage, open, contents } = await fixture(t);
  const vault = await open();
  await store(vault, 'id', 'original-secret');
  const original = await contents();
  storage.available = false;
  await assert.rejects(store(vault, 'id', 'replacement-secret'), e =>
    e.code === 'CREDENTIAL_STORAGE_UNAVAILABLE' && e.retryable && e.message.includes('钥匙串') && !e.message.includes('replacement-secret'));
  storage.available = true; storage.temporary = true;
  await assert.rejects(vault.keyFor('id'), {code:'CREDENTIAL_STORAGE_TEMPORARILY_UNAVAILABLE',retryable:true});
  assert.equal(await contents(), original);
  storage.temporary = false;
  assert.equal(await vault.keyFor('id'), 'original-secret');
  storage.encryptStringAsync = async secret => { throw new Error('Native details: ' + secret); };
  await assert.rejects(store(vault, 'id', 'sensitive-input'), e => e.code === 'CREDENTIAL_STORAGE_UNAVAILABLE' && !e.message.includes('sensitive-input'));
  assert.equal(await contents(), original);
});

test('a failed key rotation leaves the original readable after a restart', async t => {
  const { file, storage, open, contents } = await fixture(t);
  const secret='rotated-token', before=JSON.stringify({id:storage.seal(secret,'v10').toString('base64')});
  await fs.writeFile(file, before);
  const rename=fs.rename;
  const mock=t.mock.method(fs,'rename',async (source,target) => {
    if(target===file) throw Object.assign(new Error('file locked'),{code:'EPERM'});
    return rename(source,target);
  });
  const vault=await open();
  await assert.rejects(vault.keyFor('id'), {code:'CREDENTIAL_STORAGE_WRITE_FAILED',retryable:true});
  assert.equal(await contents(),before);
  mock.mock.restore();
  assert.equal(await (await open()).keyFor('id'),secret);
  assert.notEqual(await contents(),before);
});

test('a failed delete and concurrent save preserve unrelated providers and can be retried', async t => {
  const { file, open }=await fixture(t);
  const vault=await open();
  await Promise.all([store(vault,'a','key-a'),store(vault,'b','key-b')]);
  const metadata=new Set(['a','b']), rename=fs.rename;
  let failOnce=true;
  t.mock.method(fs,'rename',async (source,target)=>{
    if(target===file && failOnce){failOnce=false;throw new Error('isolated rename failure');}
    return rename(source,target);
  });
  const remove = () => vault.transaction(async edit=>{
    edit.remove('a');
    return {async commit(){metadata.delete('a');},async rollback(){metadata.add('a');}};
  });
  const [deleted, saved]=await Promise.allSettled([remove(),store(vault,'b','new-key-b')]);
  assert.equal(deleted.reason.code,'CREDENTIAL_STORAGE_WRITE_FAILED');assert.equal(saved.status,'fulfilled');
  assert.deepEqual([...metadata].sort(),['a','b']);
  const reopened=await open();
  assert.equal(await reopened.keyFor('a'),'key-a');assert.equal(await reopened.keyFor('b'),'new-key-b');
  await remove();assert.ok(!metadata.has('a'));
  assert.equal(await (await open()).keyFor('a'),'');
});

test('malformed vaults are left untouched, and a failed settings commit cannot replace an existing credential', async t=>{
  const { file, open, contents }=await fixture(t);
  await fs.writeFile(file,'{damaged');await assert.rejects(open(),/加密配置无法读取/);
  assert.equal(await contents(),'{damaged');
  await fs.writeFile(file,'{}');
  const vault=await open();await store(vault,'id','old');
  const original=await contents();let rollback=false;
  await assert.rejects(vault.transaction(async edit=>{
    await edit.set('id','new');
    return {async commit(){throw new Error('settings write failed');},async rollback(){rollback=true;}};
  }),/settings write failed/);
  assert.equal(rollback,true);assert.equal(await contents(),original);
});

test('a new provider is rolled back when its staged key cannot be published', async t => {
  const { file, open } = await fixture(t);
  const vault = await open(), providers = [];
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === file) throw new Error('isolated disk failure');
    return rename(from, to);
  });
  await assert.rejects(vault.transaction(async edit => {
    await edit.set('first-provider', 'new-secret');
    return {
      async commit() { providers.push('first-provider'); },
      async rollback() { providers.splice(providers.indexOf('first-provider'), 1); },
    };
  }), {code:'CREDENTIAL_STORAGE_WRITE_FAILED'});
  assert.deepEqual(providers, []);
  assert.equal(await (await open()).keyFor('first-provider'), '');
  assert.deepEqual(await fs.readdir(path.dirname(file)), []);
});

test('a legacy key cannot be associated with a different site even if an edit is interrupted', async t => {
  const { file, storage, open, contents } = await fixture(t);
  const a = { id:'same', protocol:'openai-chat', baseUrl:'https://a.example/v1' };
  const b = { ...a, baseUrl:'https://b.example/v1' };
  const original = JSON.stringify({ same:storage.seal('only-for-a','v10').toString('base64') });
  await fs.writeFile(file,original);
  const vault = await open();
  let committed = false;
  await assert.rejects(vault.transaction(async edit => {
    checkCredentialDestination(a,b,edit.has('same'),true);
    await edit.set('same','only-for-b');
    return { async commit(){committed=true;}, async rollback(){} };
  }), /新建连接/);
  assert.equal(committed,false);
  assert.equal(await contents(),original);
  assert.doesNotThrow(() => checkCredentialDestination(a,{...a,baseUrl:'https://a.example/api'},true,false));
  assert.throws(() => checkCredentialDestination(a,{...a,baseUrl:'https://a.example/api'},true,true),/新建连接/);
  assert.throws(() => checkCredentialDestination(null,b,true,true),/新建连接/);
});

test('queued reads check their recipient and fetch API key + account token as one snapshot', async t => {
  const { open, storage } = await fixture(t), vault = await open();
  const a={id:'id',protocol:'openai-chat',baseUrl:'https://a.example/v1'}, b={...a,baseUrl:'https://b.example/v1'};
  let current=a;
  const savePair=(provider,key,token)=>vault.transaction(async edit=>{
    await edit.set('id',key);await edit.set('account:id',token);
    return {async commit(){current=provider;},async rollback(){}};
  });
  await savePair(a,'a-key','a-token');
  const entered=Promise.withResolvers(), release=Promise.withResolvers();
  const nativeDecrypt=storage.decryptStringAsync.bind(storage);
  storage.decryptStringAsync=async bytes=>{entered.resolve();await release.promise;return nativeDecrypt(bytes);};
  const reading=vault.readForProvider(a,()=>current,['id','account:id']);
  await entered.promise;
  // A connection may be deleted and recreated under the same ID while an old
  // provider job is waiting to get its credentials.
  const removed=vault.transaction(async edit=>{edit.remove('id');edit.remove('account:id');return {async commit(){current=null;},async rollback(){}};});
  const saved=savePair(b,'b-key','b-token');
  const stale=vault.readForProvider(a,()=>current,['id','account:id']);
  release.resolve();
  assert.deepEqual(await reading,['a-key','a-token']);
  await Promise.all([removed,saved]);
  await assert.rejects(stale,{code:'CREDENTIAL_STORAGE_CONNECTION_CHANGED',retryable:true});
  assert.deepEqual(await vault.readForProvider(b,()=>current,['id','account:id']),['b-key','b-token']);
});
