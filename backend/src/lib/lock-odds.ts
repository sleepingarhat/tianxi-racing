// Lock-time market odds (凍結時賠率). At the meeting's T−90 lock the engine's Top-4 are
// frozen; this module keeps the WIN/PLA prices the market showed at that same instant so
// engine-vs-market comparisons never use final (post-lock) odds.
//
// Rules:
// - Only rows with snapshot_at <= lockAt are eligible, whenever the capture runs. A late
//   capture is still pre-lock evidence (snapshot_at is the HKJC fetch time); captured_at
//   records when the copy was taken.
// - Append-only: one manifest per meeting, INSERT OR IGNORE rows, never UPDATE/DELETE. A
//   second capture for the same meeting is a no-op.
// - Separate from prediction_log / prediction_original_snapshots; never an engine input
//   and never part of the frozen pick fingerprint.

export const LOCK_ODDS_POOLS = ['WIN', 'PLA'] as const;
export const LOCK_ODDS_STALE_MINUTES = 20;

export type LockOddsRow = {
  race_number: number;
  pool_type: string;
  combination: string;
  odds: number | null;
  snapshot_at: string;
};

export type LockOddsManifest = {
  race_date: string;
  venue: string;
  lock_at: string;
  captured_at: string;
  status: 'captured' | 'partial' | 'missing';
  races: number;
  rows: number;
  oldest_snapshot_at: string | null;
  newest_snapshot_at: string | null;
  stale_races: string;
  sha256: string | null;
};

export async function ensureLockOddsTables(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS lock_odds_manifest (
    race_date TEXT NOT NULL, venue TEXT NOT NULL, lock_at TEXT NOT NULL, captured_at TEXT NOT NULL,
    status TEXT NOT NULL, races INTEGER NOT NULL, rows INTEGER NOT NULL,
    oldest_snapshot_at TEXT, newest_snapshot_at TEXT, stale_races TEXT NOT NULL DEFAULT '', sha256 TEXT,
    PRIMARY KEY (race_date, venue))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS lock_odds_snapshots (
    race_date TEXT NOT NULL, venue TEXT NOT NULL, race_number INTEGER NOT NULL, pool_type TEXT NOT NULL,
    combination TEXT NOT NULL, odds REAL, snapshot_at TEXT NOT NULL, lock_at TEXT NOT NULL,
    PRIMARY KEY (race_date, venue, race_number, pool_type, combination))`).run();
}

/** Normalised horse key: "01" → "1" (same contract as market-blend normHorseKey). */
function normCombo(combo: string): string {
  const n = Number(combo);
  return Number.isFinite(n) && /^\s*\d+\s*$/.test(combo) ? String(n) : combo.trim();
}

/** Latest row per race/pool/combination with snapshot_at <= lockAt (later rows ignored). */
export function pickLockRows(rows: LockOddsRow[], lockAt: string): LockOddsRow[] {
  const lockMs = Date.parse(lockAt);
  if (!Number.isFinite(lockMs)) throw new Error('invalid lockAt');
  const best = new Map<string, LockOddsRow>();
  for (const r of rows) {
    const t = Date.parse(r.snapshot_at);
    if (!Number.isFinite(t) || t > lockMs) continue;
    if (!(LOCK_ODDS_POOLS as readonly string[]).includes(r.pool_type)) continue;
    const combination = normCombo(String(r.combination));
    const key = `${r.race_number}|${r.pool_type}|${combination}`;
    const prev = best.get(key);
    if (!prev || Date.parse(prev.snapshot_at) < t) {
      const odds = r.odds == null || !Number.isFinite(Number(r.odds)) ? null : Number(r.odds);
      best.set(key, { race_number: Number(r.race_number), pool_type: r.pool_type, combination, odds, snapshot_at: r.snapshot_at });
    }
  }
  return [...best.values()].sort((a, b) =>
    a.race_number - b.race_number || a.pool_type.localeCompare(b.pool_type) || (Number(a.combination) - Number(b.combination)) || a.combination.localeCompare(b.combination));
}

export function canonicalLockOdds(date: string, venue: string, lockAt: string, rows: LockOddsRow[]): string {
  const lines = rows.map((r) => [r.race_number, r.pool_type, r.combination, r.odds == null ? 'null' : String(r.odds), r.snapshot_at].join('|'));
  return [`lock-odds/v1|${date}|${venue}|${lockAt}`, ...lines].join('\n');
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function summariseLockRows(rows: LockOddsRow[], lockAt: string, staleMinutes = LOCK_ODDS_STALE_MINUTES) {
  const lockMs = Date.parse(lockAt);
  const newestByRace = new Map<number, number>();
  for (const r of rows) {
    const t = Date.parse(r.snapshot_at);
    newestByRace.set(r.race_number, Math.max(newestByRace.get(r.race_number) ?? 0, t));
  }
  const stale = [...newestByRace.entries()].filter(([, t]) => lockMs - t > staleMinutes * 60_000).map(([race]) => race).sort((a, b) => a - b);
  const times = rows.map((r) => r.snapshot_at).sort();
  const status: LockOddsManifest['status'] = rows.length === 0 ? 'missing' : stale.length ? 'partial' : 'captured';
  return { races: newestByRace.size, stale, status, oldest: times[0] ?? null, newest: times[times.length - 1] ?? null };
}

export type CaptureResult = { ok: boolean; action: 'captured' | 'already-captured' | 'error'; status?: LockOddsManifest['status']; rows?: number; sha256?: string | null; error?: string };

export async function captureLockOdds(db: D1Database, date: string, venue: string, lockAt: string, now: Date = new Date()): Promise<CaptureResult> {
  try {
    if (now.getTime() < Date.parse(lockAt)) return { ok: false, action: 'error', error: 'before-lock' };
    await ensureLockOddsTables(db);
    const existing = await db.prepare(`SELECT status, rows, sha256 FROM lock_odds_manifest WHERE race_date = ? AND venue = ?`).bind(date, venue).first<any>();
    if (existing) return { ok: true, action: 'already-captured', status: existing.status, rows: existing.rows, sha256: existing.sha256 };
    const { results } = await db.prepare(
      `SELECT race_number, pool_type, combination, odds, snapshot_at FROM odds_snapshots
        WHERE race_date = ? AND venue = ? AND pool_type IN ('WIN','PLA') AND snapshot_at <= ?`
    ).bind(date, venue, lockAt).all<LockOddsRow>();
    const rows = pickLockRows(results ?? [], lockAt);
    const sum = summariseLockRows(rows, lockAt);
    const sha = rows.length ? await sha256Hex(canonicalLockOdds(date, venue, lockAt, rows)) : null;
    const capturedAt = now.toISOString();
    const stmts = rows.map((r) => db.prepare(
      `INSERT OR IGNORE INTO lock_odds_snapshots (race_date, venue, race_number, pool_type, combination, odds, snapshot_at, lock_at) VALUES (?,?,?,?,?,?,?,?)`
    ).bind(date, venue, r.race_number, r.pool_type, r.combination, r.odds, r.snapshot_at, lockAt));
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO lock_odds_manifest (race_date, venue, lock_at, captured_at, status, races, rows, oldest_snapshot_at, newest_snapshot_at, stale_races, sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(date, venue, lockAt, capturedAt, sum.status, sum.races, rows.length, sum.oldest, sum.newest, sum.stale.join(','), sha));
    await db.batch(stmts);
    return { ok: true, action: 'captured', status: sum.status, rows: rows.length, sha256: sha };
  } catch (e: any) {
    return { ok: false, action: 'error', error: e?.message ?? String(e) };
  }
}

/** Read back a meeting's lock-time odds and re-verify the stored fingerprint. */
export async function readLockOdds(db: D1Database, date: string, venue?: string | null) {
  const tbl = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='lock_odds_manifest'`).first();
  if (!tbl) return { date, manifest: null, verified: false, races: [] as any[] };
  const manifest = venue
    ? await db.prepare(`SELECT * FROM lock_odds_manifest WHERE race_date = ? AND venue = ?`).bind(date, venue).first<LockOddsManifest>()
    : await db.prepare(`SELECT * FROM lock_odds_manifest WHERE race_date = ? ORDER BY venue LIMIT 1`).bind(date).first<LockOddsManifest>();
  if (!manifest) return { date, manifest: null, verified: false, races: [] as any[] };
  const { results } = await db.prepare(
    `SELECT race_number, pool_type, combination, odds, snapshot_at FROM lock_odds_snapshots WHERE race_date = ? AND venue = ?`
  ).bind(manifest.race_date, manifest.venue).all<LockOddsRow>();
  const rows = pickLockRows(results ?? [], manifest.lock_at);
  const sha = rows.length ? await sha256Hex(canonicalLockOdds(manifest.race_date, manifest.venue, manifest.lock_at, rows)) : null;
  const verified = sha === manifest.sha256 && rows.length === manifest.rows;
  const byRace = new Map<number, { raceNumber: number; snapshotAt: string | null; win: { horseNumber: number; odds: number | null }[]; place: { horseNumber: number; odds: number | null }[] }>();
  for (const r of rows) {
    const race = byRace.get(r.race_number) ?? { raceNumber: r.race_number, snapshotAt: null, win: [], place: [] };
    const entry = { horseNumber: Number(r.combination), odds: r.odds };
    (r.pool_type === 'WIN' ? race.win : race.place).push(entry);
    if (!race.snapshotAt || race.snapshotAt < r.snapshot_at) race.snapshotAt = r.snapshot_at;
    byRace.set(r.race_number, race);
  }
  const races = [...byRace.values()].map((race) => ({
    ...race,
    // Market favourites at lock: lowest WIN odds first; ties keep horse-number order; no price → excluded.
    marketTop4: race.win.filter((w) => w.odds != null && w.odds > 0).sort((a, b) => (a.odds as number) - (b.odds as number) || a.horseNumber - b.horseNumber).slice(0, 4).map((w) => w.horseNumber),
  }));
  return { date: manifest.race_date, manifest, verified, races };
}
