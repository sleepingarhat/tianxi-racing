# Withdrawal accounting candidate — not deployed

- Policy: official-withdrawals-v4-original-only. Original frozen ranks/scores and identities remain unchanged.
- Invalid prelock inputs remain in incident metadata, excluded from scoring and strategy costs; a correctly refreshed/recomputed prelock card remains valid.
- Official P&L includes only original-at-lock hypothetical units with official refunds/dividends. Effective selections are display-only alternatives, not official costs or payouts. No actual user bet or automatic rebet is inferred.
- Rule 3.10(a): only affected combinations refund. Four-pick original with one withdrawn: FF gross/refund/cost 10/10/0; TRIO 40/30/10; TIERCE 240/180/60; QUARTET 240/240/0. Total 530/460/70. Effective four-pick alternatives never enter official P&L.
- Rule 3.10(b)(iii): DT/TT original tickets use official first/second/third favourites excluding retained selections, never engine substitutes; missing official favourite evidence returns pending/null, not refund or loss. Shared calculator exists; full DT/TT endpoint integration remains pending.
- Rule 3.9 pool closures follow actual starter thresholds only after results evidence is complete. Dead-heat dividends retain decimal cents and sum only covered combinations.
- Locked jockey changes preserve ranks and scores and produce a separate metric group. Unknown change timing/prelock unapplied jockey changes fail closed.
- Training/import accept SHA-verified official manifests; local feature exporter also reads existing hkjc_source_versions archives. Withdrawn/positive-finish contradiction stops rather than relabels a winner. Started DNF is not inferred as withdrawal. Audit flags are not model features. Historical rows without source evidence remain unverified, not backfilled as confirmed.
- Real official raw on 2026-10-19 + original snapshot readback confirms R8/R10 invalid and R11 8-13-6-2 → 8-13-6-10, original SHA unchanged. These are read-only accounting evidence, NOT official-card → recompute → first freeze → settlement release acceptance.
- Official next Happy Valley meeting: 2026-10-21, not 10/22. Full real pre-race acceptance is not yet available; no deploy/main update.
- Remaining: data-repo recurring event sync and training workflow manifest enforcement; actual/frozen jockey lineage across all training/Elo consumers; complete cross-race endpoint integration and official favourites/partial consolation/closure evidence; authenticated UI settlement readback. Keep isolated until these checks pass.

Source: https://www.hkjc.com/english/betting/template_betting_rule_files/pdf/Horse_Race_Rule_3_Eng_20260330.pdf (3.9, 3.10)
