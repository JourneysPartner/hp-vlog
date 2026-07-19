'use strict';

/**
 * 簡易課税の事業区分トピックの出典割当・relevantRefs のテスト。
 *   node scripts/lib/__tests__/test-simplified-tax-source.js
 *
 * 背景: 2026-07-16 の下書き #297「簡易課税の業種区分」が、
 *   出典 No.6501（納税義務の免除）という無関係ページに接地したまま生成され、
 *   本文で理容・旅館を第4種と誤記した（正: サービス業＝第5種）。
 *   原因は (1) pain 'simplified-tax-business-category' が出典マップに無く消費税既定
 *   No.6501 にフォールバック、(2) 事業区分の正解ソース No.6509 が REFS 未登録、
 *   (3) プロンプトに業種→事業区分の対応表が無かったこと。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const refs = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));
const { checkSourceAlignment: checkCurrentSourceAlignment } = require(path.join(ROOT, 'scripts/lib/source-alignment'));
const checkSourceAlignment = topic => checkCurrentSourceAlignment({ source_provenance: 'curated', ...topic });
const staticRules = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const topic = {
  tax_domain: 'consumption_tax',
  pain_point: 'simplified-tax-business-category',
  category: '消費税',
  title: '簡易課税の業種区分はどう判定する？みなし仕入率の選び方と複数事業の扱い',
};

console.log('\n=== Test: 既定出典が No.6509（事業区分）になる ===');
const def = refs.getDefaultSourceForTopic(topic);
assert(/6509\.htm$/.test(def.url), '既定出典が No.6509 の URL');
assert(!/6501\.htm$/.test(def.url), '誤った No.6501 にフォールバックしない');
assert(/事業区分/.test(def.title), 'タイトルに「事業区分」を含む');

console.log('\n=== Test: relevantRefs に 6509 と 6505 が渡る ===');
const list = refs.getRefsForTopic(topic);
const nos = list.map(r => r.no);
assert(nos.includes('6509'), 'relevantRefs に No.6509（事業区分）が含まれる');
assert(nos.includes('6505'), 'relevantRefs に No.6505（簡易課税制度）が含まれる');
assert(nos[0] === '6509', 'No.6509 が最優先（先頭）で渡る');

console.log('\n=== Test: 出典一致ゲート ===');
const aligned = checkSourceAlignment({ ...topic,
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6509.htm',
  source_title: '国税庁タックスアンサー No.6509 簡易課税制度の事業区分' });
assert(aligned.aligned && aligned.score === 5, '正しい出典(6509)は score 5・aligned');
const misaligned = checkSourceAlignment({ ...topic,
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm',
  source_title: '国税庁タックスアンサー No.6501 納税義務の免除' });
assert(!(misaligned.aligned && misaligned.score === 5), '誤出典(6501)は score 5・aligned にならない（ゲートが今後は弾く）');

console.log('\n=== Test: プロンプトに業種→事業区分の対応表がある ===');
// STATIC_RULES の本文（文字列）を取得
const blob = JSON.stringify(staticRules);
assert(/6509/.test(blob), 'プロンプトに No.6509 の言及がある');
assert(/理容|美容|旅館|宿泊/.test(blob) && /第5種/.test(blob), 'サービス業（理容・旅館等）＝第5種の注意書きがある');
assert(/第4種/.test(blob) && /飲食店/.test(blob), '第4種＝飲食店業の記載がある');

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
