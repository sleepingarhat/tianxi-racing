# Data Integrity Audit · 2026-10-21

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 15

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Notes |
|---|---|---|---|---|---|---|
| race_artefacts | 🟢 ok | 780 | 780 | 0 | 0 |  |
| fixtures_cache | 🟢 ok | 1 | 230 | 0 | 0 | total cached race days: 230 |
| horse_profiles | 🟡 warn | 1190 | 1190 | 0 | 13 | 13 profiles are stale (profile_last_scraped < last_race_date); total profiles in DB: 6108 |
| horse_form_records | 🟢 ok | 1190 | 1190 | 0 | 0 | total form_records files: 6108 |
| jockey_profiles | 🟢 ok | 32 | 32 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟢 ok | 64 | 64 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 35 | 35 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | trial rows: 9590 |
| entries_upcoming | 🟡 warn | 3 | 1 | 2 | 0 | 2 upcoming race days lack entries file |
