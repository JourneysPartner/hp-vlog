'use strict';

/**
 * 国税庁 Q&A の分割・目次除外・本文短縮ガードのテスト。
 *   node scripts/lib/__tests__/test-nta-qa-split.js
 *
 * 分割関数だけを直接呼び、PDF の取得やネットワークアクセスは行わない。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const {
  looksLikeTableOfContents,
  splitByQuestion,
  splitByNumberedHeading,
  splitByParenQuestion,
  shouldSkipBodyUpdate,
  getStaleSplitFileNames,
  buildEntryId,
  resolveEntryIds,
  dedupeIndexEntries,
} = require(path.join(ROOT, 'scripts/crawl-nta-qa'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  OK ${label}`); passed++; }
  else { console.error(`  NG ${label}`); failed++; }
}

function keigenBody(no, title = `確認用見出し${no}`) {
  return `（${title}）問${no} この取引には軽減税率が適用されますか。`
    + `【答】具体的な事実関係を確認した上で税率を判定します。${'回答本文です。'.repeat(30)}`;
}

function splitKeigenWith(candidate) {
  return splitByQuestion([
    candidate,
    keigenBody(901),
    keigenBody(902),
    keigenBody(903),
    keigenBody(904),
  ].join(' '));
}

const silentWarnings = { warn() {} };

console.log('=== 分割エントリの id ===');
assert(buildEntryId('jirei', '問4') === 'jirei-4',
  '半角の問4は従来どおり jirei-4');
assert(buildEntryId('jirei', '問４') === 'jirei-4w',
  '全角の問４には wide の印を付ける');
assert(buildEntryId('jirei', '問12') === 'jirei-12',
  '半角の問12は従来どおり jirei-12');
assert(buildEntryId('jirei', '問1-1') === 'jirei-1-1',
  '半角の階層番号はハイフンを残す');
assert(buildEntryId('gaiyo', '問１') !== 'gaiyo-1',
  '全角の問１は半角の id と区別する');
assert(/^[\x00-\x7F]+$/.test(buildEntryId('jirei', '問４')),
  '全角問番号から作る id も ASCII だけになる');

{
  const parts = [
    { qNo: '問３', title: '問３ 水産物の販売', body: '水産物の回答' },
    { qNo: '問3', title: '問3 通信販売', body: '通信販売の回答' },
  ];
  const forward = resolveEntryIds('jirei', parts, silentWarnings);
  const reverse = resolveEntryIds('jirei', [...parts].reverse(), silentWarnings);
  const byQNo = entries => entries.map(entry => [entry.qNo, entry.id])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  assert(new Set(forward.map(entry => entry.id)).size === 2,
    '実データ形の全角・半角の問に別々の id を付ける');
  assert(forward.find(entry => entry.qNo === '問3').id === 'jirei-3',
    'resolveEntryIds でも半角の問3は jirei-3 のまま');
  assert(JSON.stringify(byQNo(forward)) === JSON.stringify(byQNo(reverse)),
    '全角・半角の qNo → id 対応は入力順に依存しない');
}

{
  const parts = [
    { qNo: '問12', title: '問12 一つ目の問', body: '一つ目の回答' },
    { qNo: '問12', title: '問12 二つ目の問', body: '二つ目の回答' },
  ];
  const forward = resolveEntryIds('jirei', parts, silentWarnings);
  const reverse = resolveEntryIds('jirei', [...parts].reverse(), silentWarnings);
  const byTitle = entries => entries.map(entry => [entry.title, entry.id])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  assert(forward.length === 2 && new Set(forward.map(entry => entry.id)).size === 2,
    '同じ qNo の衝突でも両方を異なる id で残す');
  assert(JSON.stringify(byTitle(forward)) === JSON.stringify(byTitle(reverse)),
    '同じ qNo の衝突解消も入力順に依存しない');
}

assert(buildEntryId('faq', '１－１') === 'faq-1-1',
  '暗号資産の番号は従来の id のまま');
assert(buildEntryId('r5kaisei', '問１-１') === 'r5kaisei-1-1',
  '相続の階層問番号は従来の id のまま');

console.log('\n=== index の file_path 重複除外 ===');
{
  const first = { id: 'first', file_path: 'keigen/jirei-4.json' };
  const duplicate = { id: 'second', file_path: 'keigen/jirei-4.json' };
  const other = { id: 'other', file_path: 'keigen/jirei-4w.json' };
  const deduped = dedupeIndexEntries([first, duplicate], silentWarnings);
  assert(deduped.length === 1, '同じ file_path は index に1件だけ残す');
  assert(deduped[0] === first, '同じ file_path では先に来たエントリを残す');
  assert(dedupeIndexEntries([first, other], silentWarnings).length === 2,
    '別の file_path なら index に両方残す');
}

console.log('=== 目次の点線判定 ===');
for (const char of ['·', '・', '．', '.', '…']) {
  assert(looksLikeTableOfContents(char.repeat(6)), `${char} が6文字なら目次`);
  assert(!looksLikeTableOfContents(char.repeat(5)), `${char} が5文字なら目次ではない`);
}
assert(looksLikeTableOfContents(`本文の途中 ${'·'.repeat(6)} 22 その後の文字`),
  '点線が末尾になくても目次');
assert(!looksLikeTableOfContents('通常の回答本文には点線がありません。'),
  '点線のない通常本文は目次ではない');
assert(looksLikeTableOfContents(
  `【令和５年 10 月改訂】 ${'·'.repeat(54)} 22`),
  '実データ jirei-52 の点線を検出');
assert(looksLikeTableOfContents(`${'·'.repeat(37)} 16`),
  '実データ gaiyo-14 の点線を検出');

console.log('\n=== splitByQuestion ===');
{
  const noAnswer = `（答のない目次）問52 ${'目次にある質問文です。'.repeat(20)}`;
  assert(!splitKeigenWith(noAnswer).some(part => part.qNo === '問52'),
    '【答】を含まない塊を落とす');

  const dotLeader = `（点線のある目次）問52 質問です。【答】${'長さを満たす文字。'.repeat(20)} ${'·'.repeat(12)} 22`;
  assert(!splitKeigenWith(dotLeader).some(part => part.qNo === '問52'),
    '【答】と十分な長さがあっても点線を含む塊を落とす');

  const tooShort = '（短い本文）問52 質問です。【答】短い回答です。';
  assert(!splitKeigenWith(tooShort).some(part => part.qNo === '問52'),
    '150字未満の塊を落とす');

  const body = keigenBody(52, 'コンビニエンスストアのイートインスペースでの飲食');
  const found = splitKeigenWith(body).find(part => part.qNo === '問52');
  assert(found && found.body.includes('【答】'), '【答】を含む本文を拾う');

  const toc = `（コンビニエンスストアのイートインスペースでの飲食）問52 店内にイートインスペースを設置した場合ですか。`
    + `【令和５年 10 月改訂】 ${'·'.repeat(24)} 22`;
  const fillers = [keigenBody(901), keigenBody(902), keigenBody(903)];
  const tocFirst = splitByQuestion([toc, body, ...fillers].join(' '));
  const bodyFirst = splitByQuestion([body, toc, ...fillers].join(' '));
  const tocFirst52 = tocFirst.find(part => part.qNo === '問52');
  const bodyFirst52 = bodyFirst.find(part => part.qNo === '問52');
  assert(tocFirst52 && tocFirst52.body === body,
    '目次が先でも同じ問の本文を採る');
  assert(bodyFirst52 && bodyFirst52.body === body,
    '本文が先でも同じ問の本文を採る');
  assert(JSON.stringify(tocFirst) === JSON.stringify(bodyFirst),
    '目次と本文の出現順によらず分割結果が同じ');
}

console.log('\n=== 既存の分割関数 ===');
{
  const numbered = (no, leader = '') => `${no} 暗号資産を売却した場合 問 所得の計算方法を教えてください。`
    + `答 売却価額と取得価額を基に計算します。${'暗号資産の回答本文です。'.repeat(20)}${leader}`;
  const numberedText = [1, 2, 3, 4, 5].map(n => numbered(`1-${n}`)).join(' ');
  const numberedParts = splitByNumberedHeading(numberedText);
  assert(numberedParts.length === 5 && numberedParts.every(part => /問/.test(part.body) && /答/.test(part.body)),
    'splitByNumberedHeading は問・答・150字以上の本文を従来どおり拾う');
  const numberedWithLeader = [
    numbered('1-1', ` ${'．'.repeat(6)} 1`),
    ...[2, 3, 4, 5].map(n => numbered(`1-${n}`)),
  ].join(' ');
  assert(!splitByNumberedHeading(numberedWithLeader).some(part => part.qNo === '1-1'),
    'splitByNumberedHeading でも点線を含む塊を落とす');

  const paren = (no, leader = '') => `（問${no}）相続時精算課税を選択した場合の取扱い `
    + `【照会要旨】適用関係を確認します。【回答要旨】法令の要件に沿って判定します。`
    + `${'相続税の回答本文です。'.repeat(20)}${leader}`;
  const parenText = [1, 2, 3].map(n => paren(`1-${n}`)).join(' ');
  const parenParts = splitByParenQuestion(parenText);
  assert(parenParts.length === 3 && parenParts.every(part => /【回答要旨】/.test(part.body)),
    'splitByParenQuestion は回答要旨・150字以上の本文を従来どおり拾う');
  const parenWithLeader = [paren('1-1', ` ${'…'.repeat(6)} 1`), paren('1-2'), paren('1-3')].join(' ');
  assert(!splitByParenQuestion(parenWithLeader).some(part => part.qNo === '問1-1'),
    'splitByParenQuestion でも点線を含む塊を落とす');
}

console.log('\n=== 本文短縮の更新ガード ===');
const record = (length, prefix = '【答】') => ({
  body: prefix + 'あ'.repeat(Math.max(0, length - prefix.length)),
});
assert(shouldSkipBodyUpdate(record(707), record(222)), '707字 → 222字は見送る');
assert(shouldSkipBodyUpdate(record(4827), record(130)), '4,827字 → 130字は見送る');
assert(!shouldSkipBodyUpdate(record(707), record(700)), '707字 → 700字は書き込む');
assert(!shouldSkipBodyUpdate(record(707), record(360)), '707字 → 360字（50%超）は書き込む');
assert(!shouldSkipBodyUpdate(record(200), record(50)), '既存が300字未満なら書き込む');
assert(!shouldSkipBodyUpdate(null, record(130)), '新規レコードは書き込む');
assert(!shouldSkipBodyUpdate(record(700), record(350)), 'ちょうど50%なら書き込む');
assert(!shouldSkipBodyUpdate(record(707), record(707)), '本文が同じ長さなら fetched_at の更新を妨げない');

assert(!shouldSkipBodyUpdate(record(822, '目次 '), record(399)),
  '既存822字に【答】がなければ、新しい399字の本文で置き換える');
assert(!shouldSkipBodyUpdate(record(822, `【答】${'·'.repeat(6)}`), record(399)),
  '既存822字に点線があれば、新しい399字の本文で置き換える');
assert(shouldSkipBodyUpdate(record(731), record(195, '目次 ')),
  '既存731字が本文なら、【答】のない新しい195字から守る');
assert(shouldSkipBodyUpdate(record(2169), record(316, `${'…'.repeat(6)} `)),
  '既存2,169字が本文なら、点線のある新しい316字から守る');
assert(shouldSkipBodyUpdate(record(700, '答 '), record(200, '目次 ')),
  '独立した「答」を含む既存本文も守る');
assert(shouldSkipBodyUpdate(record(700, '（答）'), record(200, '目次 ')),
  '「（答）」を含む既存本文も守る');
assert(shouldSkipBodyUpdate(record(700, '【回答要旨】'), record(200, '目次 ')),
  '「【回答要旨】」を含む既存本文も守る');

console.log('\n=== 分割ファイルの孤児判定 ===');
{
  const written = new Set(['gaiyo-1.json', 'jirei-1.json']);
  const existing = new Set([
    'jirei-42.json',
    'gaiyo-15.json',
    'gaiyo-1.json',
    'notes.txt',
    'gaiyo-14.json',
    'jirei-1.json',
  ]);
  const expected = ['gaiyo-14.json', 'gaiyo-15.json', 'jirei-42.json'];
  assert(JSON.stringify(getStaleSplitFileNames({ split: true }, written, existing))
    === JSON.stringify(expected),
  '書き出した名前と既存名の集合差から孤児JSONを求める');
  assert(getStaleSplitFileNames({ split: true }, written, existing, { limitSpecified: true }).length === 0,
    '--limit 指定時は削除対象を返さない');
  assert(getStaleSplitFileNames({}, written, existing).length === 0,
    '分割しない資料では削除対象を返さない');
  assert(getStaleSplitFileNames({ splitBy: 'numbered' }, written, existing).length === 3,
    'splitBy を持つ資料も孤児判定の対象にする');
}

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
