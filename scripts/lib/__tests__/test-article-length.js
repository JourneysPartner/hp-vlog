'use strict';

/**
 * 本文長の計測・下限判定のテスト。
 *
 * 背景: 本文長を 5,000〜7,000 文字へ引き上げた際、
 *   - frontmatter の除去を `split('---')` でやると本文中の区切りで切れて過小評価
 *   - WORD_COUNT_GUIDE（プロンプト文言）と WORD_COUNT_RANGE（判定値）の乖離
 * のどちらも「短い記事が黙って通る」事故に直結するため、両方を検証する。
 */

const assert = require('assert');
const { measureBodyLength, checkBodyLength } = require('../article-length');
const {
  WORD_COUNT_GUIDE,
  WORD_COUNT_RANGE,
  WORD_COUNT_FLOOR_RATIO,
} = require('../article-prompt-static');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}`); fail++; }
}

const fm = (body) => `---\ntitle: "t"\nslug: "s"\n---\n\n${body}`;

console.log('=== Test 1: measureBodyLength は frontmatter を除外する ===');
ok(measureBodyLength(fm('あいうえお')) === 5, 'frontmatter を除いた本文のみ数える');
ok(measureBodyLength('ただの本文') === 5, 'frontmatter が無ければ全体を数える');
ok(measureBodyLength('') === 0, '空文字は 0');
ok(measureBodyLength(null) === 0, 'null は 0');
ok(measureBodyLength(undefined) === 0, 'undefined は 0');
ok(measureBodyLength(fm('  本文  \n\n')) === 2, '前後の空白を除いて数える');

console.log('\n=== Test 2: 本文中の --- で切れない（過小評価しない）===');
// 免責文の前に --- を置く実際の記事構造
const withRules = fm('本文です。\n\n---\n\n免責文です。\n\n---\n\nCTAです。');
const expected = '本文です。\n\n---\n\n免責文です。\n\n---\n\nCTAです。'.length;
ok(measureBodyLength(withRules) === expected,
  `本文中の --- を含めて数える（実測 ${measureBodyLength(withRules)} / 期待 ${expected}）`);
ok(measureBodyLength(withRules) > measureBodyLength(fm('本文です。')),
  '区切り以降が切り捨てられていない');

console.log('\n=== Test 3: CRLF 改行でも動く ===');
const crlf = '---\r\ntitle: "t"\r\n---\r\n\r\nあいう';
ok(measureBodyLength(crlf) === 3, 'CRLF の frontmatter を除去できる');

console.log('\n=== Test 4: 文字数指示のキャリブレーション ===');
// GUIDE（LLM への指示）は RANGE（受入基準）より小さくなければならない。
// LLM は指示値を約 1.11 倍で超過するため、指示値をそのまま受入基準にすると必ず超過する。
// 実測: 2026-08-15 本命 7,000指示→7,767実測 / 補強 5,000指示→5,552実測
const OVERSHOOT = 1.11;
for (const [type, guide] of Object.entries(WORD_COUNT_GUIDE)) {
  const m = guide.match(/^(\d+)〜(\d+)文字/);
  const r = WORD_COUNT_RANGE[type];
  ok(!!m, `${type}: GUIDE が「N〜M文字」形式`);
  ok(!!r, `${type}: RANGE に定義がある`);
  if (m && r) {
    const gMin = Number(m[1]), gMax = Number(m[2]);
    ok(gMax < r.max,
      `${type}: 指示上限(${gMax}) < 受入上限(${r.max}) — 指示値がキャリブレーション済み`);
    ok(Math.round(gMax * OVERSHOOT) <= r.max,
      `${type}: 予測実測(${Math.round(gMax * OVERSHOOT)}) が受入上限(${r.max}) 以内`);
    ok(Math.round(gMin * OVERSHOOT) >= Math.floor(r.min * 0.98),
      `${type}: 予測実測の下側(${Math.round(gMin * OVERSHOOT)}) が受入下限(${r.min}) をほぼ満たす`);
  }
}
ok(Object.keys(WORD_COUNT_RANGE).length === Object.keys(WORD_COUNT_GUIDE).length,
  'RANGE と GUIDE のキー数が一致（片方だけの記事タイプが無い）');

console.log('\n=== Test 4b: 上限超過の検知 ===');
{
  const over = (n, t) => checkBodyLength(fm('あ'.repeat(n)), t);
  const r = WORD_COUNT_RANGE.basic_explainer;
  ok(over(r.max, 'basic_explainer').ok === true, `上限ちょうど(${r.max}) は OK`);
  ok(over(r.max + 1, 'basic_explainer').tooLong === true, `上限+1(${r.max + 1}) は tooLong`);
  ok(over(r.max + 1, 'basic_explainer').ok === false, '上限超過は ok=false');
  ok(over(7767, 'basic_explainer').tooLong === true, '2026-08-15 の実測値 7767 は tooLong と判定される');
  ok(over(r.max - 100, 'basic_explainer').tooLong === false, '上限内は tooLong にならない');
  // 下限側と上限側が同時に立たないこと
  const s = over(100, 'basic_explainer');
  ok(s.tooShort === true && s.tooLong === false, '短すぎる場合は tooShort のみ');
}

console.log('\n=== Test 5: checkBodyLength の下限判定 ===');
const body = (n) => fm('あ'.repeat(n));
const floorOf = (t) => Math.floor(WORD_COUNT_RANGE[t].min * WORD_COUNT_FLOOR_RATIO);

const beFloor = floorOf('basic_explainer');   // 5000 * 0.9 = 4500
ok(checkBodyLength(body(beFloor), 'basic_explainer').ok === true,
  `basic_explainer: 許容ちょうど(${beFloor}) は OK`);
ok(checkBodyLength(body(beFloor - 1), 'basic_explainer').ok === false,
  `basic_explainer: 許容-1(${beFloor - 1}) はリトライ対象`);
ok(checkBodyLength(body(5574), 'basic_explainer').ok === true,
  'basic_explainer: 5574 は OK');
ok(checkBodyLength(body(1500), 'basic_explainer').ok === false,
  'basic_explainer: 旧来の 1500 はリトライ対象（引き上げが効いている）');

const ecFloor = floorOf('edge_case');         // 3500 * 0.9 = 3150
ok(checkBodyLength(body(ecFloor), 'edge_case').ok === true,
  `edge_case: 許容ちょうど(${ecFloor}) は OK`);
ok(checkBodyLength(body(ecFloor - 1), 'edge_case').ok === false,
  `edge_case: 許容-1(${ecFloor - 1}) はリトライ対象`);

console.log('\n=== Test 6: 返り値の形 ===');
const r1 = checkBodyLength(body(4000), 'basic_explainer');
ok(r1.produced === 4000, 'produced に実測値が入る');
ok(r1.min === 5000, 'min に下限が入る');
ok(r1.floor === 4500, 'floor に許容値が入る');

console.log('\n=== Test 7: 未知の記事タイプは判定対象外 ===');
const r2 = checkBodyLength(body(10), 'unknown_type');
ok(r2.ok === true, '未知タイプは常に OK（既存挙動を壊さない）');
ok(r2.min === null, '未知タイプは min=null');
ok(r2.produced === 10, '未知タイプでも produced は返す');

console.log('\n=== Test 8: 未知タイプのフォールバック文字数が古い値でない ===');
// WORD_COUNT_GUIDE[articleType] が未定義のときのフォールバックが
// 旧来の「1000〜1500文字」に落ちると、薄い記事が生成されてしまう。
// prompt を実際に組み立てて、その文言が混入していないことを確認する。
{
  const fs = require('fs');
  const path = require('path');
  const SRC = path.join(__dirname, '..');
  const files = ['article-prompt-builder.js', '../generate-draft.js'];
  const STALE = /(1000〜1500|1500〜2400|1600〜2600|1800〜2800|2000〜3200|1100〜1600|1200〜1800|1400〜2200|1500〜2500)文字/;
  for (const f of files) {
    const p = path.join(SRC, f);
    const src = fs.readFileSync(p, 'utf8');
    // コメント行（旧値の説明）は除外して判定する
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    ok(!STALE.test(code), `${path.basename(f)}: 旧文字数のフォールバックが残っていない`);
  }
}
{
  const { buildGenerationPrompt } = require('../article-prompt-builder');
  const ir = buildGenerationPrompt({
    topic: { slug: 's', title: 't', tax_domain: 'consumption_tax' },
    persona: { id: '', label: '' }, cta: 'c',
    articleType: 'no_such_type', articleRole: 'support',
    ntaRefsBlock: '', lawChangesBlock: '', revisionHint: '',
    relatedSlug: '', relatedTitle: '', relatedLinkText: '', now: '2026-01-01T00:00:00Z',
  });
  const all = ir.staticSystem + ir.dynamicSystem + ir.user;
  const { WORD_COUNT_GUIDE_FALLBACK } = require('../article-prompt-static');
  ok(!/1000〜1500文字/.test(all), '未知タイプでもプロンプトに「1000〜1500文字」が出ない');
  ok(all.includes(WORD_COUNT_GUIDE_FALLBACK),
    '未知タイプはキャリブレーション済みのフォールバック値を使う');
  // フォールバックもハードコードではなく受入基準から導出されていること
  const fbMax = Number((WORD_COUNT_GUIDE_FALLBACK.match(/〜(\d+)文字/) || [])[1]);
  ok(fbMax < WORD_COUNT_RANGE.edge_case.max,
    `フォールバック上限(${fbMax}) < 補強の受入上限(${WORD_COUNT_RANGE.edge_case.max})`);
}

console.log('\n=== Test 9: 許容率が想定範囲 ===');
ok(WORD_COUNT_FLOOR_RATIO > 0 && WORD_COUNT_FLOOR_RATIO <= 1,
  `WORD_COUNT_FLOOR_RATIO=${WORD_COUNT_FLOOR_RATIO} が 0〜1`);
ok(WORD_COUNT_FLOOR_RATIO >= 0.8,
  '許容率が緩すぎない（0.8 以上）');

console.log(`\n=== 結果 ===\nPASS: ${pass} / FAIL: ${fail}`);
if (fail > 0) process.exit(1);
