'use strict';

/**
 * 差し戻しコメント分類器のテスト。
 *   node scripts/lib/__tests__/test-revision-classifier.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { classifyRevision } = require(path.join(ROOT, 'scripts/lib/revision-classifier'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. 「タイトルの「旧」を「新」に変更して」── 実ユーザーケース ──
// 修正前は factual_correction/targeted に misclassify されていた。
console.log('\n=== Test 1: タイトル変更コメント（旧→新を提示）→ title_only ===');
{
  const c = 'タイトルの「メルカリは法人化を考えるべき売上ライン？」を「メルカリ販売で法人化を考えるべき売上ラインは？」に変更して。';
  const r = classifyRevision(c);
  assert(r.type === 'title_only', `type=title_only（実際: ${r.type}）`);
  assert(r.scope === 'frontmatter', `scope=frontmatter（実際: ${r.scope}）`);
}

// ── 2. 「タイトルを〜に変更して」── 短い形 ─────────────────
console.log('\n=== Test 2: 「タイトルを〜に変更して」→ title_only ===');
{
  const r = classifyRevision('タイトルを「新案」に変更して。');
  assert(r.type === 'title_only', `type=title_only（実際: ${r.type}）`);
}

// ── 3. 「タイトルが硬い」→ title_only ─────────────────────
console.log('\n=== Test 3: 「タイトルが硬い」→ title_only ===');
{
  const r = classifyRevision('タイトルが硬いので柔らかくしてください。');
  assert(r.type === 'title_only', `type=title_only（実際: ${r.type}）`);
}

// ── 4. 「タイトルを直して」→ title_only ────────────────────
console.log('\n=== Test 4: 「タイトルを直して」→ title_only ===');
{
  const r = classifyRevision('タイトルを直してください。');
  assert(r.type === 'title_only', `type=title_only（実際: ${r.type}）`);
}

// ── 5. 「タイトルを修正して」→ title_only ──────────────────
console.log('\n=== Test 5: 「タイトルを修正して」→ title_only ===');
{
  const r = classifyRevision('タイトルを「新案」に修正してください。');
  assert(r.type === 'title_only', `type=title_only（実際: ${r.type}）`);
}

// ── 6. 「全体的に書き直し」→ full_regenerate ──────────────
console.log('\n=== Test 6: 「全体的に書き直し」→ full_regenerate ===');
{
  const r = classifyRevision('全体的に書き直してください。');
  assert(r.type === 'full_regenerate', `type=full_regenerate（実際: ${r.type}）`);
}

// ── 7. 「表を追加して」→ table_fix ─────────────────────────
console.log('\n=== Test 7: 「比較表を追加」→ table_fix ===');
{
  const r = classifyRevision('比較表を追加してください。');
  // table_fix が先に評価されるか、add_section が先に評価されるかは順序次第
  assert(r.type === 'table_fix' || r.type === 'add_section',
    `表/追加の何れかにマッチ（実際: ${r.type}）`);
}

// ── 8. 「税率の数字が違う」→ factual_correction ──────────────
console.log('\n=== Test 8: 「税率の数字が違う」→ factual_correction ===');
{
  const r = classifyRevision('税率の数字が違うので正確に修正してください。');
  // 「修正してください」がタイトル系より前にあれば factual_correction、
  // ただし「タイトル」を含まないので title_only にはマッチしない（OK）。
  assert(r.type === 'factual_correction', `type=factual_correction（実際: ${r.type}）`);
}

// ── 9. denylist 由来禁止意図 → full_regenerate ────────────────
console.log('\n=== Test 9: 禁止意図検出（denySuppression）===');
{
  // 実 denylist は denylist.js 依存。空コメントなら通常分類。
  const r = classifyRevision('');
  // 空文字なら通常分類フローを通り targeted/factual_correction か何かに落ちる。
  // 主目的は denySuppression フラグの構造維持なので type 自体は問わない。
  assert(typeof r.denySuppression === 'boolean', 'denySuppression が boolean で返る');
}

// ── 10. タイトル以外の単純コメント → factual_correction（targeted）─
console.log('\n=== Test 10: 短い自由文 → targeted ===');
{
  const r = classifyRevision('もう少し具体例を入れて。');
  // 「具体例を入れて」は add_section の patterns に該当する可能性が高い
  assert(['add_section', 'factual_correction', 'section_only'].includes(r.type),
    `add_section/section_only/factual_correction のいずれか（実際: ${r.type}）`);
}

// ── 11. 「『○○』の(章|区分|...)の中にある」型 → section_only ─────
// 実ユーザーケース。以前はパターン未マッチで targeted に落ち、本文全体が
// LLM に流れていた。これを section_only に振り、該当章のみ送信に倒す。
console.log('\n=== Test 11: 引用 + 章/区分/部分/セクション の明示指定 → section_only ===');
{
  // 実ユーザーコメント
  const c1 = '「この記事でわかること」の区分の中にある、「原則は短く言えます。」を「結論としては、」に変更して。';
  const r1 = classifyRevision(c1);
  assert(r1.type === 'section_only' && r1.scope === 'section',
    `type=section_only scope=section（実際: ${r1.type}/${r1.scope}）`);
  // セクションヒントが引用から正しく抽出される
  assert(r1.sectionHint === 'この記事でわかること',
    `sectionHint="この記事でわかること"（実際: "${r1.sectionHint}"）`);

  // 別バリエーション: 「『○○』の章を直して」
  const r2 = classifyRevision('『よくある誤解』の章を少し直してください。');
  assert(r2.type === 'section_only', `『○○』の章: section_only（実際: ${r2.type}）`);
  assert(r2.sectionHint === 'よくある誤解', `hint=よくある誤解（実際: "${r2.sectionHint}"）`);

  // 「○○」の部分
  const r3 = classifyRevision('「個人事業 vs 法人：主な比較」の部分、表が見にくいので整えて。');
  // 表が含まれているので table_fix（先評価）に拾われる可能性がある。
  // どちらでも section スコープになることだけ確認。
  assert(r3.scope === 'section', `scope=section（実際: ${r3.scope}, type=${r3.type}）`);

  // 「○○」のセクション
  const r4 = classifyRevision('「メルカリ販売で法人化を考えるべき売上ラインは？」のセクションだけ直して。');
  assert(r4.type === 'section_only', `「○○」のセクション → section_only（実際: ${r4.type}）`);
  assert(r4.sectionHint === 'メルカリ販売で法人化を考えるべき売上ラインは？',
    `hint 正しく抽出（実際: "${r4.sectionHint}"）`);

  // 引用部分が短すぎる / 「章」キーワードがない → section_only にはマッチしない
  const r5 = classifyRevision('「あ」を「い」に変更して。');
  assert(r5.type !== 'section_only',
    `セクションキーワード無しは section_only にしない（実際: ${r5.type}）`);
}

// ── 12. 「要約」コメントを title_only に分類 ─────────────────────
// 実ユーザーケース。以前は分類器に「要約」パターンが無く、targeted に
// 流れて summary が更新されなかったバグへの対策。
console.log('\n=== Test 12: 「要約を〜に変更」→ title_only ===');
{
  const c1 = '要約部分の、「中古資産の耐用年数は「法定年数の20%＋経過年数×80%」」を、「中古資産の耐用年数は基本的に「(法定年数−経過年数)＋経過年数×20%」」に変更して。';
  const r1 = classifyRevision(c1);
  assert(r1.type === 'title_only' && r1.scope === 'frontmatter',
    `type=title_only scope=frontmatter（実際: ${r1.type}/${r1.scope}）`);

  const r2 = classifyRevision('要約を短く修正してください。');
  assert(r2.type === 'title_only', `要約を短く修正 → title_only（実際: ${r2.type}）`);

  const r3 = classifyRevision('要約のここを直して。');
  assert(r3.type === 'title_only', `要約のここを直して → title_only（実際: ${r3.type}）`);

  // 「要約」キーワードが無いコメントは title_only にしない
  const r4 = classifyRevision('本文を短くしてください。');
  assert(r4.type !== 'title_only', '本文系は title_only にしない');
}

// ── Test 13: 事実誤認は table_fix より優先（2026-08-16 の事故）─────
// 「本文が事実誤認。…また比較表の該当行も修正して」というコメントが
// 表のパターンに当たって table_fix(scope=section) と分類され、
// 表のセクションだけ差し替わって本体の誤りが残った。
console.log('\n=== Test 13: 事実誤認は table_fix より優先 ===');
{
  const factual = [
    ['事実誤認＋表への言及', '「ケース①」の記述が事実誤認です。この章を修正してください。また、比較表の該当行も修正してください。'],
    ['事実誤認のみ', '記述が事実誤認です。プラットフォーム課税の対象は国外事業者に限られます。'],
    ['誤りがあります', 'この説明に誤りがあります。3万円未満の要件が抜けています。'],
    ['税務上の誤り', '税務上の誤りがあります。表の数値も含めて直してください。'],
  ];
  for (const [label, comment] of factual) {
    const r = classifyRevision(comment);
    assert(r.type === 'factual_correction', `${label} → factual_correction（実際: ${r.type}）`);
    assert(r.scope === 'targeted', `${label} → scope=targeted（実際: ${r.scope}）`);
  }

  // 純粋な表の指摘は従来どおり table_fix のまま
  const tableOnly = [
    ['比較表に行を追加', '比較表に「簡易課税」の行を追加してください。'],
    ['テーブルの整理', 'テーブルの列が多すぎるので整理してください。'],
  ];
  for (const [label, comment] of tableOnly) {
    const r = classifyRevision(comment);
    assert(r.type === 'table_fix', `${label} → table_fix のまま（実際: ${r.type}）`);
    assert(r.scope === 'section', `${label} → scope=section のまま（実際: ${r.scope}）`);
  }
}

// ── 本文も直す指示は title_only にしない（2026-08-27）──────────
// 「タイトルを付けてください」＋「本文に事実誤認があります」のコメントが、
// 冒頭のタイトル指示だけで title_only と分類され、frontmatter だけ更新されて
// 本文の誤り（2割特例の対象者）が残ったまま完了扱いになった。
// title_only は本文をまったく触らないので、本文修正の指示があれば使えない。
console.log('');
console.log('=== 本文修正を含むコメントは title_only にしない ===');
{
  const bodyEdits = [
    'タイトルを変更し、本文の事実誤認も直してください',
    'タイトルを付けてください。あと出典が間違っています',
    'タイトルを修正してください。また、対象者の記述が誤りです',
    'タイトルを直して。比較表の該当行も修正してください',
    'タイトルを付け直してください。本文の説明を訂正すること',
  ];
  for (const c of bodyEdits) {
    const r = classifyRevision(c);
    assert(r.type !== 'title_only' && r.scope !== 'frontmatter',
      `本文も直す指示は title_only にしない: ${c.slice(0, 24)}… → ${r.type}`);
  }

  // タイトル/要約だけの指示は従来どおり title_only のまま
  const titleOnly = [
    'タイトルだけ変更してください',
    'タイトルが硬いので自然にしてください',
    '要約を直してください',
    'タイトルのみ付け直してください',
  ];
  for (const c of titleOnly) {
    const r = classifyRevision(c);
    assert(r.type === 'title_only' && r.scope === 'frontmatter',
      `タイトル/要約だけの指示は従来どおり: ${c} → ${r.type}`);
  }
}
console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
