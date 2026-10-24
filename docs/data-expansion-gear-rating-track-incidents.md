# 數據擴充：裝備／評分、場地讀數、事件報告（2026-10-24）

用戶批准修正版次序：A → B → C1+C7，之後先考慮 C3、C5、C6。C2（臨場更改）已有原文存檔及指紋，C4 分段位置已有，只補漏。

## 共通約束
1. 新數據只入研究；新特徵要 walk-forward 研究閘 PASS 及用戶拍板先入生產模型。
2. 賽後資料（事件、獸醫、賽後配備）只可用於之後賽事，不可作同場賽前特徵。
3. 原始資料只加不改：每份快照獨立檔案加 SHA-256 manifest。
4. 正式預測以 T−90 凍結排位為準；快照只作研究參考。

## A. 排位表快照（已實作）
- 程式：`backend/scripts/snapshot-racecard.ts`、`backend/scripts/ingest/lib/racecard-snapshot.ts`、測試 `backend/scripts/test-racecard-snapshot.ts`。
- 排程：`.github/workflows/capy_racecard_snapshot.yml`（Capy Racecard 完成後＋每3小時:41）；內容無變就跳過；commit 步驟拒絕修改舊檔或改寫 manifest。
- 輸出：`entries/racecard_snapshots/<日期>_<場地>/<UTC時間>.csv`（UTF-8 BOM、固定欄序）＋ `manifest.jsonl`。
- 欄位：`race_date, venue, race_no, horse_no, horse_name_ch, horse_name_en, horse_id, horse_code, draw, jockey_code, jockey_ch, trainer_code, trainer_ch, handicap_weight_lbs, allowance_lbs, carried_weight_lbs, body_weight_lbs, rating, prev_card_rating, rating_change_vs_prev_card, international_rating, gear_raw, gear_first_time, gear_replaced, gear_removed, is_standby, standby_no, runner_status, scraped_at`。
- 配備標記：`/` 分隔；後綴 1＝首次、2＝更換、`-`＝除下。
- 評分升降：同較早賽日最後一份快照比較；未有較早快照時留空，不冒充官方 Rtg.+/-。
- Join：`horse_id + race_date`；場地級 `race_date + venue`。

### 負磅／體重核實（2026-10-24，已更正）
馬會投注網站程式將 `handicapWeight` 顯示為負磅、`currentWeight` 顯示為馬匹體重；2026-10-25 沙田第1場讀回 handicapWeight 132、currentWeight 921／1151，證實無誤。
快照欄位：`handicap_weight_lbs`（負磅）、`allowance_lbs`（見習減磅）、`carried_weight_lbs`（負磅減減磅）、`body_weight_lbs`（排位體重）。

**現有正式收料疑似調轉（待用戶決定，未改）：** `backend/scripts/scrape-racecard.ts` 將 `currentWeight`（體重）寫入 `entries_upcoming.actual_weight`（schema 註明「實際負磅」，預測特徵亦當負磅用），並將 `handicapWeight`（負磅）寫入 `declared_weight`。2026-10-25 現存 D1 讀回 actual_weight=132，代表現時資料來自其他寫入途徑；但該程式成功運行嘅賽日可能將約1,000磅體重當負磅。須先核對歷史 D1 及凍結紀錄，再由用戶批准修正；舊凍結不改。

**馬會介面改動：** 由 2026-10-23 起，通用 hkjc-api 查詢被馬會以 WHITELIST_ERROR 拒絕；`capy_racecard` 照報成功但實際寫「no active meeting」。快照改用馬會網站同款查詢（`backend/scripts/ingest/lib/hkjc-racecard-query.graphql`），錯誤會令工作失敗，唔會當冇賽事。

## B. 場地讀數（待做）
馬會同一排位 API 已有 `penetrometerReadings`／`hammerReadings` 欄位，可沿用同一取數方式，一賽日一行寫入 `data/track_conditions/track_conditions.csv`。

## C1＋C7. 事件／獸醫報告（待做）
來源 `racereportfull?Date=`；只入研究，標明賽後資料。
