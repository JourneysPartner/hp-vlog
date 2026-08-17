'use strict';

/**
 * LLM 出力を囲むコードフェンスの除去テスト。
 *   node scripts/lib/__tests__/test-fence-strip.js
 *
 * 2026-08-17 の事故を再現する回帰テスト。
 * 記事本文が自前のコードフェンス（計算式ブロック）を含んでいたため、
 * /m フラグ付きの ^``` が本文内のフェンスに一致し、5,711 文字の記事が
 * その中身「合計所得金額 ＝ 売上（総収入金額） − 必要経費」（25 文字）に
 * 置き換わった。差し戻し再生成が3回続けて失敗した原因。
 *
 * generate-draft.js は require すると main() が走るため、
 * 実装と同一のロジックをここに写して検証する。
 * 実装が変わったら本テストも追随させること（下の同期チェックが検出する）。
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 実装と同一のロジック ────────────────────────────────────────
const FENCE_MIN_RATIO = 0.6;
function stripWrappingFence(text) {
  const s = String(text || '').trim();
  const candidates = [
    s.match(/^```(?:markdown|md|yaml|yml)?[ \t]*\r?\n([\s\S]+)\r?\n```$/),
    s.match(/^[\s\S]{0,200}?\r?\n```(?:markdown|md|yaml|yml)?[ \t]*\r?\n([\s\S]+)\r?\n```$/),
  ];
  for (const m of candidates) {
    if (!m) continue;
    const inner = m[1].trim();
    if (inner.length >= s.length * FENCE_MIN_RATIO) return inner;
  }
  return s;
}

// 旧実装（バグ入り）— 対比のため
function strippedOld(text) {
  const fenced = text.match(/^```(?:markdown|md)?\n([\s\S]+)\n```\s*$/m);
  return (fenced ? fenced[1] : text).trim();
}

// ── 1. 事故の再現: 本文の途中にコードフェンスがある ───────────────
console.log('\n=== Test 1: 本文内のコードフェンス（2026-08-17 の事故）===');
{
  const body = [
    '## 税の扶養と社会保険の扶養は別物です',
    '',
    '売上が伸びてきた個人事業主の方から、よくいただくご質問です。'.repeat(8),
    '',
    '### 所得の計算',
    '',
    '```',
    '合計所得金額 ＝ 売上（総収入金額） − 必要経費',
    '```',
    '',
    '## 社会保険の被扶養者の要件',
    '',
    '年間収入130万円未満であることが要件です。'.repeat(8),
    '',
    '## まとめ',
    '',
    '税と社会保険は別々に確認してください。'.repeat(8),
  ].join('\n');

  const old = strippedOld(body);
  assert(old === '合計所得金額 ＝ 売上（総収入金額） − 必要経費',
    `旧実装は本文を ${old.length} 文字に潰す（事故の再現）`);

  const now = stripWrappingFence(body);
  assert(now === body.trim(), '新実装は本文をそのまま保つ');
  assert(now.includes('## まとめ'), '末尾の章が残る');
  assert(now.includes('```'), '本文内のコードフェンスは保持される');
}

// ── 2. 出力全体がフェンスで囲まれている場合は外す ─────────────────
console.log('\n=== Test 2: 出力全体がフェンス → 中身を採用 ===');
{
  const body = '## 見出し\n' + '本文です。'.repeat(100);
  assert(stripWrappingFence('```markdown\n' + body + '\n```') === body, 'markdown 指定');
  assert(stripWrappingFence('```md\n' + body + '\n```') === body, 'md 指定');
  assert(stripWrappingFence('```\n' + body + '\n```') === body, '言語指定なし');
  assert(stripWrappingFence('```yaml\n' + body + '\n```') === body, 'yaml 指定');
  assert(stripWrappingFence('```markdown  \n' + body + '\n```') === body, '言語の後に空白');
  assert(stripWrappingFence('```markdown\r\n' + body.replace(/\n/g, '\r\n') + '\r\n```')
    === body.replace(/\n/g, '\r\n'), 'CRLF 改行');
}

// ── 3. 短い前置きの後にフェンスが始まる場合も外す ─────────────────
console.log('\n=== Test 3: 前置き＋フェンス ===');
{
  const body = '## 見出し\n' + '本文です。'.repeat(100);
  assert(stripWrappingFence('はい、修正しました。\n\n```markdown\n' + body + '\n```') === body,
    '短い前置きは落として中身を採用');
}

// ── 4. 比率ガード: 中身が小さすぎるなら誤一致とみなす ─────────────
console.log('\n=== Test 4: 比率ガード ===');
{
  // 長い本文の末尾に小さなフェンスがある（前置きが200字以内でも潰させない）
  const s = '短い前置き\n\n```\nごく短い中身\n```';
  // この場合は中身が入力の 60% 未満 → そのまま返す
  assert(stripWrappingFence(s) === s.trim(), '中身が 60% 未満ならフェンス除去しない');

  // 中身が大半を占めるなら外す
  const big = '前置き\n\n```\n' + 'あ'.repeat(200) + '\n```';
  assert(stripWrappingFence(big) === 'あ'.repeat(200), '中身が大半なら外す');
}

// ── 5. フェンスが無い通常の出力はそのまま ─────────────────────────
console.log('\n=== Test 5: フェンスなし ===');
{
  const body = '## 見出し\n本文です。';
  assert(stripWrappingFence(body) === body, 'そのまま返す');
  assert(stripWrappingFence('') === '', '空文字');
  assert(stripWrappingFence(null) === '', 'null');
  assert(stripWrappingFence(undefined) === '', 'undefined');
  assert(stripWrappingFence('  \n本文\n  ') === '本文', '前後の空白は落とす');
}

// ── 6. 閉じフェンスが無い（出力が途中で切れた）場合 ───────────────
console.log('\n=== Test 6: 閉じフェンスが無い ===');
{
  const s = '```markdown\n## 見出し\n本文です。';
  assert(stripWrappingFence(s) === s, '閉じフェンスが無ければそのまま（勝手に切らない）');
}

// ── 7. 実装との同期チェック ──────────────────────────────────────
// generate-draft.js 側から /m 付きのフェンス正規表現が復活していないか確認する。
console.log('\n=== Test 7: 実装に /m 付きフェンス正規表現が残っていない ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts/generate-draft.js'), 'utf8');
  const bad = src.match(/\/\^```[^\n]*\/m[a-z]*[;,)\]]/g) || [];
  assert(bad.length === 0, `/m 付きフェンス正規表現は無い（検出: ${bad.join(' , ') || 'なし'}）`);
  assert(/function stripWrappingFence/.test(src), 'stripWrappingFence が定義されている');
  assert(/postProcess\(stripWrappingFence\(raw\)\)/.test(src), 'full 経路が stripWrappingFence を使う');
  assert(/sanitizeBannedPhrases\(stripWrappingFence\(text\)\)/.test(src),
    'postProcessBodyOnly が stripWrappingFence を使う');
  assert(/const FENCE_MIN_RATIO = 0\.6/.test(src), '比率ガードの閾値が実装と一致（0.6）');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
