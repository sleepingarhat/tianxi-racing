#!/usr/bin/env tsx
/** Racecard HTML cells that the whitelisted GraphQL query does not carry. */
import assert from 'node:assert/strict';
import { assertRacecardColumns, parseRacecardColumns, RacecardColumnError } from './ingest/lib/racecard-columns.js';

function row(cells: string[], horseId = 'HK_2024_K308'): string {
  const body = cells.map((value, index) => {
    if (index === 3) return `<td><a href="/zh-hk/local/information/horse?horseid=${horseId}">${value}</a></td>`;
    return `<td>${value}</td>`;
  }).join('');
  return `<tr>${body}</tr>`;
}

const HEAD = ['馬匹編號', '6次近績', '綵衣', '馬名', '烙號', '負磅', '騎師', '可能超磅', '檔位', '練馬師', '國際評分', '評分', '評分+/-', '排位體重', '排位體重+/-', '最佳時間', '馬齡', '分齡讓磅', '性別', '今季獎金', '優先參賽次序', '上賽距今日數', '配備', '馬主', '父系', '母系', '進口類別'];

function card(data: string[]): string {
  const header = HEAD.map((title) => `<td>${title}</td>`).join('');
  return `<table class="starter f_tac"><tr>${header}</tr>${data.join('')}</table>`;
}

const first = row(['1', '13/3/10/12/9/11', '', '電路一百', 'K308', '135', '巫顯東 (-2)', '', '2', '沈集成', '-', '40', '-1', '1101', '+29', '1.42.43', '5', '-', '閹', '134,550', '+ 1', '41', 'B/XB/TT', '何燕生與曾建華', 'Zoustar', 'Reconstruct', 'PPG']);
const second = row(
  ['2', '6/12/6/10/9/8', '', '猶有心得', 'K394', '133', '奧璇璧', '', '1', '桂福特', '-', '38', '-2', '1098', '-13', '', '4', '-', '閹', '23,400', '1', '31', '', '吳嵩', 'Starspangledbanner', 'Miss Delima', 'PPG'],
  'HK_2024_K394',
);
const zero = row(
  ['3', '', '', '健康小馬', 'L046', '133', '艾道拿', '', '7', '鄭俊偉', '-', '38', '0', '1033', '0', '1.40.19', '5', '-', '閹', '0', '+ 1', '23', 'H/P', '曾佐禧', 'Proisir', 'Sebrings Drama', 'PPG'],
  'HK_2024_L046',
);

const rows = parseRacecardColumns(card([first, second, zero]));
assert.ok(rows);
assert.equal(rows.get(1)?.ratingChange, -1);
assert.equal(rows.get(1)?.bodyWeightChange, 29);
assert.equal(rows.get(1)?.bestTime, '1.42.43');
assert.equal(rows.get(1)?.daysSinceRun, 41);
assert.equal(rows.get(1)?.horseId, 'HK_2024_K308');
assert.equal(rows.get(2)?.bestTime, null);
assert.equal(rows.get(2)?.bodyWeightChange, -13);
assert.equal(rows.get(2)?.daysSinceRun, 31);
assert.equal(rows.get(3)?.ratingChange, 0);
assert.equal(rows.get(3)?.bodyWeightChange, 0);

const runners = [
  { no: 1, horse: { id: 'HK_2024_K308', code: 'K308' } },
  { no: 2, standbyNo: '0', horse: { id: 'HK_2024_K394', code: 'K394' } },
  { no: 3, horse: { id: 'HK_2024_L046', code: 'L046' } },
  { no: 1, standbyNo: '1', horse: { id: 'HK_2022_H454', code: 'H454' } },
];
assertRacecardColumns(rows, runners);

assert.equal(parseRacecardColumns('<div>no table</div>'), null);

assert.throws(() => parseRacecardColumns(card([row(['1', ...'x'.repeat(25).split('')], 'HK_2024_K308')])), RacecardColumnError);
assert.throws(() => {
  const bad = row(['1', '13/3/10/12/9/11', '', '電路一百', 'K308', '135', '巫顯東', '', '2', '沈集成', '-', '40', '1101', '+29', '1.42.43', '5', '-', '閹', '134,550', '+ 1', '41', 'B', '主', 'S', 'D', 'PPG', 'ISG']);
  parseRacecardColumns(card([bad]));
}, RacecardColumnError);
assert.throws(() => assertRacecardColumns(rows, [{ no: 1, horse: { id: 'HK_2024_K999', code: 'K999' } }]), RacecardColumnError);

console.log('racecard column tests passed');
