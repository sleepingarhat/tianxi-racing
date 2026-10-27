/**
 * import-csv.ts 回歸測試：134 行缺配對嘅兩個根源。
 * 1) 雙字母馬匹編號（CL247）要認到，唔好跌落水名後備 ID。
 * 2) 平頭馬「3 平頭馬」係有效名次，唔好當無效資料。
 */
import { extractHorseCode, parseFinishingPlace } from "./import-csv";
import { parseScrapedFinishingPosition } from "../src/lib/finishing-position";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

// 馬匹編號抽取
check("單字母編號 J345", extractHorseCode("喆喆友福 (J345)"), { name: "喆喆友福", code: "J345" });
check("雙字母編號 CL247", extractHorseCode("天外之天 (CL247)"), { name: "天外之天", code: "CL247" });
check("雙字母編號 CM199", extractHorseCode("幸運之星 (CM199)"), { name: "幸運之星", code: "CM199" });
check("三字母編號 ABC123", extractHorseCode("測試馬 (ABC123)"), { name: "測試馬", code: "ABC123" });
check("無編號", extractHorseCode("純名馬"), { name: "純名馬", code: "" });

// 名次解析
check("普通名次 3", parseFinishingPlace("3"), 3);
check("平頭馬 3 平頭馬", parseFinishingPlace("3 平頭馬"), 3);
check("平頭馬 1 平頭馬", parseFinishingPlace("1 平頭馬"), 1);
check("英文死熱 1 DH", parseFinishingPlace("1 DH"), 1);
check("英文死熱 2DH", parseFinishingPlace("2DH"), 2);
check("中文數字 三", parseFinishingPlace("三"), 3);
check("中文數字 第十一", parseFinishingPlace("第十一"), 11);
check("第3名", parseFinishingPlace("第3名"), 3);
check("全形數字 ８", parseFinishingPlace("８"), 8);
check("無效 ---", parseFinishingPlace("---"), null);
check("DNF", parseFinishingPlace("DNF"), null);
check("PU", parseFinishingPlace("PU"), null);
check("WV-A", parseFinishingPlace("WV-A"), null);
check("空值", parseFinishingPlace(""), null);
check("undefined", parseFinishingPlace(undefined), null);

check("scrape 普通名次", parseScrapedFinishingPosition("4"), 4);
check("scrape 死熱唔好變 999", parseScrapedFinishingPosition("1 DH"), 1);
check("scrape 平頭馬", parseScrapedFinishingPosition("3 平頭馬"), 3);
check("scrape 中文數字", parseScrapedFinishingPosition("八"), 8);
check("scrape PU 維持 999", parseScrapedFinishingPosition("PU"), 999);
check("scrape WV-A 維持 999", parseScrapedFinishingPosition("WV-A"), 999);
check("scrape 破折號維持 999", parseScrapedFinishingPosition("---"), 999);

if (failures > 0) {
  console.error(`\n${failures} 項失敗`);
  process.exit(1);
}
console.log("\n全部通過");
