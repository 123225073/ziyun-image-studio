import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

const require = createRequire(import.meta.url);

// A single transaction commits the complete small project state. The database
// file is replaced atomically, so neither a crash nor an interrupted write can
// leave half of a queue submission on disk.
export class StudioStore {
  static async create(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const file = path.join(dataDir, 'studio.sqlite');
    let db;
    try {
      db = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
      db.run('PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS project_state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);');
    } catch {
      db?.close();
      throw new Error('本地项目数据库无法读取，原文件已保留。请检查数据目录。');
    }
    return new StudioStore(file, db);
  }

  constructor(file, db) { this.file = file; this.db = db; this.closed = false; }

  read() {
    const result = this.db.exec('SELECT value FROM project_state WHERE id = 1');
    if (!result.length) return null;
    try { return JSON.parse(result[0].values[0][0]); }
    catch { throw new Error('本地项目内容损坏，原数据库已保留。'); }
  }

  write(state) {
    if (this.closed) throw new Error('项目数据库已关闭。');
    this.db.run('BEGIN IMMEDIATE');
    try {
      this.db.run('INSERT OR REPLACE INTO project_state(id, value) VALUES (1, ?)', [JSON.stringify(state)]);
      this.db.run('COMMIT');
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
    const temporary = `${this.file}.tmp`;
    const descriptor = fs.openSync(temporary, 'w');
    try { fs.writeFileSync(descriptor, this.db.export()); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    // Windows scanners can briefly hold a freshly replaced file. Retry the
    // same atomic rename, never remove the last good database as a fallback.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, this.file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 8) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1));
      }
    }
  }

  close() {
    if (!this.closed) { this.closed = true; this.db.close(); }
  }
}
