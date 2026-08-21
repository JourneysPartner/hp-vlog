'use strict';

/**
 * 通達カタログのテスト。
 *   node scripts/lib/__tests__/test-tsutatsu.js
 *
 * ネットワークは使わない（保存済みカタログと解析ロジックだけを見る）。
 *
 * 2026-08-20〜21 に通達の誤りが2日続けて出た。
 *   所基通37-14 を「按分が必要」と書いた（実際は継続適用が条件の任意の取扱い）
 *   商品券の「発行」を非課税と書いた（実際は不課税。消基通6-4-5）
 * タックスアンサー番号は照合できたが、通達番号は照合できなかった。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const P = require(path.join(ROOT, 'scripts/lib/tsutatsu-parser'));
const T = require(path.join(ROOT, 'scripts/lib/nta-tsutatsu'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. 条番号の正規化 ──────────────────────────────────────────
console.log('\n=== Test 1: 条番号の正規化 ===');
{
  assert(P.normalizeProvisionNo('6－4－5') === '6-4-5', '全角ハイフンを半角に');
  assert(P.normalizeProvisionNo('37－14の2') === '37-14の2', '「の2」形式を保つ');
  assert(P.normalizeProvisionNo('６－４－５') === '6-4-5', '全角数字を半角に');
  assert(P.normalizeProvisionNo(' 37-13　') === '37-13', '前後の空白を落とす');
  assert(P.normalizeProvisionNo(null) === '', 'null は空文字');

  assert(P.looksLikeProvisionNo('6-4-5'), '6-4-5 は条番号');
  assert(P.looksLikeProvisionNo('37-14の2'), '37-14の2 は条番号');
  assert(!P.looksLikeProvisionNo('2026'), '年号は条番号ではない');
  assert(!P.looksLikeProvisionNo('37'), '枝番が無いものは条番号としない');

  // 2026-08-21: 「の」を末尾にしか許しておらず、章・節番号に「の」が入る
  // 条文を181条まるごと取りこぼしていた（法人税のリース取引など）。
  assert(P.looksLikeProvisionNo('12の5-1-1'), '章番号に「の」（法基通のリース取引）');
  assert(P.looksLikeProvisionNo('7-6の2-1'), '節番号に「の」');
  assert(P.looksLikeProvisionNo('1-2-3-4'), '4階層の番号');
  assert(!P.looksLikeProvisionNo('abc'), '文字列は条番号ではない');
  // 相続税は「・」で複数条にまたがり、「共」で共通関係を示す。
  assert(P.looksLikeProvisionNo('1の2-1'), '相基通の通常形');
  assert(P.looksLikeProvisionNo('1の3・1の4共-1'), '「・」と「共」を含む番号');
  assert(P.looksLikeProvisionNo('2・2の2共-1'), '「・」を含む番号');
  assert(!P.looksLikeProvisionNo(''), '空文字は条番号ではない');
}

// ── 2. ページ解析 ──────────────────────────────────────────────
console.log('\n=== Test 2: ページ解析 ===');
{
  // 消費税型（条番号が strong 1つ）
  const shohi = [
    '<h1>第4節　物品切手等の譲渡関係</h1>',
    '<h2>（物品切手等の発行）</h2>',
    '<p class="indent1"><strong>6－4－5　</strong>事業者が、物品切手等を発行し、交付した場合において、',
    'その交付に係る相手先から収受する金品は、資産の譲渡等の対価に該当しない。</p>',
    '<h2>（物品切手等の取扱手数料）</h2>',
    '<p class="indent1"><strong>6－4－6　</strong>事業者が…取扱手数料は、課税資産の譲渡等の対価に該当する。</p>',
  ].join('\n');
  const r1 = P.parseTsutatsuPage(shohi, { url: 'u', circular: 'shohi' });
  assert(r1.provisions.length === 2, `2条を抽出（実: ${r1.provisions.length}）`);
  assert(r1.provisions[0].no === '6-4-5', '条番号を正規化して取る');
  assert(/物品切手等の発行/.test(r1.provisions[0].title), '見出しを取る');
  assert(/資産の譲渡等の対価に該当しない/.test(r1.provisions[0].body), '本文を取る');
  assert(!/6－4－5/.test(r1.provisions[0].body), '本文に条番号が残らない');

  // 所得税型（条番号が strong 2つに分かれる）
  const shotoku = [
    '<h1>〔資本的支出と修繕費等〕</h1>',
    '<h2>（形式基準による修繕費の判定）</h2>',
    '<p class="indent1"><strong>37</strong><strong>－13　</strong>一の修理、改良等のために要した金額のうちに…</p>',
  ].join('\n');
  const r2 = P.parseTsutatsuPage(shotoku, { url: 'u', circular: 'shotoku' });
  assert(r2.provisions.length === 1, '分割された条番号でも抽出できる');
  assert(r2.provisions[0].no === '37-13', `strong 2つを連結（実: ${r2.provisions[0].no}）`);

  // 条番号らしくない見出しは拾わない
  const noise = '<h2>（参考）</h2><p><strong>参考</strong>これは条文ではありません。</p>';
  assert(P.parseTsutatsuPage(noise, {}).provisions.length === 0, '条番号でないものは拾わない');
}

// ── 3. カタログの中身 ──────────────────────────────────────────
console.log('\n=== Test 3: カタログ ===');
{
  const stats = T.catalogStats();
  assert(stats.length >= 4, `4通達が取得済み（実: ${stats.length}）`);
  for (const s of stats) {
    assert(s.provisions > 100, `${s.label}: 条文が十分にある（${s.provisions} 条）`);
  }

  // 実際に誤りが起きた条文が引けること
  const p6445 = T.findProvision('6-4-5');
  assert(!!p6445, '消基通6-4-5 が引ける');
  assert(/資産の譲渡等の対価に該当しない/.test(p6445.body), '6-4-5 の原文が正しい');
  assert(p6445.short === '消基通', '通達の略称が付く');

  const p3714 = T.findProvision('37-14');
  assert(!!p3714, '所基通37-14 が引ける');
  assert(/継続して/.test(p3714.body), '37-14 に「継続して」が含まれる');
  assert(/これを認めるものとする/.test(p3714.body), '37-14 が任意の取扱いだと分かる');

  const p3713 = T.findProvision('37-13');
  assert(!!p3713, '所基通37-13 が引ける');
  assert(/60万円/.test(p3713.body) && /10%|10パーセント|10％/.test(p3713.body),
    '37-13 が形式基準（60万円・10%）である');

  assert(T.findProvision('37-14の2') !== null, '「の2」形式も引ける');
  assert(T.findProvision('99-99-99') === null, '存在しない番号は null');
}

// ── 4. 引用の照合 ──────────────────────────────────────────────
console.log('\n=== Test 4: 引用の照合 ===');
{
  const ok = T.checkCitations('この場合は消基通6-4-5により不課税です。所基通37-13も参照。');
  assert(ok.citations.length === 2, `2件の引用を検出（実: ${ok.citations.length}）`);
  assert(ok.unknown.length === 0, '実在する引用は unknown にならない');

  const ng = T.checkCitations('所基通37-99により按分します。');
  assert(ng.unknown.length === 1, '存在しない番号を検出する');
  assert(ng.unknown[0].no === '37-99', '検出した番号が分かる');

  // 通達名の表記ゆれ
  assert(T.checkCitations('消費税法基本通達6-4-5').citations.length === 1, '正式名称でも検出');
  assert(T.checkCitations('所得税基本通達37－14').unknown.length === 0, '全角ハイフンでも照合できる');

  // 通達に触れていない本文では何も出ない
  assert(T.checkCitations('タックスアンサー No.6229 を参照。').citations.length === 0,
    'タックスアンサーの番号を通達と誤検出しない');
  assert(T.checkCitations('').citations.length === 0, '空文字でも落ちない');
}

// ── 5. プロンプト用ブロック ────────────────────────────────────
console.log('\n=== Test 5: プロンプト用ブロック ===');
{
  const block = T.buildProvisionBlock(['6-4-5', '37-14']);
  assert(block.length > 0, 'ブロックが組まれる');
  assert(/資産の譲渡等の対価に該当しない/.test(block), '6-4-5 の原文が入る');
  assert(/継続して/.test(block), '37-14 の原文が入る');
  assert(/原文がある通達だけ/.test(block), '原文がある通達だけ引く指示');
  assert(/任意の取扱い/.test(block), '任意の取扱いである旨の注意');
  assert(T.buildProvisionBlock([]) === '', '空配列なら空文字');
  assert(T.buildProvisionBlock(['99-99-99']) === '', '存在しない番号だけなら空文字');
}

// -- 6. 法人税基本通達 ------------------------------------------------
// リース取引・中古資産の耐用年数など「法人税の通達しか存在しない論点」を
// 個人事業者向けの記事で引くことがあるため追加した。
console.log('');
console.log('=== Test 6: 法人税基本通達 ===');
{
  const cat = T.loadCatalog();
  assert(!!cat.hojin, 'カタログに法人税が入っている');
  assert(Object.keys(cat.hojin.provisions).length > 500,
    `法人税の条文が十分にある（${cat.hojin ? Object.keys(cat.hojin.provisions).length : 0} 条）`);

  // 所得税と対になる条文（同じ論点の法人税版）
  const p = T.findProvision('7-8-4');
  assert(!!p, '法基通7-8-4（形式基準による修繕費の判定）が引ける');
  assert(/60万円/.test(p.body), '7-8-4 に60万円の形式基準がある');
  assert(p.short === '法基通', '略称が法基通');

  const p5 = T.findProvision('7-8-5');
  assert(!!p5 && /資本的支出と修繕費の区分の特例/.test(p5.title),
    '法基通7-8-5（区分の特例）が引ける');

  // 引用の照合が法人税にも効く
  const c = T.checkCitations('法基通7-8-4により判定します。法人税基本通達7-8-5も参照。');
  assert(c.citations.length === 2, `法人税の引用を2件検出（実: ${c.citations.length}）`);
  assert(c.unknown.length === 0, '実在する法人税の引用は unknown にならない');
  assert(T.checkCitations('法基通9-9-99を参照。').unknown.length === 1,
    '存在しない法人税の番号を検出する');

  // 通達をまたいで同じ番号があっても、指定した通達から引ける
  // リース取引は法人税の通達にしかない（第12章の5）。
  // 個人事業者向けの記事でも引くことがあるため、取得できていることを確かめる。
  const lease = T.findProvision('12の5-1-3');
  assert(!!lease, '法基通12の5-1-3（リース取引の判定）が引ける');
  assert(/リース/.test(lease.title), '見出しがリース取引');
  assert(T.checkCitations('法基通12の5-1-3を参照。').unknown.length === 0,
    '章番号に「の」が入る番号も照合できる');

  const both = T.findProvision('7-8-4', 'hojin');
  assert(both && both.circular === 'hojin', '通達を指定して引ける');
}

// -- 7. --only で他の通達の記録を消さない ------------------------------
// 2026-08-21: --only で1つだけ取得すると index.json が上書きされ、
// 他の通達の記録が消えていた。
console.log('');
console.log('=== Test 7: index の保全 ===');
{
  const fs = require('fs');
  const index = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'data/nta-tsutatsu/index.json'), 'utf8'));
  const keys = index.map(e => e.circular).sort();
  assert(['shotoku', 'shohi', 'hojin', 'sozoku'].every(k => keys.includes(k)),
    `4通達すべてが index にある（実: ${keys.join(', ')}）`);
  assert(new Set(keys).size === keys.length, '同じ通達が重複していない');
  for (const e of index) {
    assert(fs.existsSync(path.join(ROOT, 'data/nta-tsutatsu', e.file)),
      `${e.circular}: 本文ファイルが存在する`);
    assert(e.provision_count > 0, `${e.circular}: 条文数が記録されている`);
  }

  const src = fs.readFileSync(path.join(ROOT, 'scripts/crawl-nta-tsutatsu.js'), 'utf8');
  assert(/index = index\.filter\(e => e\.circular !== key\)/.test(src),
    '同じ通達の古い記録だけを差し替える実装になっている');
  assert(/JSON\.parse\(fs\.readFileSync\(indexPath/.test(src),
    '既存の index を読み込んでいる');
}

// -- 8. 相続税法基本通達 ----------------------------------------------
// URL 階層・条番号の形式・目次のリンク形式が他の3通達と異なる。
//   URL      /kihon/sisan/sozoku2/…（他は /kihon/<税目>/…）
//   条番号   1の3・1の4共-1（「・」で複数条、「共」で共通関係）
//   目次     節ページへのリンクにアンカーが付く（01/01.htm#a-1_1_2_1）
console.log('');
console.log('=== Test 8: 相続税法基本通達 ===');
{
  const cat = T.loadCatalog();
  assert(!!cat.sozoku, 'カタログに相続税が入っている');
  assert(Object.keys(cat.sozoku.provisions).length > 300,
    `相続税の条文が十分にある（${cat.sozoku ? Object.keys(cat.sozoku.provisions).length : 0} 条）`);

  const p = T.findProvision('1の3・1の4共-1');
  assert(!!p, '相基通1の3・1の4共-1 が引ける');
  assert(p.short === '相基通', '略称が相基通');
  assert(/個人/.test(p.title), '見出しが取れている');
  assert(!!T.findProvision('1の2-1'), '相基通1の2-1 が引ける');

  const c = T.checkCitations('相基通1の3・1の4共-1により判定します。');
  assert(c.citations.length === 1, `相続税の引用を検出（実: ${c.citations.length}）`);
  assert(c.unknown.length === 0, '実在する相続税の引用は unknown にならない');
  assert(T.checkCitations('相続税法基本通達99・99共-1を参照。').unknown.length === 1,
    '存在しない相続税の番号を検出する');
}

// -- 9. カタログ全体の品質 --------------------------------------------
console.log('');
console.log('=== Test 9: 品質 ===');
{
  const fs = require('fs');
  const index = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'data/nta-tsutatsu/index.json'), 'utf8'));
  const NTA_PREFIX = 'https://www.nta.go.jp/';
  let total = 0;
  for (const e of index) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/nta-tsutatsu', e.file), 'utf8'));
    const ps = Object.values(d.provisions);
    total += ps.length;
    const noTitle = ps.filter(x => !x.title).length;
    const noBody = ps.filter(x => !x.body || x.body.length < 20).length;
    assert(noTitle === 0, `${e.label}: 見出しが空の条文が無い（${noTitle} 件）`);
    assert(noBody <= Math.ceil(ps.length * 0.02),
      `${e.label}: 本文が極端に短い条文が2%以下（${noBody}/${ps.length}）`);
    assert(ps.every(x => x.url && x.url.startsWith(NTA_PREFIX)),
      `${e.label}: すべての条文に国税庁の URL が付いている`);
  }
  assert(total > 3000, `カタログ全体で十分な条文数（${total} 条）`);
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
