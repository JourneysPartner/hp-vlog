'use strict';

/**
 * banned-phrases モジュールのテスト。
 *   node scripts/lib/__tests__/test-banned-phrases.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const bp = require(path.join(ROOT, 'scripts/lib/banned-phrases'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. loadBannedPhrases ─────────────────────────────────────
console.log('\n=== Test 1: loadBannedPhrases ===');
{
  const data = bp.loadBannedPhrases();
  assert(data && typeof data === 'object', 'object を返す');
  assert(Array.isArray(data.phrases), 'phrases は array');
  assert(data.phrases.length >= 1, '初期エントリが 1 件以上');
}

// ── 2. extractBannedFromComment: 実ユーザーケース ─────────────
// 「今後、「<A>」という文言や、<B>、というような文言は書かないでください。」
console.log('\n=== Test 2: extractBannedFromComment（実ユーザーケース）===');
{
  const comment = '「原則をまず3行で押さえる」→「重要ポイントを整理💡」に変更して。\n\n今後、「原則をまず3行で押さえる」という文言や、原則を◯行で押さえる、というような文言は書かないでください。';
  const found = bp.extractBannedFromComment(comment, { sourceArticle: 'test' });
  assert(found.length >= 2, `2 件以上抽出（実: ${found.length}）`);
  assert(found.some(f => /原則をまず3行で押さえる/.test(f.pattern)), 'リテラル「原則をまず3行で押さえる」');
  assert(found.some(f => /原則を.*\\d\+.*行で押さえる/.test(f.pattern)), 'ワイルドカード化「原則を\\d+行で押さえる」');
  assert(found.every(f => f.autoExtracted === true), '全て autoExtracted=true');
  assert(found.every(f => f.appliesTo.includes('body')), 'appliesTo=body');
}

// ── 3. extractBannedFromComment: 「今後」がない普通の差し戻し ───
console.log('\n=== Test 3: 「今後」が無いコメントは抽出されない ===');
{
  const c = '「40%」を「80%」に変更して。';
  const found = bp.extractBannedFromComment(c);
  assert(found.length === 0, `抽出 0 件（実: ${found.length}）`);
}

// ── 4. detectBannedInBody: パターンマッチ ─────────────────────
console.log('\n=== Test 4: detectBannedInBody ===');
{
  // 初期エントリ "原則を(?:まず)?[\d◯〇○...]+行で押さえる" に該当
  const hits1 = bp.detectBannedInBody('まず原則をまず3行で押さえる形で進めます。');
  assert(hits1.length === 1, 'リテラル数字をキャッチ');

  const hits2 = bp.detectBannedInBody('原則を5行で押さえる方針です。');
  assert(hits2.length === 1, 'まず無しの数字パターンもキャッチ');

  const hits3 = bp.detectBannedInBody('原則を◯行で押さえる形にします。');
  assert(hits3.length === 1, '◯ ワイルドカードもキャッチ');

  const hits4 = bp.detectBannedInBody('安全な本文です。');
  assert(hits4.length === 0, 'クリーンな本文は 0 件');
}

// ── 5. applyBannedPhrasesToBody: replacement あり/無し ─────────
console.log('\n=== Test 5: applyBannedPhrasesToBody ===');
{
  // 初期エントリは replacement=null → 検出ログのみ、本文は変わらない
  const before = '原則をまず3行で押さえる形で。';
  const { text, applied } = bp.applyBannedPhrasesToBody(before);
  assert(text === before, 'replacement=null は本文を変更しない');
  assert(applied.length === 1, 'applied に 1 件記録');
  assert(applied[0].hasReplacement === false, 'hasReplacement=false');
}

// ── 6. applyBannedPhrasesToBody: replacement あり（ad-hoc data）─
console.log('\n=== Test 6: replacement あり時は自動置換 ===');
{
  const adhoc = {
    version: 1,
    phrases: [{
      id: 'test-replace',
      pattern: 'NG表現',
      replacement: 'OK表現',
      appliesTo: ['body'],
    }],
  };
  const { text, applied } = bp.applyBannedPhrasesToBody('これは NG表現 を含みます。', adhoc);
  assert(text === 'これは OK表現 を含みます。', '置換成功');
  assert(applied[0].hasReplacement === true, 'hasReplacement=true');
}

// ── 7. formatForPrompt ───────────────────────────────────────
console.log('\n=== Test 7: formatForPrompt ===');
{
  const out = bp.formatForPrompt();
  assert(out.length > 0, '出力が空でない');
  assert(/絶対に使わない/.test(out), '禁止指示文言を含む');
  assert(/原則を/.test(out), '初期エントリのフレーズが含まれる');
}

// ── 8. mergeEntries: 重複 pattern は無視 ─────────────────────
console.log('\n=== Test 8: mergeEntries ===');
{
  const existing = [{ id: 'a', pattern: 'foo' }, { id: 'b', pattern: 'bar' }];
  const additions = [
    { id: 'c', pattern: 'foo' },      // 重複
    { id: 'd', pattern: 'baz' },      // 新規
  ];
  const merged = bp.mergeEntries(existing, additions);
  assert(merged.length === 3, '重複除外で 3 件');
  assert(merged.some(e => e.pattern === 'baz'), 'baz が追加されている');
  assert(merged.filter(e => e.pattern === 'foo').length === 1, 'foo は重複なく 1 件');
}

// ── 9. wildcardize: ◯〇○ → \d+ ─────────────────────────────
console.log('\n=== Test 9: wildcardize ===');
{
  assert(bp.wildcardize('原則を◯行で') === '原則を\\d+行で', '◯ → \\d+');
  assert(bp.wildcardize('原則を〇行で') === '原則を\\d+行で', '〇 → \\d+');
  assert(bp.wildcardize('a.b') === 'a\\.b', 'ドットを escape');
}

// ── 10. extractBannedFromComment: 単一引用句のみのケース ───────
console.log('\n=== Test 10: 単一引用句のみのケース ===');
{
  const c = '今後、「丁寧に解説します」という文言は使わないでください。';
  const found = bp.extractBannedFromComment(c);
  assert(found.length === 1, '1 件抽出');
  assert(/丁寧に解説します/.test(found[0].pattern), 'リテラル「丁寧に解説します」');
}

// ── 11. replacement: "" （空文字）も置換対象として扱う ────────
// 「Markdown 太字 ** を削除」のような「該当文字列を消したい」ケース。
// JavaScript の falsy 判定（!p.replacement）で空文字を弾いていたバグ修正のリグレッション。
console.log('\n=== Test 11: replacement: "" は「削除」として置換される ===');
{
  const adhoc = {
    version: 1,
    phrases: [{
      id: 'test-delete', pattern: '\\*\\*', replacement: '',
      appliesTo: ['body'],
    }],
  };
  const { text, applied } = bp.applyBannedPhrasesToBody(
    '消費税の**課税事業者**は**インボイス登録**が必要です。',
    adhoc,
  );
  assert(text === '消費税の課税事業者はインボイス登録が必要です。',
    'replacement: "" で ** が削除される');
  assert(applied.length === 1 && applied[0].hasReplacement === true,
    'hasReplacement=true（空文字も replacement とみなす）');
}

// ── 11b. 特定期間判定の AND/OR 誤記検知 ──────────────────────
console.log('\n=== Test 11b: 特定期間判定の OR 誤記検知 ===');
{
  // 誤記パターン: 必ず検出される
  for (const txt of [
    '前年1月〜6月の課税売上高または給与等支払額が1,000万円超で課税事業者となる。',
    '特定期間の課税売上高もしくは給与等支払額が1,000万円を超えると課税事業者になります。',
    '| 課税売上高または給与等支払額 | いずれか1,000万円超で課税 |',
  ]) {
    const hits = bp.detectBannedInBody(txt);
    assert(hits.some(h => h.id === 'specific-period-or-vs-and'),
      `誤記検出: "${txt.slice(0, 30)}..."`);
  }
  // 「いずれかが1,000万円超」型
  const hitsEither = bp.detectBannedInBody('いずれかが1,000万円超 → 課税事業者');
  assert(hitsEither.some(h => h.id === 'specific-period-either-or'),
    'いずれか型の誤記検出');

  // 正しい記述: 検出されない
  for (const txt of [
    '課税売上高と給与等支払額がいずれもが1,000万円超 → 課税事業者',
    '課税売上高に代えて、給与等支払額により判定することもできます。',
    '基準期間の課税売上高が1,000万円を超えると課税事業者になります。',
  ]) {
    const hits = bp.detectBannedInBody(txt);
    const wrongHit = hits.filter(h => h.id === 'specific-period-or-vs-and' || h.id === 'specific-period-either-or');
    assert(wrongHit.length === 0, `正しい記述は誤検出されない: "${txt.slice(0, 30)}..."`);
  }
}

// ── 12. 本番 banned-phrases.json: ** → <strong> 変換 ──────────────
// 太字スタイルは維持しつつ、生の ** が見える事故を防ぐ。
console.log('\n=== Test 12: 本番 JSON 上の ** → <strong> 変換 ===');
{
  const data = bp.loadBannedPhrases();
  const convertRule = data.phrases.find(p => p.id === 'convert-markdown-bold-to-strong');
  assert(!!convertRule, 'convert-markdown-bold-to-strong ルールが登録されている');
  const stripRule = data.phrases.find(p => p.id === 'strip-stray-double-asterisk');
  assert(!!stripRule, '孤立 ** 除去ルールも登録されている');

  // 通常の太字: **X** → <strong>X</strong>
  const { text: t1 } = bp.applyBannedPhrasesToBody('これは**太字**です。');
  assert(t1 === 'これは<strong>太字</strong>です。', '通常の太字が <strong> に変換');

  // 日本語境界の実例（スクショの問題ケース）
  const { text: t2 } = bp.applyBannedPhrasesToBody(
    'それが**青色申告者向けの「青色事業専従者給与」**です（所得税法第57条）。'
  );
  assert(t2 === 'それが<strong>青色申告者向けの「青色事業専従者給与」</strong>です（所得税法第57条）。',
    '日本語境界の太字も <strong> に変換');

  // 連続する太字
  const { text: t3 } = bp.applyBannedPhrasesToBody('**項目1**と**項目2**');
  assert(t3 === '<strong>項目1</strong>と<strong>項目2</strong>', '連続太字も正しく変換');

  // 孤立 ** は削除
  const { text: t4 } = bp.applyBannedPhrasesToBody('** が孤立');
  assert(!t4.includes('**'), '孤立 ** は削除される');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
