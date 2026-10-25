# Data Integrity Audit · 2026-10-25

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 18

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Notes |
|---|---|---|---|---|---|---|
| race_artefacts | 🟡 warn | 785 | 780 | 5 | 0 | days with any missing artefact: 1 |
| fixtures_cache | 🟢 ok | 1 | 230 | 0 | 0 | total cached race days: 230 |
| horse_profiles | 🟡 warn | 1180 | 1180 | 0 | 11 | 11 profiles are stale (profile_last_scraped < last_race_date); total profiles in DB: 6111 |
| horse_form_records | 🟢 ok | 1180 | 1180 | 0 | 0 | total form_records files: 6111 |
| jockey_profiles | 🟢 ok | 26 | 26 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟢 ok | 64 | 64 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 25 | 25 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | trial rows: 9735 |
| entries_upcoming | 🟡 warn | 3 | 1 | 2 | 0 | 2 upcoming race days lack entries file |
