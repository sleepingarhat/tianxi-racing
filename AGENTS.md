# Racing engine rules
- Restore v12 through scripts/elo/compute_v12.ts, replay full history locally and scope publication separately; partial initialization changes time-weighted state.
- Elo exports retain v12 metadata and publish only v12-prefixed rows through the shared exporter; version labels must identify the actual algorithm.
- Prediction logs and lock metadata are immutable during Elo repairs; compare full ordered records before and after backfill.
- Production importance is derived from the serialized refit model and verified against model/meta hashes; it is audit evidence, never an inference input or automatic promotion rule.
