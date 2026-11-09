/**
 * 展示用馬匹 Elo：同預測引擎一樣優先讀現行 v12 快照，冇 v12 先回落舊版。
 * 同一日 D1 會同時有 v12 同舊版（v11）快照；淨係按日期排序會令馬匹頁
 * 隨機顯示舊版分數，走勢圖亦會一高一低咁跳。
 */
export const ELO_V12_FIRST = "CASE WHEN id LIKE 'v12:%' THEN 0 ELSE 1 END";
export const ELO_SNAPSHOT_SEQ = "CAST(substr(id, length(rtrim(id, '0123456789')) + 1) AS INTEGER)";

/** 每匹馬一行最新 overall Elo（欄位與舊 v_horse_latest_elo 相同）。 */
export const LATEST_HORSE_ELO_SUBQUERY = `SELECT horse_id, rating AS overall_elo, as_of_date AS overall_as_of, games_played AS overall_games
  FROM (
    SELECT horse_id, rating, as_of_date, games_played,
           ROW_NUMBER() OVER (PARTITION BY horse_id ORDER BY ${ELO_V12_FIRST}, as_of_date DESC, ${ELO_SNAPSHOT_SEQ} DESC) AS rn
    FROM horse_elo_snapshots
    WHERE axis_key = 'overall'
  ) ranked
  WHERE rn = 1`;

/** 單匹最新 overall Elo；bind(horseId)。 */
export const LATEST_ONE_HORSE_ELO_SQL = `SELECT rating AS overall_elo, as_of_date AS overall_as_of, games_played AS overall_games
  FROM horse_elo_snapshots
  WHERE horse_id = ? AND axis_key = 'overall'
  ORDER BY ${ELO_V12_FIRST}, as_of_date DESC, ${ELO_SNAPSHOT_SEQ} DESC
  LIMIT 1`;

/** 單匹 overall Elo 走勢：有 v12 就只用 v12，否則用舊版；bind(horseId, horseId)。 */
export const HORSE_ELO_HISTORY_SQL = `SELECT as_of_date, rating, games_played
  FROM horse_elo_snapshots
  WHERE horse_id = ? AND axis_key = 'overall'
    AND (id LIKE 'v12:%' OR NOT EXISTS (
      SELECT 1 FROM horse_elo_snapshots v
      WHERE v.horse_id = ? AND v.axis_key = 'overall' AND v.id LIKE 'v12:%'
    ))
  ORDER BY as_of_date ASC, ${ELO_SNAPSHOT_SEQ} ASC`;
