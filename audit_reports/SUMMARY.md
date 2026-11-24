# Data Integrity Audit · 2026-11-24

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 1

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Pending | Notes |
|---|---|---|---|---|---|---|---|
| race_artefacts | 🟢 ok | 825 | 825 | 0 | 0 | 0 | Official cancellation notices verified: 2025-09-24, 2026-09-20 |
| fixtures_cache | 🟢 ok | 1 | 233 | 0 | 0 | 0 | total cached race days: 233 |
| horse_profiles | 🟢 ok | 1215 | 1215 | 0 | 0 | 0 | total profiles in DB: 6201 |
| horse_form_records | 🟢 ok | 1215 | 1215 | 0 | 0 | 0 | total form_records files: 6201 |
| jockey_profiles | 🟢 ok | 27 | 27 | 0 | 0 | 0 | total jockey profiles: 65 |
| jockey_records | 🟢 ok | 65 | 65 | 0 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 24 | 24 | 0 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | 0 | trial rows: 10490 |
| entries_upcoming | 🟡 warn | 2 | 1 | 1 | 0 | 0 | 1 upcoming race days lack entries file |
