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
console.log('=== 5. 公開済み記事の出典URLが実在する ===');
{
  // 登録側を直しても、すでに書かれた記事が旧URLを持っていれば読者にはリンク切れが見える。
  // 2026-09-03: 実際に1本（2026-04-29 住宅取得資金贈与）が zoyo/4508 を掲げていた。
  const fs = require('fs');
  const POSTS = path.join(ROOT, 'content', 'posts');
  const files = fs.existsSync(POSTS)
    ? fs.readdirSync(POSTS).filter(f => f.endsWith('.md')) : [];
  assert(files.length > 100, `記事を読める（${files.length}本）`);

  const bad = [];
  let checked = 0;
  for (const f of files) {
    const raw = fs.readFileSync(path.join(POSTS, f), 'utf8');
    const m = raw.match(/^source_url:\s*(.*)$/m);
    if (!m) continue;
    // 値は " または ' で囲まれていることも、素のこともある
    const url = catalog.page(m[1].trim().replace(/^["']|["']$/g, ''));
    if (!url || !isTaxAnswer(url)) continue;   // パンフレット等は照合対象外
    checked++;
    if (catalog.deleted.has(url)) bad.push(`${f} → ${url}（削除済み）`);
    else if (!catalog.alive.has(url)) bad.push(`${f} → ${url}（カタログに無い）`);
  }
  console.log(`  （タックスアンサーを出典にしている記事 ${checked}本を照合）`);
  if (bad.length) bad.forEach(b => console.log(`    ${b}`));
  assert(bad.length === 0, '実在しないタックスアンサーURLを出典にした記事が無い');
}

console.log('');
console.log('=== 6. 番号一覧表（REFS）と題材一覧（topic-pool）のURLが国税庁カタログと一致する ===');
{
  // 2026-09-04: 登録済み出典（節2）は直したのに、本文の「No.4508」を自動リンクする
  // 番号一覧表（REFS）と題材一覧の source_url が zoyo/4508 のまま残り、本番の記事1本で
  // 古いリンクが復活していた。番号ごとに国税庁カタログの URL と突き合わせる。
  const fs = require('fs');
  const { REFS, resolveNtaUrlByNumber } = require(path.join(ROOT, 'scripts/lib/tax-authority-refs'));
  const idx = require(path.join(ROOT, 'data/nta-sources/index.json'));
  const list = Array.isArray(idx) ? idx : (idx.entries || idx.items || []);
  const urlByNo = {};
  for (const e of list) {
    if (e && e.type === 'taxanswer' && e.deleted !== true && e.id && e.url) urlByNo[String(e.id)] = catalog.page(e.url);
  }
  assert(Object.keys(urlByNo).length > 500, `カタログのタックスアンサーを番号で引ける（${Object.keys(urlByNo).length}件）`);

  const refsBad = [];
  let refsChecked = 0;
  for (const [topic, arr] of Object.entries(REFS)) {
    for (const r of arr) {
      const no = String(r.no || '');
      const url = catalog.page(r.url);
      if (!urlByNo[no] || !isTaxAnswer(url)) continue;
      refsChecked++;
      if (urlByNo[no] !== url) refsBad.push(`${topic}/No.${no}: ${url} → 正: ${urlByNo[no]}`);
    }
  }
  if (refsBad.length) refsBad.forEach(b => console.log(`    ${b}`));
  assert(refsChecked > 20 && refsBad.length === 0, `番号一覧表（REFS）のURLがカタログと一致（${refsChecked}件を照合）`);

  const poolSrc = fs.readFileSync(path.join(ROOT, 'scripts/topic-pool.js'), 'utf8');
  const re = /https:\/\/www\.nta\.go\.jp\/taxes\/shiraberu\/taxanswer\/([a-z]+)\/(\d{4})\.htm/g;
  const poolBad = [];
  let poolChecked = 0, m;
  while ((m = re.exec(poolSrc)) !== null) {
    if (!urlByNo[m[2]]) continue;
    poolChecked++;
    if (urlByNo[m[2]] !== m[0]) poolBad.push(`No.${m[2]}: ${m[1]} → 正: ${urlByNo[m[2]]}`);
  }
  if (poolBad.length) poolBad.forEach(b => console.log(`    ${b}`));
  assert(poolChecked > 30 && poolBad.length === 0, `題材一覧（topic-pool）のURLがカタログと一致（${poolChecked}件を照合）`);

  // 本文の「No.XXXX」自動リンクは、人手の一覧表よりカタログを優先して解決する
  const r4508 = resolveNtaUrlByNumber('4508');
  const r4602 = resolveNtaUrlByNumber('4602');
  assert(r4508 && /\/sozoku\/4508\.htm$/.test(r4508.url) && r4508.fromCatalog === true, 'No.4508 の自動リンクは sozoku 配下（カタログ由来）');
  assert(r4602 && /\/sozoku\/4602\.htm$/.test(r4602.url) && r4602.fromCatalog === true, 'No.4602 の自動リンクは sozoku 配下（カタログ由来。番号レンジ推定の hyoka ではない）');
}

console.log('');
console.log('=== 結果 ===');
console.log(`PASS: ${passed} / FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
