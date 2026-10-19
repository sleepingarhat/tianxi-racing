# Data Integrity Audit · 2026-10-19

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 1

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Notes |
|---|---|---|---|---|---|---|
| race_artefacts | 🟢 ok | 775 | 775 | 0 | 0 |  |
| fixtures_cache | 🟢 ok | 1 | 230 | 0 | 0 | total cached race days: 230 |
| horse_profiles | 🟢 ok | 1195 | 1195 | 0 | 0 | total profiles in DB: 6108 |
| horse_form_records | 🟢 ok | 1195 | 1195 | 0 | 0 | total form_records files: 6108 |
| jockey_profiles | 🟢 ok | 32 | 32 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟢 ok | 64 | 64 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 35 | 35 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | trial rows: 9573 |
| entries_upcoming | 🟡 warn | 3 | 2 | 1 | 0 | 1 upcoming race days lack entries file |
