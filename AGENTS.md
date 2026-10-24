# Racing engine rules
- Restore v12 through scripts/elo/compute_v12.ts, replay full history locally and scope publication separately; partial initialization changes time-weighted state.
- Elo exports retain v12 metadata and publish only v12-prefixed rows through the shared exporter; version labels must identify the actual algorithm.
- Prediction logs and lock metadata are immutable during Elo repairs; compare full ordered records before and after backfill.
- Production importance is derived from the serialized refit model and verified against model/meta hashes; it is audit evidence, never an inference input or automatic promotion rule.

- Freeze recovery captures only complete current-meeting pre-lock rows in an immutable hashed snapshot; repairs insert exact missing originals, never rewrite conflicts; scheduled ticks and public projections verify this snapshot. Why: recovery must preserve historical predictions and settlement.
- Capture guards compare row counts and every typed column with NULL-safe SQLite equality inside the insert transaction, never serialized JSON text. Why: REAL 1.0 and JavaScript 1 are equal predictions and must not block immutable capture.

- Existing five-minute Worker collects race-day WIN/PLA display snapshots only; health checks unstarted races at 20 minutes, notifications dedupe only after delivery. Other pool reads retain per-pool latest snapshots. Why: odds freshness never changes frozen/model records.
- Track-condition research uses official identity-bearing commonMeetings evidence with append-only raw/CSV SHA manifests and a rebuildable daily projection; pre-race readers require capture and dated official timestamps before cutoff. Why: pending readings, latest views and post-race captures cannot certify original pre-race features.
- Incident research archives verify selected/heading dates, venue, adjacent race headings and horse links, preserve raw/CSV SHA and unassigned addenda; as-of reads exclude same-date races and later captures. Why: additional narratives cannot be guessed into identities or leaked into original predictions.
- Results collection verifies the page's displayed 賽事日期 heading equals the requested date before any write; HKJC fallback pages are logged as pending and retried, never stamped with the target date. Why: a fallback page is not evidence of the requested meeting and mislabeled rows poison every downstream reader.
