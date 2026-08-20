'use strict';

/**
 * 税制改正の大綱チェックのテスト。
 *   node scripts/lib/__tests__/test-tax-reform-outline.js
 *
 * ネットワークは使わない（HTML の解析とスナップショットの整合だけを見る）。
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const mod = require(path.join(ROOT, 'scripts/check-tax-reform-outline'));
const { CHAPTERS, outlineUrl, parseChapter, stripTags, keyOf } = mod;

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. 監視範囲は4章だけ ───────────────────────────────────────
console.log('\n=== Test 1: 監視範囲 ===');
{
  const keys = Object.keys(CHAPTERS);
  assert(keys.length === 4, `4章のみ（実: ${keys.length}）`);
  assert(keys.join(',') === '01,02,03,04', '一〜四（国際課税・防衛力は対象外）');
  assert(CHAPTERS['01'].label === '個人所得課税', '一 個人所得課税');
  assert(CHAPTERS['02'].label === '資産課税', '二 資産課税');
  assert(CHAPTERS['03'].label === '法人課税', '三 法人課税');
  assert(CHAPTERS['04'].label === '消費課税', '四 消費課税');
  assert(!keys.includes('05') && !keys.includes('06'), '五 国際課税・六 防衛力は含まない');
}

// ── 2. URL の組み立て ──────────────────────────────────────────
console.log('\n=== Test 2: URL ===');
{
  assert(outlineUrl(2026, '04') ===
    'https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/08taikou_04.htm',
    '令和8年度（2026）→ fy2026/08taikou_04.htm');
  assert(outlineUrl(2027, '01') ===
    'https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2027/09taikou_01.htm',
    '令和9年度（2027）→ fy2027/09taikou_01.htm');
  assert(/^https:\/\/www\.mof\.go\.jp\//.test(outlineUrl(2026, '01')), '財務省ドメイン');
}

// ── 3. HTML の解析（実際の構造を模したもの）────────────────────
console.log('\n=== Test 3: 解析 ===');
{
  const html = [
    '<h2 class="x">四消費課税</h2>',
    '<h3 class="decoA3">１国境を越えた電子商取引に係る課税の見直し</h3>',
    '<p>本文</p>',
    '<h3 class="decoA3">２適格請求書等保存方式に係る経過措置の見直し</h3>',
    '<h3 class="decoA3">３自動車関係諸税の見直し</h3>',
  ].join('\n');
  const r = parseChapter(html);
  assert(r.chapterTitle === '四消費課税', '章名を取れる');
  assert(r.items.length === 3, `項目3件（実: ${r.items.length}）`);
  assert(r.items[0].no === '１', '番号を分離する');
  assert(r.items[0].title === '国境を越えた電子商取引に係る課税の見直し', 'タイトルから番号を除く');
  assert(r.items[1].title === '適格請求書等保存方式に係る経過措置の見直し', '2件目');

  // タグ入りの見出しでも取れる
  const r2 = parseChapter('<h3><span>１</span>税制上の基準額の点検・見直し</h3>');
  assert(r2.items[0].title === '税制上の基準額の点検・見直し', 'タグが入っていても取れる');

  // h3 が無い＝構成が変わった場合は0件（呼び出し側でエラー扱いにする）
  assert(parseChapter('<h2>四消費課税</h2><p>本文だけ</p>').items.length === 0,
    'h3 が無ければ0件（構成変化を検出できる）');

  assert(stripTags('<p>あ&nbsp;い</p>') === 'あ い', 'stripTags が実体参照も処理する');
}

// ── 4. 項目キー ────────────────────────────────────────────────
console.log('\n=== Test 4: キー ===');
{
  assert(keyOf({ no: '１', title: 'A' }) === keyOf({ no: '１', title: 'A' }), '同じ項目は同じキー');
  assert(keyOf({ no: '１', title: 'A' }) !== keyOf({ no: '２', title: 'A' }), '番号が違えば別キー');
  assert(keyOf({ no: '１', title: 'A' }) !== keyOf({ no: '１', title: 'B' }), '改題は別キー（新規として検出）');
}

// ── 5. スナップショットの整合 ──────────────────────────────────
console.log('\n=== Test 5: スナップショット ===');
{
  const p = path.join(ROOT, 'data', 'tax-reform-outline.json');
  assert(fs.existsSync(p), 'スナップショットが存在する');
  const snap = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert(Object.keys(snap.chapters).length === 4, '4章ぶん記録されている');

  const VALID = new Set(['todo', 'registered', 'not_applicable']);
  let todo = 0, total = 0, missingNote = 0;
  for (const c of Object.values(snap.chapters)) {
    assert(Array.isArray(c.items) && c.items.length > 0, `${c.label}: 項目がある`);
    for (const i of c.items) {
      total++;
      assert(VALID.has(i.status), `${c.label} ${i.title.slice(0, 18)}: status が有効（${i.status}）`);
      if (i.status === 'todo') todo++;
      if (i.status !== 'todo' && !i.note) missingNote++;
    }
  }
  assert(todo === 0, `未判断が0件（実: ${todo}）— 定常状態で通知が鳴らないこと`);
  assert(missingNote === 0, `判断済みの項目には理由が書かれている（note 無し: ${missingNote}）`);
  assert(total >= 15, `項目数が妥当（実: ${total}）`);

  // 登録済みとした項目が、実際にカタログに入っていること
  const { CHANGES } = require(path.join(ROOT, 'scripts/lib/tax-law-changes'));
  const keys = new Set(CHANGES.map(c => c.key));
  const registered = [];
  for (const c of Object.values(snap.chapters)) {
    for (const i of c.items) if (i.status === 'registered') registered.push(i);
  }
  assert(registered.length >= 4, `登録済みの項目がある（実: ${registered.length}）`);
  for (const i of registered) {
    const referenced = (i.note.match(/[a-z0-9_]{8,}/g) || []).filter(k => keys.has(k));
    assert(referenced.length > 0,
      `${i.title.slice(0, 22)}: note が実在する CHANGES の key を指している`);
  }
}

// ── 6. ワークフロー ────────────────────────────────────────────
console.log('\n=== Test 6: ワークフロー ===');
{
  const p = path.join(ROOT, '.github/workflows/check-tax-reform.yml');
  assert(fs.existsSync(p), 'ワークフローが存在する');
  const y = fs.readFileSync(p, 'utf8');
  assert(/cron:/.test(y), '定期実行が設定されている');
  assert(/workflow_dispatch/.test(y), '手動実行できる');
  assert(/gh pr create/.test(y), 'スナップショットの変更は PR 化する');
  assert(!/git push origin main/.test(y), 'main へ直 push しない');
  assert(/notify\.js/.test(y), '通知する');
  assert(/errors != '0'/.test(y), '抽出が壊れたら失敗させる');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
