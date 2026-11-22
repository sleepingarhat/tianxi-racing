# Data Integrity Audit · 2026-11-22

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 34

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Pending | Notes |
|---|---|---|---|---|---|---|---|
| race_artefacts | 🟢 ok | 825 | 825 | 0 | 0 | 0 | Official cancellation notices verified: 2025-09-24, 2026-09-20 |
| fixtures_cache | 🟢 ok | 1 | 233 | 0 | 0 | 0 | total cached race days: 233 |
| horse_profiles | 🟡 warn | 1214 | 1198 | 0 | 0 | 16 | 16 debutants first ran on 2026-11-22 — profile pending tonight's Pool A (critical if still missing next scan); total profiles in DB: 6179 |
| horse_form_records | 🟡 warn | 1214 | 1198 | 0 | 0 | 16 | 16 same-day debutants — form_records pending tonight's Pool A; total form_records files: 6179 |
| jockey_profiles | 🟢 ok | 27 | 27 | 0 | 0 | 0 | total jockey profiles: 65 |
| jockey_records | 🟢 ok | 65 | 65 | 0 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 23 | 23 | 0 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | 0 | trial rows: 10380 |
| entries_upcoming | 🟡 warn | 3 | 1 | 2 | 0 | 0 | 2 upcoming race days lack entries file |
