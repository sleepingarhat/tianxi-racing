# 香港賽馬會本地賽馬網站地圖（活清單）

盤點日：2026-10-27。2026-11-10 按當時已在 main 的收料，同這次賽期／報名表改動，更新下面有變的行。沒有改 production secret，沒有部署 Worker。

2026-11-10 那次點算：68 個 `information`／`info`／`page` 面，39 完整（約 57%）、16 部分、13 冇。下面只改今次有對上的行，唔係重爬成個網站。傷患資料庫由部分改已有。自購馬來港前賽績、從化搬遷一覽、騎練配對及初出馬成績、騎師王賠率走勢、練馬師王賠率走勢由冇改已有。計完係 **45 完整、15 部分、8 冇**（45/68，約 66%）。排位表的評分+/-、排位體重+/-、最佳時間、上賽距今日數已入庫，頁面仍然係部分。選單「傷患紀錄」`overecord` 唔係這 68 行裡面的獨立行，而家另表收集，唔計入 45。參考頁同 80 的分母冇重數。

2026-11-10 再對 live 頁之後：馬匹來港前名稱、獎金計劃出賽馬、終點照片、賽事特別情況索引由冇改已有。賽日數據的頁面 payload 係兩張 JPEG，冇表。馬匹消息同馬匹評分榜的 `View=` 仍然返回目錄殼，頁面腳本冇另一次資料請求。進口資格係政策正文。計完係 **49 完整、15 部分、4 冇**（49/68，約 72%）。排位表的可能超磅、分齡讓磅已入庫，頁面仍然係部分（出賽馬匹 PDF、跑道圖未收；馬齡、性別、馬主、進口類別、今季獎金仍然用馬匹主檔）。

2026-11-10 再讀官方頁：賽日數據仍然係兩張 JPEG，而家把官方圖片路徑同顯示窗時間入庫，唔估圖入面的數字。馬匹評分榜的 iframe 有評分表。馬匹消息的 `View=` 有公告清單、評分變動、首五十、獎金表，同季終評分正文。進口資格仍然係政策正文，正文入面的國家表同年齡表一併收。排位表的出賽馬匹 PDF、跑道圖，同埋馬齡、性別、馬主、進口類別、今季獎金，由排位 HTML 入庫。計完係 **54 完整、14 部分、0 冇**（54/68，約 79%）。

上一份審計專門對 10 月 28 日沙田場次頭：[`docs/hkjc-coverage-audit.md`](./hkjc-coverage-audit.md)，而家在 [PR #113](https://github.com/sleepingarhat/tianxi-racing/pull/113)（分支 `cursor/hkjc-coverage-audit-10dc`），尚未合併。合併之後兩份文件同目錄。今份把範圍拉闊到成個本地公開網站，唔再只係該次場次頭。

自有預測同 Elo 係官方頁上面的一層。官方頁未寫入的場名、獎金、途程，唔好用預測文案填。

## 100% 係邊度

**100% 官方數據 = `racing.hkjc.com` 上、繁體中文 `zh-hk` 的本地 `information`、`info`、`page` 每一個公開展示的數據面。** 包括賽日流程、馬匹／騎師／練馬師／馬主、賽期、試閘、報告、榜、統計、參考頁。唔等於「排位表頭加幾條樣本 URL」。

今次沿本地賽果頁的選單，再跟一層同範圍連結，實讀約 90 個路徑（2026-10-27）。經典 `RaceCard.aspx`、`LocalResults.aspx` 會跳去下面的 `zh-hk` 路徑，內容同一頁。

越洋轉播、國際評分、`bet.hkjc.com` 即時賠率、會員販馬代理、賽馬知多些、退役馬，係選單連出去的鄰近網站，唔計入這三個前綴。見文末「邊界」。

## 給老闆的一句

**而家未到 100%。** 賽果、排位馬匹、檔位、騎練、單匹評分、班次、開跑時間、試閘、馬匹主檔、晨操、傷患、派彩、分段、沿途評述有官方來源。10 月 28 日沙田那類空場次頭，在 main 上已由排位 HTML 寫入場名、途程、跑道、地況、獎金、評分區間；2026-11-11 跑馬地的公開賽事 API 已見到這些頭。完場會議的 `ratingRange` 會讀 `races.rating_range`，不再寫死 null。賽期月份會連同 `fixtures.csv` 入庫的官方賽日一併列出，未有排位的日子標 `cardStatus=fixture`，已有報名、未有檔位的日子標 `entries`。下面「仍未覆蓋」先至係而家的缺口。

下面「仍未覆蓋的主要缺口」係而家距離 100% 最遠的公開面。P0 先補場次頭，避免錯日期同空標題；P1、P2 先至係榜、統計、初出馬介紹、馬主搜尋。今份 PR 只寫清單，不實作爬蟲。

## 點讀

| 字 | 意思 |
|---|---|
| 已有 | 公開主表已進我哋的表、CSV 或研究快照，欄位對得上該頁主體 |
| 部分 | 有相關馬匹／日期／姓名，但該頁成張表、成段正文或某個維度未收 |
| 冇 | 沒有對應該頁的收料 |
| 展示 | 對外賽事卡、賽果、馬匹頁會直接用到 |
| 研究 | 可以留作核對或日後特徵；唔應該自動變成模型輸入或凍結文案 |
| 節奏 | 排程，唔係保證延遲。非賽日多數工作會跳過 |

日期風險一節要先讀。空欄同錯日係兩件不同的事：解析失敗會綠燈留空；賽果未出時馬會會顯示上一場，用請求日期蓋印就會寫錯日。

## 傳輸同 WHITELIST

| 形態 | 用喺邊 | 注意 |
|---|---|---|
| 伺服器 HTML | `/zh-hk/local/information/*` 大部分排位、賽果、馬匹、試閘、統計表 | 直接讀表格。日期、馬場、場次要對頁面正文，唔好對請求參數 |
| Next.js 殼 + GraphQL | `/zh-hk/local/info/*`（分場表、榜、更易、一般資訊、天氣、速勢、終點相） | 頁面設定指向 `info.cld.hkjc.com/graphql/base/`。首個 HTML 冇表，資料係瀏覽器之後先載入 |
| 內容管理殼 | `/zh-hk/local/page/*`（初出馬、賽日頭條、賽日數據、跑道資料等） | 標題在殼頁；正文由馬會內容服務載入。初出馬介紹已用瀏覽器核對到血統同評語 |
| 速勢 JSON | `consvc.hkjc.com` 上 SpeedPro `current` | 只得當前賽馬日，過期就冇得補歷史 |
| 經典 aspx | `RaceCard.aspx`、`LocalResults.aspx`、`Fixture.aspx` | 2026-10-27 實測跳去對應 `zh-hk/local/information/...` |

**WHITELIST：** 2026-10-23 起，排位 GraphQL 查詢一旦加場次欄（途程、開跑時間、班次、跑道）會被馬會拒絕。場次頭改由排位 HTML 解析。`/info/*` 每頁有自己已獲准的查詢（分場、更易、榜、一般資訊）。抄一條查詢再加欄，可以整段失敗。新收料要沿用該頁已經在用的查詢，或者讀 HTML；唔好為補欄位改白名單查詢。

## 日期身份

頁面寫邊日，先可以寫邊日。請求參數唔係證據。

| 風險 | 現況 |
|---|---|
| 賽果未出，`localresults` 顯示上一場 | 已有閘：頁面「賽事日期」必須等於請求日。2026-10-25 曾把 21 日跑馬地蓋成 25 日。見 `docs/reviews/results-date-guard-2026-10-25.md`。未完場唔好用賽果頁補場名 |
| 排位 GraphQL 忽略日期，回當前或海外排位 | 已有閘：本地 `HK_YYYY_Xnnn`，runner id 帶 `YYYYMMDD`＋馬場＋場次。同一內容出現在兩個日期／馬場就拒收 |
| 賽期表空月份顯示當月 | 已有閘：先對日曆標題年月 |
| 排位場次頭只認草地句 `草地, "A" 賽道, 1200米` | 10 月 28 日實際係 `全天候跑道, 1650米, 好地`。途程、跑道、地況變空，工作仍然綠色。開跑時間另一段，所以 18:45 係對的。這是 P0 |
| 地況只寫會議第一場 | 混合草地／全天候會蓋錯。10 月 28 日九日都係全天候好地，公開頁同一般資訊都係咁寫，我哋會議格係空 |
| 同一件事多個日期格式 | 排位／賽果 `YYYY/MM/DD`；沿途評述 `Date=YYYYMMDD`；分段時間 `racedate=DD/MM/YYYY`；試閘同賽果日期選擇器亦有 `DD/MM/YYYY`。抄錯格式會打中另一日 |
| 賽果頁同時列出賽馬日同轉播場 | 2026-10-25 沙田頁旁有 `Racecourse=S2`（日本）。轉播場唔可以蓋成本地沙田 |
| 榜同統計的「截至賽事日」 | 2026-10-27 看到的榜截至 25/10/2026。那是上一賽馬日，唔係「今日」。未開跑的 28 日唔好寫成已經入榜 |

## 老闆點名的頁

全部要在下面矩陣出現。

| 點名 | 矩陣 |
|---|---|
| [檔位統計 draw](https://racing.hkjc.com/zh-hk/local/information/draw) | 統計 |
| [練馬師王統計 tncstat](https://racing.hkjc.com/zh-hk/local/information/tncstat) | 統計 |
| [競賽事件報告 racereportfull](https://racing.hkjc.com/zh-hk/local/information/racereportfull) | 賽果 |
| [賽期表 fixture](https://racing.hkjc.com/zh-hk/local/information/fixture?calyear=2026&calmonth=12) | 賽日 |
| [初出馬介紹 new-horse](https://racing.hkjc.com/zh-hk/local/page/new-horse) | 馬匹 |
| [騎師分場 jockeys-rides](https://racing.hkjc.com/zh-hk/local/info/jockeys-rides) | 賽日 |
| [練馬師榜 trainer-ranking](https://racing.hkjc.com/zh-hk/local/info/trainer-ranking?season=Current&view=Numbers&racecourse=ALL) | 騎練 |
| [練馬師資料 trainerprofile](https://racing.hkjc.com/zh-hk/local/information/trainerprofile?trainerid=HDA&season=Current) | 騎練 |
| [賽果 localresults](https://racing.hkjc.com/zh-hk/local/information/localresults) | 賽果 |
| [騎師資料 jockeyprofile](https://racing.hkjc.com/zh-hk/local/information/jockeyprofile?jockeyid=HEL&Season=Current) | 騎練 |
| [馬匹資料 horse](https://racing.hkjc.com/zh-hk/local/information/horse?horseid=HK_2025_L457) | 馬匹 |
| [馬主搜尋 ownersearch](https://racing.hkjc.com/zh-hk/local/information/ownersearch?horseowner=) | 馬匹 |
| [試閘 btresult](https://racing.hkjc.com/zh-hk/local/information/btresult) | 馬匹 |
| [各駒上次競賽事件摘要 racereportext](https://racing.hkjc.com/zh-hk/local/information/racereportext) | 賽日 |
| 經典排位 `RaceCard.aspx` | 同 [排位表 racecard](https://racing.hkjc.com/zh-hk/local/information/racecard) |

## 賽日排位（P0 場次頭在這裡）

10 月 28 日第 1 場公開頁原文：`第 1 場 - 畫眉山讓賽`／`2026年10月28日, 星期三, 沙田, 18:45`／`全天候跑道, 1650米, 好地`／`獎金: $875,000, 評分: 40-0, 第五班`。騎師分場表的場次格同一般資訊的「沙田 - 全天候跑道、好地」寫的係同一件事。

| 頁 | 狀態 | 公開欄位 | 天喜落點同節奏 | 日期風險 |
|---|---|---|---|---|
| [排位表](https://racing.hkjc.com/zh-hk/local/information/racecard?racedate=2026/10/28&Racecourse=ST&RaceNo=1) 同經典 `RaceCard.aspx` | 已有 | 場名、日期、星期、馬場、開跑時間、草地／全天候、途程、賽道、地況、獎金、評分區間、班次。馬匹欄：馬號、6次近績、綵衣、馬名、烙號、負磅、騎師、可能超磅、檔位、練馬師、國際評分、評分、評分+/-、排位體重、體重+/-、最佳時間、馬齡、分齡讓磅、性別、今季獎金、優先參賽次序、上賽距今日數、配備、馬主、父系、母系、進口類別。另有出賽馬匹 PDF、跑道圖 | 馬匹層：同一條已獲准的 GraphQL → `entries_upcoming`（馬號、檔位、騎練、負磅、實際負磅、排位體重、見習減磅、評分、國際評分、6次近績、綵衣檔名、配備、班次、開跑時間、後備）。唔加 GraphQL 欄。場名、獎金、評分區間、途程、跑道、地況由排位 HTML 寫入。`capy_racecard` 掃今日起 14 日內每一個賽期，未出排位的日子跳過；一／三／五／六 09:00 HKT，每日 06:15 HKT。公開 `weight` 係負磅或實際負磅；排位體重係 `bodyWeight`。完場 `ratingRange` 讀 `races.rating_range`。評分+/-、排位體重+/-、最佳時間、上賽距今日數由同一頁 HTML 寫入 `entries_upcoming.rating_change`、`body_weight_change`、`best_time`、`days_since_run`，空白留空，0 就寫 0，唔加 GraphQL 欄。頁面有排位表但這四欄對唔上馬號同烙號，`capy_racecard` 以 exit 2 失敗。可能超磅、分齡讓磅由同一頁 HTML 寫入 `entries_upcoming.possible_overweight`、`age_allowance`，空白或「-」留空，0 就寫 0。馬齡、性別、今季獎金、馬主、父系、母系、進口類別由同一頁出賽馬匹表寫入 `official_racecard_runner`，空白或「-」留空，0 就寫 0。後備表只得馬齡，其餘主檔欄留空。出賽馬匹 PDF 同跑道圖只存官方路徑：檔名日期同途程要對頁面場次頭；草地圖中間字母係 `t`，全天候圖唔可以用 `t`。`capy_wave7_surfaces` 跟今日起 14 日有場數的賽期，未出排位就跳過。公開卡仍然用馬匹主檔填馬齡、性別、馬主、進口類別、今季獎金，呢張官方表唔改 `entries_upcoming` | P0。身份閘仍要保持。頁面有「米」同「全天候／草地」但途程或跑道空，`capy_racecard` 以 exit 2 失敗，唔會綠燈推上 D1 |
| [報名表](https://racing.hkjc.com/zh-hk/local/information/entries) | 已有 | 練馬師 × 班次 × 評分幅度 × 途程 × 草地／全天候，格內係已報馬名。未有馬號同檔位 | `scripts/hkjc_entries.py` 寫 `entries/official/entries_<日期>_<馬場>.csv`，再入 D1 `official_race_entries`。`card_stage=entries`、`draw_status=unavailable`。頁面「賽事日期」同馬場對唔上就唔寫。未刊出的賽日唔會刪走已存的表。跟住未來 14 日賽期，唔止下一場。`capy_entries`：一、二、五 20:00，六 08:00 同 20:00 HKT。`entries/entries_*.txt` 仍然只係下一場排位的馬號清單 | 排位未出之前這張表先出現。唔當正式排位表 |
| [晨操資料（當日排位）](https://racing.hkjc.com/zh-hk/local/information/localtrackwork) | 已有 | 同上場次頭。每駒：試閘、快操、踱步、游泳、跑步機、水中步行機、休歇。後備馬匹係另一張表 | `official_meeting_trackwork`。逐匹 `horse_trackwork` 唔改。`runner_section` 分開正選同後備。冇晨操線的馬留 `category=declared`。近績空白留空。`capy_raceday_companions`：賽日同賽日前一日 HKT 08:25／12:25／16:25／19:25 | 晨操日期唔係賽事日。場次頭要有途程同跑道。後備馬號可以同正選重複 |
| [各駒上次競賽事件摘要](https://racing.hkjc.com/zh-hk/local/information/racereportext) | 已有 | 馬號、烙號、馬名、日期、場次、描述（上次報告原句）。後備馬匹由「後備馬匹」一行分開 | `official_race_report_ext`。上次日期、連結場次、馬場要同日期格一致；烙號要同馬匹連結一致。描述原文保留，包括 `--`。正選同後備各記一行。全文報告 `racereportfull` 仍係另一頁。同 `capy_raceday_companions` | 描述入面的日期係上次出賽，唔係今場 |
| [同場對壘](https://racing.hkjc.com/zh-hk/local/information/formline) | 已有 | 上次同場：馬名、負磅、評分、檔位、騎師、上賽騎師、名次、完成時間、距離、賠率、相對負磅／評分差異 | `official_formline`。上一場日期、場次標籤、場次編號、馬場跟該格連結。相對差異空白留空。`not_race_result=1`。同 `capy_raceday_companions` | 上一場日期唔係今場 |
| [特別因素](https://racing.hkjc.com/zh-hk/local/information/exceptionalfactors) | 已有 | 蝕磅、分齡讓磅、配備、綁繫舌帶、上賽／今賽口銜、評分、途程、上賽距今日數、轉投練馬師、從化回港日期 | `official_exceptional_factor`。排位表的配備同負磅仍然另外收。空格留空，唔寫 0。轉投只收 YES。從化回港日期跟該駒。同 `capy_raceday_companions` | 從化回港日期要跟該駒，唔好跟賽事日 |
| [排位傷患](https://racing.hkjc.com/zh-hk/local/information/veterinaryrecord) | 已有 | 當日出賽馬：日期、詳情、通過日期。續行馬號馬名留空，跟住上一匹 | `official_veterinary_record` 係當日一覽。逐匹 `horse_injury` 唔改。通過日期空白留空。表 id `OVR1` 唔係場次。同 `capy_raceday_companions`。選單「傷患紀錄」[`overecord`](https://racing.hkjc.com/zh-hk/local/information/overecord) 係另一張會議一覽（場次、烙號、後備），寫入 `official_ove_record`，`capy_wave5_visible` | 傷患日可以早過賽事日 |
| [練馬師分場表](https://racing.hkjc.com/zh-hk/local/info/trainers-entries) | 已有 | 同騎師分場：練馬師、今季成績、每場馬名。GraphQL `commonMeetings`，參數 `dates` | `official_ride_assignment`（`role=trainer`）。只用該頁的 `rw_TrainersEntries`。今季成績取唯一的 ALL／ALL，唔加其他場地。後備冇馬號，唔借用正選獨贏。優先參賽同王牌跟頁面布林值。練馬師王出馬表見下一行。同 `capy_raceday_companions` | 日期對唔上就係另一場的馬 |
| [練馬師王出馬表](https://racing.hkjc.com/zh-hk/local/info/tnc-entries) | 已有 | 練馬師王組合、賠率、馬匹 | `official_challenge_pool`／`official_challenge_selection`／`official_challenge_ride`（`odds_type=TNC`）。`scripts/hkjc_challenge_boards.py`。同 `capy_raceday_companions`。研究副本，唔入凍結 | 同騎師王一樣，只包指定場次 |
| [騎師分場表](https://racing.hkjc.com/zh-hk/local/info/jockeys-rides) | 已有 | 騎師、今季冠亞季總出賽、每場班次、途程、全天候／草地、格內獨贏賠率同馬名。註明更換騎師。後備未派騎師係 `---` | `official_ride_assignment`（`role=jockey`）。只用該頁的 `rw_JockeysRides`，獨贏彩池係 `oddsTypes: [WIN]`。`win_odds_text` 係研究副本，唔寫 `odds_snapshots`，唔改凍結。更換騎師只計 `type=99` 而且 `dueToPromotion=0`。今季成績取唯一 ALL／ALL。騎師王坐騎表見下一行。同 `capy_raceday_companions` | 場次格的途程係場次頭的另一個副本。後備馬號在這頁係空，唔好編成 1 |
| [騎師王坐騎表](https://racing.hkjc.com/zh-hk/local/info/jkc-scheduled-rides) | 已有 | 騎師王組合、坐騎、賠率、積分 | 同上三張表，`odds_type=JKC`。同 `capy_raceday_companions` | 錦標賽日只計指定場，註腳寫明 |
| [更易事項](https://racing.hkjc.com/zh-hk/local/info/changes) | 已有 | 場次、更易事項（換騎、負磅、退出等）。選單去 `/info/changes`。舊路徑 [`/information/changes`](https://racing.hkjc.com/zh-hk/local/information/changes) 仍係 HTML，當日內容同新頁一樣係場次加更易事項 | HTML 快照仍然只追加。`scripts/RacingChanges_Scraper.py` 讀該 HTML（唔加 GraphQL 欄），最新一份投影去 `data/racing-changes/changes.csv` 同 D1 `racing_changes`（場次、馬號、馬名、`change_type`、before／after、原文）。馬號加馬名對得上 `entries_upcoming` 先寫回騎師／負磅／檔位／配備；退出只在開跑前 90 分鐘之前把 `priority_order` 設成「退出」。`capy_racing_changes`：賽日同賽日前一日 HKT 08:15／12:15／16:15／18:15／20:15。對唔上或者未識嘅句子留在快照，工作失敗 | 頁面日期同馬場先可以寫。海外賽事段唔當本地。快照係原文；寫回只限身份相符的即將開跑馬 |
| [賽馬日一般資訊](https://racing.hkjc.com/zh-hk/local/info/summary) | 部分 | 場地句子（例：沙田 - 全天候跑道、好地（第1,2,3,4,5,6,7,8,9場））、競賽董事、彩池同場次、停賽騎師同停賽日期。多寶、派彩、探針已入 `official_pool_status`、`official_pool_dividend`、`official_track_probe`（`scripts/hkjc_raceday_pools.py`，同 `capy_raceday_companions`）。派彩只加行，唔改已存金額。硬度計未出留空 | `official_meeting_summary`、`official_meeting_going`、`official_meeting_pool`（彩池代號加場次；騎師王／練馬師王用頁面中文，`{0}` 換成期數）、`official_jockey_suspension`、`official_meeting_steward`。中文職銜空白就留空。海外場唔當沙田或跑馬地。場地句係官方字串的固定排法，唔係宣稱同畫面逐個標點相同。同 `capy_raceday_companions` | 場地句係會議級。停賽日期係處罰生效日，可以碰巧等於賽事日 |
| [即時賠率](https://bet.hkjc.com/ch/racing/wp/) | 部分 | 投注網。本地選單連出。獨贏、位置以及其他彩池 | 本地賽日 **WIN／PLA** 顯示賠率 → `odds_snapshots`。GraphQL `oddsTypes: ['WIN','PLA']`。`capy_odds` 每 10 分鐘；另有約 5 分鐘 Worker 收同一對彩池。未開跑賽事 20 分鐘未更新先算舊。其他彩池冇收。騎師王／練馬師王走勢係 `official_challenge_odds`，唔寫 `odds_snapshots` | 賠率更新唔改凍結同模型 |
| [賽日頭條](https://racing.hkjc.com/zh-hk/local/page/raceday-focus) | `official_raceday_focus` | 標題、導語、版本；正文只存 SHA-256 及字數，連回官方頁 | `capy_raceday_companions` | 文章日期可以早過賽事日；圖片無授權不收 |
| [速勢能量](https://racing.hkjc.com/zh-hk/local/info/speedpro/speedguide?raceno=1) 同 [formguide](https://racing.hkjc.com/zh-hk/local/info/speedpro/formguide) | 部分 | 速勢圖：能量、所需能量、狀態、檔位、最近五仗、場地。走勢指南：騎練、負磅、檔位、賠率、分段、體重、日數。頁面註明賽前一天中午，而且係供應商參考 | `speedpro/scrape_speedpro.py` → `speedpro/data/<日期>_<馬場>.json`（去掉底圖）。09:00、11:00 HKT。只得當前賽馬日。不入模型 | 過期日補不回。場地狀況註明要對排位表 |
| [賽日數據](https://racing.hkjc.com/zh-hk/local/page/stats-centre) | 已有 | 互動統計。頁面 payload 係「熱門」同「賽日數據」兩張 JPEG（`whosHot`、`racedayStats`），另有顯示窗完結時間同最後更新時間。冇官方數字表 | `official_stats_centre_image` 只存官方圖片路徑、檔名入面的日期，同兩個時間。唔下載圖片位元組，唔從圖片估數字。`not_race_result=1`。`capy_wave7_surfaces`。公開 `GET /api/official/stats-centre` | 圖片檔名帶賽日。兩張圖的日期要一致，而且同資料夾年月一致。過期日補不回表 |
| [上仗備忘](https://racing.hkjc.com/zh-hk/local/page/last-run-reminder) | `official_last_run_reminder` | 精選馬上仗日期、場次、走位、疊數、備忘 | `capy_raceday_companions` | 須對上當日排位馬（場次、馬號、烙號、馬名），上仗日期須早過賽日 |
| [天氣及跑道狀況](https://racing.hkjc.com/zh-hk/local/info/windtracker) | 部分 | 2026-10-27 畫面：28/10 沙田夜賽 9 場、全天候、好地、風向風速（多個方位同陣風）、硬度計（當日未出）、氣溫、濕度、雨量、土壤濕度、蒸散量、最後更新時間 | `data/weather/` 有氣溫、濕度、風、雨、土壤時間序列（平台天氣檔約每 5 分鐘，23:50 HKT 同步）。`data/track_conditions` 係草地探針研究檔，每小時 47 分，不寫 D1，未公布留空。風向儀畫面同「好地」句子唔係探針檔 | 硬度計 `--` 要保持空白。全天候場的草地探針唔適用。排位頁「好地」唔可以冒充探針讀數 |
| [賽期表](https://racing.hkjc.com/zh-hk/local/information/fixture?calyear=2026&calmonth=10) | 部分 | 日曆。圖示帶馬場（ST／HV）、草地／全天候／混合、日賽／夜賽／黃昏、場數、G2／G3。參數 `calyear`、`calmonth` | `FixtureCalendar_Scraper.py` → `data/fixtures/fixtures.csv`：日期、星期，再加 `venue`（ST／HV）、`timing`（day／night／twilight）、`race_count`、`surface`（turf／awt／mixed）。黃昏圖示係 `dusk.gif`、alt `T`。例如 2026-10-28 係 ST、night、awt、9 場。`capy_fixture_weekly` 逢星期一 05:00 HKT。格內逐場班次／途程同 G2／G3 未拆成獨立行。`capy_fixture_weekly` 把這份 CSV 全量寫入 D1 `official_fixtures`。`/api/meetings?month=` 同 `/api/meetings/:date` 會列出尚未寫入 `race_meetings` 的賽日，`cardStatus=fixture`，唔當排位表。快取超過 21 日會當每日都係賽日 | 空月份回當月，已對標題，月份對唔上就唔寫日。圖示缺馬場、日夜／黃昏或跑道，該月失敗。頁面有途程數字但拆唔到場數，同樣失敗。未列途程（例如 2027 上半年、2025-09-24）場數留空，有途程的日子唔會因此被跳過 |

## 賽果同報告（P1）

| 頁 | 狀態 | 公開欄位 | 天喜落點同節奏 | 日期風險 |
|---|---|---|---|---|
| [賽果](https://racing.hkjc.com/zh-hk/local/information/localresults?racedate=2026/10/25&Racecourse=ST&RaceNo=1) | 已有 | 賽事日期、馬場、場次、場名、班次、途程、評分區間、地況、賽道、獎金、分段時間、名次、馬號、馬名、騎師、練馬師、實際負磅、排位體重、檔位、頭馬距離、沿途走位、完成時間、獨贏賠率；派彩表 | `RacingData_Scraper.py` → `data/<年>/results_*.csv` 等 → `import-csv.ts` → `race_meetings`／`races`／`race_results`／分段／評述／派彩。賽日 23:30 HKT，後備 01:30／04:30／09:30。D1 00:23，後備 06:23／10:23。寫入前核對「賽事日期」。`rating_range` 入 `races.rating_range`，完場會議 API 的 `ratingRange` 讀這欄。`course` 拆成 `races.track`（草地／全天候）同賽道（A／C+3；全天候場的 `course` 係「全天候」）。頁面有跑道但途程、賽道或評分區間空，當日工作失敗 | 未出賽果會顯示上一場，日期閘仍然丟棄。唔用賽果頁補即將開跑場名。已在 D1 的舊賽日要該日再 sync 先填新欄 |
| [所有場次賽果](https://racing.hkjc.com/zh-hk/local/information/resultsall?RaceDate=2026/10/25) | 部分 | 全日濃縮：名次、馬號、馬名、騎練、實際負磅、檔位、派彩 | 逐場賽果已有。`data/racing-dividends/` 係這頁的 HTML 原文快照，研究用 | 同一日期閘。轉播場要分開 |
| [分段時間及位置](https://racing.hkjc.com/zh-hk/local/information/displaysectionaltime?racedate=25/10/2026&RaceNo=1) | 已有 | 過終點次序、馬號、馬名、沿途走位及頭馬距離、完成時間、每段時間同位置 | `sectional_times_*.csv`、`horse_sectional_times` | 參數係 `DD/MM/YYYY`，同賽果頁的 `YYYY/MM/DD` 不同 |
| [沿途走勢評述](https://racing.hkjc.com/zh-hk/local/information/corunning?Date=20261025&RaceNo=1) | 已有 | 名次、馬號、馬名、騎師、配備、走勢評述 | `commentary_*.csv`、`running_comments` | 參數 `Date=YYYYMMDD` |
| [競賽事件報告](https://racing.hkjc.com/zh-hk/local/information/racereportfull) | 已有（研究） | 名次、馬號、綵衣、馬名、檔位、騎師、競賽事件；另有一般事項／增補 | `scripts/IncidentReport_Scraper.py` → `data/incidents/`。要核對標題日期、馬場、場題、馬匹連結。不入模型、不入凍結 | `capy_incident_reports`：HKT 02:23／08:23／14:23／20:23，加賽果之後。同日報告唔可以當賽前特徵 |
| [終點照片](https://racing.hkjc.com/zh-hk/local/info/finishphoto) | 已有 | 每場終點相。檢視頁本身要有 `path` 或 `raceImage` 先出圖；格子在賽果頁「終點相片」 | `official_finish_photo` 只存官方圖片路徑，唔存圖片位元組。路徑的賽季、日期、場次必須同賽果頁「賽事日期」同請求場次一致。標題對唔上，或者該場冇「終點相片」一格，就當未刊出，唔蓋請求日，亦唔估一張相。近 21 日已完場的本地賽期。`capy_wave6_surfaces`。重播連結仍然在 `video_links_*.csv` | 相片路徑帶賽事日。沿途走位圖係另一段，未收 |
| [騎師王賽果](https://racing.hkjc.com/zh-hk/local/information/jkcresult?racedate=2026/10/25) | 已有（研究） | 實際數目、編號、騎師、賽日積分、冠亞季殿、備註 | `official_pool_result`（`pool=jkc`）。`capy_wave4_boards`：每日 07:47 HKT | `racedate` 必須係已賽日 |
| [練馬師王賽果](https://racing.hkjc.com/zh-hk/local/information/tncresult?racedate=2026/10/25) | 已有（研究） | 同上，練馬師 | `official_pool_result`（`pool=tnc`）。同 `capy_wave4_boards` | 同上 |
| [賽事特別情況索引](https://racing.hkjc.com/zh-hk/local/page/special-race-index) | 已有 | 英文縮寫同註釋（DISQ、DNF、WV-A 等）。呢頁係詞彙表，唔係取消日清單 | `official_special_index`。頁面表必須包住已核對的縮寫集，多出來的縮寫一併收。`not_race_result=1`。`capy_wave6_surfaces`。`data/racing-cancellations/` 仍然只係單次原文快照 | 縮寫唔可以寫成某一日的賽果 |

## 馬匹（P1 主檔，P2 搜尋同介紹）

馬匹主檔標籤（實頁 `horseid=HK_2025_L457`）：往績紀錄、馬匹評分／體重／名次、所跑途程賽績紀錄、晨操紀錄、傷患紀錄、搬遷紀錄。主檔欄：出生地／馬齡、毛色／性別、進口類別、今季獎金、總獎金、冠-亞-季-總出賽、現在位置（到達日期）、進口日期、練馬師、馬主、父系、母系、外祖父。

| 頁 | 狀態 | 公開欄位 | 天喜落點同節奏 | 日期風險 |
|---|---|---|---|---|
| [馬匹資料](https://racing.hkjc.com/zh-hk/local/information/horse?horseid=HK_2025_L457) | 已有 | 上列主檔＋往績 | `HorseData_Scraper.py` → `horses/profiles`、`form_records`；D1 `horses`、`horse_profile_extra`、`horse_form_records`。`capy_pool_a` 每日 04:00 HKT，D1 05:17。非賽日可跳過 | 馬號 `HK_YYYY_Xnnn` 先至係本地馬。往績入面的日期係出賽日 |
| [評分／體重／名次](https://racing.hkjc.com/zh-hk/local/information/ratingresultweight?horseid=HK_2025_L457) | 已有（研究） | 逐場評分、體重、名次曲線，兼收途程、賽道、場地狀況、班次 | `official_rating_weight`。海外賽事體重 `---` 留空、馬場保留原文；初出馬評分空留空。`capy_wave4_boards` | 按馬季 |
| [所跑途程賽績](https://racing.hkjc.com/zh-hk/local/information/performance?horseid=HK_2025_L457) | 已有（研究） | 出賽、冠、亞、季、負，按場地／途程／歷季 | `official_performance`（`section` 分 going／distance／season）。無往績馬冇表屬正常。`capy_wave4_boards` | — |
| [晨操紀錄](https://racing.hkjc.com/zh-hk/local/information/trackworkresult?horseid=HK_2025_L073) | 已有 | 日期、晨操類別、馬場／跑道、操練詳情、配備 | `HorseTrackwork_Scraper.py` → `horses/trackwork`、`horse_trackwork` | 晨操日可以係賽事日前一日 |
| [傷患（單駒）](https://racing.hkjc.com/zh-hk/local/information/ovehorse?horseid=HK_2025_L457) | 已有 | 日期、詳情、通過日期 | `HorseInjury_Scraper.py` → `horses/injury`、`horse_injury` | 未通過的紀錄要保留通過日空白 |
| [搬遷紀錄](https://racing.hkjc.com/zh-hk/local/information/movementrecords?horseid=HK_2025_L457) | 已有（研究） | 由、至、到達日期（含海外） | `official_movement`。`capy_wave4_boards` | 到達日唔等於出賽日 |
| [同父系馬](https://racing.hkjc.com/zh-hk/local/information/samesire?horsesire=Zoustar) | 部分 | 冠、亞、季、出賽、曾勝路程 | 血統欄有父系名。同父系名單冇收 | 退役馬仍在名單 |
| [馬匹搜尋／馬主搜尋](https://racing.hkjc.com/zh-hk/local/information/ownersearch) | 部分 | 馬名、烙號、馬主、父系。結果連去馬匹頁。選單亦有按筆畫、馬房、所在地、馬齡 | 現役 `horse_profiles.csv` 馬主原句 → `data/official_p2/owner_horse.csv`、D1 `official_owner_horse`。回聲必須等於查詢字。頁面列出的退役馬一併入索引；烙號轉世而馬名不同，唔當成現役主檔那一匹。每週一 04:20 HKT `capy_official_p2`。已無現役馬的馬主未逐個爬。筆畫／馬房選單未爬 | 馬主字串要原句，團體名中間有「與」 |
| [馬匹列表](https://racing.hkjc.com/zh-hk/local/information/selecthorse) | 部分 | 現役馬、評分、按練馬師／位置／馬齡 | 活躍馬來自賽果同排位，唔係這張目錄的副本 | 位置分香港、從化、海外 |
| [馬匹評分榜](https://racing.hkjc.com/zh-hk/local/information/latestonhorse?View=Horses/clas/) | 已有 | 英文名、中文名、烙號、評分、變動。變動可以空白、`+2`／`-1`，或者 `*`。頁面係兩欄，讀法係逐行左右交叉 | `official_horse_rating`（`board=clas`）。目錄殼的 iframe 先至係表：`/racing/info/mcs/Chinese/Horses/clas`。唔加欄，唔把 `*` 改成數字。`not_race_result=1`。`capy_wave7_surfaces`。公開 `GET /api/official/horse-ratings?board=clas`。單匹現評在主檔仍然係另一份 | `View` 路徑要整段保留。評分榜係當前名單，唔係某一日的賽果 |
| [馬匹消息](https://racing.hkjc.com/zh-hk/local/information/latestonhorse) | 已有 | 目錄列出的每個 `View=`。公告視圖係標題、發佈時間、官方檔案路徑（xml.zip 或 doc／docx）。評分變動摘要、首五十名、獎金表係頁面上的表。馬匹總評分表係季終正文加兩條 PDF | `official_horse_news` 收公告清單，唔拆開 zip 或 Word。`official_horse_rating` 另收 `csum` 同 `tp50`（首五十名頁而家有 52 匹，評分打和都收，唔截成 50）。`official_horse_stakes` 收獎金表同頁尾 `*`／`#`／`%` 註。`official_horse_news_document` 收季終正文同 PDF 路徑，檔名日期要出現在正文。`not_race_result=1`。`capy_wave7_surfaces`。公開 `GET /api/official/horse-news`。選單若多出未識的 `View=`，工作失敗，唔當已經收齊 | 公告時間係標題入面的鐘，檔名日期可以係另一日。海外賽事標 `S1`–`S4`，唔當沙田或跑馬地 |
| [初出馬介紹](https://racing.hkjc.com/zh-hk/local/page/new-horse) | 已有 | 2026-10-27 畫面：馬名、烙號、資料及評語（截至日期）、出生地、毛色、進口類別、血統表、父系簡介、母系簡介。馬匹頁可以帶 `racedate`、`raceNo`、`brandNo` 指住某一匹 | `official_new_horse_intro`：評語正文、截至日、出生地、毛色、進口類別。`not_race_result=1`。血統計數留在父系母系簡介，唔寫入正文。近 14 日有介紹的會議。`capy_official_p2` 每日 07:17 HKT。父系母系數字仍由 `HorsePedigree_Scraper.py` 收 | 評語的「截至」日期早過出賽日。唔好把評語寫成賽果 |
| [試閘](https://racing.hkjc.com/zh-hk/local/information/btresult) | 已有 | 日期、馬場、途程、地況、組別時間；馬名、騎師、練馬師、排位、配備、頭馬距離、沿途走位、完成時間、結果、評述 | `TrialResults_Scraper.py` → `trials/` → `trial_sessions`、`trial_runners`。每日 02:00 HKT 抓、05:17 入 D1 | 馬會只留約 176 個試閘日 |
| [晨操搜尋](https://racing.hkjc.com/zh-hk/local/information/trackworksearch) | 部分 | 搜尋入口，結果去單駒晨操 | 單駒晨操已有 | — |
| [傷患資料庫](https://racing.hkjc.com/zh-hk/local/information/ovedatabase) | 已有 | 過去 12 個月：烙號、馬名、日期、詳情、通過日期 | `official_ove_database`。標題「截至」日期同星期先寫。續行跟上一匹。馬名空白留空，烙號先係身份。通過日 `-` 留空。`capy_wave5_visible`：每日 07:55 同 16:55 HKT。逐匹 `horse_injury` 唔改 | 截至日係頁面標題，唔係請求日 |
| [患喘鳴症馬匹](https://racing.hkjc.com/zh-hk/local/information/overoar) | 已有（研究） | 烙號、馬名、診斷日期、曾接受手術 | `official_overoar`。官方名單馬名可以空白，烙號先係身份。`capy_wave4_boards` | 截至日在標題 |
| [馬匹來港前名稱](https://racing.hkjc.com/zh-hk/local/info/horse-former-name) | 已有 | 全馬目錄：馬名、烙號、來港前名稱、父系、母系、進口類別、出生地、馬齡、出生日期。來港前名稱可以空白，頁面顯示 `----` | `official_horse_former_name`。只用該頁的 `rw_HorseFormerName`，唔加欄。烙號必須同馬匹 id 一致。空白中文馬名留空。`not_race_result=1`。`capy_wave6_surfaces`。自購馬來港前賽績的舊名仍然係 `official_ppo_performance`，唔係這張全馬目錄 | 出生日期係馬匹出生，唔係出賽日 |
| [自購馬來港前賽績](https://racing.hkjc.com/zh-hk/local/page/ppo-performance) | 已有 | 馬季、烙號、馬名、舊名、來港前賽績原文。馬名可以空白 | `official_ppo_performance`。舊名同備忘原文保留，唔拆成香港賽事。`not_race_result=1`。`capy_wave5_visible` | 來港前賽績唔係香港賽事日 |
| [從化搬遷一覽](https://racing.hkjc.com/zh-hk/local/page/conghua-movement-records) | 已有 | 場次、馬號、中英文馬名、抵達從化、回港。後備另標。頁面檔係 PDF | `official_conghua_movement`。中英標題日期要同顯示窗入面唯一的本地賽期日一致，馬場跟賽期表。冇烙號，唔估馬匹編號。單駒 `official_movement` 唔改。`capy_wave5_visible` | 回港日要早過或等於該賽事日 |
| [獎金計劃出賽馬](https://racing.hkjc.com/zh-hk/local/page/fwb-declared-starters) | 已有 | 賽日、場次、馬號（後備寫 STBY）、中英文馬名、烙號、獎金中英文。頁面 payload 係這段文字，唔係第一個 HTML 表 | `official_fwb_declared`。首行日期必須係賽期表裡面唯一的本地賽日，場次唔可以超出該日場數。`not_race_result=1`。`capy_wave6_surfaces` | 名單日期係該賽日，唔係抓取日 |
| [進口資格、進口前體格檢驗](https://racing.hkjc.com/zh-hk/local/page/pps-import-critieria) | 已有 | 政策正文、標題圖、頁內國家表同年齡／出賽次數表、自購新馬分頁，同選單上的進口前體格檢驗 PDF | `official_import_policy`。`pps` 係曾出賽馬匹，`ppgs` 係自購新馬。段落、表內每一格、標題圖路徑、PDF 路徑照頁面收。格子入面的 `*` 留在原文，唔另造「可直接進口」欄。`not_race_result=1`。`capy_wave7_surfaces`。公開 `GET /api/official/import-policy` | 參考，唔係賽事日資料 |

## 騎師同練馬師（P1 往績，P2 榜）

2026-10-27 榜的畫面：騎師／練馬師、冠、亞、季、殿、第五、出馬總數、所贏獎金。今季截至賽事日 25/10/2026，另有上季、按百分比、場地篩選（所有場地、沙田草地、沙田全天候、跑馬地草地、從化草地、從化全天候）。參數 `season=Current`、`view=Numbers`（另有百分比）、`racecourse=ALL`。

| 頁 | 狀態 | 公開欄位 | 天喜落點同節奏 | 日期風險 |
|---|---|---|---|---|
| [騎師資料](https://racing.hkjc.com/zh-hk/local/information/jockeyprofile?jockeyid=HEL&Season=Current) | 部分 | 國籍、冠亞季殿、總出賽、所贏獎金、過去 10 個賽馬日勝出、勝出率、今季途程分佈 | `jockeys/jockey_profiles.csv` 有今季獎金、出賽、勝出率。來源係排名頁加往績，唔係逐個 profile 殼。`capy_pool_b_daily` 每日 02:00 HKT | `Season` 大小寫頁面都出現過 |
| [騎師往績](https://racing.hkjc.com/zh-hk/local/information/jockeypastrec?jockeyid=HEL&season=Current) | 已有 | 場次、名次、跑道／賽道、途程、班次、場地、馬名、檔位、評分、練馬師、配備、體重、實際負磅 | `jockeys/records/` | 分頁 `PageNum`。季切換會換一整季 |
| [騎師勝出場地途程](https://racing.hkjc.com/zh-hk/local/information/jockeywinstat?jockeyid=HEL&season=Current) | 部分 | 途程 × 跑馬地／沙田的冠亞季 | 可從往績加總，而家唔係官方表副本 | — |
| [練馬師資料](https://racing.hkjc.com/zh-hk/local/information/trainerprofile?trainerid=HDA&season=Current) | 部分 | 所贏獎金、冠亞季殿、出馬總數、過去 10 個賽馬日、勝出率 | `trainers/trainer_profiles.csv` 主要係代碼同姓名。季績頁未整頁收 | 同騎師 |
| [練馬師往績](https://racing.hkjc.com/zh-hk/local/information/trainerpastrec?trainerid=HDA&season=Current) | 已有 | 場次、馬匹、名次、跑道／賽道、途程、場地、檔位、評分、賠率、騎師、配備、體重、實際負磅、首三名 | `trainers/records/`。`capy_trainer_fix` 每日 01:00 HKT，近兩日有賽先跑 | — |
| [練馬師勝出場地途程](https://racing.hkjc.com/zh-hk/local/information/trainerwinstat?trainerid=NPC) | 部分 | 途程 × 馬場 | 可從往績加總 | — |
| [騎師榜](https://racing.hkjc.com/zh-hk/local/info/jockey-ranking?season=Current&view=Numbers&racecourse=ALL) | 已有 | 上列榜欄，另有場地同百分比 | `official_ranking_board`、`official_ranking_slice`。今季截至上一賽馬日，上季截至季終。冠亞季殿第五、出賽、獎金，以及 ALL／STT／STA／HVT／CHT／CHA。空場地唔造行。百分比跟頁面四捨五入，不另存一份。`capy_official_p2` 每日 07:17 HKT，近兩日有賽先跑。profile CSV 季總數仍然係另一份 | 截至賽事日係上一賽馬日 |
| [練馬師榜](https://racing.hkjc.com/zh-hk/local/info/trainer-ranking?season=Current&view=Numbers&racecourse=ALL) | 已有 | 同上 | 同騎師榜，寫入同一對表，`role=trainer`。空的 `ssnStat` 跟頁面丟掉，唔補零 | 同上 |
| [本地騎師讓磅](https://racing.hkjc.com/zh-hk/local/information/jockeyallowance) | 已有 | 騎師、頭馬次數、現時讓磅。標題有截至賽事日 | `official_jockey_allowance`。`--` 留空，唔當 0 磅。同 `capy_official_p2`。排位表分齡讓磅仍然係另一欄 | 讓磅會隨頭馬次數變 |
| [騎練配對及初出馬成績](https://racing.hkjc.com/zh-hk/local/page/jtcombo-debutants-statistics) | 已有 | 每場馬號的勝出率同上名率；初出馬另有馬名、進口類別、練馬師。頁面檔係工作簿 | `official_jt_combo`。顯示窗要包住唯一的本地賽期日，場數要同賽期表一樣。比率跟工作簿，唔再計一次。`not_race_result=1`。`capy_wave5_visible` | 工作簿的「最後更新」早過或等於該賽事日 |

## 統計（P2）

| 頁 | 狀態 | 公開欄位 | 天喜落點同節奏 | 日期風險 |
|---|---|---|---|---|
| [檔位統計](https://racing.hkjc.com/zh-hk/local/information/draw) | 已有 | 當日每場：途程、跑道、檔位、出賽次數、冠亞季殿、勝出率、入Q率、上名率、前 4 名率 | `official_draw_stat`、`official_draw_favourite`，`not_race_result=1`，窗口註腳原句。排位表未出記 pending，唔當空榜。逐匹檔位仍在 `entries_upcoming.draw`、`race_results.draw`。`capy_official_p2` | 統計窗口係馬會定的歷史，唔係該場即將發生的事 |
| [檔位進階搜尋](https://racing.hkjc.com/zh-hk/local/information/drawadvsearch) | 已有（研究） | 馬季、馬場－跑道（含從化）、賽道、途程、場地狀況 | `official_draw_adv_stat`（`going=ALL`）。草地場必須逐個 named 賽道收；未開跑組合回空表屬正常（表格頁仍在）。`capy_wave4_boards`：每日今季、星期一補舊季 | 參數 `Year`、`Racecourse`、`Course`、`Distance`、`Going` |
| [練馬師王統計](https://racing.hkjc.com/zh-hk/local/information/tncstat) | 已有 | 編號、練馬師、近十個賽事日積分、平均、季度 | `official_pool_stat`，`pool=tnc`。`-` 留 NULL。截至最近一欄賽事日。`capy_official_p2` | 欄頭日期係過去賽馬日 |
| [騎師王統計](https://racing.hkjc.com/zh-hk/local/information/jkcstat) | 已有 | 同上，騎師 | 同表，`pool=jkc` | 同上 |
| [騎師大熱](https://racing.hkjc.com/zh-hk/local/information/jockeyfavourite) | 已有 | 出賽、頭馬、位置、大熱次數同百分比、大熱勝出、大熱入位。截至賽事日 | `official_favourite_stat`、`official_favourite_summary`。頁尾「其他」冇數字，唔造人。同 `capy_official_p2` | — |
| [練馬師大熱](https://racing.hkjc.com/zh-hk/local/information/trainerfavourite) | 已有 | 同上 | 同表，`role=trainer` | — |
| [騎師王賠率走勢](https://racing.hkjc.com/zh-hk/local/page/jkc-odds-chart) | 已有 | 每場開盤同逐場最後賠率、得主、積分。`-` 係未公布 | `official_challenge_odds`（`pool=jkc`）。用該頁的 `getOddsChart`，`requestType=jkc`，唔加欄。開盤係 `race_no=0`。同一日兩位得主各記一行。`not_race_result=1`，唔寫 `odds_snapshots`。`capy_wave5_visible` | 圖上的賽事日早過或等於更新時間 |
| [練馬師王賠率走勢](https://racing.hkjc.com/zh-hk/local/page/tnc-odds-chart) | 已有 | 同上，練馬師 | 同表，`pool=tnc` | 同上 |

## 參考、政策、工具

這些頁公開，但唔係賽事日數據表。未收。研究向，唔阻塞場次頭。

| 頁 | 內容 |
|---|---|
| [跑道資料](https://racing.hkjc.com/zh-hk/local/page/racing-course)、[賽道選用](https://racing.hkjc.com/zh-hk/local/page/racing-course-select)、[標準及紀錄時間](https://racing.hkjc.com/zh-hk/local/page/racing-course-time) | 跑道說明同紀錄時間。內容殼 |
| [賽事規例及指示](https://racing.hkjc.com/zh-hk/local/page/racing-rules-instr)、[報名及排位程序](https://racing.hkjc.com/zh-hk/local/page/learn-racing/learn-procedures)、[評磅及評分政策](https://racing.hkjc.com/zh-hk/local/page/handicap-policy) | 政策正文 |
| [認可配備](https://racing.hkjc.com/zh-hk/local/page/reg-approved-gear) | 裝備登記冊。排位表的配備代碼係另一層，已經有收 |
| [常見傷患詞彙](https://racing.hkjc.com/zh-hk/local/page/ove-intro) | 詞彙，唔係個案 |
| [過關計算機](https://racing.hkjc.com/zh-hk/local/information/allupcalculator)、[三T神算機](https://racing.hkjc.com/zh-hk/local/information/ttautopick) | 計價工具。輸入場次、彩池、注額 |
| [世界彩池](https://racing.hkjc.com/zh-hk/local/page/worldpool) | 內容殼 |
| 貼士指數 | `https://racing.hkjc.com/racing/Chinese/tipsindex/tips_index.asp`，選單連出，今次未拆欄 |

## 邊界

選單有、今次 100% 定義未計入的鄰近面：

- 越洋轉播同越洋賽期：`/zh-hk/overseas/`。本地賽果頁可以帶 `Racecourse=S2`。轉播賽果唔可以寫入本地沙田／跑馬地。
- 國際評分、香港馬匹季終排名：`/zh-hk/international-racing/`。
- 即時投注全彩池：`bet.hkjc.com`。我哋只收本地 WIN／PLA 顯示賠率。
- 會員販馬代理：`member.hkjc.com`。
- 賽馬知多些、節目、試閘片段、退役馬：`/zh-hk/learn-racing/`、`/zh-hk/showcase/`、`/zh-hk/restart/`。

## 對外展示必備，同研究先至要的

**展示必備（賽事卡同賽果讀得明）：** 賽事日期、馬場、場次、場名、開跑時間、班次、途程、草地／全天候、賽道、地況、獎金、評分區間；馬號、馬名、檔位、騎師、練馬師、負磅、評分、配備；完場之後的名次、時間、派彩。更易要反映在這張卡上。免費版可以仍然只出一場，這一場仍然要用官方場名同開跑時間。

**研究，未展示都唔會令場次頭空白：** 檔位統計、騎師王／練馬師王、大熱統計、榜的場地篩選、初出馬評語、馬主搜尋、同父系名單、賠率走勢圖、速勢能量、探針讀數、競賽事件報告、從化搬遷、來港前名稱、政策同計算機。

Elo、鎖倉預測、模型重要度係我哋自己的層，唔計入官方 100%。

## 仍未覆蓋的主要缺口

按對公眾畫面的影響排。

1. **即將開跑的場次頭。** 場名、獎金、評分區間、途程、草地／全天候、地況已由排位 HTML 入庫，完場 `ratingRange` 不再寫死空。未排位的賽期日同報名表要靠 `official_fixtures`／`official_race_entries`，Worker 部署之後月份 API 先顯示到。評分+/-、排位體重+/-、最佳時間、上賽距今日數、可能超磅、分齡讓磅已入 `entries_upcoming`，公開卡讀這些欄。可能超磅、分齡讓磅空白或「-」留空，0 就寫 0。出賽馬匹 PDF、跑道圖路徑，同埋馬齡、性別、馬主、父系、母系、進口類別、今季獎金，已入 `official_racecard_file`／`official_racecard_runner`。公開卡仍然讀馬匹主檔的馬齡、性別、馬主、進口類別、今季獎金。
2. **場次頭解析失敗仍然綠燈。** 頁面有米數同跑道，欄位空，排程當成功。
3. **地況按會議一格，而且今次連這一格都空。** 混合場會再錯。
4. **更易事項的剩餘面。** 本地榜已拆欄並在身份相符時寫回排位。海外轉播段不收。對唔上馬名的句子不覆蓋。鎖點之後的退出不改 `priority_order`。
5. **賽果新欄要逐日 sync 先補舊行。** 新導入會寫 `rating_range` 同 `races.track`。早過今次的 D1 行要該日再跑 `capy_d1_sync` 先填到。
6. **賽期表格內逐場線。** 馬場、日賽／夜賽／黃昏、場數、草地／全天候／混合已入 `fixtures.csv`。未列途程的賽日場數留空。每一格裡面的班次、途程、G2／G3 仍未拆成獨立行。
7. **馬匹主檔以外的公開表。** 評分體重曲線、途程成績、單駒搬遷、喘鳴症名單已入 Wave4。傷患資料庫、自購馬來港前賽績、從化搬遷一覽已入 `capy_wave5_visible`。來港前名稱全馬目錄、獎金計劃出賽馬已入 `capy_wave6_surfaces`。馬匹評分榜、馬匹消息（公告路徑、評分變動、首五十名、獎金表、季終正文）已入 `capy_wave7_surfaces`。同父系名單、已無現役馬的馬主仍然未收。
8. **榜同統計成表。** 練馬師榜、騎師榜的場地／百分比視圖、檔位統計、騎師王、練馬師王、大熱、讓磅。
9. **賽日配套頁。** 上次事件摘要、對壘、特別因素、當日晨操、當日傷患、騎師／練馬師分場，同一般資訊的場地句、彩池場次、停賽騎師，已入 `official_*`（`capy_raceday_companions`）。多寶、派彩、探針已入 `official_pool_*`／`official_track_probe`。騎練配對及初出馬已入 `official_jt_combo`。終點相路徑已入 `official_finish_photo`。賽事特別情況索引係縮寫表，已入 `official_special_index`。賽日數據的兩張 JPEG 路徑已入 `official_stats_centre_image`。馬匹消息已入 `official_horse_news`。
10. **即時賠率只得獨贏同位置。** 分場表的獨贏格係研究副本 `official_ride_assignment.win_odds_text`。一般資訊記錄邊個彩池包邊幾場。完場派彩已入 `official_pool_dividend`。騎師王／練馬師王走勢已入 `official_challenge_odds`，唔係獨贏快照。

## 分階段（今次不實作）

### P0 — 賽日場次頭完整

沿用已經抓的排位頁，唔好改 GraphQL 白名單。

1. 草地句同 `全天候跑道, 1650米, 好地` 都要解析。場名、獎金、評分區間、途程、跑道、地況寫入可查欄位。完場 API 的 `ratingRange` 讀已入庫的 `races.rating_range`（2026-11-10）。即將開跑場次頭沿用排位 HTML，唔再寫死空。
2. 日期、馬場、場次對唔上就整段丟。10 月 28 日沙田做回歸樣本。
3. 頁面有途程同跑道、欄位仍然空，排位工作要失敗，唔好綠著開跑。
4. 地況按場儲存。探針未公布繼續留空，唔好用排位頁地況冒充探針。
5. 公開卡至少顯示場名、途程、跑道、地況、班次、開跑時間。
6. 更易拆欄之後先寫回該場排位；對唔上的原文留在快照，唔好覆蓋。本地 HTML 榜已按此寫入 `racing_changes`；未識條款會令工作失敗。
7. 未完場唔好用賽果頁補場名。

### P1 — 賽果同人物頁完整

1. 「賽事日期」已核對之後，`rating_range` 入 D1；`course` 拆開跑道同賽道。導入路徑已做這兩欄；人物頁其餘標籤仍未做。
2. 馬匹頁餘下標籤：評分／體重／名次、途程成績、搬遷。主檔已有的欄位唔好重抓一套。
3. 騎師、練馬師資料頁的季績，同往績檔對得上先收，避免榜同往績各寫各的。
4. 賽日配套：上次事件摘要、對壘、特別因素、當日晨操一覽、當日傷患一覽、分場表已帶場次入庫。一般資訊只收場地句、彩池場次同停賽，未收派彩。人物頁其餘季績仍未做。

### P2 — 榜、統計、初出馬、馬主

1. 檔位統計、騎師王、練馬師王、大熱、讓磅、官方榜（含場地篩選）。
2. 初出馬介紹正文同截至日期。血統數字已有的唔好當評語。
3. 馬主搜尋做成索引，字串同馬匹頁「馬主」一致。
4. 賽期表的馬場、日賽／夜賽／黃昏、場數、跑道已入 `fixtures.csv`。格內逐場班次線同榜、統計仍未做。
5. 彩池同走勢圖留在研究，不進凍結。

## 點樣更新這份清單

馬會選單會改。下次盤點：打開本地賽果頁選單，跟 `/zh-hk/local/information|info|page` 的新連結；`/info/*` 要用瀏覽器或該頁自己的查詢先至見到表。新頁先寫入矩陣再談收料。狀態只可以係已有、部分、冇。
