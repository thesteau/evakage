import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {{salt: string, hash: string, preferences: Record<string, string>, revision: number}} Account */
const OPTIONS = {
  'aria-drop-theme': ['system', 'light', 'dark'],
  'aria-drop-incoming': ['new', 'always', 'auto'],
  'aria-drop-verified-only': ['0', '1'],
  'aria-drop-force-relay': ['0', '1']
};
/** @param {unknown} value @returns {Record<string, string> | null} */
export function validatePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = /** @type {Record<string, string>} */ ({});
  for (const [key, val] of Object.entries(value)) {
    if (!Object.hasOwn(OPTIONS, key) || typeof val !== 'string' || !OPTIONS[/** @type {keyof typeof OPTIONS} */ (key)].includes(val)) return null;
    result[key] = val;
  }
  return result;
}

/** Durable accounts only. Sessions, device keys, text, and files are excluded.
 * @param {string} file */
export function createAccountStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Create with private permissions before SQLite opens the file. An existing
  // database is opened as-is without truncation.
  const descriptor = fs.openSync(file, 'a', 0o600);
  fs.closeSync(descriptor);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version !== 0 && version !== 1) throw new Error(`Unsupported account database version: ${version}`);
    if (version === 0) {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS accounts (
          username TEXT PRIMARY KEY NOT NULL CHECK(length(username) BETWEEN 3 AND 40 AND username NOT GLOB '*[^a-z0-9_-]*'),
          salt TEXT NOT NULL CHECK(length(salt) = 32 AND salt NOT GLOB '*[^0-9a-f]*'),
          hash TEXT NOT NULL CHECK(length(hash) = 128 AND hash NOT GLOB '*[^0-9a-f]*'),
          preferences TEXT NOT NULL DEFAULT '{}' CHECK(length(preferences) <= 4096 AND json_valid(preferences) AND json_type(preferences) = 'object'),
          revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991)
        ) STRICT;
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
  } catch (error) { db.close(); throw error; }
  const find = db.prepare('SELECT salt, hash, preferences, revision FROM accounts WHERE username = ?');
  const count = db.prepare('SELECT count(*) AS count FROM accounts');
  const insert = db.prepare(`INSERT INTO accounts (username, salt, hash)
    SELECT ?, ?, ? WHERE (SELECT count(*) FROM accounts) < 10000
    ON CONFLICT(username) DO NOTHING`);
  const update = db.prepare(`UPDATE accounts SET preferences = ?, revision = revision + 1
    WHERE username = ? AND revision = ? RETURNING revision`);
  let closed = false;
  /** @param {string} username @returns {Account | null} */
  function get(username) {
    const row = find.get(username);
    if (!row) return null;
    const preferences = validatePreferences(JSON.parse(String(row.preferences)));
    if (!preferences) throw new Error('Invalid stored account preferences.');
    return { salt: String(row.salt), hash: String(row.hash), preferences, revision: Number(row.revision) };
  }
  return {
    get,
    count: () => Number(count.get()?.count),
    /** @param {string} username @param {string} salt @param {string} hash */
    create(username, salt, hash) {
      if (Number(insert.run(username, salt, hash).changes) === 1) return 'created';
      return get(username) ? 'exists' : 'full';
    },
    /** @param {string} username @param {Record<string, string>} preferences @param {number} revision */
    savePreferences(username, preferences, revision) {
      if (!validatePreferences(preferences) || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid preferences.');
      const row = update.get(JSON.stringify(preferences), username, revision);
      return row ? { saved: true, revision: Number(row.revision) } : { saved: false, account: get(username) };
    },
    close() { if (!closed) { closed = true; db.close(); } }
  };
}
