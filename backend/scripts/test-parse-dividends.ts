/**
 * Partial-unit dividends must be converted to per-$10 payouts.
 */
import assert from 'node:assert/strict';
import { dividendPer10, parseHkjcDividends } from '../src/lib/parse-dividends';

assert.equal(dividendPer10('8,401.00'), 8401);
// 2026-11-08 ST R7 四重彩: official 235,071.20 per $1 partial unit.
assert.equal(dividendPer10('235,071.20/$1.0'), 2350712);
for (const bad of ['退款', '', '詳情', '1.0/$0', '1.0/$20']) assert.equal(dividendPer10(bad), null);

const html = '<table><tr><td>勝出組合</td></tr></table><tbody>'
  + '<tr><td>四重彩</td><td>14,10,9,12</td><td>235,071.20/$1.0</td></tr>'
  + '<tr><td>三重彩</td><td>14,10,9</td><td>171,545.00</td></tr></tbody>';
const rows = parseHkjcDividends(html);
assert.deepEqual(rows.map(r => [r.poolZh, r.dividend]), [['四重彩', 2350712], ['三重彩', 171545]]);
console.log('parse-dividends partial-unit regression OK');
