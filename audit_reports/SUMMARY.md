# Data Integrity Audit · 2026-10-25

**Overall:** 🔴 `critical`  ·  critical gaps: **23**  ·  warn gaps: 2

**Recommendation:** `gha_next_delta_will_fix`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Notes |
|---|---|---|---|---|---|---|
| race_artefacts | 🟢 ok | 785 | 785 | 0 | 0 |  |
| fixtures_cache | 🟢 ok | 1 | 230 | 0 | 0 | total cached race days: 230 |
| horse_profiles | 🔴 critical | 1186 | 1180 | 6 | 11 | 6 horses raced in last 180d have NO profile; total profiles in DB: 6111 |
| horse_form_records | 🔴 critical | 1186 | 1180 | 6 | 0 | 6 recent-cohort horses have NO form_records file; total form_records files: 6111 |
| jockey_profiles | 🟢 ok | 26 | 26 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟢 ok | 64 | 64 | 0 | 0 |  |
| trainer_profiles | 🟢 ok | 25 | 25 | 0 | 0 | total trainer profiles: 68 |
| trainer_records | 🟢 ok | 68 | 68 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | trial rows: 9735 |
| entries_upcoming | 🟡 warn | 3 | 1 | 2 | 0 | 2 upcoming race days lack entries file |

### 🔴 horse_profiles — sample missing (first 20)

```
L250
L351
L444
L457
L509
M046
```

### 🔴 horse_form_records — sample missing (first 20)

```
L250
L351
L444
L457
L509
M046
```
