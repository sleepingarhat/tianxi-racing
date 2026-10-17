# 天喜數據庫 · Tianxi Database

> 模型說明：[MODEL.md](MODEL.md)（特徵、訓練）· [ELO.md](ELO.md)（Elo 公式）· 網頁版 https://tianxi.racing/model

> **香港賽馬 AI 數據平台** — 2016–2026 全量歷史賽果 + 每日自動爬取 + Elo rating pipeline + Data Integrity Audit。以 GitHub 為 backend，CSV 為介面，下游即開即用。

[![Pool A](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_pool_a.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_pool_a.yml)
[![Pool B](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_pool_b_daily.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_pool_b_daily.yml)
[![Race Day](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_race_daily.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_race_daily.yml)
[![Trainer](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_trainer_fix.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_trainer_fix.yml)
[![Entries](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_entries.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_entries.yml)
[![Fixture](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_fixture_weekly.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_fixture_weekly.yml)
[![Sanity](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_sanity_daily.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_sanity_daily.yml)
[![Integrity](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_integrity_audit.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_integrity_audit.yml)
[![D1 Sync](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_d1_sync.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_d1_sync.yml)
[![Pedigree](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_pedigree.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_pedigree.yml)

---

## 👥 生態系統（3 repos）

| Repo | 角色 | 技術棧 |
|---|---|---|
| **tianxi-database** (本 repo · public) | HKJC 爬取 · CSV 數據底 · GHA 調度 · Data audit | Python + GitHub Actions |
| [**tianxi-backend**](https://github.com/sleepingarhat/tianxi-backend) (public) | D1 + Workers API · ELO 計算 · TX-Oracle v3.2 prediction | Hono + TypeScript + Cloudflare D1 |
| [**tianxi-site**](https://github.com/sleepingarhat/tianxi-site) (public) | CF Pages 靜態前端 · HKJC 3-level layout | Vanilla HTML/CSS/JS |

Production URLs：
- Public API（canonical）: `https://tianxi.racing/api/*`（CF Worker apex domain，mTLS proxy 後）
- Frontend（canonical）: `https://tianxi.racing`（apex；underlying host `tianxi-site.pages.dev`）
- Backend Worker direct: `https://tianxi-backend.tianxi-entertainment.workers.dev`（debug / cron 用，平時 user 唔行）

---

## 亮點 (TL;DR)

| 指標 | 規模 |
|---|---|
| 歷史賽果年份 | **2016 – 2026**（11 年） |
| 賽馬日總數 | **886 race days** |
| 賽事總數 | **8,361 races**（每日 × 每場 unique） |
| 賽果 row 數 | **106,004 rows**（每匹馬每場 1 row） |
| 每日每場 artefact | **5 種**（results / commentary / dividends / sectional_times / video_links） |
| 馬匹 Profile 覆蓋 | 動態（backfill in progress） |
| 練馬師 Profile | **67 位**（active roster） |
| 騎師 Profile | **~100 位**（含 apprentice + freelance） |
| Fixture 日曆 cache | **152 race days** (2025-2026) |
| GHA workflow 檔 | **20 個**（每日 cron + D1 sync + 部署 + TG 通知 + ELO Post-Race） |
| 結構化數據總 size | ~90 MB CSV（`utf-8-sig`） |

**消費模式：** 前端/ML/BI 直接 fetch GitHub raw CSV。零 server、零 DB 運維。

---

## 點解存在？

香港賽馬會（HKJC）官方只出 SPA + PDF，冇公開 structured API。
天喜把 HKJC 11 年公開賽果抽象化成穩定 CSV schema，每日自動刷新，為下游 AI 產品（Elo / 選馬模型 / 賠率分析 / BI）提供可信數據層。

- **全自動** — GitHub Actions cron，20 個 workflow 協同跑
- **賽日感知** — `fixture_guard` 非賽日自動跳過，每月慳 ~60% GHA minutes
- **自愈** — 每日 sanity dashboard + integrity audit，遺漏自動開 Issue
- **Idempotent** — 已存在檔案 skip，安全重跑
- **零 vendor lock** — 純 CSV artefact，Python / R / SQL / Excel / JS 即用

---

## 架構一覽

```
┌─────────────────────────────────────────────────────────────┐
│                  HKJC 官方網站 (SPA + SSR)                   │
│  racing.hkjc.com · 賽果 / 排位 / 試閘 / 晨操 / 傷患 / 日曆    │
└─────────────────────────────────────────────────────────────┘
                         │ Selenium + httpx
                         ▼
┌─────────────────────────────────────────────────────────────┐
│          GitHub Actions Orchestrator (10 workflow)          │
│                                                             │
│ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐     │
│ │ Race Day  │ │  Pool A   │ │  Pool B   │ │  Entries  │     │
│ │ 賽果      │ │ 馬匹 DB    │ │ 試閘+騎師  │ │ 排位表     │     │
│ └───────────┘ └───────────┘ └───────────┘ └───────────┘     │
│                                                             │
│ ┌───────────┐ ┌───────────┐ ┌───────────┐                   │
│ │  Trainer  │ │ Fixture   │ │  ELO Post │                   │
│ │ 練馬師     │ │ 日曆       │ │  Race v12 │                   │
│ └───────────┘ └───────────┘ └───────────┘                   │
│                                                             │
│ ┌───────────────────────┐ ┌───────────────────────┐         │
│ │ Sanity (daily 10:03)  │ │ Integrity (daily 11:00)│        │
│ │ 48h 健康報告           │ │ 10-category 缺漏審計     │       │
│ └───────────────────────┘ └───────────────────────┘         │
│                                                             │
│              fixture_guard.sh (pre-flight)                  │
│         查 data/fixtures/ 決定跑唔跑當日 workflow            │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│     Git main branch — CSV artefacts (utf-8-sig, pinned)     │
│                                                             │
│  data/20{16..26}/    horses/profiles/    trainers/          │
│  data/fixtures/      horses/form_records/ jockeys/          │
│  entries/            horses/trackwork/    trials/           │
│  reports/            horses/injury/       horses/pedigree/  │
│                      audit_reports/                        │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│     下游產品 (前端 / ML / Backtest / BI)                      │
│     直接 fetch `raw.githubusercontent.com/...csv`           │
└─────────────────────────────────────────────────────────────┘
```

---

## 爬取器清單（What & How）

每個 scraper 都係獨立 Python module，Selenium（JS-rendered 頁）或 httpx（靜態頁），全部經 `scraper_utils.py` 共用 rate-limit + retry + driver pool。HKJC empirical rate limit ≥0.4 req/s，最多 2 並發 Chrome session。

### 1. `RacingData_Scraper.py` — 賽果主爬蟲

**爬乜：** 每個賽馬日、每場賽事，擷取 **5 個 artefact**：
- `results_YYYY-MM-DD.csv`：25-column 固定 schema（名次、馬名、馬號、騎師、練馬師、距離、場地、賠率、完成時間、位位差、配備…）
- `commentary_YYYY-MM-DD.csv`：逐匹馬嘅 running commentary
- `dividends_YYYY-MM-DD.csv`：獨贏、位置、連贏、位置Q、三重彩、六環彩等賠率
- `sectional_times_YYYY-MM-DD.csv`：每 200m 分段時間
- `video_links_YYYY-MM-DD.csv`：官方 replay URL（MP4 direct link）

**點運作：**
- Selenium Chrome headless，load `racing.hkjc.com/racing/information/Chinese/Racing/LocalResults.aspx`
- Iterate `race_no=1..N`，wait for `table.f_tac` render
- Parse `<td>` cells → pandas DataFrame → CSV
- **`--daily` mode**：只爬今日，先問 `fixture_guard.sh` 有冇賽，冇就 exit 0
- **`--date YYYY-MM-DD` mode**：爬特定日子
- **`--backfill` mode**：多 worker 並行爬歷史年份（初次 bootstrap 用）

**Trigger：** `capy_race_daily.yml` — HK 23:30 每日 cron（賽日夜場完結後），GHA job step 1 先 fixture_guard。

---

### 2. `HorseData_Scraper.py` — 馬匹 Profile + 往績（Pool A 核心）

**爬乜：**
- `horses/profiles/horse_profiles.csv`：每匹馬 profile（品種、產地、年齡、父系、母系、母父、染色、毛色、進口日期、練馬師、馬主、當前評分、出生地、cohort code、first-race date、last-race date…）
- `horses/form_records/form_XXXX.csv`：每匹馬完整出賽紀錄（21 column，直到最新一場）

**點運作：**
- 先掃 `data/*/results_*.csv` 抽出所有獨特馬匹 `(XNNN)` code（X = A-L cohort letter）
- 對每匹馬 load `racing.hkjc.com/racing/information/Chinese/Horse/Horse.aspx?HorseId=XXXX`
- Parse profile table + full form-record table
- `comeback_detection.py` 決定要唔要 rescrape（已退役 + 冇 update 就 skip）
- `lifecycle_helper.py` 識別 active / inactive / retired

**Trigger：** `capy_pool_a.yml` — HK 04:00 每日 cron。Fixture-aware：**昨日非賽日就 skip**（fresh last_race_date 未 update，冇嘢好 diff）。`force=true` dispatch 可 override。

---

### 3. `HorseTrackwork_Scraper.py` — 晨操紀錄

**爬乜：** `horses/trackwork/trackwork_XXXX.csv` — 每次訓練 session（日期、時段、練習類型：G/T/C/Sw/Slip、跑道、距離、時間、rider）。

**點運作：**
- 從 horse profile 頁面 navigate 去「晨操紀錄」tab
- Parse full trackwork table（好多馬有幾百 row）
- Incremental：每次只 append 新 session

**Trigger：** Pool A 內序貫跑（在 HorseData 之後）。

---

### 4. `HorseInjury_Scraper.py` — 獸醫 / 傷患紀錄

**爬乜：** `horses/injury/injury_<brand_no>.csv` — 每個獸醫事件（日期、詳情、通過日期）。

**點運作：**
- 需要 `horseid` (HK_YYYY_BRAND 格式，非 XNNN)，所以先 cache `_horseid_map.json`
- 第一次：掃 horse profile 解 horseid；之後：直接 map lookup
- Load `racing.hkjc.com/zh-hk/local/information/ovehorse?horseid=HK_YYYY_BRAND`
- **pure httpx + regex**（非 Selenium），因為係靜態 table
- 有紀錄先寫 CSV，冇記錄就唔寫（省空間）

**Trigger：** Pool A 內序貫跑（最後 step）。

---

### 5. `TrainerData_Scraper.py` — 練馬師 Profile + 往績

**爬乜：**
- `trainers/trainer_profiles.csv` — 67 位練馬師 profile（勝率、名次率、獎金、當季 stats）
- `trainers/records/trainer_CODE.csv` — 每位練馬師全部場次紀錄

**點運作：**
- Load trainer ranking page → 抽所有 `name → code` mapping
- 對每個 code scrape profile stats + 歷屆紀錄
- **Dedup-clean**：HKJC SPA 偶發雙 render，用 `keep=last` 保留最新

**Trigger：** `capy_trainer_fix.yml` — HK 01:00 每日 cron（fixture-aware：過去 2 日有賽先跑）。

---

### 6. `JockeyData_Scraper.py` — 騎師 Profile + 往績

**爬乜：**
- `jockeys/jockey_profiles.csv` — ~100 位騎師（含 apprentice + freelance）
- `jockeys/records/jockey_CODE.csv` — 每位騎師歷屆紀錄（13-col record：排名、場地、距離、級別、場地狀況、馬名、檔位、評分、練馬師、配備、體重、實際磅重）

**點運作：** 同 trainer 邏輯一致，但 URL 係 `jockeypastrec.aspx`。

**Trigger：** `capy_pool_b_daily.yml` — HK 02:00 每日，跟 TrialResults 一齊跑（~20 min wall-clock）。

---

### 7. `TrialResults_Scraper.py` — 試閘結果

**爬乜：**
- `trials/trial_results.csv` — 18-col 試閘結果（日期、組別、場地、距離、場地狀況、組別時間、每匹馬分段、馬名、騎師、練馬師、檔位、配備、位位差、running position、完成時間、result、commentary）
- `trials/trial_sessions.csv` — group-level summary

**點運作：**
- Load `racing.hkjc.com/zh-hk/local/information/btresult`
- Parse every trial session group → 每匹馬展開 1 row
- Skip 已存在 session（idempotent）

**Trigger：** Pool B Daily 內跑（先 TrialResults 後 JockeyData）。

---

### 8. `EntryList_Scraper.py` — 排位表（race card）

**爬乜：**
- `entries/today_entries.txt` — 下場賽馬日嘅所有 horse code（header：`# meeting=YYYY-MM-DD`）
- `entries/entries_<YYYY-MM-DD>.txt` — dated archive（只喺完全成功先寫）

**點運作：**
- SPA readiness：同時 wait「horse link render」或「沒有相關資料」sentinel 先 judge race empty
- Per-race retry on timeout（防 transient render fail）
- End-of-meeting only declared on confirmed sentinel **after page fully loaded**（唔可以靠 timeout 斷定）
- **Fail-closed**：任何錯誤寫 empty stale-marker，downstream loader 會識 skip override

**下游用途：** Pool A 讀 `today_entries.txt` 觸發 **comeback override** — 冷門退役馬如果再 entry，即使 `should_scrape()` judge 係 dormant，都強制 rescrape profile。

**Trigger：** `capy_entries.yml` — HK 20:00 逢星期一、二、六 cron（即下場賽馬日前一晚）。

---

### 9. `FixtureCalendar_Scraper.py` — 賽馬日年曆

**爬乜：** `data/fixtures/fixtures.csv`（152 rows，2025-2026）+ `data/fixtures/<year>_fixtures.csv`

Columns: `date, season_year, month, day, weekday, captured_at`

**點運作：**
- **httpx + regex（零 Selenium）**，因為 HKJC 年曆係 server-rendered
- Loop every month：`Fixture.aspx?calyear=Y&calmonth=M`
- Extract `<td class="calendar">DD</td>` cells（有賽）
- Skip `<td class="font_wb ">DD</td>` (non-race weekday) 同 `<td class="color_H font_wb">DD</td>` (other-month filler)
- **Venue-marker sanity gate**：交叉驗證 HKJC LocalResults API 回傳 `norace` 就剔除（防 phantom dates）

**Trigger：** `capy_fixture_weekly.yml` — 每星期一 HK 05:00 cron（HKJC 通常週日發佈下季賽期）。

**點解咁重要：** `fixture_guard.sh` 用呢個 cache，所有 workflow pre-flight check 先避免非賽日 wake 到 HKJC。

---

### 10. `RunAll_Scrapers.py` — Legacy orchestrator

Backfill / developer tooling，**不參與 daily cron**。跑佢會序貫執行所有 scraper 一次（~6 hour wall-clock），主要用喺 initial bootstrap 同 manual repair。

---

### 11. `HorsePedigree_Scraper.py` — 馬匹血統（含新馬自動補抓）

**爬乜：**
- `horses/pedigree/horse_pedigree.csv` — 父系（sire）、母系（dam）、外祖父（dam_sire）等血統欄位
- 專門回填由 CSV → D1 同步過程中遺漏嘅血統資料，令新馬即使無往績都能有血統特徵可用

**點運作：**
- 自動從三個來源收集馬匹 code：
  1. 今日／近期排位表（`entries/`）— 優先抓新馬
  2. 現有 `horse_profiles.csv` — 種入已經有 profile 但血統未同步嘅馬
  3. 歷年賽果（`data/20*/results_*.csv`）— 全池補漏
- 只抓血統欄位不完整嘅馬，避免重複請求
- 純 `requests` + HKJC 共用解析器，唔需要 Selenium，輕量可跑喺 GitHub Actions
- 輸出 CSV 後由 `scripts/pedigree_to_d1_sql.py` 生成 upsert SQL，回填 D1 `horse_pedigree` 表同 `horses.sire/dam/dam_sire`

**Trigger：**
- `capy_pedigree.yml` — 香港時間逢一、二、六 21:30 跑「排位表模式」（只抓新 entry 馬）；逢三 05:00 跑「全池補抓模式」（上限 600 匹）。workflow_dispatch 支援 `mode`、`limit`、`refresh-all`。

**現狀：** 已種入 6,068 匹血統，父系 / 母系 / 外祖父全部有值；生產 D1 `horses.sire` 由原本 16 匹提升至 6,068 匹。

---

## D1 自動同步 · capy_d1_sync（NEW 2026-04-30）

兩條 workflow 負責將 tianxi-database 嘅 CSV 自動推上 Cloudflare D1（`tianxi-db`）：

| Workflow | Trigger | 處理範圍 |
|---|---|---|
| `capy_d1_sync.yml` | 跟 `capy_race_daily` 成功後 auto-trigger | 當日 race_meetings / races / race_results / dividends / running_comments + 相關 FK parent (horses / jockeys / trainers) + 當日 ELO snapshots |
| `capy_d1_sync_pool_a.yml` | 跟 `capy_pool_a` 成功後 auto-trigger | 30 日內 horse_trackwork / horse_injury / horse_form_records + 相關 horses |

兩條 workflow 都 checkout `tianxi-backend` 嘅 `scripts/import-csv.ts`（CSV → 臨時 bulk-local.db）同 `scripts/push-delta.ts`（date-scoped delta → SQL chunks → `wrangler d1 execute` 按 FK parent-first 順序逐 chunk push）。需要 repo secret `TIANXI_BACKEND_PAT` + `CF_API_TOKEN` + `CF_ACCOUNT_ID`。

---

## 調度策略 (Calendar-Aware Scheduling)

每條 workflow 開工前必跑 `scripts/fixture_guard.sh --window N --direction past|future|any`。

| Workflow | Cron (HKT) | Fixture Guard | 目的 |
|---|---|---|---|
| Race Day | 23:30 每日 | 今日有賽 | 抓當日 5 artefact |
| Pool A | 04:00 每日 | 昨日有賽（force 可 override） | 馬匹 DB delta |
| Pool B Daily | 02:00 每日 | 冇（輕量，日日跑唔傷） | 試閘 + 騎師 |
| Trainer | 01:00 每日 | 過去 2 日有賽 | 練馬師 SPA refresh |
| Entries | 20:00 逢一、二、六 | 明日有賽 | 下場排位表 |
| Fixture Weekly | 週一 05:00 | 冇 | 年曆 cache refresh |
| ELO Post-Race | 賽後即跑（race_daily 完成觸發） | 過去 2 日有賽 | ELO v12 增量更新（落 D1）|
| Sanity Daily | 10:03 | 冇 | 生成 SANITY.md |
| Integrity Audit | 11:00 | 冇 | 10-cat 缺漏審計 |
| Pedigree | 一/二/六 21:30 + 三 05:00 | 冇（輕量） | 新馬血統自動補抓 + 全池回填 |

---

## 數據層 (Data Artefacts)

```
data/
├── fixtures/                       # 年曆 cache
│   ├── fixtures.csv                # 152 rows (2025-2026)
│   └── 2026_fixtures.csv
├── 2016/ … 2026/                   # 每年賽果 — 5 類 artefact per race day
│   ├── results_YYYY-MM-DD.csv          # 25-col 賽果
│   ├── commentary_YYYY-MM-DD.csv       # running commentary
│   ├── dividends_YYYY-MM-DD.csv        # 賠率
│   ├── sectional_times_YYYY-MM-DD.csv  # 分段時間
│   └── video_links_YYYY-MM-DD.csv      # replay URL
horses/
├── profiles/horse_profiles.csv     # 馬匹 profile（動態列）
├── form_records/form_XXXX.csv      # 每匹馬完整出賽紀錄（21-col）
├── trackwork/trackwork_XXXX.csv    # 晨操
├── injury/injury_<brand>.csv       # 獸醫紀錄
└── pedigree/horse_pedigree.csv     # 父系 / 母系 / 外祖父（6,068 匹覆蓋）
trainers/
├── trainer_profiles.csv            # 67 位
└── records/trainer_CODE.csv        # 往績
jockeys/
├── jockey_profiles.csv             # ~100 位
└── records/jockey_CODE.csv         # 13-col 往績
trials/
├── trial_results.csv               # 18-col 試閘
└── trial_sessions.csv              # group summary
entries/
├── today_entries.txt               # 下場 race card
└── entries_<DATE>.txt              # dated archive
audit_reports/
├── integrity_YYYY-MM-DD.json       # 每日 audit JSON
├── integrity_latest.json           # 最新 snapshot
└── SUMMARY.md                      # human-readable summary
reports/
└── SANITY.md                       # 每日健康報告
```

所有 CSV：**UTF-8-BOM** (Excel-friendly) · **Schema 穩定** · **Column order pinned**。

---

## 評分層 (TX-Oracle v3)

模型分兩層，全部落 tianxi-backend Cloudflare D1：

**ELO v12 (`elo-post-race.yml`)** — 賽後即時跑（race_daily 完成觸發），增量更新 horse / jockey / trainer ELO。5 個 axis：`overall` · `turf_sprint` · `turf_mile` · `turf_middle` · `turf_staying`。Snapshot 規模 ~82K horse / 39K jockey / 37K trainer。

**LightGBM lambdarank (`lgb_backfill.yml`)** — `tianxi-backend` 跑，graded labels (1/2/3 finishing pos 反映 placement quality)，val-tuned `τ_lgb` / `τ_elo`。**訓練窗口 2016-09-01 → 今日全歷史**（2026-05-28 擴展，~8,058 races / ~98k rows；單日 `workflow_dispatch` 可補新賽日）。

**Ensemble blend** — `applyEnsembleBlend` 喺每場做 per-race z-norm：
`finalScore = 1500 + (α·lgb_z + (1-α)·elo_z + factor·0.5)·100`，nominal α=0.88（2026-05-31 升；每賽日由 `lgb_predict_upcoming.yml` auto-gate 自癒：PASS→0.88 / FAIL→0 純 ELO。舊 offline sweep 曾揀 α=0.62）。

α tuner workflow（`alpha_tune.yml`，ADMIN_TOKEN-gated）+ server-side per-(date,alpha) cache，後續 re-tune 唔再食 wall clock。

---

## 數據完整性 (Integrity Audit)

核心原則：**數據係命根，唔可以遺漏。**

`tools/data_integrity_audit.py` 每日 HK 11:00 跑，掃 10 個 category：

1. race_artefacts（每個 race day 5 個 artefact 齊）
2. fixtures_cache（年曆新鮮度）
3. horse_profiles（現役馬 180 日內落場必須有 profile）
4. horse_form_records（對應 form record 齊）
5. jockey_profiles
6. jockey_records
7. trainer_profiles
8. trainer_records
9. trial_results
10. entries_upcoming

Exit codes: `0`=ok · `1`=warn · `2`=critical

**Critical** 會自動開 GitHub Issue（有 dedupe）+ 紅 badge。

[![Integrity](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_integrity_audit.yml/badge.svg)](https://github.com/sleepingarhat/tianxi-database/actions/workflows/capy_integrity_audit.yml)

---

## 快速上手（下游用戶）

### Python

```python
import pandas as pd

BASE = "https://raw.githubusercontent.com/sleepingarhat/tianxi-database/main"

# 讀某一場賽果
df = pd.read_csv(f"{BASE}/data/2025/results_2025-09-07.csv", encoding="utf-8-sig")

# 讀馬匹 profile
horses = pd.read_csv(f"{BASE}/horses/profiles/horse_profiles.csv", encoding="utf-8-sig")

# 讀練馬師
trainers = pd.read_csv(f"{BASE}/trainers/trainer_profiles.csv", encoding="utf-8-sig")

# 讀年曆
fixtures = pd.read_csv(f"{BASE}/data/fixtures/fixtures.csv", encoding="utf-8-sig")
```

### JavaScript / Frontend

```javascript
const BASE = "https://raw.githubusercontent.com/sleepingarhat/tianxi-database/main";
const res  = await fetch(`${BASE}/data/fixtures/fixtures.csv`);
const text = await res.text();
// parse with PapaParse / d3.csvParse / etc.
```

### GitHub Actions (下游 CI)

```yaml
- uses: actions/checkout@v4
  with: { repository: sleepingarhat/tianxi-database, path: tianxi-data }
- run: ls tianxi-data/data/2026/
```

---

## 健康監察

- **每日 HK 10:03** — `capy_sanity_daily.yml` 生成 `reports/SANITY.md`（10 條 workflow 48h 成功率 + artefact freshness + 今日 fixture）
- **每日 HK 11:00** — `capy_integrity_audit.yml` 生成 `audit_reports/SUMMARY.md`（10-cat gap count + recommendation）
- 查閱最新：[reports/SANITY.md](./reports/SANITY.md) · [audit_reports/SUMMARY.md](./audit_reports/SUMMARY.md)

---

## Roadmap

**完成**
- [x] 全量 GHA 部署（9 workflow，2026 年起 10 條：+ ELO Post-Race）
- [x] Calendar-aware scheduling（`fixture_guard.sh`）
- [x] Sanity dashboard + Data Integrity Audit + auto-Issue
- [x] Pool A 全量接管（horse-data 4 shards + injury + trackwork 4 shards）
- [x] 1,300 現役馬 profile 全量覆蓋（audit 1300/1300，form_records 1299/1300 自愈中）
- [x] Phantom-meeting pre-filter
  - `meetings.ts` anti-ghost SQL filter（同日 sibling 場數較多即剔短場）
  - `scrape-racecard.ts` `totalRunners > 0` guard（取代脆嘅 local DB 證據檢查）
  - `capy_d1_sync.yml` auto cleanup hook
- [x] **TX-Oracle v3 ensemble**（取代原 "Elo v2"）— LightGBM lambdarank + ELO v12 probability-level blend，α=0.62 val-tuned
  - `lgb_backfill.yml` 單日補算 workflow
  - `alpha_tune.yml` ADMIN_TOKEN-gated α 掃描 + per-(date,alpha) server cache
- [x] **Public read-only API** — `https://tianxi.racing/api/*`（CF Worker apex domain），開放 `/api/meetings`、`/api/analyze/top-picks`、`/api/analyze/hit-rate`、`/api/analyze/today-picks`

**進行中 / 短期**
- [ ] form_records 100% 覆蓋（1299/1300，單馬 gap 自動 heal）
- [ ] HKJC 5/27 起 racecard 詳情賽前自動 enrich（T-1/T-2 publish window 監察）
- [x] LGB model 自動 retrain（`lgb_predict_upcoming.yml` cron 04:00 HKT + `capy_racecard` 成功後 cross-repo dispatch；`lgb_backfill.yml` 補算）
- [ ] τ_lgb / τ_elo 重 tune（與 α 同步定期 refresh）
- [ ] Pool A `horse-injury` 並行化（目前單 thread ~160min，shard 後可縮到 ~40min）

**長期**
- [ ] 場地修正 model（going × distance × draw 交互項加入 LGB feature）
- [ ] Backtest harness 自動回歸測試（替代 manual `/api/analyze/hit-rate` 抽查）
- [ ] OpenAPI spec for `tianxi.racing` 公開 API

---

## 許可 & 使用條款

HKJC 原始賽果為公開資訊，本 repo 只做 **結構化重組** 同 **schema 穩定化**，不包括 HKJC 圖片、影片內容、或任何付費 pool 數據。下游使用請尊重 HKJC 原站 rate contract（≥0.4 req/s）。本 repo 內部爬取限流 ~0.5-2.5 req/s，符合 empirical 安全區。

---

## 技術支援

- GHA 狀態：<https://github.com/sleepingarhat/tianxi-database/actions>
- 每日 sanity：[reports/SANITY.md](./reports/SANITY.md)
- Integrity audit：[audit_reports/SUMMARY.md](./audit_reports/SUMMARY.md)
- 系統規劃：[plan.md](./plan.md)
- Data schema 詳情：[DATA_NOTES.md](./DATA_NOTES.md)

*Maintained by Capy / GitHub Actions · 20 個 workflow 24/7 自主運行 · 每日自動數據完整性審計。*


  ## 已知問題修復記錄

  ### 2026-05-10 · Scraper R1 重複 bug（5/9 賽果 backfill）

  **症狀**：5/9 沙田 11 場賽果 `results_2026-05-09.csv` 寫入 126 行，但全部 race_no=1（即 R1 重複 9 次），R2–R11 完全缺失。`commentary_2026-05-09.csv` / `dividends_2026-05-09.csv` 同樣中招。

  **Root cause**（兩層）：
  1. `get_race_urls(driver, formatted_date, venue)` 由 racecard 主頁攞 `<a href>`，但同一場馬會出現多次連結（meeting nav + body + footer），無 dedupe。當 collapse 到 set 後可能淨返 1 條。
  2. HKJC 對 non-existent race_no 唔會 404，會默默 fallback 渲染 R1。原 main loop 無 `seen_race_nos` guard，每次 iter 都重新解 R1 同一場。

  **Fix（3 個 commit, on `main`）**：
  - `e1b96572` — `get_race_urls`: URL set 去重；若 distinct < 2，主動 probe RaceNo=2..14 補回連結
  - `99e15503` — 修復 dedupe loop 嘅 indentation（4/8 vs 6/10 space 混用導致 SyntaxError）
  - `caa0bc06` — 還原 `divs = parse_dividends(driver)` 行（前序 patch 不慎 drop 咗）
  - main loop 加 `seen_race_nos = set()`，遇到重複 race_no 即 `continue`

  **Verification**：手動 dispatch `capy_race_daily` workflow_dispatch（`date=2026-05-09, force=y`）GHA #43 ✅ success，5/9 CSV 重生為 143 rows × 11 races，每場 winner 唔同（R1 鵲橋飛昇 → R11 錶之星河）。

  **防再犯**：未來若 `get_race_urls` 返 1 條 URL 應視為 anomaly；建議下游 ingest pipeline 加 race_no diversity sanity check（每個賽馬日 distinct race_no ≥ 8）。
  