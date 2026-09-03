'use strict';
/**
 * 登録済み出典のURLが実在するか（2026-09-03）
 *
 * 何が起きていたか:
 *   pain_point 別・税目別にあらかじめ登録している出典のうち2件が、
 *   存在しないURLを指していた。
 *     real-estate-valuation → taxanswer/hyoka/4602.htm（正しくは sozoku/4602.htm）
 *     housing-fund-gift     → taxanswer/zoyo/4508.htm （正しくは sozoku/4508.htm）
 *   どちらもディレクトリ名の誤り。
 *
 * なぜ気づけなかったか:
 *   出典ガードは「AIが選んだ出典」だけカタログ収録を照合しており、
 *   人が登録した出典（curated / explicit）は無条件で信頼していた。
 *   さらに国税庁の存在しないページは HTTP 404 ではなく 200 を返し、
 *   中身だけがエラーページ（約2KB）なので、通信の成否では判別できない。
 *   結果、公開済み記事1本が切れたリンクを出典として掲げたままになっていた。
 *
 * このテストの役割:
 *   実行のたびに国税庁へ取りに行くのは重いので、月次で取り込んでいる
 *   カタログとの照合で代用する。カタログはタックスアンサー・質疑応答・通達を
 *   収録しているので、そこに載っていないタックスアンサーURLは誤りとみなせる。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { DEFAULT_SOURCE_BY_PAIN, DEFAULT_SOURCE_BY_TAX_DOMAIN } =
  require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// カタログを引けるようにする
const catalog = (() => {
  const idx = require(path.join(ROOT, 'data/nta-sources/index.json'));
  const list = Array.isArray(idx) ? idx : (idx.entries || idx.items || []);
  const alive = new Set();
  const deleted = new Set();
  const page = (u) => String(u || '').split('#')[0].split('?')[0];
  for (const e of list) {
    if (!e || !e.url) continue;
    (e.deleted === true ? deleted : alive).add(page(e.url));
  }
  return { alive, deleted, page, size: list.length };
})();

// カタログはタックスアンサー・質疑応答・通達を収録している。
// パンフレット（/publication/pamph/）は収録対象外なので照合できない。
const isTaxAnswer = (url) => /\/taxes\/shiraberu\/taxanswer\//.test(String(url || ''));

console.log('=== 1. カタログが読める（前提）===');
{
  assert(catalog.size > 2000, `カタログが取り込まれている（${catalog.size}件）`);
  assert(catalog.alive.has('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2020.htm'),
    '既知のページ（No.2020 確定申告）を引ける');
}

console.log('');
console.log('=== 2. 登録済み出典のタックスアンサーURLがすべてカタログにある ===');
{
  const entries = [
    ...Object.entries(DEFAULT_SOURCE_BY_PAIN).map(([k, v]) => [`pain:${k}`, v]),
    ...Object.entries(DEFAULT_SOURCE_BY_TAX_DOMAIN).map(([k, v]) => [`domain:${k}`, v]),
  ];
  assert(entries.length > 100, `登録済み出典がある（${entries.length}件）`);

  const missing = [];
  const removed = [];
  for (const [key, ref] of entries) {
    const url = catalog.page(ref && ref.url);
    if (!url || !isTaxAnswer(url)) continue;      // パンフレット等は照合対象外
    if (catalog.deleted.has(url)) removed.push(`${key} → ${url}`);
    else if (!catalog.alive.has(url)) missing.push(`${key} → ${url}`);
  }

  if (missing.length) {
    console.log('  カタログに無いURL:');
    missing.forEach(m => console.log(`    ${m}`));
  }
  if (removed.length) {
    console.log('  カタログ上で削除済みのURL:');
    removed.forEach(m => console.log(`    ${m}`));
  }
  assert(missing.length === 0, 'カタログに無いタックスアンサーURLが無い');
  assert(removed.length === 0, '削除済みページを指している登録が無い');
}

console.log('');
console.log('=== 3. 今回直した2件が正しい場所を指している ===');
{
  // ディレクトリを取り違えると、国税庁は404ではなく200＋エラーページを返す。
  // 通信の成否では検出できないので、URLそのものを固定して守る。
  const realEstate = DEFAULT_SOURCE_BY_PAIN['real-estate-valuation'];
  assert(/\/taxanswer\/sozoku\/4602\.htm$/.test(realEstate.url),
    '土地家屋の評価（No.4602）が sozoku 配下を指している');
  assert(!/\/hyoka\/4602\.htm/.test(realEstate.url), '誤っていた hyoka 配下に戻っていない');

  const housing = DEFAULT_SOURCE_BY_PAIN['housing-fund-gift'];
  assert(/\/taxanswer\/sozoku\/4508\.htm$/.test(housing.url),
    '住宅取得等資金の贈与（No.4508）が sozoku 配下を指している');
  assert(!/\/zoyo\/4508\.htm/.test(housing.url), '誤っていた zoyo 配下に戻っていない');
}

console.log('');
console.log('=== 4. 登録内容の体裁 ===');
{
  const all = [
    ...Object.values(DEFAULT_SOURCE_BY_PAIN),
    ...Object.values(DEFAULT_SOURCE_BY_TAX_DOMAIN),
  ];
  assert(all.every(r => r && typeof r.url === 'string' && r.url), 'すべてURLを持つ');
  assert(all.every(r => /^https:\/\/[\w.-]+\.go\.jp\//.test(r.url)),
    'すべて go.jp（政府ドメイン）を指している');
  assert(all.every(r => r.title && r.title.length > 0), 'すべてタイトルを持つ');

  // 番号を持つ登録は、URL の番号と食い違わないこと（No.4152 と書いて 4125 を指す等）
  const mismatched = all.filter(r => {
    if (!r.no) return false;
    const inUrl = (String(r.url).match(/(\d+)\.htm/) || [])[1];
    return inUrl && inUrl !== String(r.no);
  }).map(r => `${r.no} ≠ ${r.url}`);
  if (mismatched.length) mismatched.forEach(m => console.log(`    ${m}`));
  assert(mismatched.length === 0, '登録番号とURLの番号が一致している');
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
