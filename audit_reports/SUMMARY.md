# Data Integrity Audit · 2026-10-28

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 7

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Pending | Notes |
|---|---|---|---|---|---|---|---|
| race_artefacts | 🟡 warn | 790 | 785 | 0 | 0 | 5 | Official cancellation notices verified: 2025-09-24, 2026-09-20; same-day artefacts pending until verified final start +30m: 2026-10-28T23:20:00+08:00 |
| fixtures_cache | 🟢 ok | 1 | 232 | 0 | 0 | 0 | total cached race days: 232 |
| horse_profiles | 🟢 ok | 1191 | 1191 | 0 | 0 | 0 | total profiles in DB: 6129 |
| horse_form_records | 🟢 ok | 1191 | 1191 | 0 | 0 | 0 | total form_records files: 6129 |
| jockey_profiles | 🟢 ok | 26 | 26 | 0 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟢 ok | 64 | 64 | 0 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 25 | 25 | 0 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | 0 | trial rows: 9775 |
| entries_upcoming | 🟡 warn | 3 | 1 | 2 | 0 | 0 | 2 upcoming race days lack entries file |
