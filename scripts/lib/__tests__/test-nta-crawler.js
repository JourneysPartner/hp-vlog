'use strict';

/**
 * nta-crawler モジュールのテスト
 *   node scripts/lib/__tests__/test-nta-crawler.js
 *
 * Phase C-1 でカバーする内容:
 *   - エンコーディング検知（HTTP header / meta tag / fallback）
 *   - Shift_JIS / UTF-8 のデコード
 *   - 文字化け検知（U+FFFD 出現率）
 *   - SHA-256 ハッシュ
 *   - RateLimiter の最小間隔保証
 *
 * 実 fetch のテストは別ファイル（手動実行）に分離。CI では走らせない。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const crawler = require(path.join(ROOT, 'scripts/lib/nta-crawler'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. エンコーディング検知 ────────────────────────────────────
console.log('\n=== Test 1: detectEncoding ===');
{
  // HTTP header 優先
  const buf = Buffer.from('<html><meta charset="shift_jis"></html>');
  assert(crawler.detectEncoding(buf, 'text/html; charset=utf-8') === 'utf-8',
    'HTTP header の charset を優先');

  // HTTP header に charset なし → meta charset
  assert(crawler.detectEncoding(buf, 'text/html') === 'shift_jis',
    'meta charset を検知');

  // HTTP header も meta もない → utf-8 fallback
  const buf2 = Buffer.from('<html><body>plain</body></html>');
  assert(crawler.detectEncoding(buf2, '') === 'utf-8',
    'fallback は utf-8');

  // http-equiv 形式
  const buf3 = Buffer.from('<html><meta http-equiv="Content-Type" content="text/html; charset=shift_jis"></html>');
  assert(crawler.detectEncoding(buf3, '') === 'shift_jis',
    'meta http-equiv 形式も検知');

  // 大文字小文字、ハイフン違い吸収
  const buf4 = Buffer.from('<meta charset="SHIFT-JIS">');
  assert(crawler.detectEncoding(buf4, '') === 'shift_jis',
    'SHIFT-JIS 表記も shift_jis に正規化');
}

// ── 2. decodeBuffer ────────────────────────────────────────────
console.log('\n=== Test 2: decodeBuffer ===');
{
  const utf8Text = 'こんにちは、国税庁';
  const utf8Buf = Buffer.from(utf8Text, 'utf-8');
  assert(crawler.decodeBuffer(utf8Buf, 'utf-8') === utf8Text,
    'UTF-8 デコード');

  // Shift_JIS バイト列を手動で構築
  // 「あ」 (U+3042) → 0x82 0xA0
  const sjisBytes = Buffer.from([0x82, 0xA0]);
  const decoded = crawler.decodeBuffer(sjisBytes, 'shift_jis');
  assert(decoded === 'あ', `Shift_JIS デコード（"あ"）, got: ${decoded}`);

  // 不明エンコーディングは utf-8 fallback
  const fallback = crawler.decodeBuffer(utf8Buf, 'unknown-encoding-xxx');
  assert(fallback === utf8Text, '不明エンコーディングは utf-8 fallback');
}

// ── 3. 文字化け検知 ──────────────────────────────────────────
console.log('\n=== Test 3: detectMojibake ===');
{
  assert(crawler.detectMojibake('正常な日本語テキストです') === false,
    '正常なテキストは false');

  // U+FFFD を 5% 含む（閾値 1% を超える）
  const mojibake = '正常テキスト' + '�'.repeat(5);
  assert(crawler.detectMojibake(mojibake) === true,
    'U+FFFD 多数 → true');

  // 空文字列
  assert(crawler.detectMojibake('') === false, '空文字は false');
  assert(crawler.detectMojibake(null) === false, 'null は false');

  // 閾値カスタマイズ
  const slight = '正常テキスト' + '�'.repeat(1);  // 1/11 ≈ 9% > 1%
  assert(crawler.detectMojibake(slight, 0.5) === false,
    '閾値 50% にすれば検知されない');
}

// ── 4. SHA-256 ハッシュ ──────────────────────────────────────
console.log('\n=== Test 4: sha256Hex ===');
{
  const h1 = crawler.sha256Hex('hello');
  assert(h1 === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    '"hello" の SHA-256 が正しい');

  const h2 = crawler.sha256Hex('hello');
  assert(h1 === h2, '同じ入力で同じ hash');

  const h3 = crawler.sha256Hex('world');
  assert(h1 !== h3, '異なる入力で異なる hash');

  // 日本語入力
  const hJp = crawler.sha256Hex('税理士');
  assert(hJp.length === 64 && /^[0-9a-f]+$/.test(hJp),
    '日本語入力でも 64 hex 文字を返す');
}

// ── 6. decideIncrementalAction ────────────────────────────────
console.log('\n=== Test 6: decideIncrementalAction ===');
{
  // 1. 既存なし → first_time
  {
    const r = crawler.decideIncrementalAction(null, { ok: true, etag: 'X', lastModified: 'L' });
    assert(r.decision === 'first_time', `既存なし → first_time`);
  }
  // 2. 既存に html_hash なし → first_time
  {
    const r = crawler.decideIncrementalAction({}, { ok: true, etag: 'X', lastModified: 'L' });
    assert(r.decision === 'first_time', `html_hash なし → first_time`);
  }
  // 3. HEAD 404 → mark_deleted
  {
    const r = crawler.decideIncrementalAction(
      { html_hash: 'h', etag: 'X' },
      { ok: false, reason: 'not_found', status: 404 }
    );
    assert(r.decision === 'mark_deleted', `HEAD 404 → mark_deleted`);
  }
  // 4. HEAD エラー → fetch（安全側）
  {
    const r = crawler.decideIncrementalAction(
      { html_hash: 'h', etag: 'X' },
      { ok: false, reason: 'retry_exhausted', status: 0 }
    );
    assert(r.decision === 'fetch', `HEAD エラー → fetch (安全側)`);
  }
  // 5. ETag 一致 → skip
  {
    const r = crawler.decideIncrementalAction(
      { html_hash: 'h', etag: '"abc123"', last_modified: 'old' },
      { ok: true, etag: '"abc123"', lastModified: 'new' }
    );
    assert(r.decision === 'skip' && r.reason === 'etag_match', `ETag 一致 → skip`);
  }
  // 6. Last-Modified 一致（ETag 不一致 or なし）→ skip
  {
    const r = crawler.decideIncrementalAction(
      { html_hash: 'h', last_modified: 'Wed, 03 Dec 2025 08:30:43 GMT' },
      { ok: true, etag: null, lastModified: 'Wed, 03 Dec 2025 08:30:43 GMT' }
    );
    assert(r.decision === 'skip' && r.reason === 'last_modified_match',
      `Last-Modified 一致 → skip`);
  }
  // 7. ETag/Last-Modified 不一致 → fetch
  {
    const r = crawler.decideIncrementalAction(
      { html_hash: 'h', etag: '"old"', last_modified: 'old' },
      { ok: true, etag: '"new"', lastModified: 'new' }
    );
    assert(r.decision === 'fetch' && r.reason === 'metadata_changed',
      `metadata 変更 → fetch`);
  }
  // 8. HEAD に metadata なし → fetch（既存とは別状態と判断）
  {
    const r = crawler.decideIncrementalAction(
      { html_hash: 'h', etag: '"old"', last_modified: 'old' },
      { ok: true, etag: null, lastModified: null }
    );
    assert(r.decision === 'fetch', `HEAD に metadata なし → fetch`);
  }
}

// ── 7. RateLimiter ────────────────────────────────────────────
console.log('\n=== Test 7: RateLimiter ===');
{
  const rl = new crawler.RateLimiter(100);  // 100ms 最小間隔

  // 1 回目は即座に通る
  const start = Date.now();
  rl.wait().then(() => {
    const elapsed1 = Date.now() - start;
    assert(elapsed1 < 50, `1 回目は即時通過（実: ${elapsed1}ms）`);

    // 2 回目は ~100ms 待たされる
    const t2 = Date.now();
    rl.wait().then(() => {
      const elapsed2 = Date.now() - t2;
      assert(elapsed2 >= 90 && elapsed2 < 200, `2 回目は ~100ms 待機（実: ${elapsed2}ms）`);

      // 結果サマリ
      console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
      process.exit(failed === 0 ? 0 : 1);
    });
  });
}
