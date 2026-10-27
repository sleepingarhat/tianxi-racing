# 香港賽馬會本地賽馬網站地圖（活清單）

盤點日：2026-10-27。只讀。沒有改收料、沒有改 D1、沒有動 production secret。

上一份審計專門對 10 月 28 日沙田場次頭：[`docs/hkjc-coverage-audit.md`](./hkjc-coverage-audit.md)，而家在 [PR #113](https://github.com/sleepingarhat/tianxi-racing/pull/113)（分支 `cursor/hkjc-coverage-audit-10dc`），尚未合併。合併之後兩份文件同目錄。今份把範圍拉闊到成個本地公開網站，唔再只係該次場次頭。

自有預測同 Elo 係官方頁上面的一層。官方頁未寫入的場名、獎金、途程，唔好用預測文案填。

## 100% 係邊度

**100% 官方數據 = `racing.hkjc.com` 上、繁體中文 `zh-hk` 的本地 `information`、`info`、`page` 每一個公開展示的數據面。** 包括賽日流程、馬匹／騎師／練馬師／馬主、賽期、試閘、報告、榜、統計、參考頁。唔等於「排位表頭加幾條樣本 URL」。

今次沿本地賽果頁的選單，再跟一層同範圍連結，實讀約 90 個路徑（2026-10-27）。經典 `RaceCard.aspx`、`LocalResults.aspx` 會跳去下面的 `zh-hk` 路徑，內容同一頁。

越洋轉播、國際評分、`bet.hkjc.com` 即時賠率、會員販馬代理、賽馬知多些、退役馬，係選單連出去的鄰近網站，唔計入這三個前綴。見文末「邊界」。

## 給老闆的一句

**而家未到 100%。** 賽果、排位馬匹、檔位、騎練、單匹評分、班次、開跑時間、試閘、馬匹主檔、晨操、傷患、派彩、分段、沿途評述有官方來源。10 月 28 日沙田公開頁已經寫住「畫眉山讓賽、18:45、全天候 1650 米、好地、獎金、評分 40-0」，我哋即將開跑的場次頭仍然空，所以網站可以見到「第 N 場」。細節同生產 API 對照在 PR #113。

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
| [排位表](https://racing.hkjc.com/zh-hk/local/information/racecard?racedate=2026/10/28&Racecourse=ST&RaceNo=1) 同經典 `RaceCard.aspx` | 部分 | 場名、日期、星期、馬場、開跑時間、草地／全天候、途程、賽道、地況、獎金、評分區間、班次。馬匹欄：馬號、6次近績、綵衣、馬名、烙號、負磅、騎師、可能超磅、檔位、練馬師、國際評分、評分、評分+/-、排位體重、體重+/-、最佳時間、馬齡、分齡讓磅、性別、今季獎金、優先參賽次序、上賽距今日數、配備、馬主、父系、母系、進口類別。另有出賽馬匹 PDF、跑道圖 | 馬匹層：GraphQL → `entries_upcoming`（馬號、檔位、騎練、負磅、評分、配備、班次、開跑時間、後備）。`capy_racecard`：一／三／五／六 09:00 HKT，每日 06:15 HKT。研究快照 `entries/racecard_snapshots/` 每 3 小時，內容不變就跳過。場名、獎金、評分區間讀完即丟。全天候途程／跑道／地況解析失敗。API 組即將開跑場時場名同獎金寫死空 | P0。身份閘仍要保持。頁面有「米」同「全天候／草地」但欄位空，而家工作仍綠 |
| [報名表](https://racing.hkjc.com/zh-hk/local/information/entries) | 部分 | 練馬師 × 班次 × 評分幅度 × 途程 × 草地／全天候，格內係已報馬名 | `EntryList_Scraper.py` 只留馬號清單 `entries/entries_*.txt`。`capy_entries`：一、二、六 20:00 HKT | 排位未出之前這張表先出現。馬號清單冇場次頭 |
| [晨操資料（當日排位）](https://racing.hkjc.com/zh-hk/local/information/localtrackwork) | 部分 | 同上場次頭。每駒：試閘、快操、踱步、游泳、跑步機、水中步行機、休歇 | 逐匹晨操在 `horses/trackwork`、`horse_trackwork`（Pool A）。這張「全場一覽」冇收 | 場次頭同排位表同一段，全天候一樣會空 |
| [各駒上次競賽事件摘要](https://racing.hkjc.com/zh-hk/local/information/racereportext) | 冇 | 馬號、烙號、馬名、日期、場次、描述（上次報告原句） | 賽後全文報告係另一頁，見下。這張賽前摘要冇收 | 描述入面的日期係上次出賽，唔係今場 |
| [同場對壘](https://racing.hkjc.com/zh-hk/local/information/formline) | 冇 | 上次同場：馬名、負磅、評分、檔位、騎師、上賽騎師、名次、完成時間、距離、賠率、相對負磅／評分差異 | 無 | 每格對上一場日期 |
| [特別因素](https://racing.hkjc.com/zh-hk/local/information/exceptionalfactors) | 部分 | 蝕磅、分齡讓磅、配備、綁繫舌帶、上賽／今賽口銜、評分、途程、上賽距今日數、轉投練馬師、從化回港日期 | 配備、負磅、評分在排位表。這張對照表冇收 | 從化回港日期要跟該駒，唔好跟賽事日 |
| [排位傷患](https://racing.hkjc.com/zh-hk/local/information/veterinaryrecord) | 部分 | 當日出賽馬：日期、詳情、通過日期 | 逐匹 `horses/injury`、`horse_injury`（`ovehorse`）。當日一覽冇收 | 傷患日可以早過賽事日 |
| [練馬師分場表](https://racing.hkjc.com/zh-hk/local/info/trainers-entries) | 部分 | 同騎師分場：練馬師、今季成績、每場馬名。GraphQL `commonMeetings`，參數 `racedate` | 當日練馬師名在 `entries_upcoming`。分場表本身冇收 | 日期對唔上就係另一場的馬 |
| [練馬師王出馬表](https://racing.hkjc.com/zh-hk/local/info/tnc-entries) | 冇 | 練馬師王組合、賠率、馬匹 | 無 | 同騎師王一樣，只包指定場次 |
| [騎師分場表](https://racing.hkjc.com/zh-hk/local/info/jockeys-rides) | 部分 | 2026-10-27 畫面：騎師、今季冠亞季總出賽、第 1–9 場（班次、途程、全天候／草地）、格內賠率＋馬名。註明更換騎師 | 當日騎師名在 `entries_upcoming.jockey_name`。頁面本身冇爬。賠率見下面 WIN/PLA | 場次格的途程係場次頭的另一個副本。空標題時這頁仍然有 1650 米全天候 |
| [騎師王坐騎表](https://racing.hkjc.com/zh-hk/local/info/jkc-scheduled-rides) | 冇 | 騎師王組合、坐騎、賠率、積分 | 無 | 錦標賽日只計指定場，註腳寫明 |
| [更易事項](https://racing.hkjc.com/zh-hk/local/info/changes) | 部分 | 場次、更易事項（換騎、負磅、退出等）。2026-10-27 28 日沙田各場仍係「--」。選單去 `/info/changes`。舊路徑 [`/information/changes`](https://racing.hkjc.com/zh-hk/local/information/changes) 仍係 HTML，當日內容同新頁一樣係場次加更易事項 | `data/racing-changes/` 只追加 HTML 同 SHA，來源 URL 寫舊路徑。未拆成欄，亦未寫回排位。雲端同步見藍圖，呢度唔當已進 `entries_upcoming` | 更易發生在開跑前。快照係原文，唔係已經改好的排位 |
| [賽馬日一般資訊](https://racing.hkjc.com/zh-hk/local/info/summary) | 冇 | 場地句子（例：沙田全天候、好地、第 1–9 場）、競賽董事、彩池同場次（獨贏、位置、連贏、位置Q、二重彩、三重彩、單T、四連環、四重彩、三寶、孖T、三T、六環彩、各過關、騎師王、練馬師王、孖寶）、多寶預計派彩、停賽騎師同停賽日期 | 彩池派彩要等賽果。停賽騎師同賽前場地句冇收。即時獨贏／位置見下 | 場地句係會議級。停賽日期係處罰生效日 |
| [即時賠率](https://bet.hkjc.com/ch/racing/wp/) | 部分 | 投注網。本地選單連出。獨贏、位置以及其他彩池 | 本地賽日 **WIN／PLA** 顯示賠率 → `odds_snapshots`。GraphQL `oddsTypes: ['WIN','PLA']`。`capy_odds` 每 10 分鐘；另有約 5 分鐘 Worker 收同一對彩池。未開跑賽事 20 分鐘未更新先算舊。其他彩池、賠率走勢圖冇收 | 賠率更新唔改凍結同模型 |
| [賽日頭條](https://racing.hkjc.com/zh-hk/local/page/raceday-focus) | 冇 | 賽日文章。正文在內容殼，今次未拆欄 | 無 | 文章日期可以早過賽事日 |
| [速勢能量](https://racing.hkjc.com/zh-hk/local/info/speedpro/speedguide?raceno=1) 同 [formguide](https://racing.hkjc.com/zh-hk/local/info/speedpro/formguide) | 部分 | 速勢圖：能量、所需能量、狀態、檔位、最近五仗、場地。走勢指南：騎練、負磅、檔位、賠率、分段、體重、日數。頁面註明賽前一天中午，而且係供應商參考 | `speedpro/scrape_speedpro.py` → `speedpro/data/<日期>_<馬場>.json`（去掉底圖）。09:00、11:00 HKT。只得當前賽馬日。不入模型 | 過期日補不回。場地狀況註明要對排位表 |
| [賽日數據](https://racing.hkjc.com/zh-hk/local/page/stats-centre) | 冇 | 互動統計。殼頁，今次未拆欄 | 無 | — |
| [上仗備忘](https://racing.hkjc.com/zh-hk/local/page/last-run-reminder) | 冇 | 內容殼 | 無 | — |
| [天氣及跑道狀況](https://racing.hkjc.com/zh-hk/local/info/windtracker) | 部分 | 2026-10-27 畫面：28/10 沙田夜賽 9 場、全天候、好地、風向風速（多個方位同陣風）、硬度計（當日未出）、氣溫、濕度、雨量、土壤濕度、蒸散量、最後更新時間 | `data/weather/` 有氣溫、濕度、風、雨、土壤時間序列（平台天氣檔約每 5 分鐘，23:50 HKT 同步）。`data/track_conditions` 係草地探針研究檔，每小時 47 分，不寫 D1，未公布留空。風向儀畫面同「好地」句子唔係探針檔 | 硬度計 `--` 要保持空白。全天候場的草地探針唔適用。排位頁「好地」唔可以冒充探針讀數 |
| [賽期表](https://racing.hkjc.com/zh-hk/local/information/fixture?calyear=2026&calmonth=10) | 部分 | 日曆。圖示帶馬場（ST／HV）、草地／全天候／混合、日賽／夜賽、場數、G2／G3。參數 `calyear`、`calmonth` | `FixtureCalendar_Scraper.py` → `data/fixtures/fixtures.csv`，只有日期、星期、抓取時間。冇馬場、場數、日夜、跑道。`capy_fixture_weekly` 逢星期一 05:00 HKT。快取超過 21 日會當每日都係賽日 | 空月份回當月，已對標題。圖示未收，所以日曆檔唔知 28 日係沙田夜賽全天候 |

## 賽果同報告（P1）

| 頁 | 狀態 | 公開欄位 | 天喜落點同節奏 | 日期風險 |
|---|---|---|---|---|
| [賽果](https://racing.hkjc.com/zh-hk/local/information/localresults?racedate=2026/10/25&Racecourse=ST&RaceNo=1) | 已有 | 賽事日期、馬場、場次、場名、班次、途程、評分區間、地況、賽道、獎金、分段時間、名次、馬號、馬名、騎師、練馬師、實際負磅、排位體重、檔位、頭馬距離、沿途走位、完成時間、獨贏賠率；派彩表 | `RacingData_Scraper.py` → `data/<年>/results_*.csv` 等 → `import-csv.ts` → `race_meetings`／`races`／`race_results`／分段／評述／派彩。賽日 23:30 HKT，後備 01:30／04:30／09:30。D1 00:23，後備 06:23／10:23。寫入前核對「賽事日期」 | 未出賽果會顯示上一場。`races.track` 仍空，整句跑道在 `course`。`rating_range` 留在 CSV，未進 D1 |
| [所有場次賽果](https://racing.hkjc.com/zh-hk/local/information/resultsall?RaceDate=2026/10/25) | 部分 | 全日濃縮：名次、馬號、馬名、騎練、實際負磅、檔位、派彩 | 逐場賽果已有。`data/racing-dividends/` 係這頁的 HTML 原文快照，研究用 | 同一日期閘。轉播場要分開 |
| [分段時間及位置](https://racing.hkjc.com/zh-hk/local/information/displaysectionaltime?racedate=25/10/2026&RaceNo=1) | 已有 | 過終點次序、馬號、馬名、沿途走位及頭馬距離、完成時間、每段時間同位置 | `sectional_times_*.csv`、`horse_sectional_times` | 參數係 `DD/MM/YYYY`，同賽果頁的 `YYYY/MM/DD` 不同 |
| [沿途走勢評述](https://racing.hkjc.com/zh-hk/local/information/corunning?Date=20261025&RaceNo=1) | 已有 | 名次、馬號、馬名、騎師、配備、走勢評述 | `commentary_*.csv`、`running_comments` | 參數 `Date=YYYYMMDD` |
| [競賽事件報告](https://racing.hkjc.com/zh-hk/local/information/racereportfull) | 已有（研究） | 名次、馬號、綵衣、馬名、檔位、騎師、競賽事件；另有一般事項／增補 | `scripts/IncidentReport_Scraper.py` → `data/incidents/`。要核對標題日期、馬場、場題、馬匹連結。不入模型、不入凍結 | `capy_incident_reports`：HKT 02:23／08:23／14:23／20:23，加賽果之後。同日報告唔可以當賽前特徵 |
| [終點照片](https://racing.hkjc.com/zh-hk/local/info/finishphoto) | 冇 | 每場終點相 | 無。重播連結在 `video_links_*.csv`（全景、餘勢、鳥瞰） | 相片路徑帶賽事日 |
| [騎師王賽果](https://racing.hkjc.com/zh-hk/local/information/jkcresult?racedate=2026/10/25) | 冇 | 實際數目、編號、騎師、賽日積分、冠亞季殿、備註 | 無 | `racedate` 必須係已賽日 |
| [練馬師王賽果](https://racing.hkjc.com/zh-hk/local/information/tncresult?racedate=2026/10/25) | 冇 | 同上，練馬師 | 無 | 同上 |
| [賽事特別情況索引](https://racing.hkjc.com/zh-hk/local/page/special-race-index) | 冇 | 內容殼（取消、改期一類索引） | `data/racing-cancellations/` 有單次原文快照；`data/meeting-status/` 有停賽註記。未對這頁做完整索引 | 取消日唔可以寫成有賽果 |

## 馬匹（P1 主檔，P2 搜尋同介紹）

馬匹主檔標籤（實頁 `horseid=HK_2025_L457`）：往績紀錄、馬匹評分／體重／名次、所跑途程賽績紀錄、晨操紀錄、傷患紀錄、搬遷紀錄。主檔欄：出生地／馬齡、毛色／性別、進口類別、今季獎金、總獎金、冠-亞-季-總出賽、現在位置（到達日期）、進口日期、練馬師、馬主、父系、母系、外祖父。

| 頁 | 狀態 | 公開欄位 | 天喜落點同節奏 | 日期風險 |
|---|---|---|---|---|
| [馬匹資料](https://racing.hkjc.com/zh-hk/local/information/horse?horseid=HK_2025_L457) | 已有 | 上列主檔＋往績 | `HorseData_Scraper.py` → `horses/profiles`、`form_records`；D1 `horses`、`horse_profile_extra`、`horse_form_records`。`capy_pool_a` 每日 04:00 HKT，D1 05:17。非賽日可跳過 | 馬號 `HK_YYYY_Xnnn` 先至係本地馬。往績入面的日期係出賽日 |
| [評分／體重／名次](https://racing.hkjc.com/zh-hk/local/information/ratingresultweight?horseid=HK_2025_L457) | 冇 | 逐場評分、體重、名次曲線 | 往績有當場評分同體重，冇這張對照表 | 按馬季 |
| [所跑途程賽績](https://racing.hkjc.com/zh-hk/local/information/performance?horseid=HK_2025_L457) | 冇 | 出賽、冠、亞、季、負，按途程 | 無成表 | — |
| [晨操紀錄](https://racing.hkjc.com/zh-hk/local/information/trackworkresult?horseid=HK_2025_L073) | 已有 | 日期、晨操類別、馬場／跑道、操練詳情、配備 | `HorseTrackwork_Scraper.py` → `horses/trackwork`、`horse_trackwork` | 晨操日可以係賽事日前一日 |
| [傷患（單駒）](https://racing.hkjc.com/zh-hk/local/information/ovehorse?horseid=HK_2025_L457) | 已有 | 日期、詳情、通過日期 | `HorseInjury_Scraper.py` → `horses/injury`、`horse_injury` | 未通過的紀錄要保留通過日空白 |
| [搬遷紀錄](https://racing.hkjc.com/zh-hk/local/information/movementrecords?horseid=HK_2025_L457) | 冇 | 由、至、到達日期 | 主檔只有「現在位置（到達日期）」一句 | 到達日唔等於出賽日 |
| [同父系馬](https://racing.hkjc.com/zh-hk/local/information/samesire?horsesire=Zoustar) | 部分 | 冠、亞、季、出賽、曾勝路程 | 血統欄有父系名。同父系名單冇收 | 退役馬仍在名單 |
| [馬匹搜尋／馬主搜尋](https://racing.hkjc.com/zh-hk/local/information/ownersearch) | 部分 | 馬名、烙號、馬主、父系。結果連去馬匹頁。選單亦有按筆畫、馬房、所在地、馬齡 | 現役 `horse_profiles.csv` 馬主原句 → `data/official_p2/owner_horse.csv`、D1 `official_owner_horse`。回聲必須等於查詢字。頁面列出的退役馬一併入索引；烙號轉世而馬名不同，唔當成現役主檔那一匹。每週一 04:20 HKT `capy_official_p2`。已無現役馬的馬主未逐個爬。筆畫／馬房選單未爬 | 馬主字串要原句，團體名中間有「與」 |
| [馬匹列表](https://racing.hkjc.com/zh-hk/local/information/selecthorse) | 部分 | 現役馬、評分、按練馬師／位置／馬齡 | 活躍馬來自賽果同排位，唔係這張目錄的副本 | 位置分香港、從化、海外 |
| [馬匹評分榜](https://racing.hkjc.com/zh-hk/local/information/latestonhorse?View=Horses/clas/) | 冇 | 評分榜視圖 | 單匹現評在主檔 | `View` 路徑要整段保留 |
| [馬匹消息](https://racing.hkjc.com/zh-hk/local/information/latestonhorse) | 冇 | 消息列表 | 無 | — |
| [初出馬介紹](https://racing.hkjc.com/zh-hk/local/page/new-horse) | 已有 | 2026-10-27 畫面：馬名、烙號、資料及評語（截至日期）、出生地、毛色、進口類別、血統表、父系簡介、母系簡介。馬匹頁可以帶 `racedate`、`raceNo`、`brandNo` 指住某一匹 | `official_new_horse_intro`：評語正文、截至日、出生地、毛色、進口類別。`not_race_result=1`。血統計數留在父系母系簡介，唔寫入正文。近 14 日有介紹的會議。`capy_official_p2` 每日 07:17 HKT。父系母系數字仍由 `HorsePedigree_Scraper.py` 收 | 評語的「截至」日期早過出賽日。唔好把評語寫成賽果 |
| [試閘](https://racing.hkjc.com/zh-hk/local/information/btresult) | 已有 | 日期、馬場、途程、地況、組別時間；馬名、騎師、練馬師、排位、配備、頭馬距離、沿途走位、完成時間、結果、評述 | `TrialResults_Scraper.py` → `trials/` → `trial_sessions`、`trial_runners`。每日 02:00 HKT 抓、05:17 入 D1 | 馬會只留約 176 個試閘日 |
| [晨操搜尋](https://racing.hkjc.com/zh-hk/local/information/trackworksearch) | 部分 | 搜尋入口，結果去單駒晨操 | 單駒晨操已有 | — |
| [傷患資料庫](https://racing.hkjc.com/zh-hk/local/information/ovedatabase) | 部分 | 過去 12 個月：烙號、馬名、日期、詳情、通過日期 | 單駒檔有；這張全庫滾動表冇獨立收 | 截至日係抓取日 |
| [患喘鳴症馬匹](https://racing.hkjc.com/zh-hk/local/information/overoar) | 冇 | 烙號、馬名、診斷日期、曾接受手術 | 無 | 截至日在標題 |
| [馬匹來港前名稱](https://racing.hkjc.com/zh-hk/local/info/horse-former-name) | 冇 | 舊名對照。Next 殼，今次未拆表 | 無 | — |
| [自購馬來港前賽績](https://racing.hkjc.com/zh-hk/local/page/ppo-performance) | 冇 | 內容殼 | 無 | 來港前賽績唔係香港賽事日 |
| [從化搬遷一覽](https://racing.hkjc.com/zh-hk/local/page/conghua-movement-records) | 冇 | 內容殼。單駒搬遷係另一頁 | 無 | — |
| [獎金計劃出賽馬](https://racing.hkjc.com/zh-hk/local/page/fwb-declared-starters) | 冇 | 自購新馬／拍賣新馬／卓越系列名單 | 無 | — |
| [進口資格、進口前體格檢驗](https://racing.hkjc.com/zh-hk/local/page/pps-import-critieria) | 冇 | 政策正文同 PDF | 無 | 參考，唔係賽事日資料 |

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
| [騎練配對及初出馬成績](https://racing.hkjc.com/zh-hk/local/page/jtcombo-debutants-statistics) | 冇 | 內容殼 | 無 | — |

## 統計（P2）

| 頁 | 狀態 | 公開欄位 | 天喜落點同節奏 | 日期風險 |
|---|---|---|---|---|
| [檔位統計](https://racing.hkjc.com/zh-hk/local/information/draw) | 已有 | 當日每場：途程、跑道、檔位、出賽次數、冠亞季殿、勝出率、入Q率、上名率、前 4 名率 | `official_draw_stat`、`official_draw_favourite`，`not_race_result=1`，窗口註腳原句。排位表未出記 pending，唔當空榜。逐匹檔位仍在 `entries_upcoming.draw`、`race_results.draw`。`capy_official_p2` | 統計窗口係馬會定的歷史，唔係該場即將發生的事 |
| [檔位進階搜尋](https://racing.hkjc.com/zh-hk/local/information/drawadvsearch) | 冇 | 馬季、馬場－跑道（含從化）、賽道、途程、場地狀況 | 無 | 參數 `Year`、`Racecourse`、`Course`、`Distance`、`Going` |
| [練馬師王統計](https://racing.hkjc.com/zh-hk/local/information/tncstat) | 已有 | 編號、練馬師、近十個賽事日積分、平均、季度 | `official_pool_stat`，`pool=tnc`。`-` 留 NULL。截至最近一欄賽事日。`capy_official_p2` | 欄頭日期係過去賽馬日 |
| [騎師王統計](https://racing.hkjc.com/zh-hk/local/information/jkcstat) | 已有 | 同上，騎師 | 同表，`pool=jkc` | 同上 |
| [騎師大熱](https://racing.hkjc.com/zh-hk/local/information/jockeyfavourite) | 已有 | 出賽、頭馬、位置、大熱次數同百分比、大熱勝出、大熱入位。截至賽事日 | `official_favourite_stat`、`official_favourite_summary`。頁尾「其他」冇數字，唔造人。同 `capy_official_p2` | — |
| [練馬師大熱](https://racing.hkjc.com/zh-hk/local/information/trainerfavourite) | 已有 | 同上 | 同表，`role=trainer` | — |
| [騎師王賠率走勢](https://racing.hkjc.com/zh-hk/local/page/jkc-odds-chart) | 冇 | 走勢圖 | 無。WIN/PLA 快照唔係這張圖 | — |
| [練馬師王賠率走勢](https://racing.hkjc.com/zh-hk/local/page/tnc-odds-chart) | 冇 | 走勢圖 | 無 | — |

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

1. **即將開跑的場次頭。** 場名、獎金、評分區間、途程、草地／全天候、地況。10 月 28 日全天候九日都中。公開卡因此係「第 N 場」。
2. **場次頭解析失敗仍然綠燈。** 頁面有米數同跑道，欄位空，排程當成功。
3. **地況按會議一格，而且今次連這一格都空。** 混合場會再錯。
4. **更易事項只係 HTML 原文。** 未拆成換騎、改磅、退出，亦未寫回排位。
5. **賽果入庫之後仍然缺兩欄。** `rating_range` 未進 D1；`course` 未拆成草地／全天候同賽道，`races.track` 空。
6. **賽期表只有日期。** 冇馬場、日夜、場數、跑道，所以唔知 28 日係沙田夜賽全天候。
7. **馬匹主檔以外的公開表。** 評分體重曲線、途程成績、搬遷、同父系、馬主索引、初出馬評語、來港前名稱、喘鳴症名單。
8. **榜同統計成表。** 練馬師榜、騎師榜的場地／百分比視圖、檔位統計、騎師王、練馬師王、大熱、讓磅。
9. **賽日配套頁。** 一般資訊的彩池同停賽騎師、分場表、對壘、特別因素、上次事件摘要、終點相、賽日頭條、賽日數據。
10. **即時賠率只得獨贏同位置。** 一般資訊列出的其餘彩池同走勢圖未收。

## 分階段（今次不實作）

### P0 — 賽日場次頭完整

沿用已經抓的排位頁，唔好改 GraphQL 白名單。

1. 草地句同 `全天候跑道, 1650米, 好地` 都要解析。場名、獎金、評分區間、途程、跑道、地況寫入可查欄位。API 唔好再把場名同獎金寫死空。
2. 日期、馬場、場次對唔上就整段丟。10 月 28 日沙田做回歸樣本。
3. 頁面有途程同跑道、欄位仍然空，排位工作要失敗，唔好綠著開跑。
4. 地況按場儲存。探針未公布繼續留空，唔好用排位頁地況冒充探針。
5. 公開卡至少顯示場名、途程、跑道、地況、班次、開跑時間。
6. 更易拆欄之後先寫回該場排位；對唔上的原文留在快照，唔好覆蓋。
7. 未完場唔好用賽果頁補場名。

### P1 — 賽果同人物頁完整

1. 「賽事日期」已核對之後，`rating_range` 入 D1；`course` 拆開跑道同賽道。
2. 馬匹頁餘下標籤：評分／體重／名次、途程成績、搬遷。主檔已有的欄位唔好重抓一套。
3. 騎師、練馬師資料頁的季績，同往績檔對得上先收，避免榜同往績各寫各的。
4. 賽日配套：上次事件摘要、對壘、特別因素、當日晨操一覽。每條都要帶返所屬場次。

### P2 — 榜、統計、初出馬、馬主

1. 檔位統計、騎師王、練馬師王、大熱、讓磅、官方榜（含場地篩選）。
2. 初出馬介紹正文同截至日期。血統數字已有的唔好當評語。
3. 馬主搜尋做成索引，字串同馬匹頁「馬主」一致。
4. 賽期表補馬場、日夜、場數、跑道。
5. 彩池同走勢圖留在研究，不進凍結。

## 點樣更新這份清單

馬會選單會改。下次盤點：打開本地賽果頁選單，跟 `/zh-hk/local/information|info|page` 的新連結；`/info/*` 要用瀏覽器或該頁自己的查詢先至見到表。新頁先寫入矩陣再談收料。狀態只可以係已有、部分、冇。
