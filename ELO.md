# 天喜 Elo v12 公式說明

更新：2026-10-17　源碼：backend/scripts/elo/engine.ts、backend/scripts/elo/compute.ts、backend/src/routes/analyze.ts

## 1. 參數
| 項目 | 值 |
|---|---|
| K 值 | 40（預設，可用 --k 改） |
| 初始評分 | 1500 |
| 評分對象 | 馬匹、騎師、練馬師各自獨立 |

## 2. 期望勝率同更新
一場有 N 匹完成賽事。對每一對 i、j（i 名次較好）：

```text
expected_i = 1 / (1 + 10^((R_j − R_i) / 400))
expected_j = 1 / (1 + 10^((R_i − R_j) / 400))
delta_i   += K / (N − 1) × (1 − expected_i)
delta_j   += K / (N − 1) × (0 − expected_j)
```

- 每匹馬嘅變動係佢同其餘 N−1 匹比較嘅總和；全部計完先一次過套用。
- 同名次：實際得分當 0.5／0.5。
- 未完成（DNF／PU，名次 999）唔參與配對，評分不變。
- 每個快照只用該場之前嘅賽果（as-of），賽後由 elo-post-race 增量更新。

## 3. 綜合分（elo_composite）
```text
elo_composite = (0.7 × 馬匹 + 0.2 × 騎師 + 0.1 × 練馬師) ÷ 有資料權重之和
```
騎師或練馬師冇評分時，只用有資料嘅部分重新按比例計。權重可經回測調整後存入設定；以上係預設值。

## 4. 五個評分軸
馬匹快照分 overall、turf_sprint、turf_mile、turf_middle、turf_staying 五軸儲存。

**正式預測只讀 overall 軸，其餘四軸冇加權入預測，所以冇「五軸權重」。** 四個途程軸目前只作研究用途。騎師、練馬師只有單一評分。

## 5. 未公開或未有紀錄
- v12 快照另有 confidence、is_provisional、is_frozen 等欄位；產生呢啲欄位嘅程式唔喺本倉，計法暫未能公開核對。


網頁版：https://tianxi.racing/model
