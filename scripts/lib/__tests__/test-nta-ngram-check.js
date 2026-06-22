'use strict';

/**
 * n-gram 転載検知のテスト
 *   node scripts/lib/__tests__/test-nta-ngram-check.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const ngram = require(path.join(ROOT, 'scripts/lib/nta-ngram-check'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. splitSentences ─────────────────────────────────────────
console.log('\n=== Test 1: splitSentences ===');
{
  const text = 'これは最初の文です。これは2番目の文。3番目はどうですか？最後だ！';
  const result = ngram.splitSentences(text);
  assert(result.length === 4, `4 文に分割 (実: ${result.length})`);
  assert(result[0] === 'これは最初の文です。', `1 文目`);
  assert(result[1] === 'これは2番目の文。', `2 文目`);
  assert(result[2] === '3番目はどうですか？', `3 文目`);
  assert(result[3] === '最後だ！', `4 文目`);

  // 空文字 / null
  assert(ngram.splitSentences('').length === 0, `空文字は 0 件`);
  assert(ngram.splitSentences(null).length === 0, `null は 0 件`);

  // 改行 + 連続空白の正規化
  const messy = 'A です。\nB です。\n\n  C です。';
  const r2 = ngram.splitSentences(messy);
  assert(r2.length === 3, `改行 + 連続空白で 3 文 (実: ${r2.length})`);
}

// ── 2. normalizeForCompare ───────────────────────────────────
console.log('\n=== Test 2: normalizeForCompare ===');
{
  assert(ngram.normalizeForCompare('  AB CD ') === 'ABCD', `空白除去`);
  assert(ngram.normalizeForCompare('<strong>太字</strong>です') === '太字です',
    `<strong> タグ除去`);
  assert(ngram.normalizeForCompare('') === '', `空文字 OK`);
}

// ── 3. find3GramOverlap: 一致なし ────────────────────────────
console.log('\n=== Test 3: find3GramOverlap 一致なし ===');
{
  const article = '記事の文章その1。記事の文章その2。記事の文章その3。';
  const source = 'まったく別の原文です。違う内容になっています。共通箇所なし。';
  const r = ngram.find3GramOverlap(article, source);
  assert(r.matched === false, `一致なし`);
  assert(r.overlaps.length === 0, `overlaps 0 件`);
}

// ── 4. find3GramOverlap: 連続 3 文一致 → 検出 ────────────────
console.log('\n=== Test 4: 連続 3 文一致を検出 ===');
{
  const source = '前提: 山林の譲渡について解説します。山林の育成には通常50年程度かかることから事業判断が複雑です。伐採の反復継続性を見て判断する必要があります。育成管理の度合を加味して総合的に判断します。';
  const article = '想定事例の前置きです。元事例とは違う業種に置き換えました。山林の育成には通常50年程度かかることから事業判断が複雑です。伐採の反復継続性を見て判断する必要があります。育成管理の度合を加味して総合的に判断します。';
  const r = ngram.find3GramOverlap(article, source);
  assert(r.matched === true, `連続 3 文一致を検出`);
  assert(r.overlaps.length === 1, `overlap 1 件 (実: ${r.overlaps.length})`);
  assert(r.overlaps[0].length === 3, `length=3`);
  assert(r.overlaps[0].sentences[0].includes('山林の育成'),
    `1 文目に "山林の育成" 含む`);
}

// ── 5. 2 文一致は検出しない ──────────────────────────────────
console.log('\n=== Test 5: 2 文一致は閾値未満 ===');
{
  const source = '基本ルールはこうです。これは具体例の一文目です。これは具体例の二文目です。さらに別の解説です。';
  const article = '記事の冒頭。これは具体例の一文目です。これは具体例の二文目です。違う表現に書き換えました独自に。';
  const r = ngram.find3GramOverlap(article, source);
  assert(r.matched === false, `2 文一致は閾値未満で未検出`);
}

// ── 6. 短文（10 文字未満）は除外 ─────────────────────────────
console.log('\n=== Test 6: 短文の除外 ===');
{
  const source = 'はい。そうです。違います。やります。長い文章これは検出対象になります。';
  const article = 'はい。そうです。違います。やります。長い文章これは検出対象になります。';
  // 「はい。」「そうです。」「違います。」「やります。」はすべて 10 文字未満
  const r = ngram.find3GramOverlap(article, source);
  // 短文 3 連続は除外、最後の長文だけでは 3 文に届かない
  assert(r.matched === false, `短文 3 連続は除外、検出されない`);
}

// ── 7. 連続 4 文一致 → length=4 ──────────────────────────────
console.log('\n=== Test 7: 連続 4 文一致 ===');
{
  const longSentences = [
    '事業者は国内において行った課税資産の譲渡等について消費税を納める義務があります。',
    'ただし基準期間における課税売上高が1000万円以下の場合は原則として納税義務が免除されます。',
    'なお適格請求書発行事業者の登録を受けている場合は納税義務が免除されません。',
    '特定期間における課税売上高が1000万円を超える場合も免除されません。',
  ].join('');
  const source = longSentences;
  const article = '冒頭の文章です。' + longSentences + '最後にまとめがあります。';
  const r = ngram.find3GramOverlap(article, source);
  assert(r.matched === true, `連続 4 文一致を検出`);
  assert(r.overlaps[0].length === 4, `length=4 (実: ${r.overlaps[0].length})`);
}

// ── 8. checkNgramOverlapForArticle: ソース未発見 ─────────────
console.log('\n=== Test 8: ソース未発見 ===');
{
  ngram._resetUrlIndexCache();
  // 通常記事は source_url が未指定なら検査スキップ
  const r1 = ngram.checkNgramOverlapForArticle({}, '本文');
  assert(r1.sourceFound === false, `source_url なし → sourceFound=false`);

  // 存在しない URL → sourceFound=false
  const r2 = ngram.checkNgramOverlapForArticle(
    { source_url: 'https://nonexistent.example.com/x.htm' },
    '本文'
  );
  assert(r2.sourceFound === false, `存在しない URL → sourceFound=false`);
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
