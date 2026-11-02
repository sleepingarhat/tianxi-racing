# Data Integrity Audit · 2026-11-02

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 2

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Pending | Notes |
|---|---|---|---|---|---|---|---|
| race_artefacts | 🟢 ok | 795 | 795 | 0 | 0 | 0 | Official cancellation notices verified: 2025-09-24, 2026-09-20 |
| fixtures_cache | 🟢 ok | 1 | 232 | 0 | 0 | 0 | total cached race days: 232 |
| horse_profiles | 🟢 ok | 1191 | 1191 | 0 | 0 | 0 | total profiles in DB: 6133 |
| horse_form_records | 🟢 ok | 1191 | 1191 | 0 | 0 | 0 | total form_records files: 6133 |
| jockey_profiles | 🟢 ok | 26 | 26 | 0 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟢 ok | 64 | 64 | 0 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 25 | 25 | 0 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | 0 | trial rows: 9854 |
| entries_upcoming | 🟡 warn | 2 | 0 | 2 | 0 | 0 | 2 upcoming race days lack entries file |
