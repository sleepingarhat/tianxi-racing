# Data Integrity Audit · 2026-10-28

**Overall:** 🔴 `critical`  ·  critical gaps: **15**  ·  warn gaps: 2

**Recommendation:** `gha_next_delta_will_fix`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Pending | Notes |
|---|---|---|---|---|---|---|---|
| race_artefacts | 🔴 critical | 800 | 785 | 15 | 0 | 0 | days with any missing artefact: 3 |
| fixtures_cache | 🟢 ok | 1 | 232 | 0 | 0 | 0 | total cached race days: 232 |
| horse_profiles | 🟢 ok | 1191 | 1191 | 0 | 0 | 0 | total profiles in DB: 6129 |
| horse_form_records | 🟢 ok | 1191 | 1191 | 0 | 0 | 0 | total form_records files: 6129 |
| jockey_profiles | 🟢 ok | 26 | 26 | 0 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟢 ok | 64 | 64 | 0 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 25 | 25 | 0 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | 0 | trial rows: 9775 |
| entries_upcoming | 🟡 warn | 3 | 1 | 2 | 0 | 0 | 2 upcoming race days lack entries file |

### 🔴 race_artefacts — sample missing (first 20)

```
results_2025-09-24
commentary_2025-09-24
dividends_2025-09-24
sectional_times_2025-09-24
video_links_2025-09-24
results_2026-09-20
commentary_2026-09-20
dividends_2026-09-20
sectional_times_2026-09-20
video_links_2026-09-20
results_2026-10-28
commentary_2026-10-28
dividends_2026-10-28
sectional_times_2026-10-28
video_links_2026-10-28
```
