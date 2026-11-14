'use strict';

/**
 * 国税庁 Q&A の分割・目次除外・本文短縮ガードのテスト。
 *   node scripts/lib/__tests__/test-nta-qa-split.js
 *
 * 分割関数だけを直接呼び、PDF の取得やネットワークアクセスは行わない。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'nta-qa-split');
const {
  looksLikeTableOfContents,
  splitByQuestion,
  findQuestionMarks,
  filterIndirectMarks,
  isAscendingQuestionOrder,
  isIgnoredHeading,
  questionNumberKey,
  compareQuestionNumbers,
  startsParagraph,
  splitByNumberedHeading,
  splitByParenQuestion,
  shouldSkipBodyUpdate,
  isReorderOnly,
  sameCharMultiset,
  titlesDiffer,
  saveEntry,
  crawlSource,
  buildReport,
  writeReport,
  preservedIndexEntries,
  mergeIndexEntries,
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

console.log('\n=== G2: 同じ札に見出しの候補が複数あるとき ===');
{
  for (const heading of ['参考', '注', '注釈', '参考１', '注２', '注 3', '参考１０', '注釈１']) {
    assert(isIgnoredHeading(heading), `「${heading}」は問の見出しかではない`);
  }
  assert(!isIgnoredHeading('新聞の譲渡'), '通常の見出しは除外しない');
  assert(titlesDiffer('問1 古い題名', '問1 新しい題名')
    && !titlesDiffer('問1 題名', '問1  題名'),
  '題名の違いは空白の位置だけなら変わったとみなさない');

  // 問99 の答の末尾の「（注１）」を問100 の題名にしない。
  const filler = (no) => `（確認用見出し${no}） 問${no} 本文です。 【答】 ${'回答本文です。'.repeat(30)}`;
  const text = [
    '（確認用見出し99） 本文です。問99 【答】 '
      + `${'回答本文です。'.repeat(20)}…となります。 （注１） 詳しくは通達をご覧ください（基通５－９－13）`,
    '（ホテルに対して販売する新聞） 当社は、新聞販売店を経営しています。問100 新聞は軽減税率の適用対象ですか。'
      + ` 【答】 ${'新聞の回答です。'.repeat(20)}`,
    filler(901), filler(902), filler(903), filler(904),
  ].join(' ');
  const parts = splitByQuestion(text);
  const q100 = parts.find(part => part.qNo === '問100');
  assert(q100 && q100.title === '問100 ホテルに対して販売する新聞',
    '「（注１）」ではなく本当の見出しを問100 の題名にする');
  const q99 = parts.find(part => part.qNo === '問99');
  assert(q99 && q99.body.includes('（注１） 詳しくは通達をご覧ください（基通５－９－13）'),
    '問99 の末尾が問99 に残る');
  assert(!parts.some(part => part.qNo === '問１' || part.qNo === '問1'),
    '「（注１）」を問番号にしない');

  // 見出しの前が文の途中でも、段落の先頭の見出しを題名にする。
  const nested = [
    '（確認用見出し51） 回答しますが、 （近い見出し） 詳しくは次のとおりです。問52 本文です。'
      + ` 【答】 ${'回答本文です。'.repeat(20)}`,
    filler(901), filler(902), filler(903), filler(904),
  ].join(' ');
  const nestedParts = splitByQuestion(nested);
  const q52 = nestedParts.find(part => part.qNo === '問52');
  assert(q52 && q52.title === '問52 確認用見出し51', '段落の先頭の見出しを題名にする');

  // ページ番号「-8-」（空白なし）の直後も段落の先頭とみなす。
  assert(startsParagraph('前の段落です。 -8- （見出し） 本文', '前の段落です。 -8- '.length),
    '「-8-」の直後を段落の先頭とみなす');
  assert(startsParagraph('前の段落です。 - 52 - （見出し） 本文', '前の段落です。 - 52 - '.length),
    '「- 52 -」の直後を段落の先頭とみなす');
  assert(!startsParagraph('文の途中です （見出し） 本文', '文の途中です '.length),
    '文の途中は段落の先頭とみなさない');
}

console.log('\n=== G4: 札が探す範囲の端にかかっても番号を切らない ===');
{
  const near = 'あ'.repeat(97);
  const filler = (no) => `（確認用見出し${no}） 問${no} 本文です。 【答】 ${'回答本文です。'.repeat(30)}`;
  const text = [
    `（確認用見出し99） ${near} 問100 本文です。 【答】 ${'回答本文です。'.repeat(30)}`,
    filler(901), filler(902), filler(903), filler(904),
  ].join(' ');
  const flat = text.replace(/\s+/g, ' ').trim();
  const mark = findQuestionMarks(flat).find(item => item.heading === '確認用見出し99');
  assert(mark && mark.card === '問100', '範囲の端でも札を「問10」に切らない');
  assert(splitByQuestion(flat).some(part => part.qNo === '問100'),
    '範囲の端の札でも問100 として区切る');
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

console.log('\n=== R1: poppler の並び（札が1行目の後ろに来る形）===');
{
  const text = fs.readFileSync(path.join(FIXTURES, 'keigen-poppler-excerpt.txt'), 'utf8');
  const parts = splitByQuestion(text);
  const byNo = new Map(parts.map(part => [part.qNo, part]));
  const wanted = ['問99', '問100', '問101', '問119', '問120', '問121'];
  assert(parts.length === wanted.length,
    `抜粋から ${wanted.length} 問に区切る（実際 ${parts.length} 問）`);
  for (const qNo of wanted) {
    const part = byNo.get(qNo);
    assert(!!part, `${qNo} を別の問として拾う`);
    if (!part) continue;
    const heading = part.title.slice(qNo.length + 1);
    assert(part.body.startsWith(`（${heading}） ${qNo} `),
      `${qNo} の本文が「（見出し） ${qNo} …」で始まる`);
  }

  const q99 = byNo.get('問99');
  const q100 = byNo.get('問100');
  assert(q99 && !q99.body.includes('問100'),
    '問99 の本文に問100 の札が入らない');
  assert(q99 && !q99.body.includes('ホテルが従業員の購読用'),
    '問99 の本文に問100 の本文が入らない');

  // 札を動かしても、札以外の文字は増減しない。
  const flat = text.replace(/\s+/g, ' ').trim();
  const marks = findQuestionMarks(flat).sort((a, b) => a.index - b.index);
  const mark100 = marks.find(mark => mark.card.replace(/\s/g, '') === '問100');
  const next = marks.find(mark => mark.index > mark100.index);
  const rawBody = flat.slice(mark100.index, next ? next.index : flat.length).trim();
  assert(q100.body !== rawBody, '問100 は札の位置を直している');
  assert(sameCharMultiset(
    rawBody.replace(mark100.card, ''),
    q100.body.replace(mark100.card, ''),
  ), '札を動かしても札以外の文字の多重集合は同じ');
}

console.log('\n=== G1: 答の中の参照を問の始まりと取り違えない ===');
{
  const cases = [
    { file: 'keigen-poppler-excerpt.txt', targets: ['問99'] },
    { file: 'keigen-gaiyo-poppler-excerpt.txt', targets: ['問５', '問６'] },
  ];
  const replacements = [['（参考）', '（参考１）'], ['（注）', '（注１）']];
  for (const entry of cases) {
    const text = fs.readFileSync(path.join(FIXTURES, entry.file), 'utf8');
    const baseParts = splitByQuestion(text);
    const baseByNo = new Map(baseParts.map(part => [part.qNo, part]));
    for (const [from, to] of replacements) {
      const replaced = splitByQuestion(text.split(from).join(to));
      const byNo = new Map(replaced.map(part => [part.qNo, part]));
      assert(replaced.length === baseParts.length,
        `${entry.file}: 「${from}」→「${to}」で問の数が変わらない`);
      for (const qNo of entry.targets) {
        const before = baseByNo.get(qNo);
        const after = byNo.get(qNo);
        assert(before && after && after.body === before.body.split(from).join(to),
          `${entry.file}: ${qNo} の本文が置き換えた所だけ違って残る`);
      }
    }
  }

  // 問99 の答に「（定期購読契約がない場合） 問 98 の場合と同様に…」を足す。
  const text = fs.readFileSync(path.join(FIXTURES, 'keigen-poppler-excerpt.txt'), 'utf8');
  const baseParts = splitByQuestion(text);
  const baseQ99 = baseParts.find(part => part.qNo === '問99');
  const marker = 'したがって、ご質問の新聞が、定期購読契約に基づくものであれば';
  const addition = '（定期購読契約がない場合） 問 98 の場合と同様に、軽減税率の適用対象となりません。 ';
  const parts = splitByQuestion(text.replace(marker, addition + marker));
  const q99 = parts.find(part => part.qNo === '問99');
  assert(parts.length === baseParts.length, '問99 に参照を足しても問の数が変わらない');
  assert(q99 && baseQ99 && q99.body === baseQ99.body.replace(marker, addition + marker),
    '問99 の本文が足した参照だけ違って残る');
  assert(!parts.some(part => part.qNo === '問98'), '足した参照の「問 98」を問の始まりにしない');

  // 問番号は全角・空白を吸収し、「問N-M」は N の次に M で比べる。
  assert(JSON.stringify(questionNumberKey('問 １００')) === JSON.stringify([100, 0]),
    '全角・空白つきの問番号を数として読む');
  assert(compareQuestionNumbers('問9', '問10') === -1
    && compareQuestionNumbers('問1-2', '問1-10') === -1
    && compareQuestionNumbers('問3', '問3') === 0,
  '問番号の大小を N、M の順で比べる');

  // (b) の歯止め: 前後の区切りの問番号の間にある後ろ向きの区切りだけ採る。
  const gated = [
    { index: 0, card: '問99', indirect: false },
    { index: 10, card: '問98', indirect: true },
    { index: 20, card: '問100', indirect: true },
    { index: 30, card: '問101', indirect: false },
  ];
  assert(JSON.stringify(filterIndirectMarks(gated).map(mark => mark.card))
    === JSON.stringify(['問99', '問100', '問101']),
  '前の区切り以下の問番号の区切りを外す（問98）');
  assert(isAscendingQuestionOrder([
    { card: '問99' }, { card: '問100' }, { card: '問101' },
  ]), '問番号の順の区切りは昇順とみなす');
  assert(!isAscendingQuestionOrder([
    { card: '問10' }, { card: '問101' }, { card: '問11' },
  ]), 'id 順につないだ並びは昇順とみなさない');
}

console.log('\n=== G1: 区切った前後で文字が消えない（多重集合） ===');
{
  const excerptFiles = ['keigen-poppler-excerpt.txt', 'keigen-gaiyo-poppler-excerpt.txt'];
  for (const file of excerptFiles) {
    const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    const flat = text.replace(/\s+/g, ' ').trim();
    const parts = splitByQuestion(flat);
    const marks = findQuestionMarks(flat);
    const start = Math.min(...marks.map(mark => mark.index));
    assert(parts.length > 0 && sameCharMultiset(
      parts.map(part => part.body).join(''),
      flat.slice(start),
    ), `${file}: 全部の問の本文をつないだ文字が入力（区切りの始まり以降）と同じ`);
  }

  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'keigen-xpdf-excerpt.json'), 'utf8'));
  const text = expected.map(entry => entry.body).join(' ');
  const flat = text.replace(/\s+/g, ' ').trim();
  const parts = splitByQuestion(flat);
  const marks = findQuestionMarks(flat);
  const start = Math.min(...marks.map(mark => mark.index));
  assert(parts.length === expected.length && sameCharMultiset(
    parts.map(part => part.body).join(''),
    flat.slice(start),
  ), 'xpdf の並びでも文字が消えない');
}

console.log('\n=== R1: 答の中の参照では区切らない ===');
{
  const references = fs.readFileSync(path.join(FIXTURES, 'references.txt'), 'utf8');
  const filler = (no, extra = '') => `（確認用見出し${no}） 問${no} 本文です。`
    + `【答】 ${'回答本文です。'.repeat(30)}${extra}`;
  const text = [
    filler(901, ` ${references}`),
    filler(902), filler(903), filler(904), filler(905),
  ].join(' ');
  const parts = splitByQuestion(text);
  assert(parts.length === 5, '参照の「問115」「問 80」を問の始まりにしない');
  assert(!parts.some(part => part.qNo === '問115' || part.qNo === '問80'),
    '参照の問番号が分割結果に現れない');
  assert(!parts.some(part => ['問25', '問85', '問98'].includes(part.qNo)),
    '「【個別事例編】 問 25」「問 98 の場合」も問の始まりにしない');

  // G3: 問の数だけでなく、参照の文章が本文に全部残っていること。
  const referenceLines = references.split('\n').map(line => line.trim()).filter(Boolean);
  assert(referenceLines.length >= 5, '参照の試験データに今の除外に当たらない形を入れてある');
  const body901 = (parts.find(part => part.qNo === '問901') || {}).body || '';
  for (const line of referenceLines) {
    assert(body901.replace(/\s+/g, '').includes(line.replace(/\s+/g, '')),
      `参照「${line.slice(0, 16)}…」が問901 の本文に残る`);
  }
}

console.log('\n=== R1: 今の形（xpdf の並び）の結果は変えない ===');
{
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'keigen-xpdf-excerpt.json'), 'utf8'));
  const parts = splitByQuestion(expected.map(entry => entry.body).join(' '));
  assert(parts.length === expected.length, 'xpdf の抜粋を同じ数に区切る');
  const byNo = new Map(parts.map(part => [part.qNo, part]));
  for (const entry of expected) {
    const part = byNo.get(entry.q_no);
    assert(!!part, `${entry.q_no} を拾う`);
    if (!part) continue;
    assert(part.title === entry.title, `${entry.q_no} の題名が直す前と同じ`);
    assert(part.body === entry.body, `${entry.q_no} の本文が直す前と同じ`);
  }
}

console.log('\n=== R2: 並び替えだけの変化は今の本文を残す ===');
{
  const pairs = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'reorder-pairs.json'), 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-qa-r2-'));
  try {
    const source = {
      label: '確認用', tax_category: '消費税', tax_category_code: 'shohi', tax_domain: 'consumption_tax',
    };
    for (const pair of pairs) {
      const [sourceKey, file] = pair.name.split('/');
      const docId = file.replace(/\.json$/, '');
      const dir = path.join(temp, sourceKey);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), JSON.stringify({
        id: docId, title: pair.title, body: pair.existing, char_count_body: pair.existing.length,
      }, null, 2) + '\n', 'utf8');

      const result = saveEntry(sourceKey, source, { id: docId }, {
        qNo: pair.name.includes('113') ? '問113' : '問1',
        title: pair.title,
        body: pair.incoming,
      }, 'https://example.test/', { outDir: temp, root: temp, warn() {} });
      const written = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const stillReorderOnly = isReorderOnly(
        { body: pair.existing, title: pair.title },
        { body: pair.incoming, title: pair.title },
      );
      if (pair.reorderOnly) {
        assert(stillReorderOnly === true, `${pair.name} は並び替えだけと判定する`);
        assert(result.reordered === true, `${pair.name} は本文を残したと返す`);
        assert(written.body === pair.existing, `${pair.name} は今の本文を残す`);
        assert(written.title === pair.title, `${pair.name} は題名を残す`);
        assert(written.char_count_body === pair.existing.length,
          `${pair.name} は char_count_body を残す`);
      } else {
        assert(stillReorderOnly === false, `${pair.name} は本物の違いと判定する`);
        assert(!result.reordered, `${pair.name} は本文を残さない`);
        assert(written.body === pair.incoming, `${pair.name} は新しい本文を保存する`);
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log('\n=== F1: 空白の位置だけの違いも今の本文を残す ===');
{
  const existingBody = '（確認用見出し1） 問1 この取引には軽減税率が適用されますか。'
    + '【答】具体的な事実関係を確認した上で税率を判定します。'
    + `${'回答本文です。'.repeat(20)}`;
  const spacedBody = existingBody
    .replace('この取引には', 'この取引には ')
    .replace('【答】具体', '【答】 具体')
    .replace('税率を判定します。', '税率を判定します 。');
  assert(spacedBody !== existingBody && spacedBody.replace(/\s+/g, '') === existingBody.replace(/\s+/g, ''),
    '試験データは空白の位置だけが違う');
  assert(isReorderOnly(
    { body: existingBody, title: '問1 確認用見出し1' },
    { body: spacedBody, title: '問1 確認用見出し1' },
  ) === true, '空白の位置だけの違いを並び替えと同じ扱いにする');
  assert(isReorderOnly(
    { body: existingBody, title: '問1 確認用見出し1' },
    { body: existingBody, title: '問1 確認用見出し1' },
  ) === false, '空白まで含めて全く同じ本文は違いと数えない');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-qa-f1-'));
  try {
    const sourceKey = 'keigen';
    const source = {
      label: '確認用', tax_category: '消費税', tax_category_code: 'shohi', tax_domain: 'consumption_tax',
    };
    const dir = path.join(temp, sourceKey);
    fs.mkdirSync(dir, { recursive: true });
    const write = (body) => fs.writeFileSync(path.join(dir, 'jirei-1.json'), JSON.stringify({
      id: 'jirei-1', title: '問1 確認用見出し1', body, char_count_body: body.length,
    }, null, 2) + '\n', 'utf8');

    write(existingBody);
    const spacedResult = saveEntry(sourceKey, source, { id: 'jirei-1' }, {
      qNo: '問1', title: '問1 確認用見出し1', body: spacedBody,
    }, 'https://example.test/', { outDir: temp, root: temp, warn() {} });
    const spacedWritten = JSON.parse(fs.readFileSync(path.join(dir, 'jirei-1.json'), 'utf8'));
    assert(spacedResult.reordered === true, '空白の位置だけの違いは本文を残したと返す');
    assert(spacedWritten.body === existingBody, '空白の位置だけの違いは今の本文を残す');
    assert(spacedWritten.char_count_body === existingBody.length,
      '空白の位置だけの違いは char_count_body を残す');

    write(existingBody);
    const sameResult = saveEntry(sourceKey, source, { id: 'jirei-1' }, {
      qNo: '問1', title: '問1 確認用見出し1', body: existingBody,
    }, 'https://example.test/', { outDir: temp, root: temp, warn() {} });
    const sameWritten = JSON.parse(fs.readFileSync(path.join(dir, 'jirei-1.json'), 'utf8'));
    assert(!sameResult.reordered, '全く同じ本文は本文を残した件数に入れない');
    assert(sameWritten.body === existingBody, '全く同じ本文はそのまま保存する');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log('\n=== R4: 報告 ===');
{
  assert(typeof buildReport === 'function', '報告を作る関数がある');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-qa-report-'));
  try {
    const reportPath = path.join(temp, 'report.md');
    const summary = {
      reorderedCount: 120,
      skippedDocs: [{ sourceKey: 'keigen', docId: 'jirei', missing: ['問100', '問104'] }],
      skippedUpdates: 3,
    };
    assert(writeReport(reportPath, summary) === true, '報告ファイルを書く');
    const report = fs.readFileSync(reportPath, 'utf8');
    assert(report.includes('並び替え・空白の違いだけのため本文を残した 120 件'),
      'R2 の件数を報告に出す');
    assert(report.includes('keigen/jirei は更新していません') && report.includes('問100')
      && report.includes('問104'), 'R3 の資料 id と問番号を報告に出す');
    assert(report.includes('本文が大幅に短くなるため更新を見送った 3 件'),
      '本文短縮の見送りを報告に出す');

    assert(writeReport('', summary) === false, 'NTA_QA_REPORT が無ければ書かない');
    assert(writeReport(undefined, summary) === false, 'NTA_QA_REPORT が undefined でも書かない');
    assert(fs.readdirSync(temp).length === 1, '報告先が無ければ余計なファイルを作らない');

    // G5: 本文を残したファイルの一覧を折りたたんで出す。
    const reorderedReport = buildReport({
      reorderedCount: 2,
      reorderedFiles: ['keigen/jirei-1.json', 'keigen/jirei-2.json'],
    });
    assert(reorderedReport.includes('<details><summary>本文を残したファイル（2 件）</summary>'),
      '本文を残したファイルの件数を summary に出す');
    assert(reorderedReport.includes('\nkeigen/jirei-1.json\n')
      && reorderedReport.includes('\nkeigen/jirei-2.json\n'),
    '本文を残したファイルを1行ずつ出す');

    // G2: 題名が変わった問を前後の題名つきで出す。
    const titleReport = buildReport({
      titleChanges: [
        { file: 'keigen/jirei-100.json', before: '問100 古い題名', after: '問100 新しい題名' },
      ],
    });
    assert(titleReport.includes('- keigen/jirei-100.json: 問100 古い題名 → 問100 新しい題名'),
      '題名が変わった問を「前 → 新」で出す');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log('\n=== G7: 索引のつなぎ（同じ種類を消す→保存した行→残す行→重複を除く→並べる） ===');
{
  const previous = [
    { source_key: 'keigen', id: 'jirei-99', file_path: 'keigen/jirei-99.json', title: '前の題名99' },
    { source_key: 'keigen', id: 'jirei-100', file_path: 'keigen/jirei-100.json', title: '前の題名100' },
    { source_key: 'keigen', id: 'gaiyo-1', file_path: 'keigen/gaiyo-1.json', title: '古い題名' },
    { source_key: 'invoice', id: 'faq', file_path: 'invoice/faq.json', title: '変えない' },
  ];
  const installed = [{
    relative: 'keigen/gaiyo-1.json',
    record: {
      id: 'gaiyo-1', type: 'qa', source_key: 'keigen', source_label: '確認用',
      tax_category: '消費税', tax_category_code: 'shohi', tax_domain: 'consumption_tax',
      q_no: '問1', digest: false, title: '新しい題名', url: 'https://example.test/',
      char_count_body: 10, fetched_at: '2026-11-14T00:00:00.000Z',
    },
  }];
  const merged = mergeIndexEntries(previous, [{
    sourceKey: 'keigen',
    installed,
    preservedFilePaths: ['keigen/jirei-99.json', 'keigen/jirei-100.json'],
  }], silentWarnings);
  const byPath = new Map(merged.map(entry => [entry.file_path, entry]));
  assert(merged.length === 4, '残す行と保存した行を合わせて重複を除く');
  assert(byPath.get('keigen/gaiyo-1.json').title === '新しい題名',
    '取り込んだ資料の行は新しいものにする');
  assert(byPath.get('keigen/jirei-99.json') === previous[0]
    && byPath.get('keigen/jirei-100.json') === previous[1],
  'R3・F2 で見送った資料の行は前のまま残す');
  assert(byPath.get('invoice/faq.json') === previous[3], '他の資料の行は消さない');
  assert(JSON.stringify(merged.map(entry => entry.file_path)) === JSON.stringify([
    'invoice/faq.json', 'keigen/gaiyo-1.json', 'keigen/jirei-100.json', 'keigen/jirei-99.json',
  ]), '索引の行は資料と id で並べる');
  assert(merged.filter(entry => entry.file_path === 'keigen/gaiyo-1.json').length === 1,
    '同じ file_path の行は1件だけ残す');
}

(async () => {
  console.log('\n=== R3: 問が見つからない資料は更新しない ===');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-qa-r3-'));
  try {
    const sourceKey = 'keigen';
    const source = {
      label: '確認用軽減税率', tax_category: '消費税', tax_category_code: 'shohi',
      tax_domain: 'consumption_tax', split: true,
      docs: [{ id: 'jirei', url: 'https://example.test/jirei.pdf' }],
    };
    const makeText = (qNos) => qNos.map(qNo => `（確認用見出し${qNo}） 問${qNo} 本文です。`
      + ` 【答】 ${'回答本文です。'.repeat(30)}`).join(' ');
    const dir = path.join(temp, sourceKey);
    fs.mkdirSync(dir, { recursive: true });
    const existing = (qNo) => ({
      id: `jirei-${qNo}`,
      type: 'qa', source_key: sourceKey, source_label: source.label,
      tax_category: source.tax_category, tax_category_code: source.tax_category_code,
      tax_domain: source.tax_domain, q_no: `問${qNo}`, digest: false,
      title: `問${qNo} 既存の題名`, url: source.docs[0].url,
      body: `既存の本文${qNo}`, char_count_body: `既存の本文${qNo}`.length,
      fetched_at: '2026-09-01T00:00:00.000Z',
    });
    const writeExisting = (qNo) => fs.writeFileSync(
      path.join(dir, `jirei-${qNo}.json`), JSON.stringify(existing(qNo), null, 2) + '\n', 'utf8');
    writeExisting(99);
    writeExisting(100);
    const before = {
      99: fs.readFileSync(path.join(dir, 'jirei-99.json'), 'utf8'),
      100: fs.readFileSync(path.join(dir, 'jirei-100.json'), 'utf8'),
    };

    const run = (text) => crawlSource(sourceKey, source, {
      outDir: temp, root: temp, delayMs: 0,
      fetchBuffer: async () => Buffer.from('dummy'),
      extractText: () => text,
    });

    // 問100 が新しい区切りに無い → その資料は書かない・消さない。
    const missingResult = await run(makeText([99, 101, 901, 902, 903]));
    assert(missingResult.skippedDocs.length === 1
      && missingResult.skippedDocs[0].docId === 'jirei',
      '区切りを見失った資料を記録する');
    assert(JSON.stringify(missingResult.skippedDocs[0].missing) === JSON.stringify(['問100']),
      '見つからない問番号を記録する');
    assert(fs.existsSync(path.join(dir, 'jirei-99.json'))
      && fs.existsSync(path.join(dir, 'jirei-100.json')), 'その資料のファイルを消さない');
    assert(fs.readFileSync(path.join(dir, 'jirei-99.json'), 'utf8') === before[99]
      && fs.readFileSync(path.join(dir, 'jirei-100.json'), 'utf8') === before[100],
    'その資料のファイルを書き換えない');
    assert(!fs.existsSync(path.join(dir, 'jirei-101.json')), 'その資料の新しい問も書かない');
    assert(missingResult.preservedFilePaths.includes('keigen/jirei-99.json')
      && missingResult.preservedFilePaths.includes('keigen/jirei-100.json'),
    '索引に残すファイルを返す');
    const keptIndex = preservedIndexEntries([
      { source_key: 'keigen', file_path: 'keigen/jirei-99.json', id: 'jirei-99' },
      { source_key: 'keigen', file_path: 'keigen/jirei-100.json', id: 'jirei-100' },
      { source_key: 'keigen', file_path: 'keigen/jirei-88.json', id: 'jirei-88' },
      { source_key: 'gaiyo', file_path: 'keigen/gaiyo-1.json', id: 'gaiyo-1' },
    ], 'keigen', missingResult.preservedFilePaths);
    assert(keptIndex.length === 2
      && keptIndex.every(entry => entry.file_path.startsWith('keigen/jirei-')),
    'R3 の資料の索引の行だけを前のまま残す');

    // 問が増えるだけなら取り込む。
    const addedResult = await run(makeText([99, 100, 101, 901, 902, 903]));
    assert(addedResult.skippedDocs.length === 0, '問が増えるだけなら見送らない');
    assert(fs.existsSync(path.join(dir, 'jirei-101.json')), '増えた問を書き出す');
    const updated100 = JSON.parse(fs.readFileSync(path.join(dir, 'jirei-100.json'), 'utf8'));
    assert(updated100.body.includes('確認用見出し100'), '既存の問を新しい本文で更新する');

    // 報告に R3 の見送りを出す。
    const report = buildReport({
      reorderedCount: 0, skippedDocs: missingResult.skippedDocs, skippedUpdates: 0,
    });
    assert(report.includes('区切りを見失った問があるため keigen/jirei は更新していません: 問100'),
      '報告に R3 の資料 id（資料の種類つき）と問番号を出す');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  console.log('\n=== G2/G5: 題名の変更と、本文を残したファイルを報告する ===');
  {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-qa-g2-'));
    try {
      const sourceKey = 'keigen';
      const source = {
        label: '確認用軽減税率', tax_category: '消費税', tax_category_code: 'shohi',
        tax_domain: 'consumption_tax', split: true,
        docs: [{ id: 'jirei', url: 'https://example.test/jirei.pdf' }],
      };
      const text = [
        `（新しい題名） 問1 本文です。 【答】 ${'回答本文です。'.repeat(30)}`,
        `（並び替えの問） 問2 本文です。 【答】 ${'回答本文です。'.repeat(30)}`,
        ...[3, 4, 5].map(no => `（確認用見出し${no}） 問${no} 本文です。 【答】 ${'回答本文です。'.repeat(30)}`),
      ].join(' ');
      const parts = splitByQuestion(text);
      const body2 = parts.find(part => part.qNo === '問2').body;
      const dir = path.join(temp, sourceKey);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'jirei-1.json'), JSON.stringify({
        id: 'jirei-1', title: '問1 古い題名', body: '前の本文', char_count_body: 4,
      }, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'jirei-2.json'), JSON.stringify({
        id: 'jirei-2', title: '問2 並び替えの問', body: body2.replace('本文です。', '本文です。 '),
        char_count_body: body2.length,
      }, null, 2) + '\n', 'utf8');

      const result = await crawlSource(sourceKey, source, {
        outDir: temp, root: temp, delayMs: 0,
        fetchBuffer: async () => Buffer.from('dummy'),
        extractText: () => text,
      });
      assert(result.titleChanges.length === 1
        && result.titleChanges[0].file === 'keigen/jirei-1.json'
        && result.titleChanges[0].before === '問1 古い題名'
        && result.titleChanges[0].after === '問1 新しい題名',
      '題名が変わった問を前後の題名つきで返す');
      assert(result.reorderedFiles.length === 1
        && result.reorderedFiles[0] === 'keigen/jirei-2.json',
      '本文を残したファイルを返す');
      const report = buildReport({
        reorderedCount: result.reorderedCount,
        reorderedFiles: result.reorderedFiles,
        titleChanges: result.titleChanges,
      });
      assert(report.includes('<details><summary>本文を残したファイル（1 件）</summary>')
        && report.includes('\nkeigen/jirei-2.json\n'),
      '報告に本文を残したファイルを出す');
      assert(report.includes('- keigen/jirei-1.json: 問1 古い題名 → 問1 新しい題名'),
        '報告に題名の変更を出す');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  console.log('\n=== F2: 取得に失敗した資料はファイルも索引の行も残す ===');
  {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nta-qa-f2-'));
    try {
      const sourceKey = 'keigen';
      const source = {
        label: '確認用軽減税率', tax_category: '消費税', tax_category_code: 'shohi',
        tax_domain: 'consumption_tax', split: true,
        docs: [
          { id: 'jirei', url: 'https://example.test/jirei.pdf' },
          { id: 'gaiyo', url: 'https://example.test/gaiyo.pdf' },
        ],
      };
      const makeText = (qNos) => qNos.map(qNo => `（確認用見出し${qNo}） 問${qNo} 本文です。`
        + ` 【答】 ${'回答本文です。'.repeat(30)}`).join(' ');
      const dir = path.join(temp, sourceKey);
      fs.mkdirSync(dir, { recursive: true });
      const writeExisting = (file, body) => fs.writeFileSync(path.join(dir, file),
        JSON.stringify({ id: file.replace(/\.json$/, ''), body, char_count_body: body.length },
          null, 2) + '\n', 'utf8');
      writeExisting('jirei-1.json', '既存の本文1');
      writeExisting('jirei-2.json', '既存の本文2');
      writeExisting('gaiyo-1.json', '既存の本文1');
      const jireiBefore = {
        1: fs.readFileSync(path.join(dir, 'jirei-1.json'), 'utf8'),
        2: fs.readFileSync(path.join(dir, 'jirei-2.json'), 'utf8'),
      };

      const result = await crawlSource(sourceKey, source, {
        outDir: temp, root: temp, delayMs: 0,
        fetchBuffer: async (url) => {
          if (url.includes('jirei')) throw new Error('HTTP 503: 一時的な障害\n詳細は応答本文を参照');
          return Buffer.from('dummy');
        },
        extractText: () => makeText([1, 2, 3, 4, 5]),
      });

      assert(result.failed === 1, '取得に失敗した資料を数える');
      assert(result.failedDocs.length === 1
        && result.failedDocs[0].sourceKey === 'keigen'
        && result.failedDocs[0].docId === 'jirei', '失敗した資料を記録する');
      assert(result.failedDocs[0].reason === 'HTTP 503: 一時的な障害',
        '理由は例外メッセージの1行目だけ');
      assert(fs.readFileSync(path.join(dir, 'jirei-1.json'), 'utf8') === jireiBefore[1]
        && fs.readFileSync(path.join(dir, 'jirei-2.json'), 'utf8') === jireiBefore[2],
      '失敗した資料のファイルを消さない・書き換えない');
      assert(result.preservedFilePaths.includes('keigen/jirei-1.json')
        && result.preservedFilePaths.includes('keigen/jirei-2.json'),
      '失敗した資料の索引に残すファイルを返す');
      assert(fs.existsSync(path.join(dir, 'gaiyo-5.json')),
        '他の資料は今までどおり更新する');

      const keptIndex = preservedIndexEntries([
        { source_key: 'keigen', file_path: 'keigen/jirei-1.json', id: 'jirei-1' },
        { source_key: 'keigen', file_path: 'keigen/jirei-2.json', id: 'jirei-2' },
        { source_key: 'keigen', file_path: 'keigen/gaiyo-1.json', id: 'gaiyo-1' },
      ], 'keigen', result.preservedFilePaths);
      assert(keptIndex.length === 2
        && keptIndex.every(entry => entry.file_path.startsWith('keigen/jirei-')),
      '失敗した資料の索引の行だけを前のまま残す');

      const report = buildReport({
        reorderedCount: 0, skippedDocs: [], skippedUpdates: 0, failedDocs: result.failedDocs,
      });
      assert(report.includes('- 取得できなかったため keigen/jirei は更新していません'
        + '（HTTP 503: 一時的な障害）'), '報告に取得できなかった資料と理由を出す');

      // 取り出し（pdftotext など）の失敗も同じ扱いにする。
      const extractResult = await crawlSource(sourceKey, source, {
        outDir: temp, root: temp, delayMs: 0,
        fetchBuffer: async () => Buffer.from('dummy'),
        extractText: () => { throw new Error('pdftotext が失敗しました'); },
      });
      assert(extractResult.failedDocs.length === 2
        && extractResult.failedDocs.every(doc => doc.reason === 'pdftotext が失敗しました'),
      '取り出しの失敗も資料ごとに記録する');
      assert(fs.existsSync(path.join(dir, 'jirei-1.json'))
        && fs.existsSync(path.join(dir, 'gaiyo-5.json')),
      '取り出しに失敗してもファイルを消さない');

      // 区切らない資料も、取得に失敗したら索引の行を前のまま残す。
      const plainKey = 'denshi_torihiki';
      const plainSource = {
        label: '確認用HTML', tax_category: '帳簿・経費', tax_category_code: 'chobo',
        tax_domain: 'bookkeeping_expenses', format: 'html',
        docs: [{ id: '07_1', url: 'https://example.test/07_1.htm' }],
      };
      fs.mkdirSync(path.join(temp, plainKey), { recursive: true });
      fs.writeFileSync(path.join(temp, plainKey, '07_1.json'),
        JSON.stringify({ id: '07_1', body: '既存の本文' }, null, 2) + '\n', 'utf8');
      const plainBefore = fs.readFileSync(path.join(temp, plainKey, '07_1.json'), 'utf8');
      const plainResult = await crawlSource(plainKey, plainSource, {
        outDir: temp, root: temp, delayMs: 0,
        fetchBuffer: async () => { throw new Error('x'.repeat(300)); },
        extractText: () => '',
      });
      assert(plainResult.failedDocs.length === 1
        && plainResult.failedDocs[0].reason.length === 200,
      '長い理由は200字までにする');
      assert(plainResult.preservedFilePaths.includes('denshi_torihiki/07_1.json'),
        '区切らない資料も索引の行を前のまま残す');
      assert(fs.readFileSync(path.join(temp, plainKey, '07_1.json'), 'utf8') === plainBefore,
        '区切らない資料のファイルを書き換えない');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  console.log(`\n結果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
