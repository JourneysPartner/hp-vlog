'use strict';

/**
 * マスター鮮度チェッカーのテスト。
 *   node masters/scripts/__tests__/test-check-master-freshness.js
 *
 * 2026-08-23: 相続税マスターで、ファイル冒頭の _extraction_source.html_hash（No.4155のもの）が
 * 別の出典（4152/4114/4117/4158/4157）を引くレコードにも控えとして使われていた。
 * 他所のハッシュを自分の出典として記録した状態で、その出典が改正されても検知できない。
 * 「taxanswer_id が一致するときだけ控えに使う」規則を検証する。
 *
 * 併せて、告示時期の予告が「鳴るべき時に鳴り、それ以外では鳴らない」ことを確認する。
 * 予告が常時鳴ると通知が無視されるようになり、実際の改正を見落とす。
 */

const path = require('path');
const {
  collectRecords,
  coversPeriod,
  targetPeriods,
  nextPeriods,
  inNoticeWindow,
} = require(path.join(__dirname, '..', '..', 'check-master-freshness.js'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── 1. ネストしたデータファイルからレコードを拾えるか ──────────────
console.log('\n=== Test 1: レコードの再帰収集 ===');
{
  const data = {
    _extraction_source: { taxanswer_id: '1410', html_hash: 'aaa' },
    r7: { records: [{ record_id: 'A' }, { record_id: 'B' }] },
    r8: { records: [{ record_id: 'C' }] },
    single: { record_id: 'D' },
    tax_rates: [{ record_id: 'E' }],
  };
  const got = collectRecords(data, 'f.json', [], null).map(x => x.record.record_id);
  assert(got.length === 5, `年度別の入れ子から5件（実: ${got.length}）`);
  assert(['A', 'B', 'C', 'D', 'E'].every(id => got.includes(id)), '配列・単体・入れ子のすべてを拾う');
}
{
  // レコードの内側の入れ子（per_capita_amounts 等）を別レコードとして数えない
  const data = {
    records: [{
      record_id: 'X',
      per_capita_amounts: [{ capital_lower: '0' }, { capital_lower: '1' }],
    }],
  };
  const got = collectRecords(data, 'f.json', [], null);
  assert(got.length === 1, `レコード内部の入れ子は別レコードにしない（実: ${got.length}）`);
}

// ── 2. blocked 理由をグループから引き継ぐ ─────────────────────────
console.log('\n=== Test 2: blocked 理由の引き継ぎ ===');
{
  const data = {
    r8: {
      _status: 'blocked — 改正法で確認するまで登録不可',
      records: [{ record_id: 'R8-1', data_review_status: 'blocked' }],
    },
  };
  const got = collectRecords(data, 'f.json', [], null);
  assert(got[0].groupNote === 'blocked — 改正法で確認するまで登録不可',
    'グループの _status がレコードに引き継がれる');
}
{
  // レコード自身の _blocked_reason があればそちらが優先されることは check() 側の責務。
  // ここでは、グループが無いときに null になることだけ確認する。
  const got = collectRecords({ records: [{ record_id: 'Z' }] }, 'f.json', [], null);
  assert(got[0].groupNote === null, 'グループの注記が無ければ null');
}

// ── 3. 適用期間の判定 ─────────────────────────────────────────
console.log('\n=== Test 3: 期間の重なり判定 ===');
{
  const r7 = { effective_from: '2025-01-01', effective_to: '2025-12-31' };
  const open = { effective_from: '2015-01-01', effective_to: null };

  assert(coversPeriod(r7, '2025-01-01', '2025-12-31') === true, 'R7レコードはR7暦年を覆う');
  assert(coversPeriod(r7, '2026-01-01', '2026-12-31') === false, 'R7レコードはR8暦年を覆わない');
  assert(coversPeriod(open, '2030-01-01', '2030-12-31') === true, 'effective_to が null なら将来も覆う');
  // 期間の端で切れないこと（12/31 開始・1/1 終了の取りこぼし）
  assert(coversPeriod({ effective_from: '2025-12-31', effective_to: null }, '2025-01-01', '2025-12-31') === true,
    '期間の最終日に始まるレコードも重なりとみなす');
}

// ── 4. 対象期間の決定 ─────────────────────────────────────────
console.log('\n=== Test 4: 対象期間 ===');
{
  // 年度は4月始まり。3月は前年度に属する。
  const march = targetPeriods('2026-03-15');
  assert(march.fiscal_april.start === '2025-04-01', `3月は前年度（実: ${march.fiscal_april.start}）`);
  assert(march.calendar_year.start === '2026-01-01', '暦年は当年');

  const april = targetPeriods('2026-04-01');
  assert(april.fiscal_april.start === '2026-04-01', '4月1日から新年度');

  const next = nextPeriods('2026-03-15');
  assert(next.fiscal_april.start === '2026-04-01', `3月時点の「次の年度」は2026年度（実: ${next.fiscal_april.start}）`);
}

// ── 5. 告示時期の予告が鳴る条件 ────────────────────────────────
console.log('\n=== Test 5: 予告の発火条件 ===');
{
  const kenpo = { coverage_basis: 'fiscal_april', expected_update_month: 3 };
  assert(inNoticeWindow(kenpo, '2026-03-10') === true, '3月（告示月）に予告が出る');
  assert(inNoticeWindow(kenpo, '2026-04-10') === false, '4月（切替後）は予告不要');
  assert(inNoticeWindow(kenpo, '2026-08-10') === false, '8月は予告不要');
  assert(inNoticeWindow(kenpo, '2026-01-10') === false, '1月はまだ告示前なので鳴らさない');

  // 年をまたぐ告示（12月告示・4月切替）
  const early = { coverage_basis: 'fiscal_april', expected_update_month: 12 };
  assert(inNoticeWindow(early, '2026-12-10') === true, '12月告示: 12月に予告が出る');
  assert(inNoticeWindow(early, '2027-02-10') === true, '12月告示: 年をまたいだ2月も予告期間');
  assert(inNoticeWindow(early, '2027-06-10') === false, '12月告示: 6月は予告期間外');

  const income = { coverage_basis: 'calendar_year' };
  assert(inNoticeWindow(income, '2026-12-10') === true, '暦年もの: 大綱が出る12月に予告');
  assert(inNoticeWindow(income, '2026-11-10') === false, '暦年もの: 11月は鳴らさない');
  assert(inNoticeWindow(income, '2027-01-10') === false, '暦年もの: 切替後の1月は鳴らさない');

  assert(inNoticeWindow({ coverage_basis: 'none' }, '2026-03-10') === false,
    '期間区分の無い出典は予告しない');
}

// ── 6. 実データに対する回帰確認 ────────────────────────────────
// 上の単体テストは collectRecords までしか見ておらず、
// 「ファイル冒頭のhashを別出典のレコードに流用しない」規則は check() の内部にある。
// 実際のマスターを通して、その規則が効いていることを確かめる。
console.log('\n=== Test 6: 実データでの回帰確認 ===');
{
  const fs = require('fs');
  const { check } = require(path.join(__dirname, '..', '..', 'check-master-freshness.js'));
  const ntaDir = process.env.NTA_SOURCES_DIR
    || path.join(__dirname, '..', '..', '..', 'data', 'nta-sources');

  if (!fs.existsSync(ntaDir)) {
    console.log(`  - 国税庁ソースDBが見つからないため省略（${ntaDir}）`);
  } else {
    const r = check('2026-08-23');
    const f = r.findings;

    assert(f.hashMismatch.length === 0,
      `出典ハッシュの不一致が無い（実: ${f.hashMismatch.length} 件`
      + `${f.hashMismatch.length ? ' — ' + f.hashMismatch.map(x => x.record_id).join(', ') : ''}）`);

    assert(f.sourceUnknown.length === 0,
      `台帳に無い source_document_id が無い（実: ${f.sourceUnknown.length} 件`
      + `${f.sourceUnknown.length ? ' — ' + [...new Set(f.sourceUnknown.map(x => x.source_document_id))].join(', ') : ''}）`);

    assert(f.hashUntracked.length === 0,
      `タックスアンサー出典で source_hash 未記録が無い（実: ${f.hashUntracked.length} 件`
      + `${f.hashUntracked.length ? ' — ' + f.hashUntracked.map(x => x.record_id).join(', ') : ''}）`);

    assert(f.sourceMissing.length === 0,
      `出典ファイルがすべて存在する（実: ${f.sourceMissing.length} 件欠落）`);

    // blocked には理由が要る。理由の無い blocked は、何を確認すれば解除できるのか分からない。
    const noReason = f.blocked.filter(b => b.reason === '（理由の記載なし）');
    assert(noReason.length === 0,
      `blocked に理由が書かれている（理由なし: ${noReason.length} 件`
      + `${noReason.length ? ' — ' + noReason.map(x => x.record_id).join(', ') : ''}）`);
  }
}

// ── 結果 ──────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
