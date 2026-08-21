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

// -- 7. LLM の検討過程が本文に混入するのを防ぐ ------------------------
// 2026-08-21: ルール自動反映の出力が「差し戻しコメントで指摘された論点を
// 本文中で確認します。該当箇所：… 最小限加筆します。」で始まり、
// それがそのまま記事の本文になった（403文字）。
// 短縮ガードは縮んだときしか反応せず、前置きが足されて増えた場合は素通りした。
console.log('');
console.log('=== Test 7: 検討過程の混入 ===');
{
  const partial = require(path.join(ROOT, 'scripts/lib/partial-revise'));
  const NL = String.fromCharCode(10);
  const lead = 'レジで印刷するレシートは、これまでと同じ内容のままで本当に大丈夫なのか。';
  const origBody = [lead, '', '## 見出し', '本文です。'.repeat(300)].join(NL);
  const preamble = [
    '差し戻しコメントで指摘された論点（特定期間の判定に関する記述）を本文中で確認します。',
    '',
    '該当箇所：「3割特例」の要件説明の中の以下の記述',
    '',
    'より精査すると、問題は…最小限加筆します。',
    '',
    '---',
    '',
  ].join(NL);

  // 前置きを取り除ける
  const r = partial.stripAnalysisPreamble(origBody, preamble + origBody);
  assert(r.stripped.length > 0, '前置きを検出して除去する');
  assert(r.body === origBody, '本文はそのまま保たれる');
  assert(r.body.startsWith(lead), '元の書き出しから始まる');

  // 変更が無ければ何もしない
  const same = partial.stripAnalysisPreamble(origBody, origBody);
  assert(same.stripped === '' && same.body === origBody, '前置きが無ければ触らない');

  // 本文を作り替えている場合は触らない（切り取って壊さない）
  const rewritten = '全く別の本文です。'.repeat(50);
  assert(partial.stripAnalysisPreamble(origBody, rewritten).stripped === '',
    '書き出しが見つからなければ切り取らない');

  // 作業指示側の語彙を検出できる
  const c1 = partial.findInternalProcessWords(preamble + origBody);
  assert(c1.contaminated, '内部用語の混入を検出する');
  assert(c1.words.includes('差し戻しコメント'), '「差し戻しコメント」を検出');
  assert(c1.words.includes('該当箇所：'), '「該当箇所：」を検出');
  assert(!partial.findInternalProcessWords(origBody).contaminated,
    '正常な本文では検出しない');
  assert(!partial.findInternalProcessWords(r.body).contaminated,
    '除去後は汚染なし');

  // 呼び出し側に組み込まれている
  const src = require('fs').readFileSync(path.join(ROOT, 'scripts/generate-draft.js'), 'utf8');
  assert(/partial\.stripAnalysisPreamble\(body, revised\)/.test(src),
    'ルール自動反映で前置きを除去している');
  assert(/partial\.findInternalProcessWords\(revised\)/.test(src),
    'ルール自動反映で混入を検査している');
  assert(/sanitizeRevisedBody\(body, postProcessBodyOnly/.test(src),
    '差し戻し再生成でも同じ処理をかけている');
  assert(/検討の過程・確認結果・修正方針の説明を本文に書かない/.test(src),
    '指示文で検討過程を書かないよう明示している');
  assert(!/該当箇所が最新の制度に合っているか確認し/.test(src),
    '「確認し」という誘発しやすい指示が残っていない');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
