# Data Integrity Audit · 2026-11-12

**Overall:** 🔴 `critical`  ·  critical gaps: **2**  ·  warn gaps: 2

**Recommendation:** `gha_next_delta_will_fix`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Pending | Notes |
|---|---|---|---|---|---|---|---|
| race_artefacts | 🟢 ok | 810 | 810 | 0 | 0 | 0 | Official cancellation notices verified: 2025-09-24, 2026-09-20 |
| fixtures_cache | 🟢 ok | 1 | 232 | 0 | 0 | 0 | total cached race days: 232 |
| horse_profiles | 🔴 critical | 1197 | 1196 | 1 | 0 | 0 | 1 horses raced in last 180d have NO profile; total profiles in DB: 6153 |
| horse_form_records | 🔴 critical | 1197 | 1196 | 1 | 0 | 0 | 1 recent-cohort horses have NO form_records file; total form_records files: 6153 |
| jockey_profiles | 🟢 ok | 27 | 27 | 0 | 0 | 0 | total jockey profiles: 65 |
| jockey_records | 🟢 ok | 65 | 65 | 0 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 25 | 25 | 0 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | 0 | trial rows: 10178 |
| entries_upcoming | 🟡 warn | 2 | 0 | 2 | 0 | 0 | 2 upcoming race days lack entries file |

### 🔴 horse_profiles — sample missing (first 20)

```
L414
```

### 🔴 horse_form_records — sample missing (first 20)

```
L414
```
