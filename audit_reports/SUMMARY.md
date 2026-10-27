# Data Integrity Audit · 2026-10-27

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 6

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Pending | Notes |
|---|---|---|---|---|---|---|---|
| race_artefacts | 🟡 warn | 790 | 785 | 5 | 0 | 0 | days with any missing artefact: 1 |
| fixtures_cache | 🟢 ok | 1 | 231 | 0 | 0 | 0 | total cached race days: 231 |
| horse_profiles | 🟢 ok | 1191 | 1191 | 0 | 0 | 0 | total profiles in DB: 6129 |
| horse_form_records | 🟢 ok | 1191 | 1191 | 0 | 0 | 0 | total form_records files: 6129 |
| jockey_profiles | 🟢 ok | 26 | 26 | 0 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟢 ok | 64 | 64 | 0 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 25 | 25 | 0 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | 0 | trial rows: 9735 |
| entries_upcoming | 🟡 warn | 2 | 1 | 1 | 0 | 0 | 1 upcoming race days lack entries file |
