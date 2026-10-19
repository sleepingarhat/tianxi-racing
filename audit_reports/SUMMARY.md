# Data Integrity Audit · 2026-10-19

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 5

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Notes |
|---|---|---|---|---|---|---|
| race_artefacts | 🟢 ok | 775 | 775 | 0 | 0 |  |
| fixtures_cache | 🟢 ok | 1 | 230 | 0 | 0 | total cached race days: 230 |
| horse_profiles | 🟢 ok | 1195 | 1195 | 0 | 0 | total profiles in DB: 6108 |
| horse_form_records | 🟢 ok | 1195 | 1195 | 0 | 0 | total form_records files: 6108 |
| jockey_profiles | 🟢 ok | 32 | 32 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟡 warn | 64 | 62 | 2 | 0 | 2 jockey profiles have no records file |
| trainer_profiles | 🟢 ok | 35 | 35 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟡 warn | 68 | 67 | 1 | 0 | 1 trainer profiles have no records file |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | trial rows: 9573 |
| entries_upcoming | 🟡 warn | 3 | 1 | 2 | 0 | 2 upcoming race days lack entries file |
