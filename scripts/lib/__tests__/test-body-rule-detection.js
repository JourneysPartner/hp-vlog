'use strict';

/**
 * 本文ベースの論点検出のテスト。
 *   node scripts/lib/__tests__/test-body-rule-detection.js
 *
 * 2026-08-19: 論点別ルールと参考資料の判定は企画メタ（title / search_intent /
 * pain_point 等）の語句一致だけで行っていた。だが企画メタは「何を書く予定か」
 * でしかなく、「実際に何を書いたか」は本文にしかない。
 *
 * 実例: 「電気工事・配管の資格更新費や専用工具は経費になる？」の企画メタには
 * 「減価償却」「少額」「耐用年数」のいずれも含まれないが、工具の話をすれば
 * 本文は当然に減価償却の閾値表を書く。結果、令和8年度改正（40万円未満）を
 * 反映させるルールが一度も渡らず、古い30万円だけの表が生成された。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const st = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));
const ref = require(path.join(ROOT, 'scripts/lib/nta-reference-pages'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// 2026-08-19 に実際に取りこぼした記事の企画メタ（そのまま）
const TOPIC = {
  slug: 'newseg-construction_solo-construction-qualification-cost-electrical-practice',
  title: '電気工事・配管の資格更新費や専用工具は経費になる？',
  tax_domain: 'bookkeeping_expenses',
  pain_point: 'construction-qualification-cost',
  search_intent: '電気工事 配管 資格 更新 講習費 工具 経費 なる',
  reader_problem: '資格維持費や専門工具の経費区分が分からない',
  subcluster: 'bookkeeping-expenses-construction-qualification-cost-electrical-support',
  persona: 'construction_solo',
};

// 実際に生成された本文の該当部分
const BODY = [
  '## 金額別の判断基準',
  '',
  '| 1点あたりの取得価額 | 処理方法 | 勘定科目 |',
  '|---|---|---|',
  '| 10万円未満 | 購入年に全額経費 | 消耗品費 |',
  '| 10万円以上20万円未満 | 一括償却資産（3年均等）または全額経費 | 工具器具備品 |',
  '| 10万円以上30万円未満（青色申告者） | 少額減価償却資産として購入年に全額経費（年300万円限度） | 工具器具備品 |',
  '| 30万円以上 | 法定耐用年数で減価償却 | 工具器具備品 |',
].join('\n');

// ── 1. 企画メタだけでは検出できない（事故の再現）───────────────
console.log('\n=== Test 1: 企画メタだけでは検出できない ===');
{
  const metaText = [TOPIC.title, TOPIC.search_intent, TOPIC.reader_problem,
    TOPIC.subcluster, TOPIC.slug, TOPIC.pain_point].join(' ');
  assert(!/減価償却|少額|耐用年数/.test(metaText),
    '企画メタに「減価償却」「少額」「耐用年数」が一つも無い（事故の前提）');
  assert(st.selectConditionalRuleEntries(TOPIC).length === 0,
    '企画メタからは論点別ルールが1件も出ない');
  assert(ref.findReferencePages(TOPIC).length === 0,
    '企画メタからは参考資料が1件も出ない');
  assert(/減価償却/.test(BODY) && /少額減価償却資産/.test(BODY),
    'しかし本文は減価償却について書いている');
}

// ── 2. 本文を見れば検出できる ──────────────────────────────────
console.log('\n=== Test 2: 本文から検出できる ===');
{
  const missingRules = st.findUnappliedRules(TOPIC, BODY);
  assert(missingRules.length > 0, `本文から未適用ルールを検出（${missingRules.length} 件）`);
  assert(missingRules.some(r => r.key === 'small_depreciable_assets'),
    '少額減価償却資産のルールが検出される');
  assert(missingRules.every(r => typeof r.text === 'string' && r.text.length > 0),
    '検出結果にルール本文が入っている');
  assert(missingRules.some(r => /40万円未満/.test(r.text)),
    '検出されたルールに改正後の基準が含まれる');

  const missingRefs = ref.findUnappliedReferencePages(TOPIC, BODY);
  assert(missingRefs.some(p => p.key === 'small_depreciable_assets_2026'),
    '参考資料も検出される');
  const block = ref.formatReferencePages(missingRefs);
  assert(/40万円未満/.test(block) && /令和8年4月1日以後/.test(block),
    '参考資料ブロックに改正内容が入る');
}

// ── 3. 本文が無ければ従来どおり（挙動を変えない）────────────────
console.log('\n=== Test 3: 本文なしでは従来どおり ===');
{
  assert(st.findUnappliedRules(TOPIC, '').length === 0, '本文が空なら未適用ルールは0件');
  assert(st.findUnappliedRules(TOPIC).length === 0, '本文未指定でも0件');
  assert(ref.findUnappliedReferencePages(TOPIC, '').length === 0, '参考資料も0件');
  assert(ref.formatReferencePages([]) === '', '空配列なら空文字');

  // 生成時の判定結果そのものが変わっていないこと
  const before = st.selectConditionalRules(TOPIC);
  assert(before.length === 0, '生成時の論点別ルールは従来どおり0件のまま');
}

// ── 4. すでに適用済みのルールは「未適用」に含めない ──────────────
console.log('\n=== Test 4: 二重適用しない ===');
{
  // 企画メタに「減価償却」が入っているトピック（＝生成時に適用済み）
  const already = { ...TOPIC, title: 'ゲーム機・PCの減価償却は？' };
  const appliedKeys = st.selectConditionalRuleEntries(already).map(r => r.key);
  assert(appliedKeys.includes('small_depreciable_assets'), '前提: 生成時に適用されている');
  const missing = st.findUnappliedRules(already, BODY);
  assert(!missing.some(r => r.key === 'small_depreciable_assets'),
    '適用済みのルールは未適用として再検出されない');
}

// ── 5. 無関係な本文で誤検出しない ──────────────────────────────
console.log('\n=== Test 5: 誤検出しない ===');
{
  const unrelated = [
    '## 帳簿の保存期間',
    '青色申告者は帳簿を7年間保存する必要があります。',
    '請求書や領収書も同様に保存してください。',
  ].join('\n');
  const missing = st.findUnappliedRules(TOPIC, unrelated);
  assert(!missing.some(r => r.key === 'small_depreciable_assets'),
    '減価償却に触れていない本文では検出しない');
  assert(ref.findUnappliedReferencePages(TOPIC, unrelated).length === 0,
    '参考資料も検出しない');
}

// ── 6. 呼び出し側に組み込まれている ────────────────────────────
console.log('\n=== Test 6: 組み込み ===');
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'scripts/generate-draft.js'), 'utf8');
  assert(/async function applyMissingRulesToBody/.test(src), '反映関数が定義されている');
  assert(/ruleFix = await applyMissingRulesToBody\(/.test(src), 'generateArticle から呼ばれている');
  assert(/ruleFix\.failed/.test(src), '反映失敗時の分岐がある');
  assert(/自動反映できませんでした/.test(src), '反映失敗は review_comment に残す');
  assert(!/記事を破棄|discard/.test(src), '記事を破棄する実装になっていない');

  const builder = fs.readFileSync(path.join(ROOT, 'scripts/lib/article-prompt-builder.js'), 'utf8');
  assert(/\[rules\] 論点別ルールを適用/.test(builder), '通常生成でルール適用をログに出す');
  assert(/\[rules\] 論点別ルール: 該当なし/.test(builder), '該当なしもログに出す');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
