# Racing engine rules
- Restore v12 through scripts/elo/compute_v12.ts, replay full history locally and scope publication separately; partial initialization changes time-weighted state.
- Elo exports retain v12 metadata and publish only v12-prefixed rows through the shared exporter; version labels must identify the actual algorithm.
- Prediction logs and lock metadata are immutable during Elo repairs; compare full ordered records before and after backfill.
- Production importance is derived from the serialized refit model and verified against model/meta hashes; it is audit evidence, never an inference input or automatic promotion rule.

- Freeze recovery captures only complete current-meeting pre-lock rows in an immutable hashed snapshot; repairs insert exact missing originals, never rewrite conflicts; scheduled ticks and public projections verify this snapshot. Why: recovery must preserve historical predictions and settlement.
- Capture guards compare row counts and every typed column with NULL-safe SQLite equality inside the insert transaction, never serialized JSON text. Why: REAL 1.0 and JavaScript 1 are equal predictions and must not block immutable capture.

- Pre-lock predictions synchronously archive and validate HKJC changes and the complete official card, atomically deliver entries, bypass old caches, recheck versions before writing and bind the input receipt. New freeze capture requires that receipt and refuses stale/unapplied changes; post-lock originals never recompute. Why: schedules cannot prove source freshness.
- Settlement selects only proven post-lock withdrawal substitutes from frozen order; pre-lock/unknown withdrawals retain incident evidence but do not enter scored aggregates. Invalidate settlement/strategy caches by policy version. Why: stale rankings cannot become valid through substitution.
