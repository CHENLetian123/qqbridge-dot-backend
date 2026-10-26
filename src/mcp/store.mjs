import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// One encrypted, transactional record store for subscriptions, outbox entries,
// run identities and fail-closed send reservations. Never store QQ history here.
export class GatewayStore {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const keyFile = filename + '.key';
    try {
      fs.writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    this.key = fs.readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('Invalid gateway encryption key.');
    this.db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));',
    );
  }
  encode(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
  }
  decode(text) {
    const data = Buffer.from(text, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(-16));
    return JSON.parse(
      Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8'),
    );
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? this.decode(row.value) : null;
  }
  put(kind, id, value) {
    this.db
      .prepare(
        'INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value',
      )
      .run(kind, id, this.encode(value));
    return value;
  }
  list(kind) {
    return this.db
      .prepare('SELECT id,value FROM records WHERE kind=?')
      .all(kind)
      .map((row) => ({ id: row.id, ...this.decode(row.value) }));
  }
  delete(kind, id) {
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
