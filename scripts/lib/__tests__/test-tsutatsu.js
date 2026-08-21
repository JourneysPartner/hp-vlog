'use strict';

/**
 * 通達カタログのテスト。
 *   node scripts/lib/__tests__/test-tsutatsu.js
 *
 * ネットワークは使わない（保存済みカタログと解析ロジックだけを見る）。
 *
 * 2026-08-20〜21 に通達の誤りが2日続けて出た。
 *   所基通37-14 を「按分が必要」と書いた（実際は継続適用が条件の任意の取扱い）
 *   商品券の「発行」を非課税と書いた（実際は不課税。消基通6-4-5）
 * タックスアンサー番号は照合できたが、通達番号は照合できなかった。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const P = require(path.join(ROOT, 'scripts/lib/tsutatsu-parser'));
const T = require(path.join(ROOT, 'scripts/lib/nta-tsutatsu'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. 条番号の正規化 ──────────────────────────────────────────
console.log('\n=== Test 1: 条番号の正規化 ===');
{
  assert(P.normalizeProvisionNo('6－4－5') === '6-4-5', '全角ハイフンを半角に');
  assert(P.normalizeProvisionNo('37－14の2') === '37-14の2', '「の2」形式を保つ');
  assert(P.normalizeProvisionNo('６－４－５') === '6-4-5', '全角数字を半角に');
  assert(P.normalizeProvisionNo(' 37-13　') === '37-13', '前後の空白を落とす');
  assert(P.normalizeProvisionNo(null) === '', 'null は空文字');

  assert(P.looksLikeProvisionNo('6-4-5'), '6-4-5 は条番号');
  assert(P.looksLikeProvisionNo('37-14の2'), '37-14の2 は条番号');
  assert(!P.looksLikeProvisionNo('2026'), '年号は条番号ではない');
  assert(!P.looksLikeProvisionNo('37'), '枝番が無いものは条番号としない');
}

// ── 2. ページ解析 ──────────────────────────────────────────────
console.log('\n=== Test 2: ページ解析 ===');
{
  // 消費税型（条番号が strong 1つ）
  const shohi = [
    '<h1>第4節　物品切手等の譲渡関係</h1>',
    '<h2>（物品切手等の発行）</h2>',
    '<p class="indent1"><strong>6－4－5　</strong>事業者が、物品切手等を発行し、交付した場合において、',
    'その交付に係る相手先から収受する金品は、資産の譲渡等の対価に該当しない。</p>',
    '<h2>（物品切手等の取扱手数料）</h2>',
    '<p class="indent1"><strong>6－4－6　</strong>事業者が…取扱手数料は、課税資産の譲渡等の対価に該当する。</p>',
  ].join('\n');
  const r1 = P.parseTsutatsuPage(shohi, { url: 'u', circular: 'shohi' });
  assert(r1.provisions.length === 2, `2条を抽出（実: ${r1.provisions.length}）`);
  assert(r1.provisions[0].no === '6-4-5', '条番号を正規化して取る');
  assert(/物品切手等の発行/.test(r1.provisions[0].title), '見出しを取る');
  assert(/資産の譲渡等の対価に該当しない/.test(r1.provisions[0].body), '本文を取る');
  assert(!/6－4－5/.test(r1.provisions[0].body), '本文に条番号が残らない');

  // 所得税型（条番号が strong 2つに分かれる）
  const shotoku = [
    '<h1>〔資本的支出と修繕費等〕</h1>',
    '<h2>（形式基準による修繕費の判定）</h2>',
    '<p class="indent1"><strong>37</strong><strong>－13　</strong>一の修理、改良等のために要した金額のうちに…</p>',
  ].join('\n');
  const r2 = P.parseTsutatsuPage(shotoku, { url: 'u', circular: 'shotoku' });
  assert(r2.provisions.length === 1, '分割された条番号でも抽出できる');
  assert(r2.provisions[0].no === '37-13', `strong 2つを連結（実: ${r2.provisions[0].no}）`);

  // 条番号らしくない見出しは拾わない
  const noise = '<h2>（参考）</h2><p><strong>参考</strong>これは条文ではありません。</p>';
  assert(P.parseTsutatsuPage(noise, {}).provisions.length === 0, '条番号でないものは拾わない');
}

// ── 3. カタログの中身 ──────────────────────────────────────────
console.log('\n=== Test 3: カタログ ===');
{
  const stats = T.catalogStats();
  assert(stats.length >= 2, `所得税・消費税が取得済み（実: ${stats.length} 通達）`);
  for (const s of stats) {
    assert(s.provisions > 100, `${s.label}: 条文が十分にある（${s.provisions} 条）`);
  }

  // 実際に誤りが起きた条文が引けること
  const p6445 = T.findProvision('6-4-5');
  assert(!!p6445, '消基通6-4-5 が引ける');
  assert(/資産の譲渡等の対価に該当しない/.test(p6445.body), '6-4-5 の原文が正しい');
  assert(p6445.short === '消基通', '通達の略称が付く');

  const p3714 = T.findProvision('37-14');
  assert(!!p3714, '所基通37-14 が引ける');
  assert(/継続して/.test(p3714.body), '37-14 に「継続して」が含まれる');
  assert(/これを認めるものとする/.test(p3714.body), '37-14 が任意の取扱いだと分かる');

  const p3713 = T.findProvision('37-13');
  assert(!!p3713, '所基通37-13 が引ける');
  assert(/60万円/.test(p3713.body) && /10%|10パーセント|10％/.test(p3713.body),
    '37-13 が形式基準（60万円・10%）である');

  assert(T.findProvision('37-14の2') !== null, '「の2」形式も引ける');
  assert(T.findProvision('99-99-99') === null, '存在しない番号は null');
}

// ── 4. 引用の照合 ──────────────────────────────────────────────
console.log('\n=== Test 4: 引用の照合 ===');
{
  const ok = T.checkCitations('この場合は消基通6-4-5により不課税です。所基通37-13も参照。');
  assert(ok.citations.length === 2, `2件の引用を検出（実: ${ok.citations.length}）`);
  assert(ok.unknown.length === 0, '実在する引用は unknown にならない');

  const ng = T.checkCitations('所基通37-99により按分します。');
  assert(ng.unknown.length === 1, '存在しない番号を検出する');
  assert(ng.unknown[0].no === '37-99', '検出した番号が分かる');

  // 通達名の表記ゆれ
  assert(T.checkCitations('消費税法基本通達6-4-5').citations.length === 1, '正式名称でも検出');
  assert(T.checkCitations('所得税基本通達37－14').unknown.length === 0, '全角ハイフンでも照合できる');

  // 通達に触れていない本文では何も出ない
  assert(T.checkCitations('タックスアンサー No.6229 を参照。').citations.length === 0,
    'タックスアンサーの番号を通達と誤検出しない');
  assert(T.checkCitations('').citations.length === 0, '空文字でも落ちない');
}

// ── 5. プロンプト用ブロック ────────────────────────────────────
console.log('\n=== Test 5: プロンプト用ブロック ===');
{
  const block = T.buildProvisionBlock(['6-4-5', '37-14']);
  assert(block.length > 0, 'ブロックが組まれる');
  assert(/資産の譲渡等の対価に該当しない/.test(block), '6-4-5 の原文が入る');
  assert(/継続して/.test(block), '37-14 の原文が入る');
  assert(/原文がある通達だけ/.test(block), '原文がある通達だけ引く指示');
  assert(/任意の取扱い/.test(block), '任意の取扱いである旨の注意');
  assert(T.buildProvisionBlock([]) === '', '空配列なら空文字');
  assert(T.buildProvisionBlock(['99-99-99']) === '', '存在しない番号だけなら空文字');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
