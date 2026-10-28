# 香港賽馬會官方資料覆蓋審計（2026-10-27）

本文件記錄2026-10-27的只讀審計，保留當時觀察；後續修復狀態以2026-10-28補充及官方資料地圖為準。

對照時點：2026-10-27。10 月 28 日沙田場以馬會公開頁同生產 Worker `GET /api/meetings/2026-10-28` 實讀。Git 排位快照是 `entries/racecard_snapshots/2026-10-28_ST/20261026T121013Z.csv`（2026-10-26 20:10 HKT）。

## 審計摘要

**而家唔係 100% 官方底。** 賽果、排位馬匹、檔位、騎練、評分、班次、開跑時間有官方來源；賽事名稱、獎金、評分區間，以及全天候場的途程／跑道／地況，未寫入即將開跑的賽事。網站因此顯示「第 N 場」，看不到「畫眉山讓賽」這類場名。

目標仍然係：官方頁做底，自有評分／預測做上層。日期錯誤要繼續靠頁面身份核對，不能只依請求日期判定。

## 三層

| 層 | 內容 |
|---|---|
| 核心已有 | 賽期日期、排位馬匹（馬號／檔位／騎師／練馬師／負磅／單匹評分／班次／開跑時間）、賽果（場名、班次、途程、地況、跑道字串、獎金、評分區間在 CSV）、分段、派彩、沿途評述、試閘、馬匹檔案同往績、血統、賠率快照、競賽事件報告（研究）、草地探針讀數（研究，未公布就留空） |
| 缺口優先 | 即將開跑場次的**場名、獎金、評分區間、途程、草地／全天候、地況**。10 月 28 日全天候場正正缺後面四項加場名同獎金。公開預測頁再抽走開跑時間，免費版只出第 1 場 |
| 可後補 | 檔位統計表、練馬師王統計、練馬師榜冠亞季數、初出馬介紹原文、馬主搜尋、騎師分場表獨立頁。排位表已經有逐匹檔位同騎師，呢啲係另一層官方產品，唔阻塞 10 月 28 日場次標題 |

## 10 月 28 日沙田（實讀）

官方（`racereportext` 同經典排位頁同一段）：

- 第 1 場「畫眉山讓賽」18:45，全天候跑道 1650 米，好地，獎金 $875,000，評分 40-0，第五班。11 匹正選，同網站 API 馬匹名單一致。
- 第 7 場「石屋山讓賽」21:45，全天候跑道 1200 米，好地，獎金 $1,170,000，評分 60-40，第四班。官方頁多兩匹後備（L104、H108）；快照標 `Standby`，API 按設計唔顯示後備。

生產 `GET /api/meetings/2026-10-28`（`2026-10-28_ST`，9 場）：

| 欄位 | 第 1 場 | 第 7 場 | 落點 |
|---|---|---|---|
| 賽事名稱 | 空 | 空 | `parseRaceMeta` 讀到 `raceName`，`scrape-racecard.ts` 冇寫。`entries_upcoming` 冇 title 欄。API 組排位時寫死 `title: null`。預測退回「第 N 場」 |
| 開跑時間 | 18:45 | 21:45 | `entries_upcoming.post_time`。賽事日 09:00 同 06:15 HKT 排位工作會刷新 |
| 班次 | 第五班 | 第四班 | `entries_upcoming.race_class`。只收「第 X 班／新馬賽」，條件限制括號會掉 |
| 途程 | 空 | 空 | 解析失敗，見下 |
| 跑道（全天候／草地） | 空 | 空 | 同上。`entries_upcoming.track` 留空 |
| 地況 | 空（會議 `trackCondition` 亦空） | 空 | 地況只會寫入 `race_meetings.track_condition`，而且用第一場解析結果。今次解析失敗，所以全日空白。研究檔 `data/track_conditions` 的 10 月 28 日沙田行是空讀數，代表探針未公布，唔等於排位頁未寫「好地」 |
| 獎金 | 空 | 空 | 賽前解析唔收獎金。API 組即將開跑排位時寫死 `prize: null` |
| 評分區間 | 無「40-0／60-40」 | 無 | 單匹 `rating` 有（第 1 場 18–40，第 7 場 41–60），同官方區間相符。區間字串本身冇欄位 |
| 馬匹／檔位／騎練／負磅 | 有 | 有（正選 12） | GraphQL 白名單查詢 → `entries_upcoming`。Git `entries/entries_2026-10-28.txt` 只係馬號清單，冇場次資料 |

### 點解途程同全天候會空

排位 GraphQL 查詢加場次欄會被馬會 `WHITELIST_ERROR` 拒絕，所以場次資料靠經典排位頁。解析器只認草地格式：

`草地, "A" 賽道, 1200米, 好地`

10 月 28 日實際係：

`全天候跑道, 1650米, 好地`

冇引號賽道，途程、跑道、地況一齊變空。班次同開跑時間用另一段，所以仍然有。解析失敗會保留舊值（`COALESCE`），舊值本身係空，工作仍然綠色。

對照已完場的 2026-10-25 沙田：賽果 CSV 同 API 有場名、班次、途程、地況、`course`（`草地 - "A" 賽道`）、獎金。`races.track` 仍然係空，因為每日 `import-csv.ts` 把整句跑道寫入 `course`，`track` 固定寫空。評分區間只留在 `results_*.csv` 的 `rating_range`，冇進 D1。

## 官方頁對照

狀態只分已有／部分／冇。更新節奏係排程，唔係保證延遲。

| 官方頁 | 狀態 | 表／檔／工作 | 更新節奏同延遲風險 |
|---|---|---|---|
| [檔位統計](https://racing.hkjc.com/zh-hk/local/information/draw) | 部分 | 逐匹檔位在 `entries_upcoming.draw`、`race_results.draw`。官方統計表本身冇收 | 跟排位／賽果。自有檔位因子唔等於馬會統計頁 |
| [練馬師王統計](https://racing.hkjc.com/zh-hk/local/information/tncstat) | 冇 | 無對應表。練馬師逐場往績係另一頁 | — |
| [競賽事件報告](https://racing.hkjc.com/zh-hk/local/information/racereportfull) | 已有（研究） | `scripts/IncidentReport_Scraper.py` → `data/incidents/`。要核對標題日期、馬場、場題、馬匹連結。唔入模型、唔入凍結 | `capy_incident_reports`：HKT 02:23／08:23／14:23／20:23，加賽果工作完成後。同日報告不可當賽前特徵 |
| [賽期表](https://racing.hkjc.com/zh-hk/local/information/fixture?calyear=2026&calmonth=12) | 部分 | `FixtureCalendar_Scraper.py` → `data/fixtures/fixtures.csv`。只有日期、星期、抓取時間。冇馬場、場數、開跑時間。2026-12 已在檔內；10 月 28 日在冊。最近抓取 2026-10-25 | `capy_fixture_weekly`：逢星期一 05:00 HKT。快取超過 21 日會當每日都係賽日（寧願多跑）。馬會空月份會回當月，程式對月份標題，唔收錯月 |
| [初出馬介紹](https://racing.hkjc.com/zh-hk/local/page/new-horse) | 冇 | 介紹文冇收。新馬血統另由 `HorsePedigree_Scraper.py` 跟排位馬號補 | 血統：一／二／六 21:30 HKT 排位模式；星期三 05:00 全池補 |
| [騎師策騎／分場](https://racing.hkjc.com/zh-hk/local/info/jockeys-rides) | 部分 | 沒有獨立分場表。當日騎師在 `entries_upcoming.jockey_name` | 跟排位工作。頁面本身係前端殼，目前未收錄該頁 |
| [練馬師榜](https://racing.hkjc.com/zh-hk/local/info/trainer-ranking?season=Current&view=Numbers&racecourse=ALL) | 冇 | `trainers/trainer_profiles.csv` 只有代碼同姓名（68 行）。冠亞季殿、出馬總數冇收。逐場往績在 `trainers/records/`（`trainerpastrec`，`capy_trainer_fix` 每日 01:00 HKT） | 榜可以日後由往績加總，而家唔係官方榜副本 |
| [練馬師資料](https://racing.hkjc.com/zh-hk/local/information/trainerprofile?trainerid=HDA&season=Current) | 部分 | 姓名有。簡介頁季績冇整頁收。往績走 `trainerpastrec` | 每日 01:00 HKT，近兩日有賽先跑 |
| [賽果](https://racing.hkjc.com/zh-hk/local/information/localresults) | 已有 | `RacingData_Scraper.py` → `data/<year>/results_*.csv` 等五份檔 → `import-csv.ts` → `race_meetings`／`races`／`race_results`／分段／評述／派彩。寫入前核對頁面「賽事日期」 | 賽日 23:30 HKT，後備 01:30／04:30／09:30。D1 同步 00:23，後備 06:23／10:23。賽果未出，馬會會顯示上一場，必須拒絕寫入 |
| [騎師資料](https://racing.hkjc.com/zh-hk/local/information/jockeyprofile?jockeyid=HEL&Season=Current) | 部分 | `jockeys/jockey_profiles.csv` 有今季獎金、出賽、勝出率等；`jockeys/records/` 64 個往績檔。來源係騎師排名頁加 `jockeypastrec`，唔係逐個 profile 殼頁 | `capy_pool_b_daily` 每日 02:00 HKT |
| [馬匹資料](https://racing.hkjc.com/zh-hk/local/information/horse?horseid=HK_2025_L457) | 已有 | `HorseData_Scraper.py` → `horses/profiles`、`form_records`；D1 `horses`、`horse_profile_extra`、`horse_form_records`。晨操、傷患同池。馬主係檔案一欄 | `capy_pool_a` 每日 04:00 HKT；D1 05:17。非賽日可跳過 |
| 馬主搜尋 | 部分 | 馬主名字在馬匹檔案 `馬主`／`horse_profile_extra.owner`。冇馬主索引，搜尋頁冇爬 | 跟馬匹檔案 |
| [試閘](https://racing.hkjc.com/zh-hk/local/information/btresult) | 已有 | `TrialResults_Scraper.py` → `trials/` → `trial_sessions`、`trial_runners` | 每日 02:00 HKT 抓、05:17 入 D1。馬會只留約 176 個試閘日，更早補不回 |
| 排位表／賽事報告延伸（場名、時間、班次、獎金、評分區間、跑道、途程、地況） | 部分 | 馬匹層：`capy_racecard` → `entries_upcoming`；研究快照 `entries/racecard_snapshots/`。場次層只持久化班次、開跑時間；場名同獎金讀完即丟；全天候途程／跑道／地況解析失敗 | 排位：一／三／五／六 09:00 HKT，每日 06:15 HKT，以及排位馬號工作成功之後。快照每 3 小時，內容不變就跳過。賽前缺欄會缺少驗證仍顯示成功 |

草地探針（天氣及跑道狀況，唔係練馬師王統計）係 `capy_track_conditions`，每小時 47 分，研究檔，不寫 D1。未公布讀數保持空白。

## 賽事日期：舊錯同而家的閘

1. **2026-10-25 賽果。** 馬會在賽果未出時回上一場（21 日跑馬地）。舊程式用請求日期蓋印，第 1 場 11 行寫成 25 日。D1 反幽靈檢查冇收，Elo 同 Telegram 冇用錯檔。修復：頁面「賽事日期」標題必須等於請求日，讀唔到都唔寫；`test_racing_data_date_guard.py`。見 `docs/reviews/results-date-guard-2026-10-25.md`。
2. **2026-10-24 排位 GraphQL。** 馬會忽略日期變數，回傳當前或海外排位。修復：每匹馬必須係本地 `HK_YYYY_Xnnn`，而且 runner id 帶 `YYYYMMDD`＋馬場＋場次（例 `20261025ST01L245`）。相同內容出現在兩個日期／馬場就拒收。
3. **賽期表。** 空月份會顯示當月。而家先對日曆標題年月，不符就整月跳過。
4. **排位場次頁。** 開跑時間只在頁面日期、馬場、場次都對得上先收。呢個閘有效，所以 10 月 28 日時間係 18:45 而唔係別日。途程失敗係格式唔係日期。

未完場的 `races` 行不應靠賽果頁補。賽果頁在開跑前會回退，用佢填場名會再錯日期。

## 網站顯示（資料層為準）

`tianxi-site` 唔在本倉。生產 Worker 已夠說明畫面會見到咩：

- `/api/meetings/:date` 在賽果未入庫時用 `entries_upcoming`。場名同獎金寫死空。地況用會議級一格，今次係空，所以每場地況都空。
- `/api/analyze/today-picks` 免費公開版只留第 1 場。公開投影欄位冇 `startTime`，所以預測卡可以有班次、有馬，但標題係「第 1 場」、冇時間、冇途程。內部計算有時間，係投影時抽走。
- 管理頁場名後備係「第 N 場」；副題只在途程、地況、班次有值時先拼。

已完場日（例 10 月 25 日）會顯示場名、獎金、途程、地況，因為嗰啲來自賽果 CSV。差距集中在**開跑前**。

## 建議下一步（本 PR 不實作）

按對網站同錯日期的影響排序：

1. **補即將開跑的場次頭。** 沿用已抓的排位頁，擴充解析：`全天候跑道, 1650米, 好地` 同現有草地句都要收。把場名、獎金、評分區間寫入可查欄位（`entries_upcoming` 或同等場次行），API 唔好再寫死 `title`／`prize` 為空。身份閘保持：日期、馬場、場次不符就整段丟棄。10 月 28 日可作回歸樣本。
2. **解析到頭卻缺途程就令工作失敗。** 而家失敗變空值，排程仍然成功。頁面明明有「米」同「全天候／草地」但欄位仍空，應紅燈，避免再綠著開跑。
3. **地況按場，唔好全日共用第一場。** 混合草地／全天候時，會議級一個「好地」會蓋錯另一場。探針讀數繼續獨立，未公布保持空白，唔好用排位頁地況冒充探針。
4. **公開卡顯示已收的官方頭。** 至少場名、途程、跑道、地況、班次、開跑時間。免費版可以繼續只出一場，但這一場唔好叫「第 1 場」而丟掉 18:45。
5. **賽果路徑補齊，但唔好提前用賽果頁。** `rating_range` 入 D1；`course` 拆開 `track`（草地／全天候）同移欄。只在「賽事日期」標題已核對後寫。檔位統計、練馬師榜、初出馬介紹、馬主搜尋留後，唔好同場次頭混成一次大改。

官方底未齊之前，唔好把自有預測文案寫成馬會場名或獎金。
