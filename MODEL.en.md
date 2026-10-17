# Tianxi racing model specification — English reference

Traditional Chinese main document: [MODEL.md](MODEL.md). Technical identifiers and original source formulas are retained. This is an English reference translation, not a claim that older English narrative was preserved verbatim; the prior repository commit remains the historical source.

## Ensemble
Per-race z-score normalization; alpha defaults to 0.88.
```
blendZ = alpha * lgb_z + (1-alpha) * elo_z
ranking_score = blendZ + 0.5 * factor_bonus / 100
finalScore = 1500 + 100 * blendZ
```
The displayed finalScore excludes the factor bonus. Production ranking uses draw and carried-weight rules only. Missing LGB scores were historically imputed with the race mean; repair candidates require complete generation coverage.

## Elo v12
Pairwise expected score: `E_i = 1/(1+10^((R_j-R_i)/400))`.
`delta_i = sum_j K_eff_i/(N-1) * (S_ij-E_i)`; S=1/0/0.5 for better/worse/tied finish. Non-finishers (999) are excluded.
K for horse/jockey/trainer is 28/18/11; time-decay tau is 548/730/1095 days. K_eff=K*exp(-days/tau)*1.5 while prior starts<6, otherwise multiplier 1.
Initial rating: normally 1500; imported horse 1580; purchased horse 1560. Foreign-jockey 1550 is available in engine configuration, but not proven passed by the original batch driver.
Confidence=`min(1,starts/20)*(1-exp(-recentWeightedStarts/6))`; it is experience/freshness, not win probability.
Horse suspension/retirement thresholds are >365/>720 days; jockey/trainer >730/>1095. Season reversion towards 1500 is 5%/2%/2%; original code also triggers across calendar years. Predictor reads horse overall, not a five-axis weighted blend. Composite predictor weights are horse .7/jockey .2/trainer .1, normalized over available weights.

## LightGBM training
Objective lambdarank; production early stopping uses race_logloss; the separate walk-forward path uses NDCG; truncation level 4. Labels for finishes 1/2/3/4 are 4/3/2/1, later finishers 0. label_gain begins [0,1,7,31,127,...]. All missing numeric values=-1; going_code is excluded from production. Early stopping selects the iteration count, then all eligible training rows are refit. Historical inputs must be strictly before the race date; odds are not model features.

## 52 numeric production features
All production inputs are numeric. Missing=-1; inactive interaction=0. All aggregates exclude the current and future race dates.

| # | Source identifier | Derivation / encoding |
|---|---|---|
| 1 | `distance` | race distance in metres |
| 2 | `field_size` | declared runner count |
| 3 | `draw` | draw number |
| 4 | `actual_weight` | carried weight in pounds |
| 5 | `is_sprint` | distance<=1200; binary |
| 6 | `is_middle` | distance 1400–1600; binary |
| 7 | `is_distance` | distance>=1800; binary |
| 8 | `h_elo` | latest pre-date horse overall Elo |
| 9 | `j_elo` | latest pre-date jockey Elo |
| 10 | `t_elo` | latest pre-date trainer Elo |
| 11 | `days_since_last` | days since last start; debut missing |
| 12 | `dist_starts` | horse starts within distance ±200m |
| 13 | `dist_top3` | top-3 count in preceding distance cohort |
| 14 | `going_starts` | horse starts on matching going |
| 15 | `going_top3` | top-3 count on matching going |
| 16 | `draw_starts` | all horses: same venue, distance ±100m and draw starts |
| 17 | `draw_top3` | top-3 count in preceding draw cohort |
| 18 | `combo_starts` | jockey×trainer partnership starts |
| 19 | `combo_top3` | partnership top-3 count |
| 20 | `weight_avg5` | mean weight over last 5 starts |
| 21 | `factor_bonus` | sum of six training factor rules (see Chinese rules) |
| 22 | `form_n` | available recent-form count (0–5) |
| 23 | `form_avgpos_w` | finish/field size weighted .40/.25/.15/.10/.10 over last 5 |
| 24 | `form_top3rate_w` | weighted top-3 rate, same weights |
| 25 | `form_pos_slope` | linear finish-position improvement slope; single start=0 |
| 26 | `tv_starts` | trainer×venue starts |
| 27 | `tv_top3` | trainer×venue top-3 count |
| 28 | `jv_starts` | jockey×venue starts |
| 29 | `jv_top3` | jockey×venue top-3 count |
| 30 | `jdb_starts` | jockey×distance ±200m starts |
| 31 | `jdb_top3` | jockey×distance top-3 count |
| 32 | `jg_starts` | jockey×going starts |
| 33 | `jg_top3` | jockey×going top-3 count |
| 34 | `tg_starts` | trainer×going starts |
| 35 | `tg_top3` | trainer×going top-3 count |
| 36 | `horse_pace_n` | last 8 starts with running-position records |
| 37 | `horse_pace_early` | mean first running-position checkpoint over last 8 |
| 38 | `horse_pace_style` | early mean<=2.5 leader=1; <=4 forward=2; else closer=3; unknown=0 |
| 39 | `race_n_leaders` | number of leader-style runners in current race |
| 40 | `race_n_closers` | number of closer-style runners in current race |
| 41 | `horse_pace_clash` | leader: -(leaders-1); closer: max(0,2-closers); forward:0 |
| 42 | `class_now_num` | G1/G2/G3=-1/-2/-3; classes1–5=1–5; griffin=6 |
| 43 | `last_class_num` | previous class using same encoding |
| 44 | `class_delta` | previous class minus current class; positive=class rise |
| 45 | `sect_n` | last 6 starts with sectional observations (0–6) |
| 46 | `sect_early_avg` | mean first sectional position |
| 47 | `sect_late_kick` | mean first minus last sectional position; positive=late gain |
| 48 | `draw_x_sprint` | draw if sprint, else0 |
| 49 | `paceclash_x_distance` | pace-clash if long-distance, else0 |
| 50 | `sire_top3_sm` | sire offspring top-3: (top3+40*globalRate)/(starts+40); unknown=-1 |
| 51 | `sire_dist_top3_sm` | same sire smoothing restricted to distance ±200m |
| 52 | `damsire_top3_sm` | damsire offspring top-3 using same smoothing |

Going text is encoded only by the separate lgb_walkforward.py path, not the production 52-feature list. Training factor rules, source paths and unused research features remain in MODEL.md. Feature importance is gain/split from the actual serialized production refit, tied to hashes; not SHAP, causal attribution or an automatic promotion signal.

Historical prediction timestamps are not immutable publication receipts. Backfilled Elo is not historical inference evidence. The v12 update gap was 2026-04-16 through 2026-10-14; affected prediction differences have not been quantified.
