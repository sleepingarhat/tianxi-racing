# elo_baseline_picks 可選 backfill

**唔喺 PR CI／merge 自動跑。** 先手動 apply `20261027_elo_baseline_picks.sql`，再按需要 backfill。

## 步驟

1. 確保 D1 已有 `elo_baseline_picks` 表（見正式 migration）。
2. 產出／讀取特徵矩陣：夜間 `dump-features` → R2／artifact／demo；記下 `matrix.version`。
3. 對矩陣每場：
   - `picks = pickTop4(runners, [{ id: 'elo', weight: 1 }])`
   - 需要正好 4 個馬號先寫入。
4. `INSERT OR REPLACE INTO elo_baseline_picks (race_id, matrix_version, pick1, pick2, pick3, pick4, computed_at) VALUES (…)`.
5. 驗證：`SELECT COUNT(*) FROM elo_baseline_picks WHERE matrix_version = ?`；再用 lab compare／backtest 睇 limitations 是否標「用表列」。

## 行為

- 表存在且有 `(race_id, matrix_version)` → 用表列頭四。
- 否則 → on-demand 由矩陣 Elo 排（MVP 行為不變）。
