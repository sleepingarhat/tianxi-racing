import type { Env } from '../types';
import { oddsStale, parseOdds } from './odds-freshness';
const ODDS_QUERY = `
query racing($date: String, $venueCode: String, $oddsTypes: [OddsType], $raceNo: Int) {
  raceMeetings(date: $date, venueCode: $venueCode) {
    pmPools(oddsTypes: $oddsTypes, raceNo: $raceNo) {
      id
      status
      sellStatus
      oddsType
      lastUpdateTime
      guarantee
      minTicketCost
      name_en
      name_ch
      leg {
        number
        races
      }
      cWinSelections {
        composite
        name_ch
        name_en
        starters
      }
      oddsNodes {
        combString
        oddsValue
        hotFavourite
        oddsDropValue
        bankerOdds {
          combString
          oddsValue
        }
      }
    }
  }
}`;
type Pool = { oddsType: string; oddsNodes?: { combString: string; oddsValue: unknown }[] };
/** Active local race-day display odds only; never touches model or frozen records. */
export async function readOddsFreshness(db: Env['DB'], now = Date.now()) {
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const hour = new Date(now + 8 * 3600_000).getUTCHours();
  if (hour < 9 || hour >= 23) return { active: false, stale: [], date: today };
  const { results } = await db.prepare(`SELECT e.venue,e.race_number,MIN(e.post_time) post_time,
    (SELECT MAX(o.snapshot_at) FROM odds_snapshots o WHERE o.race_date=e.race_date AND o.venue=e.venue AND o.race_number=e.race_number AND o.pool_type='WIN') snapshot
    FROM entries_upcoming e WHERE e.race_date=? AND e.venue IN ('ST','HV') AND e.race_number>0
    GROUP BY e.venue,e.race_number ORDER BY e.race_number`).bind(today).all<{venue:string;race_number:number;post_time:string|null;snapshot:string|null}>();
  const active = results.filter(r => r.post_time && Date.parse(r.post_time) > now);
  return { active: active.length > 0, date: today, races: active, stale: active.filter(r => oddsStale(r.snapshot, now)) };
}
export async function collectDisplayOdds(env: Env) {
  const before = await readOddsFreshness(env.DB);
  if (!before.active) return { ok: true, action: 'no-active-local-races' };
  const errors: number[] = [];
  let written = 0;
  for (const race of before.races ?? []) {
    try {
      const response = await fetch('https://info.cld.hkjc.com/graphql/base/', { method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({query:ODDS_QUERY,variables:{date:before.date,venueCode:race.venue,raceNo:race.race_number,oddsTypes:['WIN','PLA']}}), signal:AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`hkjc-odds-${response.status}`);
      const body = await response.json() as { errors?: unknown[]; data?: {raceMeetings?: {pmPools?: Pool[]}[]} };
      if (body.errors?.length) throw new Error('hkjc-odds-graphql-error');
      const pools = body.data?.raceMeetings?.[0]?.pmPools ?? [];
      const win = pools.find(p => p.oddsType === 'WIN');
      if (!win?.oddsNodes?.some(n => parseOdds(n.oddsValue) !== null)) throw new Error('empty-win-pool');
      const snapshot = new Date().toISOString();
      const statements = pools.filter(p => ['WIN','PLA'].includes(p.oddsType)).flatMap(p => (p.oddsNodes ?? []).filter(n => /^\d{1,2}$/.test(n.combString)).map(n =>
        env.DB.prepare(`INSERT OR IGNORE INTO odds_snapshots(id,race_date,venue,race_number,pool_type,combination,odds,snapshot_at,source_commit) VALUES (?,?,?,?,?,?,?,?,?)`)
          .bind(crypto.randomUUID(),before.date,race.venue,race.race_number,p.oddsType,n.combString.padStart(2,'0'),parseOdds(n.oddsValue),snapshot,'worker-display-odds-v1')));
      if (!statements.length) throw new Error('no-odds-rows');
      await env.DB.batch(statements);
      written += statements.length;
    } catch (e) { errors.push(race.race_number); console.error('[odds-collection]',race.race_number,String(e)); }
  }
  const after = await readOddsFreshness(env.DB);
  if (after.stale.length) {
    console.error('[odds-freshness] >20m or missing',after.date,after.stale.map(r => r.race_number));
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS odds_alert_delivery (race_date TEXT PRIMARY KEY, sent_at TEXT NOT NULL)`).run();
    const receipt = await env.DB.prepare(`SELECT sent_at FROM odds_alert_delivery WHERE race_date=?`).bind(after.date).first<{sent_at:string}>();
    if (env.WEATHER_CRON_SECRET && (!receipt || Date.now()-Date.parse(receipt.sent_at)>20*60_000)) {
      try {
        const response = await fetch('https://mark-six-joy.lovable.app/api/public/telegram-alert',{method:'POST',headers:{'content-type':'application/json','x-cron-secret':env.WEATHER_CRON_SECRET},
          body:JSON.stringify({kind:'odds-stale',date:after.date,races:after.stale.map(r => r.race_number)}),signal:AbortSignal.timeout(8_000)});
        const result = await response.json() as {sent?:boolean};
        if (response.ok && result.sent) await env.DB.prepare(`INSERT INTO odds_alert_delivery(race_date,sent_at) VALUES (?,?) ON CONFLICT(race_date) DO UPDATE SET sent_at=excluded.sent_at`).bind(after.date,new Date().toISOString()).run();
      } catch { console.warn('[odds-freshness] notification not delivered'); }
    }
  }
  return {ok:errors.length===0, written, failedRaces:errors, staleRaces:after.stale.map(r => r.race_number)};
}
