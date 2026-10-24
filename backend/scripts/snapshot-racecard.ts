#!/usr/bin/env tsx
/**
 * Research-only, append-only racecard snapshot (gear / rating / weight).
 * Writes entries/racecard_snapshots/<date>_<venue>/<stamp>.csv and appends
 * manifest.jsonl {file, sha256, content_sha256, rows, scraped_at}. Existing
 * files are never modified; an unchanged card (same content SHA as the latest
 * snapshot) is skipped. Does not touch D1, predictions or frozen cards.
 *
 * Uses the exact query HKJC's own bet site sends (the generic hkjc-api query
 * has been rejected with WHITELIST_ERROR since 2026-10-23). Any HKJC error
 * fails the job; it is never reported as "no meeting".
 *
 * Usage: tsx scripts/snapshot-racecard.ts [--root=..] [--date=YYYY-MM-DD] [--venue=ST|HV]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRows, contentSha, fileSha, toCsv } from './ingest/lib/racecard-snapshot.js';

const arg = (n: string, d = '') => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;

function latestRatingsBefore(base: string, raceDate: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(base)) return out;
  const dirs = readdirSync(base).filter(d => /^\d{4}-\d{2}-\d{2}_(ST|HV)$/.test(d) && d.slice(0, 10) < raceDate).sort();
  for (const dir of dirs) {
    const files = readdirSync(join(base, dir)).filter(f => f.endsWith('.csv')).sort();
    const last = files.at(-1);
    if (!last) continue;
    const [head, ...lines] = readFileSync(join(base, dir, last), 'utf8').replace(/^\uFEFF/, '').trim().split('\n');
    const cols = head.split(',');
    const hi = cols.indexOf('horse_id'), ri = cols.indexOf('rating');
    for (const line of lines) {
      const cells = line.split(',');
      const rating = Number(cells[ri]);
      if (cells[hi] && cells[ri] !== '' && Number.isFinite(rating)) out.set(cells[hi], rating);
    }
  }
  return out;
}

async function main() {
  const root = resolve(arg('root', '..'));
  const base = join(root, 'entries', 'racecard_snapshots');
  const query = readFileSync(fileURLToPath(new URL('./ingest/lib/hkjc-racecard-query.graphql', import.meta.url)), 'utf8');
  let dates = arg('date') ? [arg('date')] : [];
  if (!dates.length) {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const season = await fetch('https://tianxi-backend.tianxi-entertainment.workers.dev/api/season', { signal: AbortSignal.timeout(20_000) }).then(r => r.json()).catch(() => null) as any;
    dates = [...new Set([today, season?.nextMeeting].filter((d): d is string => /^\d{4}-\d{2}-\d{2}$/.test(String(d))))];
  }
  const venues = arg('venue') ? [arg('venue').toUpperCase()] : ['ST', 'HV'];
  const meetings: any[] = [];
  for (const date of dates) for (const venueCode of venues) {
    const res = await fetch('https://info.cld.hkjc.com/graphql/base/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { date, venueCode } }), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HKJC HTTP ${res.status} for ${date}@${venueCode}`);
    const body = await res.json() as any;
    if (body.errors?.length) throw new Error(`HKJC error for ${date}@${venueCode}: ${JSON.stringify(body.errors).slice(0, 200)}`);
    for (const m of body.data?.raceMeetings ?? []) if ((m.races ?? []).some((r: any) => (r.runners ?? []).length)) meetings.push({ ...m, date, venueCode });
  }
  if (!meetings.length) { console.error(`[snapshot] HKJC returned no runners for ${dates.join(',')} — nothing written`); return; }
  const scrapedAt = new Date().toISOString();
  const stamp = scrapedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  for (const meeting of meetings) {
    const rows = buildRows(meeting, scrapedAt, latestRatingsBefore(base, meeting.date));
    if (!rows.length) { console.error(`[snapshot] ${meeting.date}@${meeting.venueCode} has no runners — skipped`); continue; }
    const dir = join(base, `${meeting.date}_${String(meeting.venueCode).toUpperCase()}`);
    mkdirSync(dir, { recursive: true });
    const manifest = join(dir, 'manifest.jsonl');
    const cSha = contentSha(rows);
    const prior = existsSync(manifest) ? readFileSync(manifest, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    if (prior.at(-1)?.content_sha256 === cSha) { console.error(`[snapshot] ${dir} unchanged — skipped`); continue; }
    const file = `${stamp}.csv`;
    if (existsSync(join(dir, file))) throw new Error(`refusing to overwrite ${file}`);
    const text = toCsv(rows);
    writeFileSync(join(dir, file), text, { flag: 'wx' });
    appendFileSync(manifest, JSON.stringify({ file, sha256: fileSha(text), content_sha256: cSha, rows: rows.length, scraped_at: scrapedAt, source: 'hkjc bet-site racing query' }) + '\n');
    console.error(`[snapshot] wrote ${dir}/${file} (${rows.length} rows)`);
  }
}

main().catch(e => { console.error('[snapshot] failed:', e?.message ?? e); process.exit(1); });
