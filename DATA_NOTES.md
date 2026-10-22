# 📖 DATA_NOTES.md — 天喜數據庫逐欄說明書

> 本文件係 tianxi-database 所有 CSV / TXT artefacts 嘅**逐欄說明 + 取值範圍 + 用途備忘**。
>
> 前端（tianxi-frontend）、後端 Elo pipeline、任何第三方用戶，睇呢份文件就知每一格數字代表咩、單位係咩、可以點樣用。
>
> 最後更新：**2026-04-24**
> 維護者：`天喜 Bot` / auto-sync
> 數據涵蓋：**2016-01-01 至今**，每日自動更新。即時數量（賽馬日、賽事、賽果行數、馬匹、晨操等）以生產 D1 實數為唯一來源：<https://tianxi.racing/api/public/data-stats>（每日 06:00 HKT 重計）。本文件唔再手寫總數。

---

## 📚 目錄

1. [資料夾結構總覽](#資料夾結構總覽)
2. [賽馬日 5 份檔案（per race day artefacts）](#賽馬日-5-份檔案)
   - 2.1 [results](#21-dataresultsresults_yyyy-mm-ddcsv)
   - 2.2 [commentary](#22-datacommentarycommentary_yyyy-mm-ddcsv)
   - 2.3 [dividends](#23-datadividendsdividends_yyyy-mm-ddcsv)
   - 2.4 [sectional_times](#24-datasectional_timessectional_times_yyyy-mm-ddcsv)
   - 2.5 [video_links](#25-datavideo_linksvideo_links_yyyy-mm-ddcsv)
3. [馬匹主檔 (horses/)](#馬匹主檔-horses)
4. [練馬師 (trainers/)](#練馬師-trainers)
5. [騎師 (jockeys/)](#騎師-jockeys)
6. [試閘 (trials/)](#試閘-trials)
7. [排位表 (entries/)](#排位表-entries)
8. [賽馬日日曆 (data/fixtures/)](#賽馬日日曆-datafixtures)
9. [Elo 輸出（GHA artifact）](#elo-輸出gha-artifact)
10. [約定與共通規則](#約定與共通規則)
11. [已知缺口 / 取消日期 / 永久不可抓類別](#已知缺口--取消日期--永久不可抓類別)

---

## 資料夾結構總覽

```
tianxi-database/
├── data/
│   ├── 2016/ … 2026/
│   │   ├── results_YYYY-MM-DD.csv
│   │   ├── commentary_YYYY-MM-DD.csv
│   │   ├── dividends_YYYY-MM-DD.csv
│   │   ├── sectional_times_YYYY-MM-DD.csv
│   │   └── video_links_YYYY-MM-DD.csv
│   └── fixtures/
│       ├── 2025_fixtures.csv
│       ├── 2026_fixtures.csv
│       └── fixtures.csv          ← 合併近兩季
│
├── horses/
│   ├── profiles/horse_profiles.csv         ← 1 行 / 匹馬
│   └── form_records/form_<horse_no>.csv    ← 1 檔 / 匹馬（全歷來出賽）
│
├── trainers/
│   └── trainer_profiles.csv                 ← 1 行 / 練馬師（目前只有 code+name）
│
├── jockeys/
│   ├── jockey_profiles.csv                  ← 1 行 / 騎師
│   └── records/jockey_<code>.csv            ← 1 檔 / 騎師（歷來騎乘）
│
├── trials/
│   ├── trial_results.csv                    ← 逐匹馬試閘
│   └── trial_sessions.csv                   ← 試閘日彙總（組別 / 時間）
│
├── entries/
│   ├── entries_YYYY-MM-DD.txt               ← 指定賽馬日嘅馬匹名冊
│   └── today_entries.txt                    ← 最近嗰日嘅 snapshot
│
└── audit_reports/                           ← 每日完整性 audit 輸出
    ├── integrity_YYYY-MM-DD.json
    ├── integrity_latest.json
    └── SUMMARY.md
```

---

## 賽馬日 5 份檔案

每一個正式賽馬日都產生以下 5 份檔案，用 `YYYY-MM-DD` 做 key 互相對應。取消/改期日期（見 §11）只會缺 `results_*.csv`，其餘 4 份可能仍存在（派彩退款等）。

### 2.1 `data/<year>/results/results_YYYY-MM-DD.csv`

**每行 = 一場賽事中一匹馬嘅落位紀錄。**同一場有多少匹馬就有多少行；race-level 資訊（race_name、距離、場地）會重複填入每一行。

| # | 欄位 | 中文意思 | 類型 | 例子 / 範圍 | 備註 |
|---|---|---|---|---|---|
| 1 | `date` | 賽馬日 | date | `2026-01-01` | ISO-8601 |
| 2 | `venue` | 場地 | str | `沙田` / `跑馬地` | 中文 |
| 3 | `race_no` | 場次 | int | 1-11 | 通常 1-10，節日賽可達 11 |
| 4 | `race_meeting_no` | HKJC 內部場次號 | int | `303` | HKJC race_index，全季流水號 |
| 5 | `race_name` | 賽事名稱 | str | `松柏塱讓賽` | |
| 6 | `race_class` | 班次 | str | `第五班` / `第一班` / `Group 1` | |
| 7 | `distance_m` | 途程 (米) | int | `1000 / 1200 / 1400 / 1600 / 1650 / 1800 / 2000 / 2200 / 2400` | |
| 8 | `rating_range` | 評分上下限 | str | `40-0` / `80-60` | 讓賽入場評分區間 |
| 9 | `going` | 場地狀況 | str | `好 / 好至快 / 好黏 / 黏 / 大爛` | |
| 10 | `course` | 跑道資料 | str | `草地 - "B+2" 賽道` / `全天候跑道` | |
| 11 | `prize_hkd` | 冠軍總獎金 (HKD) | int | `875000` | |
| 12 | `race_finish_time` | 分段累計時間 | str | `(24.33) (46.63) (1:10.70) (1:35.36)` | 最後一格 = 全程勝出時間 |
| 13 | `sectional_times_header` | 分段段落時間 | str | `24.33 22.30 24.07` | 空格分隔 |
| 14 | `place` | 名次 | str | `1 - 12` / `WV`（違例）/ `-` | |
| 15 | `horse_no` | 馬匹編號 | str | `A001` / `J459` | 終身不變 |
| 16 | `horse_name` | 馬匹中文名 + 編號 | str | `鐵甲驌龍 (J459)` | 帶括號編號 |
| 17 | `jockey` | 騎師中文名 | str | `鍾易禮` | |
| 18 | `trainer` | 練馬師中文名 | str | `告東尼` | |
| 19 | `actual_wt_lbs` | 實際負磅 (磅) | int | `113 - 133` | 1 lb = 0.4536 kg |
| 20 | `declared_wt_lbs` | 申報馬匹體重 (磅) | int | `950 - 1250` | 馬秤 |
| 21 | `draw` | 檔位 | int | `1 - 14` | 起閘位置 |
| 22 | `lbw` | 敗距（馬位） | str | `1 / 1-1/2 / SH / HD / NOSE / -` | 冠軍為 `-` |
| 23 | `running_position` | 跑程走位 | str | `5 3 3 1` | 空格分每段排位 |
| 24 | `finish_time` | 個人衝線時間 | str | `1:35.36` | 分:秒.xx |
| 25 | `win_odds` | 獨贏賠率 | num | `1.5 - 999` | 開閘時 HKJC 官方賠率 |

---

### 2.2 `data/<year>/commentary/commentary_YYYY-MM-DD.csv`

**每行 = 一匹馬喺一場賽事嘅沿途走勢文字評述。**

| # | 欄位 | 中文意思 | 類型 | 例子 | 備註 |
|---|---|---|---|---|---|
| 1 | `date` | 賽馬日 | date | `2026-01-01` | |
| 2 | `venue` | 場地 | str | `沙田` | |
| 3 | `race_no` | 場次 | int | `1` | |
| 4 | `place` | 名次 | str | `1 / 12 / WV` | |
| 5 | `horse_no` | 馬匹編號 | str | `J459` | |
| 6 | `horse_name` | 名字 + 編號 | str | `鐵甲驌龍 (J459)` | |
| 7 | `jockey` | 騎師 | str | `鍾易禮` | |
| 8 | `gear` | 戴具代號 | str | `H/TT` / `B-` / `-` | 見下方戴具詞典 |
| 9 | `commentary` | 沿途評述 | text | `躍出時發生碰撞，早段居中間之前位置…` | HKJC 官方中文描述 |

**戴具代號詞典（常見）**：
`B`=眼罩、`TT`=舌帶、`H`=頭罩、`V`=前眼罩、`P`=防沙眼罩、`SR`=羊毛面箍、`CP`=耳塞、`E`=扭八字、`-` 後綴=第一次配戴。

---

### 2.3 `data/<year>/dividends/dividends_YYYY-MM-DD.csv`

**每行 = 一場賽事嘅一個投注池派彩記錄。**

| # | 欄位 | 中文意思 | 類型 | 例子 | 備註 |
|---|---|---|---|---|---|
| 1 | `date` | 賽馬日 | date | `2026-01-01` | |
| 2 | `venue` | 場地 | str | `沙田` | |
| 3 | `race_no` | 場次 | int | `1` | |
| 4 | `pool` | 投注池中文名 | str | `獨贏 / 位置 / 連贏 / 位置Q / 三重彩 / 四連環 / 過關 / 孖T / 四連環獎池` | |
| 5 | `combination` | 中彩組合 | str | `4` / `4-7` / `4,7,9` | 視 pool type 而定 |
| 6 | `dividend_hkd` | 每注派彩 (HKD) | num | `131.50` | 以 $10 為一注 |

---

### 2.4 `data/<year>/sectional_times/sectional_times_YYYY-MM-DD.csv`

**每行 = 一匹馬喺一場賽事嘅詳細分段時間（最多 6 段）。**

| # | 欄位 | 中文意思 | 類型 | 例子 | 備註 |
|---|---|---|---|---|---|
| 1 | `date` | 賽馬日 | date | `2026-01-01` | |
| 2 | `venue` | 場地 | str | `沙田` | |
| 3 | `race_no` | 場次 | int | `1` | |
| 4 | `finish_pos` | 名次 | int/str | `1 - 14` / `WV` | |
| 5 | `horse_no` | 馬匹編號 | str | `J459` | |
| 6 | `horse_name` | 名字 + 編號 | str | `鐵甲驌龍 (J459)` | |
| 7 | `finish_time` | 全程時間 | str | `1:35.36` | |
| 8-10 | `sec1_margin` / `sec1_running_pos` / `sec1_time` | 第 1 段敗距 / 位置 / 秒數 | mixed | `1-1/2` / `5` / `24.57` | 第 1 段 = 閘前至第 N 公尺 |
| 11-13 | `sec2_*` | 第 2 段 | … | … | 逢 200-400m 分段 |
| 14-16 | `sec3_*` | 第 3 段 | … | … | 常帶 `23.99 12.08 11.91` sub-split |
| 17-19 | `sec4_*` | 第 4 段 | … | … | |
| 20-22 | `sec5_*` | 第 5 段 | … | … | 1800m+ 先有 |
| 23-25 | `sec6_*` | 第 6 段 | … | … | 2000m+ 先有；短途留空 |

**分段數量隨途程不同**：1000m=3 段 · 1200m=3 段 · 1400m=4 段 · 1600m=4 段 · 1800m=4-5 段 · 2000m=5 段 · 2200m=5-6 段 · 2400m=6 段。

---

### 2.5 `data/<year>/video_links/video_links_YYYY-MM-DD.csv`

**每行 = 一場賽事嘅官方影片連結。**

| # | 欄位 | 中文意思 | 類型 | 例子 |
|---|---|---|---|---|
| 1 | `date` | 賽馬日 | date | `2026-01-01` |
| 2 | `venue` | 場地 | str | `沙田` |
| 3 | `race_no` | 場次 | int | `1` |
| 4 | `video_full_url` | 全景重播 | url | `https://racing.hkjc.com/...replay-full...` |
| 5 | `video_passthrough_url` | 直通鏡頭 | url | `...passthrough...` |
| 6 | `video_aerial_url` | 鳥瞰鏡頭 | url | `...replay-aerial...` |

**注意**：3 條 URL 都係 iframe embed，唔係 mp4 直連。前端要用 `<iframe>` 嵌入。

---

## 馬匹主檔 (horses/)

### 3.1 `horses/profiles/horse_profiles.csv`

**一行 = 一匹馬嘅靜態 profile + 累計統計。** Key = `horse_no`。

| # | 欄位 | 中文意思 | 類型 | 例子 | 備註 |
|---|---|---|---|---|---|
| 1 | `horse_no` | 馬匹編號 | str | `A001` / `J459` | 終身唯一 PK |
| 2 | `name` | 馬匹中文名 | str | `金鎗六十` | |
| 3 | `last_race_date` | 上次出賽日期 | date | `2024-04-06` | 用於判斷是否在役 |
| 4 | `status` | 狀態 | str | `active` / `retired` / `unknown` | |
| 5 | `profile_last_scraped` | profile 最後更新時間 | datetime | `2026-04-23T12:34:56Z` | |
| 6 | `出生地` | 出生國家 | str | `澳洲 / 紐西蘭 / 愛爾蘭 / 英國 / 美國 / 日本` | |
| 7 | `毛色___性別` | 毛色 + 性別 | str | `棕色閹馬` / `棗色雄馬` / `灰色雌馬` | 三底線分隔原 HKJC 2-line 標籤 |
| 8 | `進口類別` | 進口分類 | str | `自購馬 / 自購新馬 / PPG / PP 等` | |
| 9 | `總獎金` | 舊累計獎金 (HKD) | int | `1200000` | 可能 stale，見 `總獎金*` |
| 10 | `冠-亞-季-總出賽次數` | 冠亞季和出賽 | str | `4-3-2-20` | 格式：W-P-S-T |
| 11 | `馬主` | 馬主 | str | `施敏夫先生` | |
| 12 | `最後評分` | HKJC 最後評分 | int/str | `105` | 讓賽評分 |
| 13 | `父系` | 父系血統 | str | `Medaglia d'Oro` | 英文名為主 |
| 14 | `母系` | 母系血統 | str | `Sizzling Tempo` | |
| 15 | `外祖父` | 外祖父 | str | `Hussonet` | |
| 16 | `同父系馬` | 同血統兄姐 | str | 鏈接列表 | 可 parse |
| 17 | `出生地___馬齡` | 出生地 + 馬齡組合 | str | `澳洲___6` | |
| 18 | `今季獎金*` | 當季獎金 (最新) | int | `234000` | `*` 表示最新抓取 |
| 19 | `總獎金*` | 總獎金 (最新) | int | `1520000` | 取代欄 9 |
| 20 | `冠-亞-季-總出賽次數*` | W-P-S-T (最新) | str | `5-3-2-22` | |
| 21 | `最近十個賽馬日\n出賽場數` | 近 10 賽馬日出賽數 | int | `0-10` | 活躍度指標 |
| 22 | `現在位置\n(到達日期)` | 目前所在地 + 到達日期 | str | `香港 (2021-08-15)` | 含海外放假、澳洲賽季 |
| 23 | `進口日期` | 進口到港日期 | date | `2020-11-30` | |
| 24 | `自購馬來港前賽事片段` | 外地出賽片段 URL | str | URL 或 `(n/a)` | 自購馬先有 |

**注意**：欄名帶 `\n` 係因為 HKJC 原 table header 本身係兩行。parse 時用 `utf-8-sig`（有 BOM）。

---

### 3.2 `horses/form_records/form_<horse_no>.csv`

**一個 horse_no 一個檔案。** 每行 = 一場出賽紀錄。歷來全部出賽（包括退役前）都會保留。

| # | 欄位 | 中文意思 | 類型 | 例子 | 備註 |
|---|---|---|---|---|---|
| 1 | `horse_no` | 馬匹編號 | str | `A001` | 同 filename 一致 |
| 2 | `race_index` | HKJC race index | int | `303` | 全季流水號 |
| 3 | `place` | 名次 | str | `1 - 14` / `WV` / `-` | |
| 4 | `date` | 比賽日 | str | `01/01/2019` | **注意**：非 ISO，係 `DD/MM/YYYY` |
| 5 | `racecourse` | 場地 | str | `沙田 / 跑馬地` | |
| 6 | `track` | 跑道類型 | str | `草地 / 全天候` | |
| 7 | `course` | 彎道 + 移欄 | str | `C / C+3 / A / AWT` | |
| 8 | `distance_m` | 途程 (米) | int | `1200` | |
| 9 | `going` | 場地狀況 | str | `好 / 黏 / 大爛` | |
| 10 | `race_class` | 班次 | str | `第五班 / 一班 / G1` | |
| 11 | `draw` | 檔位 | int | `1-14` | |
| 12 | `rating` | 評分 | int | `54` | 當日入場評分 |
| 13 | `trainer` | 練馬師 | str | `霍利時` | |
| 14 | `jockey` | 騎師 | str | `韋達` | |
| 15 | `lbw` | 敗距 | str | `11 / 1-1/2 / SH` | |
| 16 | `win_odds` | 獨贏賠率 | num | `15` | 開閘時 |
| 17 | `actual_wt_lbs` | 實際負磅 (磅) | int | `128` | |
| 18 | `running_position` | 跑程走位 | str | `3 4 11` | 空格分段 |
| 19 | `finish_time` | 衝線時間 | str | `1.11.17` | **注意**：用 `.` 分鐘秒，非 `:` |
| 20 | `declared_wt_lbs` | 申報體重 (磅) | int | `1086` | |
| 21 | `gear` | 戴具 | str | `B-` / `H/TT` | |

**⚠️ 日期格式一致性陷阱**：`form_records` 嘅 `date` 係 `DD/MM/YYYY`，而 `results_*.csv` 嘅 `date` 係 ISO `YYYY-MM-DD`。ETL 一定要統一。

---

## 練馬師 (trainers/)

### 4.1 `trainers/trainer_profiles.csv`

| # | 欄位 | 中文意思 | 類型 | 例子 |
|---|---|---|---|---|
| 1 | `trainer_code` | HKJC 練馬師代碼 | str | `TA` / `SWY` |
| 2 | `trainer_name` | 練馬師中文名 | str | `告東尼` |

**🚧 已知缺失**：
- `trainers/records/` 目錄**完全空缺**（D1 High severity · 2026-04-22 audit）。
- 需要類似 `jockeys/records/jockey_<code>.csv` 嘅檔案：每個練馬師歷來訓練結果。
- 未來補數透過 `TrainerData_Scraper.py` 嘅 `records` 模式完成。

---

## 騎師 (jockeys/)

### 5.1 `jockeys/jockey_profiles.csv`

| # | 欄位 | 中文意思 | 類型 | 例子 | 備註 |
|---|---|---|---|---|---|
| 1 | `jockey_code` | 騎師代碼 | str | `AA` / `MOL` | |
| 2 | `jockey_name` | 騎師中文名 | str | `潘頓` | |
| 3 | `current_25_26_馬季\n截至賽事日` | 本季最後更新日 | date | `2026-04-22` | 多行標題 |
| 4 | `current_國籍` | 國籍 | str | `南非` | |
| 5 | `current_所贏獎金` | 本季獎金 (HKD) | int | `38000000` | |
| 6 | `current_過去10個賽馬日\n獲勝次數` | 近 10 日勝出 | int | `3` | |
| 7 | `current_殿` | 季內殿軍次數 | int | `10` | HKJC 4th 獨立欄 |
| 8 | `current_總出賽次數` | 本季騎乘總次數 | int | `450` | |
| 9 | `current_勝出率` | 勝出率 % | num | `14.22` | |
| 10-15 | `previous_*` | 上一季鏡像欄 | … | … | 包含國籍/獎金/季/殿/總出賽/勝出率 |

### 5.2 `jockeys/records/jockey_<code>.csv`

**每個騎師一個檔案，每行 = 一次騎乘紀錄。**

| # | 欄位 | 中文意思 | 類型 | 例子 |
|---|---|---|---|---|
| 1 | `jockey_code` | 騎師代碼 | str | `AA` |
| 2 | `jockey_name` | 騎師名 | str | `阿力士古馬田` |
| 3 | `season` | 馬季 | str | `2019/20` |
| 4 | `date` | 出賽日 | date | `2020-03-15` |
| 5 | `venue` | 場地 | str | `沙田` |
| 6 | `race_index` | 場次編號 | int | `401` |
| 7 | `place` | 名次 | str | `1-14 / WV` |
| 8 | `total_starters` | 全場頭馬數 | int | `14` |
| 9 | `track` | 跑道 | str | `草地` |
| 10 | `course` | 彎道 | str | `C` |
| 11 | `distance_m` | 途程 | int | `1200` |
| 12 | `race_class` | 班次 | str | `第四班` |
| 13 | `going` | 場地 | str | `好` |
| 14 | `horse_name` | 馬匹 | str | `友禮之星 (A327)` |
| 15 | `draw` | 檔位 | int | `1-14` |
| 16 | `rating` | 評分 | int | `60` |
| 17 | `trainer` | 練馬師 | str | `蘇保羅` |
| 18 | `gear` | 戴具 | str | `-` / `B/TT` |
| 19 | `body_wt_lbs` | 體重 (磅) | int | `1050` |
| 20 | `actual_wt_lbs` | 負磅 (磅) | int | `129` |

**注意**：`jockeys/records/` 目前只有 **59 個檔案**，應該係 ~100 位活躍騎師嘅 subset。後續由 `JockeyData_Scraper.py` 補齊。

---

## 試閘 (trials/)

### 6.1 `trials/trial_results.csv`

**所有試閘結果統一一個檔。** 每行 = 一組試閘入面一匹馬嘅表現。

| # | 欄位 | 中文意思 | 類型 | 例子 | 備註 |
|---|---|---|---|---|---|
| 1 | `trial_date` | 試閘日 | date | `2026-03-04` | |
| 2 | `group_no` | 組別 | int | `1-20` | 每日分組 |
| 3 | `trial_venue` | 試閘場地 | str | `沙田 / 跑馬地 / 廣東從化` | |
| 4 | `distance_m` | 距離 | int | `800 / 1000 / 1200` | |
| 5 | `going` | 場地 | str | `好 / 軟` | |
| 6 | `group_time` | 組別全程時間 | str | `57.32` | 同組共用 |
| 7 | `group_sectional_times` | 組別分段 | str | `24.5 12.3 12.1` | 同組共用 |
| 8 | `horse_name` | 馬匹 | str | `金劍威 (A345)` | |
| 9 | `horse_no` | 編號 | str | `A345` | |
| 10 | `jockey` | 騎師 | str | `潘頓` | 試閘騎師 |
| 11 | `trainer` | 練馬師 | str | `蘇兆輝` | |
| 12 | `draw` | 檔位 | int | `1-12` | |
| 13 | `gear` | 戴具 | str | `B-` / `-` | |
| 14 | `lbw` | 敗距 | str | `HD / 1 / 2-1/2` | |
| 15 | `running_position` | 走位 | str | `3 2 1` | |
| 16 | `finish_time` | 衝線時間 | str | `57.32` | |
| 17 | `result` | 試閘結果代號 | str | `1 / 2 / DNF` | |
| 18 | `commentary` | HKJC 評述 | text | `躍出尚可，末段反應佳。` | |

### 6.2 `trials/trial_sessions.csv`

**每行 = 一個試閘日嘅一組彙總。** 同 `trial_results.csv` 嘅欄 1-7 相同（group header），冇個別馬資料。

**⚠️ HKJC 限制**：試閘頁面只保留最近 **176 個試閘日**（約一年）。早於 `2025-03-13` 嘅試閘紀錄已從官方網站移除，**無法追溯抓取**。

---

## 排位表 (entries/)

**⚠️ 非 CSV、係 TXT。** 每個未來賽馬日一個 txt 檔。

### 7.1 `entries/entries_YYYY-MM-DD.txt`

**格式**：
```
# meeting=2026-04-19 racecourse=ST written=2026-04-19
D241
E301
E434
...
```

- 第 1 行係 metadata comment
- 之後每行 = 一個 `horse_no`（即該賽馬日**所有參賽馬**嘅名冊）
- **注意**：只有馬名冊，冇 per-race 分配。完整 racecard（分場 + 騎師 + 檔位）要賽馬日當日 09:00 HK 由 `capy_entries.yml` workflow 重新抓。

### 7.2 `entries/today_entries.txt`

同上，但指向**下一個賽馬日**。日夜前端 poll 呢個檔嚟知「下次邊場」。

---

## 賽馬日日曆 (data/fixtures/)

### 8.1 `data/fixtures/YYYY_fixtures.csv` / `fixtures.csv`

**每行 = 一個確認賽馬日。** 由 `FixtureCalendar_Scraper.py`（httpx + regex，非 Selenium）生成。

| # | 欄位 | 中文意思 | 類型 | 例子 |
|---|---|---|---|---|
| 1 | `date` | 賽馬日 | date | `2026-04-26` |
| 2 | `season_year` | 馬季年份 | int | `2026` |
| 3 | `month` | 月份 | int | `4` |
| 4 | `day` | 日 | int | `26` |
| 5 | `weekday` | 星期 | str | `Wed / Sun / Sat` |
| 6 | `captured_at` | 抓取時間 (UTC) | datetime | `2026-04-23T21:43:03Z` |

**用途**：`scripts/fixture_guard.sh` 用呢個檔喺每個 workflow 跑之前決定「今日有冇賽事 → 要唔要跑」。

---

## Elo 輸出（GHA artifact）

Elo v1.1 產物**唔會 commit 入 repo**，以 **GitHub Actions artifact** 形式保存 14 天。

- Artifact 名：`elo-v11-bulk-db-<run_number>`
- 格式：SQLite (`.db`) 壓縮 gzip（53MB → 12MB）
- 內容（3 條獨立 Elo）：
  - `horse_elo` — **73,646 snapshots**，5 軸：`overall / turf_sprint / turf_mile / turf_middle / turf_staying`
  - `jockey_elo` — 38,893 snapshots
  - `trainer_elo` — 37,287 snapshots
- 每個 snapshot 欄位：`entity_id, date, elo, games_played, k_factor, mean_opponent_elo`

**前端存取方式**：`gh run download` → 解壓 → query SQLite；或等後端 API wrap（planned）。

---

## 約定與共通規則

1. **編碼**：所有 CSV 用 **UTF-8 with BOM** (`\ufeff` 開頭)。Python parser 要用 `encoding="utf-8-sig"`。
2. **日期格式**：
   - `data/*`、`fixtures`、`horse_profiles.last_race_date`：**ISO `YYYY-MM-DD`**
   - `horses/form_records/*`：`DD/MM/YYYY`（HKJC 原格式，未統一）
3. **時間格式**：
   - `results.finish_time` 用 `:` → `1:35.36`
   - `form_records.finish_time` 用 `.` → `1.35.36`
   - ETL 必須統一再做 timedelta。
4. **重量單位**：一律**磅 (lbs)**。換算 kg：`lbs × 0.4536`。
5. **race key**：`(date, venue, race_no)` 三欄組合全局唯一。
6. **horse key**：`horse_no` 終身不變（就算改名）。
7. **CSV 寫入原則**：scrapers 一律經 `git_sync.py` + commit message prefix `[data][skip ci]`，避免觸發 CI 循環。
8. **新增欄位時**：同步更新本檔案、`data/index.json` manifest（Option 2，下一步）、`tools/data_integrity_audit.py` 嘅欄位檢查。

---

## 已知缺口 / 取消日期 / 永久不可抓類別

### 颱風 / 黑雨取消（無 `results_*.csv`）

以下日期因惡劣天氣取消，但 `dividends / commentary / video_links` 可能仍然存在（退款記錄等）：

- 2018-09-16
- 2019-09-18
- 2019-11-13
- 2021-10-13
- 2022-11-02
- 2023-10-08

### 已識別嘅 data gaps（2026-04-24 audit baseline）

| 類別 | 缺口數量 | 原因 | 補數計劃 |
|---|---|---|---|
| `horses/profiles` | 1,268 | Pool A 首次 full pass 未完 | Pool A daily 4/24 起 |
| `horses/form_records` | 1,268 | 同上 | 同上 |
| `trainers/records` | 67 (全部) | records 模式未實作 | TrainerData_Scraper.py P1 |
| `jockeys/records` | 5 | 漏 5 位活躍騎師 | JockeyData_Scraper.py |
| `entries_upcoming` | 1 | 下一個賽馬日 marker | 每日自動 |

每日完整性 audit 輸出：`audit_reports/integrity_YYYY-MM-DD.json`。critical gap 清零維持 7 日 → `capy-handover-baseline-v1` tag。

### HKJC 已永久移除（官方網站回 404）

以下類別無法從 HKJC 抓取，代替方案喺括號內：

1. **歷史排位表** — 只存 live 賽馬日 ±7 日，過期消失
2. **歷史天氣 / 跑道狀況** — 用 `results.going` / `results.course` 代替
3. **速勢能量（Speed Energy）** — 官方已下架
4. **馬匹搬遷紀錄** — 需人工維護
5. **裝備登記冊** — 用 `commentary.gear` 代替（每場實際配戴）
6. **傷患紀錄** — 官方已下架
7. **上仗備忘** — 官方已下架

### CSV → D1 每日同步覆蓋（2026-10-22 補齊分段時間、試閘）

| CSV | D1 表 | Workflow（HK 時間） | 範圍 |
|---|---|---|---|
| `results` / `commentary` / `dividends` | `race_meetings` · `races` · `race_results` · `running_comments` · `dividends` | `capy_d1_sync.yml`（00:23，後備 06:23 / 10:23） | 當日賽事 |
| `sectional_times_YYYY-MM-DD.csv` | `horse_sectional_times` | 同上 | 當日賽事 |
| `horses/trackwork` · `injury` · `form_records` · profiles | `horse_trackwork` · `horse_injury` · `horse_form_records` · `horse_profile_extra` | `capy_d1_sync_pool_a.yml`（05:17） | 近 30 日 |
| `trials/trial_sessions.csv` + `trial_results.csv`（Pool B 02:00 抓取） | `trial_sessions` · `trial_runners` | 同上 | 近 30 日（`trials_since` 可放寬） |

重跑安全：ID 由日期／場次／馬匹編號決定；同一行再推只會原地更新，自然鍵（如同場同馬同分段）已存在就略過，唔會重複。D1 未有嘅馬匹或賽事，該行會略過，下次同步自動補上。舊分段時間一次性補數：`capy_d1_backfill_sectionals.yml`（手動）。

### 試閘歷史限制

HKJC 只保留最近 **176 個試閘日**（約一年）。早於 `2025-03-13` 嘅試閘紀錄**永久不可追溯**。

### 失敗紀錄檔案（排查用）

- `failed_dates.log` — 賽果抓取失敗（已重試 2 次）
- `failed_horses.log` — 馬匹資料抓取失敗
- `failed_trials.log` — 試閘抓取失敗
- `failed_trackwork.log` — 晨操抓取失敗
- `failed_jockeys.log` — 騎師資料抓取失敗
- `failed_trainers.log` — 練馬師資料抓取失敗

`failed_dates.log` 內 2016-01-02 / 2016-01-03 係正常（當日本身無賽馬，並非缺漏）。

---

## 🔗 參考資料

- Schema 演進史：`BUILD_JOURNAL.md`
- 爬取器清單 + 操作細節：`README.md` §「爬取器清單」
- 每日 audit 結果：`audit_reports/SUMMARY.md`
- 整合計劃：`plan.md`
- 整體哲學（反大眾偏見 / 拒絕幻覺源）：`outputs/horse_db_spec.md` §0

---

_天喜數據庫 · 只賣原始事實。_
