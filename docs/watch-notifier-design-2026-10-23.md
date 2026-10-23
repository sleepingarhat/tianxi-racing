# 愛駒追蹤 / 收賽日提示 — architecture (2026-10-23)

## Ownership split
| Piece | Lives in | Why |
|---|---|---|
| Race data events (排位/晨操/試閘/傷患) | **Backend Worker** `GET /api/watch/events` (this repo, `backend/src/routes/watch.ts`) | Data is in D1 |
| Users, watchlists, prefs, dedupe ledger, Telegram links, push subscriptions, crypto passes | **Lovable / Supabase** | Identity and entitlement live in Supabase |
| Cron notifier, Telegram DM, Web Push, Telegram webhook, Pro channel invite/kick | **Lovable** server routes plus pg_cron | Needs the user identity; secrets stay in Lovable |

## Feed contract
`GET /api/watch/events?horse_ids=<≤90 ids>&since=YYYY-MM-DD[&types=entry,trackwork,trial,injury][&trackwork=gallop|all]`
- Header `x-cron-secret`: `WATCH_FEED_SECRET`, falling back to `WEATHER_CRON_SECRET`. Returns 503 if neither is configured and 401 on a mismatch (constant-time compare).
- The 90-id cap keeps D1 under its 100-bound-parameter limit.
- `since` defaults to HK today−2 and is clamped to 14 days back.
- Stable `event_key`s. The consumer dedupes on `(user_id, event_key)`. Never use `ingested_at`, because the ingest upsert resets it.
  - `entry:{date}:{venue}:{race}:{horse}:D|R`. Only race_date ≥ HK today. R = 後備.
  - `trackwork:{id}`. Gallop mode keeps only 快操/試閘/出賽.
  - `trial:{id}`
  - `injury:{id}:open` / `injury:{id}:resolved`
- A `freshness` block (latest dates per source) and a Chinese `freshnessNote`. Data arrives in daily batches (trackwork about 1–3 days behind). It is not live.

## Consumer flow (Lovable job `/api/public/jobs/horse-watch`, hourly)
1. Distinct watched horse ids → chunks of 90 → feed (`since` = today−3, `trackwork=all`).
2. Per watcher: apply toggles. Non-entry events older than when the watch was added are inserted as already-seen (no backfill spam).
3. `insert … on conflict (user_id, event_key) do nothing returning` → deliver only new rows. Telegram DM via @tianxi_racing_bot, Web Push via VAPID (Web Crypto library).
4. Each run is logged to `watch_job_runs`.

Race-day alerts: a separate job polls `/api/analyze/lock-state` and sends once per meeting when `locked && edition==='final'`. Content is tiered (registered after the gate = race 1 only).

## Security notes
- The feed only exposes public HKJC-derived data. The secret is there to prevent scraping and abuse, not to protect private data.
- Frontend tier gating is UX-only today, because Pro endpoints on this Worker are publicly readable. Real enforcement needs a follow-up PR that verifies a Supabase JWT / entitlement in the Worker.

## Prompt files
Lovable prompts: `/workspace/tianxi/state/tiers/lovable_tiers_part{1,2,3,4a,4b,5a,5b,6,7}.md` (owner workspace).
