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

**正式收料調轉（2026-10-24 已修）：** `backend/scripts/scrape-racecard.ts` 原本將 `currentWeight`（體重，約900–1300磅）寫入 `entries_upcoming.actual_weight`（預測特徵當負磅用）、`handicapWeight`（負磅）寫入 `declared_weight`。歷史核對：944 份賽果 CSV 共 111,211 行，`actual_wt_lbs` 介乎 103–135（中位 124）、`declared_wt_lbs` 介乎 856–1503（中位 1117）——賽果收料（RacingData_Scraper）欄位正確，只有排位收料調轉。已修正：`declared_weight = handicapWeight`（負磅）、`actual_weight = handicapWeight − allowance`（實際負磅，同賽果欄位一致）；體重不再寫入任何負磅欄位。舊凍結不改。

**馬會介面改動（2026-10-24 已修）：** 由 2026-10-23 起，通用 hkjc-api 查詢被馬會以 WHITELIST_ERROR 拒絕；`capy_racecard` 照報成功但實際寫「no active meeting」。正式排位收料（scrape-racecard.ts）及賠率收料（scrape-odds.ts）已改用馬會網站同款查詢（共用 `backend/scripts/ingest/lib/hkjc-racecard.ts`），錯誤會令工作失敗，唔會當冇賽事。該查詢冇場次級資料（距離、開跑時間、班次、場地），加欄位即被拒；場次資料改由公開排位頁 RaceCard.aspx 解析（`backend/scripts/ingest/lib/racecard-meta.ts`），解析失敗時保留資料庫現有值（COALESCE），唔會寫空。顯示修正：`/api/meetings` 後備路徑嘅 `weight` 改用 `declared_weight ?? actual_weight`，唔再將體重當負磅顯示。

## B. 場地讀數（待做）
馬會同一排位 API 已有 `penetrometerReadings`／`hammerReadings` 欄位，可沿用同一取數方式，一賽日一行寫入 `data/track_conditions/track_conditions.csv`。

## C1＋C7. 事件／獸醫報告（待做）
來源 `racereportfull?Date=`；只入研究，標明賽後資料。

### 2026-10-24 首次運行更正
首次 GitHub 運行（run 40100156059）因馬會查詢結果冇日期／場地欄位，將海外轉播賽事誤標為 2026-10-24 ST／HV 及 2026-10-25 HV 寫入。該三份係錯標資料（非馬會本地排位原文），已刪除；2026-10-25 ST（156行，本地馬匹編號）保留。程式已加：只收全部馬匹均為本地 HK 編號嘅排位；同一內容出現喺兩個日期／場地即當馬會預設回應而拒收。
