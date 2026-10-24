# 天喜後端 · tianxi-backend

天喜賽馬預測的生產 API 與 TX-Oracle v3.2 引擎。

公開站台：[tianxi.racing](https://tianxi.racing)

## 產品

TX-Oracle 對每場香港賽馬輸出獨贏、頭三、頭四機率與排名。模型用 LightGBM LambdaRank 學習名次順序，再與多軸 Elo 組合；臨場獨贏賠率只作參考欄，不進入排名模型。馬季中按賽程輸出訓練健康指標；休馬季自動暫停定時更新，新馬季開跑後自動恢復。

截至上季最後一日（2026-07-15），引擎仍用當日凍結的預測紀錄，不改寫歷史戰績。

Elo 快照存於 D1。賽果本身按日同步；若快照缺月，由 `d1_fill_elo_gap` 工作流用 2016 起連續重算後只補缺口月份，不抹掉已有列、不改 LambdaRank 權重。

## 生態（2026-10-24現行）

首200名創始會員於開閘日起享52週Pro（HK$4,056）；門檻200不自動開閘，付款驗收及用戶明確批准後才收款。Stripe HK$78／週自動續訂；Crypto US$416／52週一次付，展示HK$3,244.80八折，不自動續期。現時不收款，Crypto及賽日提示未啟用，付款環境維持live；愛駒上限30／3／90，愛駒通知不加開閘檢查。

正式站 https://tianxi.racing 已發布。平台驗證排程：weather-archive-managed每5分鐘、weather-sync-github-managed每日23:50 HKT、race-results-dispatch-managed每日23:31／01:31 HKT；首次均200，兩項天氣安全略過，賽果派送獲接納但不等於收齊。正常首次後已停舊weather-archive-5min、weather-sync-github-nightly及race-results-dispatch。逐場收料保留，全日首次核實官方完場後30分鐘主收料；固定深夜只為後備。

鎖前官方更改只重算受影響場次；鎖後不補位，保留原四揀，退出／未完賽逐匹無效，命中分母固定4；鎖前退出未及重算亦按原四揀／4。實際換騎另記，不重算原凍結。官方彩池替補／退款只用於原注结算，不能改模型四揀。

- tianxi-racing：賽馬服務與資料；tianxi-web：網站鏡像，正式站由Lovable發布。
- domain-brain：衍生知識；tianxi-research：私有研究及退役足球／六合彩技術，不屬現行會員產品。
- tianxi-database：賽事資料鏡像；不改歷史凍結或SHA。

## 技術

- Cloudflare Workers（Hono）+ D1
- TX-Oracle v3.2：LambdaRank + Elo v12 + 因子補償
