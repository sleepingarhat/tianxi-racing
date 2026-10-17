# Data Integrity Audit · 2026-10-17

**Overall:** 🔴 `critical`  ·  critical gaps: **1**  ·  warn gaps: 12

**Recommendation:** `gha_next_delta_will_fix`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Notes |
|---|---|---|---|---|---|---|
| race_artefacts | 🟡 warn | 775 | 770 | 5 | 0 | days with any missing artefact: 1 |
| fixtures_cache | 🟢 ok | 1 | 231 | 0 | 0 | total cached race days: 231 |
| horse_profiles | 🟢 ok | 1182 | 1182 | 0 | 0 | total profiles in DB: 6099 |
| horse_form_records | 🟢 ok | 1182 | 1182 | 0 | 0 | total form_records files: 6099 |
| jockey_profiles | 🟢 ok | 32 | 32 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟡 warn | 64 | 59 | 5 | 0 | 5 jockey profiles have no records file |
| trainer_profiles | 🔴 critical | 35 | 34 | 1 | 0 | 1 trainers active recently but NO profile; total trainer profiles: 67 |
| trainer_records | 🟢 ok | 67 | 67 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | trial rows: 9573 |
| entries_upcoming | 🟡 warn | 2 | 0 | 2 | 0 | 2 upcoming race days lack entries file |

### 🔴 trainer_profiles — sample missing (first 20)

```
甘敏斯
```
