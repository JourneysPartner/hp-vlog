'use strict';

/**
 * 高額特定資産の3年縛りトピックの出典割当・relevantRefs・論点別ルールのテスト。
 *   node scripts/lib/__tests__/test-high-value-asset-source.js
 *
 * 背景: 2026-07-19 の下書き #306「高額特定資産の3年縛り」が、出典 No.6501（納税義務の免除）
 *   という無関係ページに接地したまま生成され、制限期間の起点を誤記した
 *   （「取得した課税期間の初日から…末日まで」。正しくは「取得した課税期間の翌課税期間から、
 *    取得した課税期間の初日以後3年を経過する日の属する課税期間まで」）。
 *   原因は (1) pain 'high-value-asset-3year-restriction' が出典マップに無く No.6501 に
 *   フォールバック、(2) 正解ソース No.6502 が REFS 未登録、(3) プロンプトに正確な期間定義が
 *   無かったこと。#297（簡易課税事業区分）と同型。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const refs = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));
const { checkSourceAlignment: checkCurrentSourceAlignment } = require(path.join(ROOT, 'scripts/lib/source-alignment'));
const checkSourceAlignment = topic => checkCurrentSourceAlignment({ source_provenance: 'curated', ...topic });
const { selectConditionalRules } = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS ${label}`); passed++; }
  else      { console.error(`  FAIL ${label}`); failed++; }
}

const topic = {
  tax_domain: 'consumption_tax',
  pain_point: 'high-value-asset-3year-restriction',
  category: '消費税',
  title: '高額特定資産を取得したら消費税はどうなる？3年縛りのしくみと注意点',
  search_intent: '1,000万円超の建物・機械等を取得した時の消費税の3年縛りを正しく理解したい',
};

console.log('\n=== Test: 既定出典が No.6502 になる ===');
const def = refs.getDefaultSourceForTopic(topic);
assert(/6502\.htm$/.test(def.url), '既定出典が No.6502 の URL');
assert(!/6501\.htm$/.test(def.url), '誤った No.6501 にフォールバックしない');
assert(/高額特定資産/.test(def.title), 'タイトルに「高額特定資産」を含む');

console.log('\n=== Test: relevantRefs に 6502 が最優先で渡る ===');
const nos = refs.getRefsForTopic(topic).map(r => r.no);
assert(nos.includes('6502'), 'relevantRefs に No.6502 が含まれる');
assert(nos[0] === '6502', 'No.6502 が最優先（先頭）で渡る');

console.log('\n=== Test: 出典一致ゲート ===');
const aligned = checkSourceAlignment({ ...topic,
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6502.htm',
  source_title: '国税庁タックスアンサー No.6502 高額特定資産を取得した場合等の納税義務の免除等の特例' });
assert(aligned.aligned && aligned.score === 5, '正しい出典(6502)は score 5・aligned');
const misaligned = checkSourceAlignment({ ...topic,
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm',
  source_title: '国税庁タックスアンサー No.6501 納税義務の免除' });
assert(!(misaligned.aligned && misaligned.score === 5), '誤出典(6501)は score 5・aligned にならない');

console.log('\n=== Test: 論点別ルール（CONDITIONAL_RULES）が注入される ===');
const rules = selectConditionalRules(topic).join('\n');
assert(/高額特定資産/.test(rules) && /6502/.test(rules), 'high_value_asset ルールが該当トピックで注入される');
assert(/翌課税期間/.test(rules), '正しい起点「翌課税期間」が明記されている');
assert(/悪い例|誤記/.test(rules) && /初日から/.test(rules), '誤った起点（取得課税期間の初日から）を誤記として警告している');

console.log('\n=== Test: 無関係トピックには注入されない ===');
const other = selectConditionalRules({ tax_domain: 'inheritance_tax', pain_point: 'spouse-reduction', title: '配偶者の税額軽減' }).join('\n');
assert(!/高額特定資産/.test(other), '相続トピックには high_value_asset ルールが出ない');

console.log(`\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
