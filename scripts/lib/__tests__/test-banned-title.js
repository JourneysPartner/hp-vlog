'use strict';

/**
 * 禁止フレーズのタイトル適用テスト。
 *   node scripts/lib/__tests__/test-banned-title.js
 *
 * 「今後〜使わない」で指定された語は、本文だけでなくタイトルでも使わせない。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const bp = require(path.join(ROOT, 'scripts/lib/banned-phrases'));
const { isValidLlmTitle } = require(path.join(ROOT, 'scripts/lib/draft-normalizer'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const DATA = { version: 1, phrases: [
  { id: 'w', pattern: '認知機能', replacement: null, appliesTo: ['body'] },              // 内容禁止(本文)→タイトルにも効く
  { id: 'f', pattern: '\\*\\*[^*]+\\*\\*', replacement: '<strong>x</strong>', appliesTo: ['body'] }, // 整形→タイトル対象外
  { id: 't', pattern: '煽り語', replacement: null, appliesTo: ['title'] },
]};

// ── 1. getTitleBannedPhrases（整形ルールは除外・内容禁止は含む）──
console.log('\n=== Test 1: getTitleBannedPhrases ===');
const ids = bp.getTitleBannedPhrases(DATA).map(p => p.id).sort();
assert(ids.join(',') === 't,w', `内容禁止(w)とtitle(t)のみ、整形(f)は除外: [${ids}]`);

// ── 2. detectBannedInTitle ─────────────────────────────────
console.log('\n=== Test 2: detectBannedInTitle ===');
assert(bp.detectBannedInTitle('認知機能の低下に備える相続の準備', DATA).length > 0, '本文内容禁止語をタイトルでも検出');
assert(bp.detectBannedInTitle('煽り語を含むタイトル', DATA).length > 0, 'title スコープ語を検出');
assert(bp.detectBannedInTitle('親の相続で最初に確認すること', DATA).length === 0, 'クリーンなタイトルは検出しない');

// ── 3. extractBannedFromComment: 引用が「今後」より前 ──────────
console.log('\n=== Test 3: 「X」は今後使用しないで の抽出 ===');
const ex1 = bp.extractBannedFromComment('「認知機能」は今後使用しないで。');
assert(ex1.some(e => e.pattern === '認知機能'), '「認知機能」は今後使用しないで → 認知機能 を抽出');
assert(ex1.every(e => e.appliesTo.includes('title')), '抽出語は appliesTo に title を含む');
// タイトル変更コメントは禁止語として拾わない
assert(bp.extractBannedFromComment('タイトルを「新タイトル」に変更して。').length === 0, 'タイトル変更指示は禁止語抽出しない');

// ── 4. isValidLlmTitle が禁止語タイトルを弾く（実データ）─────────
console.log('\n=== Test 4: isValidLlmTitle × 実データ ===');
// 実データに禁止語があれば、そのタイトルは無効になること（データ非依存の論理確認）
const realBanned = bp.getTitleBannedPhrases();
if (realBanned.length > 0) {
  const sample = realBanned.find(p => /^[一-鿿ぁ-んァ-ヶ]{2,}$/.test(p.pattern));
  if (sample) {
    assert(isValidLlmTitle(`${sample.pattern}についての解説と実務の注意点`) === false, `実データ禁止語「${sample.pattern}」を含むタイトルは無効`);
  } else {
    assert(true, '実データにリテラル禁止語が無いためスキップ');
  }
} else {
  assert(true, '実データに title 禁止語が無いためスキップ');
}
// クリーンなタイトルは有効
assert(isValidLlmTitle('メルカリ販売で法人化を考えるべき売上ラインは？｜初動を整理') === true, 'クリーンなタイトルは有効');

// ── 5. formatTitleBannedForPrompt は文字列 ─────────────────────
console.log('\n=== Test 5: formatTitleBannedForPrompt ===');
assert(typeof bp.formatTitleBannedForPrompt() === 'string', 'プロンプト用文字列を返す');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
