// store.js — where anonymous, opt-in result summaries are kept.
//
// Only summaries people CHOSE to share are stored: drift type, score, weekly
// totals, topic shares, an accuracy answer and an age group. Never history,
// titles, names, timestamps or anything that identifies someone.
//
// Storage:
//   - DATABASE_URL set  → Postgres (durable; e.g. a free Neon database)
//   - otherwise         → a JSON file (fine locally; on Render's free plan the
//                         file is wiped on every deploy/restart)

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Accept the connection string exactly as Neon shows it; drop URL options the
// Postgres driver doesn't need (SSL is configured below).
function cleanUrl(u) {
  if (!u) return '';
  try { const x = new URL(u.trim()); ['channel_binding', 'sslmode'].forEach((k) => x.searchParams.delete(k)); return x.toString(); }
  catch { return u.trim(); }
}
const DATABASE_URL = cleanUrl(process.env.DATABASE_URL || '');
const FILE = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'contributions.json');

let pool = null;
async function pg() {
  if (pool) return pool;
  const { default: pgmod } = await import('pg');
  pool = new pgmod.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  await pool.query(`CREATE TABLE IF NOT EXISTS contributions (
    id TEXT PRIMARY KEY,
    delete_hash TEXT NOT NULL,
    day DATE NOT NULL,
    data JSONB NOT NULL
  )`);
  return pool;
}

export const storageKind = DATABASE_URL ? 'postgres' : 'file (temporary)';

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const today = () => new Date().toISOString().slice(0, 10); // day only, never a time

async function readFile() {
  try { return JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { return []; }
}
async function writeFile(rows) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(rows));
}

/** Save one summary. Returns {id, deleteToken} — the token lets the person remove it later. */
export async function addContribution(data) {
  const id = crypto.randomUUID();
  const deleteToken = crypto.randomBytes(24).toString('hex');
  const row = { id, delete_hash: hash(deleteToken), day: today(), data };
  if (DATABASE_URL) {
    const db = await pg();
    await db.query('INSERT INTO contributions (id, delete_hash, day, data) VALUES ($1, $2, $3, $4)', [row.id, row.delete_hash, row.day, row.data]);
  } else {
    const rows = await readFile();
    rows.push(row);
    await writeFile(rows.slice(-20000));
  }
  return { id, deleteToken };
}

/** Remove a summary, only with the token that was given when it was shared. */
export async function deleteContribution(id, token) {
  if (!id || !token) return false;
  if (DATABASE_URL) {
    const db = await pg();
    const r = await db.query('DELETE FROM contributions WHERE id = $1 AND delete_hash = $2', [id, hash(token)]);
    return r.rowCount > 0;
  }
  const rows = await readFile();
  const keep = rows.filter((r) => !(r.id === id && r.delete_hash === hash(token)));
  if (keep.length === rows.length) return false;
  await writeFile(keep);
  return true;
}

/** All summaries (data only) for the public totals page. */
export async function allContributions() {
  if (DATABASE_URL) {
    const db = await pg();
    const r = await db.query('SELECT day, data FROM contributions ORDER BY day');
    return r.rows.map((x) => ({ day: String(x.day).slice(0, 10), ...x.data }));
  }
  return (await readFile()).map((x) => ({ day: x.day, ...x.data }));
}
