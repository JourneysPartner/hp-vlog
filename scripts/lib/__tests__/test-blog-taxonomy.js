'use strict';

/**
 * blog-taxonomy のテスト。
 *   node scripts/lib/__tests__/test-blog-taxonomy.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const tx = require(path.join(ROOT, 'scripts/lib/blog-taxonomy'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

console.log('\n=== Test: CATEGORIES が全件 slug/color/icon を持つ ===');
{
  assert(tx.CATEGORIES.length >= 6, 'カテゴリ 6 件以上');
  for (const c of tx.CATEGORIES) {
    assert(c.ja && c.slug && c.color && c.icon, `${c.ja}: ja/slug/color/icon 全て揃う`);
    assert(/^#[0-9a-f]{6}$/i.test(c.color), `${c.ja}: color が hex 形式`);
    assert(/^[a-z\-]+$/.test(c.slug), `${c.ja}: slug が小文字+ハイフン`);
  }
}

console.log('\n=== Test: getCategoryMeta / getCategorySlug ===');
{
  const m = tx.getCategoryMeta('所得税');
  assert(m && m.slug === 'shotoku', '所得税 → shotoku');
  assert(tx.getCategorySlug('消費税') === 'shouhi', '消費税 → shouhi');
  assert(tx.getCategoryMeta('存在しない') === null, '未定義は null');
  assert(tx.getCategorySlug('存在しない') === null, '未定義 slug は null');
}

console.log('\n=== Test: MACROS / getMacroMeta ===');
{
  assert(tx.MACROS.length >= 5, 'マクロ 5 件以上');
  const m = tx.getMacroMeta('物販');
  assert(m && m.slug === 'retail', '物販 → retail');
  assert(tx.getMacroSlug('インフルエンサー') === 'influencer', 'インフルエンサー → influencer');
}

console.log('\n=== Test: slug 一意性 ===');
{
  const catSlugs = tx.CATEGORIES.map(c => c.slug);
  assert(new Set(catSlugs).size === catSlugs.length, 'カテゴリ slug 重複なし');
  const macSlugs = tx.MACROS.map(m => m.slug);
  assert(new Set(macSlugs).size === macSlugs.length, 'マクロ slug 重複なし');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
