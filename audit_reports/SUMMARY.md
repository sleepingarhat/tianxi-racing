# Data Integrity Audit · 2026-10-25

**Overall:** 🟡 `warn`  ·  critical gaps: **0**  ·  warn gaps: 49

**Recommendation:** `monitor_no_block`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Pending | Notes |
|---|---|---|---|---|---|---|---|
| race_artefacts | 🟢 ok | 785 | 785 | 0 | 0 | 0 |  |
| fixtures_cache | 🟢 ok | 1 | 230 | 0 | 0 | 0 | total cached race days: 230 |
| horse_profiles | 🟡 warn | 1199 | 1181 | 0 | 0 | 29 | 18 debutants first ran on 2026-10-25 — profile pending tonight's Pool A (critical if still missing next scan); 11 profiles ran on 2026-10-25 — refresh pending tonight's Pool A |
| horse_form_records | 🟡 warn | 1199 | 1181 | 0 | 0 | 18 | 18 same-day debutants — form_records pending tonight's Pool A; total form_records files: 6111 |
| jockey_profiles | 🟢 ok | 26 | 26 | 0 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟢 ok | 64 | 64 | 0 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 25 | 25 | 0 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | 0 | trial rows: 9735 |
| entries_upcoming | 🟡 warn | 3 | 1 | 2 | 0 | 0 | 2 upcoming race days lack entries file |
