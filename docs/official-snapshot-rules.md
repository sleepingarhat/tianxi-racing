# Official point-in-time snapshot rules

Status: **implementable specification, self-reviewed against live repo and Worker on 2026-11-25 (Asia/Hong_Kong)**.  
Target repo: `sleepingarhat/tianxi-racing` only. Draft PR only. Do not merge, deploy, or publish.  
Do not merge drafts #137 or #138. Do not change the frozen production A-line (TX-Oracle v3, 52 `FEAT_COLS`, α=0.88, formal track-record start 2026-10-04). Do not rotate secrets. Do not auto-expand tianxi-web #36.

This document is the source of truth for pre-race (freeze), post-race, and automatic intermediate official snapshots. A later engineer must be able to follow it without guessing. Where a remaining ambiguity would produce a wrong snapshot, it is flagged in §12 and must be resolved by the owner, not by invention.

---

## 1. Purpose and non-goals

### 1.1 Why this exists

Live official tables written by `capy_wave5_visible`, `capy_wave6_surfaces`, `capy_wave7_surfaces`, and `capy_wave8_surfaces` are **latest-state projections**. Several surfaces `DELETE` the whole table or `DELETE` the meeting key before insert (`REPLACE_ALL` and meeting-keyed replace). Verified examples:

- `official_ove_database` is in Wave5 `REPLACE_ALL`. A 2026-11-24 `asOf` that had 839 rows earlier that day became unreadable as current after the 2026-11-25 `asOf` write of 836 rows.
- Meeting-keyed boards (`official_ove_record`, `official_conghua_movement`, `official_jt_combo`, `official_fwb_declared`, `official_racecard_runner`, wind going, etc.) are replaced on the same keys when a later Wave run ingests the same meeting.
- Wave8 `emit_sql` issues `DELETE FROM` for wind tables, then inserts the latest observation. `GET /api/official/wind` returns only that latest observation. A 2026-11-25 station copy at 02:41 HKT is **not** T−90.
- Public `GET /api/meetings/:date` calls `cardDeltas(null)` once results are in. Racecard deltas (`ratingChange`, `bodyWeight`, `bodyWeightChange`, `bestTime`, `daysSinceRun`, `possibleOverweight`, `ageAllowance`) disappear from the public meetings API after results. They must be snapshotted at freeze. Do **not** backfill those deltas from `race_results.declared_weight` (that column is 排位體重; results body weight and post-race going are not freeze values).

Official routes usually do not return `scraped_at`. A meeting-keyed row currently proves **presence**, not capture-at-T−90. Therefore a freeze snapshot must carry its own `captured_at`.

### 1.2 What this system does

- Recapture required official surfaces at documented trigger times.
- Persist **append-only / point-in-time** snapshots in the repo and in D1, keyed by meeting + kind + `captured_at` / content hash.
- Record gaps explicitly when a required pre-freeze surface is missing at T−90.
- Expose a minimal read-only Worker verification route. The Worker never crawls HKJC and is not the source of truth.

### 1.3 What this system does NOT do

- No A-line training, no change to 52 features, α, or formal track-record start 2026-10-04.
- No backtest of 2026-10-04… with current overwrite tables. First meetings with some official runner tables are 2026-11-11, 11-14 (Conghua / jt-combo 0), 11-18, 11-22 — 39 valid completed races after dropping 2026-11-14 ST R6 (cancelled). Do not invent historical freeze snapshots for meetings that were never snapshotted.
- No claim that a live official row was captured at T−90.
- No moving ingest into `tianxi-web`, Lovable, or a Worker cron as source of truth.
- No writing live WIN/PLA odds, finish photos, raceday JPEGs, import-policy prose, horse-news, or special-notes into a freeze snapshot as if they were pre-race features.
- No overwrite of an earlier freeze or post-race snapshot for the same meeting+kind.
- This is not `capy_racecard_snapshot` (research gear/rating history every 3 hours at :41, repo-only, no D1). That workflow stays unchanged and is not the freeze clock.

---

## 2. Authoritative freeze clock (do not invent a parallel clock)

### 2.1 Canonical rule (already implemented)

From `backend/src/lib/lock-window.ts`, live at `GET /api/analyze/engine-health` (`LOCK_POLICY`, `lockLeadMinutes`):

- `LOCK_LEAD_MINUTES = 90`.
- `firstPostAt = MIN(post_time)` from `entries_upcoming` for the meeting (`race_date`, `venue`, `race_number > 0`, `post_time IS NOT NULL`).
- `lockAt = firstPostAt − 90 minutes` (instant arithmetic, never lexicographic ISO-string compare).
- The whole race day's public Top-4 locks once `now >= lockAt`. Settlement is a stricter backstop, not the primary clock.
- Officially cancelled meeting date `2026-09-19` is excluded (`isCancelledMeeting`).

Live check on 2026-11-25 (Asia/Hong_Kong), `GET /api/analyze/lock-state` (no-store):

```json
{
  "date": "2026-11-25",
  "venue": "HV",
  "firstPostAt": "2026-11-25T18:40:00+08:00",
  "lockAt": "2026-11-25T09:10:00.000Z",
  "locked": false,
  "source": "pre-lock",
  "lockLeadMinutes": 90,
  "edition": "draft"
}
```

`lockAt` 09:10Z = 17:10 HKT = 18:40 HKT − 90 minutes. Engine health is `GET /api/analyze/engine-health` (not a root `ENGINE_HEALTH.json`).

### 2.2 How the snapshot job finds T−90

1. Discover upcoming or in-window HK meetings from official fixtures / `entries_upcoming` (same identity as `findMeetingForLockTick`: a meeting qualifies while its true first post is in the future or within the last 8 hours, `LOCK_TICK_WINDOW_HOURS = 8`).
2. Compute `firstPostAt` and `lockAt` **locally** with the same formula as `getMeetingLockState` (`LOCK_LEAD_MINUTES = 90`, parse `post_time` as instants).
3. Cross-check `GET /api/analyze/lock-state` **only when it reports the same `date`+`venue`**. That route **ignores `?date=` / `?venue=`** and always returns `findMeetingForLockTick()`'s current meeting. It cannot be used as a historical lock-state lookup.
4. If the local clock and lock-state disagree on `firstPostAt` or `lockAt` for that same meeting, **do not capture a freeze**. Write a `clock_mismatch` gap record and fail the freeze attempt. Do not invent a third clock.

### 2.3 Turf day vs night — worked examples (verified)

There is no fixed wall clock such as 07:40. Timing is always first official post minus 90 minutes.

| Meeting | Type | First post (HKT) | Freeze `lockAt` (HKT) | Last post (HKT) | Post-race earliest (last post + 30 min) |
|---|---|---|---|---|---|
| 2026-11-22 ST | Day turf (Sha Tin) | 12:30 | **11:00** | 18:25 | 18:55 |
| 2026-11-18 HV | Night (Happy Valley) | 18:40 | **17:10** | 22:50 | 23:20 |
| 2026-11-25 HV | Night (Happy Valley) | 18:40 | **17:10** | (declared at audit) | after last official post + 30 min |

### 2.4 Why existing Wave crons are not T−90

| Workflow | HKT schedule | Day ST freeze 11:00 | Night HV freeze 17:10 |
|---|---|---|---|
| Wave7 | 07:25, 16:25 | Morning is early; afternoon is **after freeze, during racing** (overwrite risk) | Afternoon is before freeze but not at T−90 |
| Wave6 | 07:40, 16:40 | Same | Same |
| Wave5 | 07:55, 16:55 | Same | 16:55 is 15 min before 17:10, still not T−90 |
| Wave8 | **07:40 only** | Early; no afternoon refresh | Wind/going at 07:40 or 02:41 is not T−90 |

This snapshot system must recapture required surfaces in the freeze window itself. It must not label a 07:40 Wave row as a freeze value. An optional later change to add a Wave8 afternoon ingest is **out of this PR**; the snapshot job recrawls wind at freeze time.

The Worker `*/5 * * * *` cron is the prediction lock tick only (`lockMeetingIfDue`). Official snapshot ingest must remain a `capy_*` GitHub Action.

---

## 3. Snapshot kinds and triggers

Kinds are mutually exclusive in meaning. A later kind never mutates an earlier snapshot.

### 3.1 `freeze` (pre-race / T−90)

- **When:** `lockAt <= now < firstPostAt`.
- **What:** Recrawl required freeze surfaces (§5.1), then write one append-only snapshot for `(meeting_date, venue, kind=freeze)`.
- **Capture timestamp:** `captured_at` is the scrape/write instant (ISO UTC). Every freeze **payload row** must have a surface-level `captured_at` satisfying `lockAt <= captured_at < firstPostAt`. A recrawl that **started** before `lockAt` may be used only if its completed `captured_at` is still `>= lockAt`.
- **Once only:** If a freeze snapshot already exists for that meeting, later runs are a no-op. They must not overwrite bytes, D1 rows, or the manifest entry.
- **If a required surface cannot be recaptured in the window:** record an explicit gap for that surface. Do **not** silently fill from a later post-race ingest, from the current live overwrite table, or from a same-day Wave file whose `scraped_at` is before `lockAt`. Those may be cited only under `gaps[].stale_available` with their real timestamp and `not_freeze_fresh: true`.
- **Do not wait past `firstPostAt`** to complete a freeze. After first post, a missing freeze is a permanent gap (`freeze_missed_window`). Never backfill a freeze after racing has started.

### 3.2 `pre_freeze_safety` (automatic, approaching freeze)

- **When:** `lockAt − 45 minutes <= now < lockAt`, and at least one required freeze surface is still missing or has no ingest with `scraped_at >= lockAt − 45 minutes`.
- **What:** Recrawl missing required surfaces; write a safety snapshot labelled `pre_freeze_safety`. This is **not** a freeze and must never be promoted to `freeze` after the fact.
- **Purpose:** Evidence that a freshness recrawl was attempted, and a last-known pre-lock copy if freeze-window recrawl later fails. Lab/feature readers must use `kind=freeze` only.
- Multiple safety snapshots are allowed if content hash changes; identical content hash is skipped (idempotent).

### 3.3 `card_status` (automatic intermediate)

- **When:** Official meeting `cardStatus` (`fixture` → `entries` → `declared`) changes, using the same signals as `resolveCardStatus` in `backend/src/lib/meeting-card.ts`. `resulted` is not a `card_status` snapshot; that belongs to `post_race`.
- The important transition is **`entries` → `declared`** (draws / official racecard cells appear, including card deltas). Also snapshot `fixture` → `entries` if the entries list is first published.
- **What:** Capture the declared/entries card including card-delta columns, plus any already-available meeting-keyed official runner boards. Do not include results or dividends.
- Append-only per `(meeting, kind=card_status, card_status_value, content_sha256)`. A later `declared` snapshot must not overwrite the earlier `entries` snapshot.

### 3.4 `post_race` (after results and dividends have settled)

- **When — all of the following:**
  1. `now >= lastOfficialPostTime + 30 minutes` (aligned with existing `scripts/results_readiness.py`; unknown timing must **not** suppress a missing-results alert and must **not** be treated as settled).
  2. Every scheduled race is either (a) present in official results with a finishing order, or (b) explicitly labelled void/cancelled (see §6).
  3. For every non-void race, official dividends include at least **WIN (獨贏)** and **PLA (位置)** rows.
  4. **Stability:** two successive poll ticks (the workflow's own interval) produce the same content hash for results+dividends. If hashes differ, wait. If still unstable at `lastOfficialPostTime + 3 hours`, write `post_race` with `completeness=partial` and list unsettled pools/races in `gaps`. Do not keep waiting forever, and do not overwrite later.
- **What:** Official results runners, official dividends, void/cancelled labels, and post-race going if published as official results going (stored here, never copied back into the freeze snapshot).
- **Once only** for `(meeting_date, venue, kind=post_race)`. Never overwrite.
- **Never mixed** into `kind=freeze` files or D1 rows used for lab/features.

### 3.5 Scheduler

Workflow: `.github/workflows/capy_official_snapshot.yml`.

GitHub Actions does **not** deliver a ten-minute cron on this repository. After this workflow merged, `cron: '*/10 * * * *'` created 5 runs in about 34 hours (2026-11-25 04:06 UTC through 2026-11-26 14:44 UTC). The 2026-11-25 Happy Valley freeze window 09:10–10:40 UTC had zero snapshot runs. The 04:06 UTC run wrote `card_status` only. The 14:12 UTC run wrote `freeze_missed_window` with `not_backfilled=true`. The same sparse delivery hit other ten-minute crons in this repo. `workflow_run` from racecard did start inside that missed window (09:26 UTC), and track conditions started at 10:30 UTC.

Triggers that start a run:

- `workflow_run` on `main` when any of these complete: Capy Racecard, Capy Race Day, Capy Track Conditions, Capy Odds. This is the catch-up when the snapshot schedule itself does not start inside the window.
- Best-effort `schedule` crons at 22:20, 03:20, 04:10, 08:10, and 09:20 UTC. These are arms, not a delivered every-10-minutes clock. A dropped cron leaves no failed run.
- `workflow_dispatch` (`date`, `venue`, `kind` optional). Dispatch still obeys idempotency and must not overwrite.

Wait rule, in the same job, before the crawl:

- If `kind=freeze` is missing and `now` is inside `[lockAt, firstPostAt)`, crawl and write `kind=freeze` immediately. A start more than 15 minutes after `lockAt` is `catch_up_inside_window`.
- If `kind=freeze` is missing and `lockAt` is still ahead by at most 330 minutes, the job waits until `lockAt + 90 seconds` (still before `firstPostAt`), re-reads the meeting clock, and writes `kind=freeze` only if that instant is still inside the window. Heartbeats every 15 minutes re-read post times. A retimed meeting that has already reached `firstPostAt` is not frozen.
- At or after `firstPostAt`, a missing freeze is `freeze_missed_window` with `not_backfilled=true`. The job does not backfill, including 2026-11-25.
- `card_status`, `pre_freeze_safety`, and `post_race` still follow §3 when the tick runs. A wait that sleeps until `lockAt` does not also write `pre_freeze_safety` for the minutes it slept through.

Each run logs `[official-snapshot]` lines with trigger, source workflow, meeting, phase, action, `lockAt`, `firstPostAt`, sleep, and catch-up. `capture_now` and `record_gap` decisions are appended to `data/official_snapshots/ticks.jsonl`.

Season gate: same fail-open pattern as other `capy_*` workflows (`GET /api/season`; skip only when `off_season` on scheduled runs). `workflow_run` and `workflow_dispatch` are not season-skipped.

Concurrency group `capy-official-snapshot`, `cancel-in-progress: false`, so a later run cannot cancel a job that is waiting for `lockAt`.

The Worker stays a reader. This job remains a `capy_*` GitHub Action. It does not move ingest into tianxi-web, Lovable, or a Worker cron.

Each tick still computes clocks, decides kinds due, recrawls only what that kind requires, writes snapshots, commits append-only repo files, and upserts D1 snapshot tables. Live Wave CSV/D1 projections stay on their own schedules. This job writes snapshots to **separate** paths/tables so a later Wave run cannot replace a freeze.

---

## 4. Storage

### 4.1 Repository (append-only evidence)

```
data/official_snapshots/
  manifest.jsonl                  # append-only, one JSON object per snapshot
  gaps.jsonl                      # append-only gap events, including freeze_missed_window
  poll.jsonl                      # append-only post-race stability hashes
  ticks.jsonl                     # append-only freeze-window decisions (capture or missed)
  YYYY-MM-DD_VE/
    freeze_<captured_at>.json     # header + gap list + surface index
    freeze_<captured_at>/
      <surface>.csv
    post_race_<captured_at>/      # same shape, different kind
    card_status_<status>_<captured_at>/
    pre_freeze_safety_<captured_at>/
```

- New files only (`wx` / refuse overwrite). Manifest line appends only; a rewrite of an existing manifest line or a modified CSV is a hard failure (same guard style as `capy_racecard_snapshot` and Wave manifest jobs).
- `captured_at` in file names is UTC compact ISO, e.g. `20261125T0912Z`.
- Commit message: `[data][skip ci] official snapshot <date> <venue> <kind>`.
- Push with the existing three-attempt rebase guard: abort rebase rather than overwrite evidence.

### 4.2 D1 (queryable copy, also append-only)

New migration, e.g. `backend/src/db/migrations/20261125_official_snapshots.sql`. Do not alter live `official_*` Wave tables.

```sql
-- Header. One freeze and one post_race per meeting, ever.
CREATE TABLE IF NOT EXISTS official_snapshot_manifest (
  snapshot_id TEXT NOT NULL PRIMARY KEY,          -- sha256 of canonical header+content
  meeting_date TEXT NOT NULL,                     -- YYYY-MM-DD
  venue TEXT NOT NULL CHECK (venue IN ('ST', 'HV')),
  snapshot_kind TEXT NOT NULL CHECK (
    snapshot_kind IN ('freeze', 'post_race', 'card_status', 'pre_freeze_safety')
  ),
  card_status TEXT CHECK (
    card_status IS NULL OR card_status IN ('fixture', 'entries', 'declared')
  ),
  first_post_at TEXT,
  lock_at TEXT,
  last_post_at TEXT,
  captured_at TEXT NOT NULL,                      -- ISO instant
  content_sha256 TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial')),
  gaps_json TEXT NOT NULL,                        -- JSON array, empty if none
  lock_crosscheck_json TEXT,                      -- lock-state vs local clock
  source_commit TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS official_snapshot_freeze_once
  ON official_snapshot_manifest (meeting_date, venue)
  WHERE snapshot_kind = 'freeze';

CREATE UNIQUE INDEX IF NOT EXISTS official_snapshot_postrace_once
  ON official_snapshot_manifest (meeting_date, venue)
  WHERE snapshot_kind = 'post_race';

CREATE UNIQUE INDEX IF NOT EXISTS official_snapshot_idempotent
  ON official_snapshot_manifest (meeting_date, venue, snapshot_kind, content_sha256);

CREATE TABLE IF NOT EXISTS official_snapshot_surface (
  snapshot_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  captured_at TEXT,                               -- null iff status is gap / excluded
  source_sha256 TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('present', 'gap', 'stale_available', 'excluded_leakage')
  ),
  gap_reason TEXT,
  repo_path TEXT,
  PRIMARY KEY (snapshot_id, surface)
);

-- Row payload: copy of the official row plus snapshot identity. No UPDATE, no DELETE.
CREATE TABLE IF NOT EXISTS official_snapshot_row (
  snapshot_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  meeting_date TEXT,
  venue TEXT,
  race_no INTEGER,
  horse_no INTEGER,
  is_reserve INTEGER CHECK (is_reserve IS NULL OR is_reserve IN (0, 1)),
  horse_id TEXT,
  brand_no TEXT,
  horse_code TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, surface, row_no)
);
```

Writer rules:

- `INSERT OR IGNORE` into `official_snapshot_manifest`. If the unique freeze/post_race index would conflict with a **different** `content_sha256`, abort: an earlier snapshot already exists; do not replace it.
- Same `content_sha256` is idempotent success (no duplicate rows).
- Never `UPDATE` or `DELETE` snapshot tables in scheduled jobs.
- Live Wave upserts stay on `official_*` tables and must not be pointed at snapshot tables.

### 4.3 Worker read routes (verification only, no crawl, no write)

Add to `backend/src/routes/official-visible.ts` (mounted at `/api/official`):

- `GET /api/official/snapshots?date=YYYY-MM-DD&venue=ST|HV[&kind=freeze|post_race|card_status|pre_freeze_safety]`
  - Returns manifest rows + per-surface status/counts/`captured_at`/`gap_reason`. Does not need to return full payloads by default (`?includeRows=1` optional, cap the size).
- `GET /api/official/snapshot-health?date=&venue=`
  - Minimal health: whether `freeze` exists, whether `post_race` exists, completeness, gap count, `captured_at`, `lock_at`, `first_post_at`. Cache-Control: `no-store`.

These routes ship only when the draft is later approved and the Worker is deployed. The draft must include the code but this workstream must not deploy.

---

## 5. Per-surface catalogue

Legend:

- **Live mode:** `overwrite-live` (Wave DELETE+INSERT) vs `meeting-replace` vs already append-only.
- **In freeze?** Required / optional / excluded (leakage).
- **Join:** how to attach to a runner or race.
- **Sentinel:** empty/missing vs zero; current-risk rules.

### 5.1 Required in `kind=freeze`

| Surface | Live mode | Keys | Join | Fill / sentinel | Pre-freeze knowable | Leakage |
|---|---|---|---|---|---|---|
| `entries_upcoming` card deltas + imposed weight + body weight | Live card is overwritten; public API nulls deltas after results | `race_date, venue, race_number, horse_number` (and `horse_id` when present) | date+venue+raceNo+horseNo or `horse_id` (`HK_YYYY_BRAND`) | Empty cells → `null`, never `0`. `bodyWeight` is 排位體重 (700–1500). Imposed/carried pounds (80–180) are never stored as `bodyWeight`. Do not fill from results `declared_weight`. | Yes, on declared cards | Not leakage. Snapshot the freeze-time values. |
| `official_racecard_runner` | meeting-replace | `(meeting_date, venue, race_no, is_reserve, horse_no)` | Prefer `horse_id` / `brand_no`; confirm raceNo. Age/sex come from here, not meetings (11-25 meetings age/sex were 0/108). Reserves may have incomplete profile cells — store nulls, do not impute. `import_type` is official code `PPG`/`PP`/`ISG`, not meetings Chinese labels — map codes, do not invent. | Missing age/sex/stakes → null | Yes | Not leakage |
| `official_ove_record` | meeting-replace | `(meeting_date, venue, race_no, line_no)` | date+venue+raceNo+horseNo + `horse_code`; confirm name only as a check (strip `名 (BRAND)` suffix if comparing) | `passed_date` set ⇒ **already-passed, not current risk**. Do not flag as current injury. Multiple lines per horse allowed (`line_no`). | Yes | Not leakage |
| `official_ove_database` | `REPLACE_ALL` (history lost in live table) | `(as_of_date, line_no)` + `horse_code` | `horse_code` / brand | Same passed-date rule. Snapshot the `asOf` current at freeze time; keep that `as_of_date` in the payload. | Yes (current list) | Not leakage |
| `official_conghua_movement` | meeting-replace | `(meeting_date, venue, race_no, line_no)` | **No horse code.** Join `raceNo+horseNo`, confirm `horseNameCh`, allow multiple trips via `line_no` | Do not invent a brand. Empty return/arrive dates stay null. | Yes when published (11-14 had 0) | Not leakage |
| `official_jt_combo` | meeting-replace | `(meeting_date, venue, section, race_no, horse_no)` include `is_reserve` | Join `raceNo+horseNo` (+ `is_reserve`). Names are usually empty (11-25: 108/110 empty; the 2 named rows were `section=debut`). Keep `as_of_text`. | Empty name is missing, not an error. Do not join by name. | Yes when published (11-14 had 0) | Not leakage |
| `official_fwb_declared` | `REPLACE_ALL` | `(meeting_date, venue, race_no, is_reserve, horse_no)` + `brand_no` | **Join by `brand_no` first, then confirm `race_no`.** Never join by `horse_no` alone. `is_reserve=1` horse numbers collide with starter numbers (STBY-N). See §6.2. | Missing bonus text is a parse error on ingest; do not invent. | Yes when published | Not leakage (bonus scheme is pre-race) |
| `official_horse_rating` | overwrite-live (`PRIMARY KEY (board, horse_code)`) | `board + horse_code` | brand / horse_code | Snapshot all boards `clas`, `csum`, `tp50` present at freeze | Yes | Not leakage |
| `official_horse_directory` | overwrite-live | `(list_kind, list_key, horse_id)` | `horse_id` | Do not treat absence from one list as a zero rating | Yes | Not leakage |
| `official_person_season` / `official_person_winstat` | overwrite-live | `(role, person_id, season_label)` / + `line_no` | official person id, not name | **`last10_wins` = wins in the last 10 racedays, not last 10 rides.** A value such as 19 is legal. Do not cap at 10 or reinterpret as ride count. | Yes | Not leakage |
| `official_same_sire` / `official_same_sire_page` | overwrite-live | `(sire_name, line_no)` | sire name is the official list key; horses join via official horse identity when present, never raw informal names | Do not invent missing siblings | Yes | Not leakage |
| `official_ppo_performance` | `REPLACE_ALL` | `(season_code, brand_no)` | brand | Notes stay text; `show_play`/`season_enabled` are 0/1 flags, not missing | Yes | Not leakage |
| `official_wind_meeting`, `official_wind_going`, `official_wind_station`, `official_wind_section` | live DELETE-all then insert; API is latest-only | meeting keys / `(racecourse, observed_date, observed_time)` | going by date+venue+raceNo; stations by racecourse | Store the T−90 observation with its official `observed_time`. **`official_wind_probe` may be empty (live probes=0). Do not use penetrometer** (a `"--"` reading stays blank; probes are not a required freeze surface). | Going/wind are knowable pre-race but change; must be recaptured in the freeze window | Not leakage if captured at T−90. Post-race going is a different value and belongs only in `post_race`. |

### 5.2 Required in `kind=post_race` only (excluded from freeze)

| Surface | Notes |
|---|---|
| `official_results_all_runner` | Official finishers. Label void/cancelled races; do not treat them as missing joins. |
| `official_results_all_dividend` | Official dividends. Not a pre-race feature. |
| Post-race going (results page or post-race wind going) | Store here only. Never copy into freeze. |

### 5.3 Excluded from freeze and not required in post_race snapshots

These may continue to be ingested by existing Wave jobs, but this snapshot writer must mark them `excluded_leakage` if accidentally present and must not copy them into freeze or treat them as lab features:

- Live WIN/PLA odds (lock-odds is a separate, already-shipping append-only record; do not duplicate into official freeze).
- `official_finish_photo` and raceday JPEGs / stats-centre images (pixels not unpacked; paths are not freeze features).
- `official_import_policy` prose.
- `official_horse_news` and notice documents.
- Special-notes / special-index as model features (the abbreviation index may exist for display; do not put it in freeze feature payload).
- Challenge-odds charts (jockey/trainer challenge) are not freeze runner features.

`official_fixture_line` is pre-race context and may be included in `card_status` / `freeze` as optional meeting metadata (class/distance/course text). It is not a runner-join surface.

### 5.4 `card_status` / `pre_freeze_safety` surfaces

Same runner/card surfaces as freeze, best-effort. Missing surfaces are gaps, not zeros. No results, no dividends, no live odds.

---

## 6. Join, identity, and regression rules

### 6.1 Default join

- Primary: `meeting_date + venue + race_no + horse_no`, or official ids: `horse_id` (`HK_YYYY_BRAND`), `brand_no` / `horse_code` (`^[A-Z]\d{3}$`).
- Never join on raw names as the primary key.
- If a name is used as a **confirmation only**, strip a meetings suffix of the form `名 (BRAND)` before compare.
- Drop void/cancelled races from runner joins (they are labelled in `post_race`, not “missing FWB/Conghua”). Example: 2026-11-14 ST R6.
- Reserves: always carry `is_reserve`. Incomplete reserve profile cells stay null.

### 6.2 FWB horseNo-vs-brand pitfall (regression required)

Live on 2026-11-25, `GET /api/official/fwb-declared?date=2026-11-25&venue=HV` includes:

- R8 `horseNo=1`, **`reserve=true`**, brand `M021`, 天時威威 / PRECISION TIME.

Live `GET /api/official/racecard-profile` for the same meeting:

- R8 starter `#1` (`reserve=false`) is `J290` 東來欣賞 (`HK_2023_J290`).
- R8 starter `#11` (`reserve=false`) is `M021` 天時威威 (`HK_2026_M021`).

The Wave6 parser already understands `STBY-N` as `is_reserve=1` (`parse_fwb` in `scripts/hkjc_wave6_surfaces.py`). Joining FWB `horse_no=1` while ignoring `is_reserve` and `brand_no` maps 天時威威 onto the wrong starter. **This draft must not “fix” ingest by guessing a new horse number.** Required tests:

- Join FWB by brand, then confirm `race_no`.
- A reserve FWB row with `horse_no=1` must not match starter `#1`.
- 11-25 R8: `M021` must not be attached to starter `#1` (`J290`).

See §12 if a later raw-page audit shows a true parse bug.

### 6.3 Other required tests (must be green)

- `last10_wins` is last-10-racedays wins; a fixture with value 19 must remain 19 and must not be treated as last-10-rides.
- An OVE/vet row with `passed_date` set is not current risk.
- Blank card-delta cells serialise as `null`, not `0`.
- Card deltas are never backfilled from results `declared_weight`.
- Freeze payload rejects results, dividends, live odds, finish photos.
- Second `freeze` write for the same meeting is a no-op and leaves the first bytes unchanged.
- Second `post_race` write likewise.
- A void race is labelled and excluded from “missing join” counts.
- Import type codes stay `PPG`/`PP`/`ISG`.
- Conghua allows multiple `line_no` trips; join is raceNo+horseNo + name confirm.
- JT combo keeps `as_of_text` with empty names allowed.
- Wind penetrometer `"--"` stays blank; `probes=0` is not a freeze failure.
- Clock tests: ST 12:30 → lock 11:00 HKT; HV 18:40 → lock 17:10 HKT; 07:40 is not a freeze instant.
- After `firstPostAt`, a missing freeze becomes `freeze_missed_window` and is not backfilled.
- A gap must not be silently replaced by later live overwrite data.

---

## 7. Failure and gap policy

A gap object (in manifest `gaps_json` and surface status) must include:

```json
{
  "surface": "official_wind_going",
  "status": "gap",
  "reason": "recrawl_failed | not_published | clock_mismatch | freeze_missed_window | stale_only",
  "stale_available": {
    "scraped_at": "2026-11-25T02:41:58+08:00",
    "row_count": 9,
    "not_freeze_fresh": true
  }
}
```

- `stale_available` is citation only. It is not freeze content.
- A partial freeze (`completeness=partial`) is still a freeze: later runs must not overwrite it to “complete” with post-lock data.
- Job exit: a scheduled freeze-window run that misses a required surface exits **non-zero** after writing the partial snapshot and gaps (so CI/watchdog can see it), unless the surface is documented as optionally unpublished (Conghua / jt-combo may be legitimately empty; record `not_published` with row_count 0, not a watchdog-false-positive if the official page is empty). Distinguish “page empty/officially unpublished” from “fetch failed”.

---

## 8. Idempotency

- `(meeting, kind=freeze)` at most one snapshot ever.
- `(meeting, kind=post_race)` at most one snapshot ever.
- `(meeting, kind, content_sha256)` must not duplicate.
- `card_status` and `pre_freeze_safety` may occur more than once if content changes; identical hash is skipped.
- Repo writer refuses to overwrite an existing file of the same name.
- D1 unique partial indexes enforce the once-only kinds.

---

## 9. Implementation plan (files to add or touch)

Implement in `sleepingarhat/tianxi-racing` on a new branch from current `main`. Do not branch off #137/#138.

| Path | Action |
|---|---|
| `docs/official-snapshot-rules.md` | This document, verbatim or with only typo fixes. |
| `backend/src/db/migrations/20261125_official_snapshots.sql` | Schema in §4.2. |
| `scripts/official_snapshot_clock.py` (or `backend/scripts/official-snapshot-clock.ts`) | Pure functions: `firstPostAt`, `lockAt`, kind decisions, clock cross-check. Must reuse `LOCK_LEAD_MINUTES = 90` and instant arithmetic. |
| `scripts/official_snapshot_join.py` | Join helpers and sentinel rules (FWB brand, passed OVE, last10Wins, null deltas, void races, import codes). |
| `scripts/official_snapshot_writer.py` | Staging recrawl (call existing Wave parse functions into a staging directory — do not clobber `data/official_waveN` from this job if that would race a Wave workflow; use `data/official_snapshots/_staging/` then copy into the versioned snapshot folder), manifest, D1 SQL emit (`INSERT OR IGNORE` only). |
| `scripts/official_snapshot_tick.py` | CLI used by the workflow: discover meetings, decide kinds, recrawl, write. |
| `.github/workflows/capy_official_snapshot.yml` | `workflow_run` catch-up, best-effort arms, in-job wait until `lockAt`, season gate, unit tests, capture, append-only commit, D1 apply via existing `scripts/d1-execute-file.sh`. Requires `CF_API_TOKEN` / `CF_ACCOUNT_ID` on schedule (same pattern as Wave jobs). Do not add or rotate secrets. A ten-minute cron is not the capture clock. |
| `scripts/test_official_snapshot_rules.py` | All regressions in §6.3. |
| `backend/src/routes/official-visible.ts` | Read-only snapshot routes. |
| `backend` tests for the new routes if a TS test harness already exists for official-visible. | |
| `AGENTS.md` | One short bullet: official freeze/post snapshots are append-only; live Wave tables are not T−90 evidence. |

Reuse, do not fork: Wave parsers, `lock-window.ts` constants, `meeting-card.ts` `cardDeltas` / `resolveCardStatus`, `results_readiness.py` (+30 minutes), `d1-execute-file.sh`, season gate.

Do **not** change: prediction lock tick, `prediction_log`, A-line training scripts, Wave live upsert behaviour (except a clearly proven FWB ingest bug — see §12), `capy_racecard_snapshot.yml`.

---

## 10. Self-check against existing systems

- **Freeze clock:** Hooked to `entries_upcoming.post_time` and `LOCK_LEAD_MINUTES`, the same sources as `getMeetingLockState` / the 5-minute Worker lock tick. Not 07:40, not report-refresh crons (11:00 / 12:00 / 18:00 HKT in `wrangler.toml`, which are race-day report refreshes).
- **Wave 5/6/7/8:** Remain the live ingest. Snapshots are a second, append-only store. Afternoon Wave runs after a day-meeting freeze will keep overwriting live tables; that is expected and is why snapshots exist.
- **D1:** New tables only. No change to live official table PKs. No secret rotation.
- **Worker:** Serves already-ingested snapshot rows. No Worker cron ingest.
- **Existing racecard snapshot:** Orthogonal research history.
- **Lock-odds:** Orthogonal market comparison record; not a freeze official surface.
- **Cancelled meetings:** Honour `isCancelledMeeting` (`2026-09-19`) and void-race labels (`race-cancellation` / 2026-11-14 ST R6).

---

## 11. Historical policy

- Do not manufacture freeze snapshots for 2026-10-04 through the first complete official captures.
- Official runner-table coverage useful for future isolated lab work begins at meetings that actually had pre-race official tables: 2026-11-11, 11-14 (Conghua/jt-combo empty), 11-18, 11-22 (39 valid completed races). 2026-11-25 was declared at the T−7 audit and at this writing had not yet reached T−90.
- After this system ships, lab readers may use `kind=freeze` only for meetings that have a freeze snapshot. Absence means “not snapshotted”, not “use today's live table”.

---

## 12. Ambiguities refused (do not guess)

These would produce a wrong snapshot or a wrong identity if invented. Leave them flagged; do not “fix” them in this draft without new official evidence.

### 12.1 FWB 11-25 R8 ingest vs join

The live FWB row already marks `M021` 天時威威 as **reserve horseNo 1** (`STBY-1` in the parser). The racecard lists `M021` as **starter #11** and `J290` as starter #1. Joining that row by horse number maps it onto `J290`. This join does **not** rewrite FWB `horse_no` to 11. `STBY-1` remains `horse_no=1`, `is_reserve=1`, and the parser keeps it as a separate row from declared `#1`.

`join_fwb` (and `GET /api/official/fwb-declared`) attaches by `brand_no` or `horse_id`, including a racecard reserve. Same saddle and a different brand stay unattached. 2026-11-29 examples covered by the same rule: R8 `M072` does not attach to official `#1` `J157`; R10 `L435` attaches to the racecard reserve of that brand, not to official `#1` `L152`; R11 `L529` attaches to official `#3`, where the card already lists that brand.

To refresh a live row, rerun `capy_wave6_surfaces` (or `python3 scripts/hkjc_wave6_surfaces.py --root=. --surfaces=fwb`). That job replaces `official_fwb_declared` from the current official page. Do not edit files under `data/official_snapshots/`, and do not backfill the missed 2026-11-25 freeze. The 2026-11-25 `card_status` copy already stores `M021` as reserve horse 1; that captured list number stays, and readers align it by brand.

### 12.2 Post-race dividend “fully settled”

WIN+PLA plus a two-tick identical hash, with a 3-hour cap after last post, is the operational definition written in §3.4 so the first post_race snapshot is not taken on a still-updating dividend board (because it can never be overwritten). If the owner wants a different pool set (e.g. also QIN/QPL/TCE) or a different cap, change §3.4 explicitly before implementation. Do not treat an empty exotic pool as a reason to withhold WIN/PLA forever.

### 12.3 `GET /api/analyze/lock-state` query parameters

The live route ignores `date`/`venue` filters. This job must not pretend otherwise. A future Worker change to honour those params is out of scope here.

### 12.4 Freshness slack before `lockAt`

No slack is allowed for freeze **payload** rows (`captured_at >= lockAt`). Pre-lock recrawls belong in `pre_freeze_safety` or `stale_available` only. Do not widen this to “15 minutes early” without an explicit owner decision.

### 12.5 Dual meetings on one calendar day

Current HK fixtures are one local meeting per date. If two venues ever share a date, clocks and unique indexes are already per `(date, venue)`. Do not assume a date has only one lockAt across venues.

---

## 13. Review checklist (author)

- [x] Freeze hook is the real T−90 clock (`lock-window.ts` / live lock-state), not 07:40.
- [x] Day vs night examples verified from `/api/meetings/:date` start times.
- [x] Live official overwrite behaviour verified from Wave `REPLACE_ALL` / `DELETE FROM`.
- [x] Card-delta disappearance and results `declared_weight` pitfall documented from `meeting-card.ts` / `meetings.ts`.
- [x] Join and leakage rules from the T−7 audit are encoded as tests, not prose only.
- [x] A-line, #137, #138, secrets, and tianxi-web ingest are untouched.
- [x] Remaining identity/settlement ambiguities are flagged, not guessed.
