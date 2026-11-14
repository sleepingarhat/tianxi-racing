# Data Integrity Audit · 2026-11-14

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 6

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Pending | Notes |
|---|---|---|---|---|---|---|---|
| race_artefacts | 🟡 warn | 815 | 810 | 0 | 0 | 5 | Official cancellation notices verified: 2025-09-24, 2026-09-20; same-day artefacts pending until verified final start +30m: 2026-11-14T18:40:00+08:00 |
| fixtures_cache | 🟢 ok | 1 | 232 | 0 | 0 | 0 | total cached race days: 232 |
| horse_profiles | 🟢 ok | 1185 | 1185 | 0 | 0 | 0 | total profiles in DB: 6154 |
| horse_form_records | 🟢 ok | 1185 | 1185 | 0 | 0 | 0 | total form_records files: 6154 |
| jockey_profiles | 🟢 ok | 27 | 27 | 0 | 0 | 0 | total jockey profiles: 65 |
| jockey_records | 🟢 ok | 65 | 65 | 0 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 25 | 25 | 0 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | 0 | trial rows: 10259 |
| entries_upcoming | 🟡 warn | 2 | 1 | 1 | 0 | 0 | 1 upcoming race days lack entries file |
