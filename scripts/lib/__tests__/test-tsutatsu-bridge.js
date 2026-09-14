'use strict';

/**
 * 質疑応答事例の関係法令欄から通達原文を渡す橋渡しの回帰テスト。
 *   node scripts/lib/__tests__/test-tsutatsu-bridge.js
 *
 * 背景（2026-09-14）: 日次生成は関係法令欄に通達があっても原文を渡さず、モデルが
 *   記憶で取扱いを補っていた。連記の取りこぼしを防ぎ、「共」の範囲表記は未解決として警告しつつ、
 *   カタログにある通達だけを最大3件渡し、差し戻し再生成には二重添付しないことを固定する。
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const T = require(path.join(ROOT, 'scripts/lib/nta-tsutatsu'));
const source = require(path.join(ROOT, 'scripts/lib/nta-source-body'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  OK ${label}`); passed++; }
  else      { console.error(`  NG ${label}`); failed++; }
}

function ids(result) {
  return result.citations.map(c => `${c.circular}:${c.no}`);
}

console.log('=== 連記された通達番号を引き継ぐ ===');
const rei = T.checkCitations('所得税法施行令第14条、第15条、所得税基本通達2-1、3-3');
assert(JSON.stringify(ids(rei)) === JSON.stringify(['shotoku:2-1', 'shotoku:3-3'])
  && rei.unknown.length === 0,
  '法令の条を拾わず、所基通2-1と3-3の2件を照合する');

const articleFirst = T.checkCitations('所得税法第10条、所得税基本通達10-14、10-15');
assert(JSON.stringify(ids(articleFirst)) === JSON.stringify(['shotoku:10-14', 'shotoku:10-15'])
  && articleFirst.unknown.length === 0,
  '先行する所得税法第10条を通達番号にせず、10-14と10-15だけを照合する');

const changedName = T.checkCitations('所得税基本通達2-1、3-3、法人税基本通達9-2-9、9-2-10');
assert(JSON.stringify(changedName.citations.map(c => c.circular))
  === JSON.stringify(['shotoku', 'shotoku', 'hojin', 'hojin']),
  '別の通達名が来たら引継ぎ先を切り替える');
assert(T.checkCitations('所得税基本通達2-1、3-3、民法10-14、10-15').citations.length === 2,
  '別の法令名が来たら番号の引継ぎを終える');
assert(T.checkCitations('所得税基本通達2-1、3-3、第10条、10-15').citations.length === 2,
  '第○条が来たら番号の引継ぎを終える');
assert(T.checkCitations('所得税基本通達2-1、3-3。10-15\n2-2').citations.length === 2,
  '句点・改行を越えて番号を引き継がない');

console.log('');
console.log('=== 範囲表記は検出するが別の通達へ解決しない ===');
for (const wave of ['～', '〜', '~']) {
  const no = `181${wave}223共-6`;
  const range = T.checkCitations(`所得税基本通達${no}`);
  assert(range.citations.length === 1 && range.citations[0].no === no
    && range.citations[0].found === false && range.unknown.length === 1
    && range.unknown[0] === range.citations[0],
  `範囲記号「${wave}」を1件検出し、未解決としてunknownに入れる`);
  assert(T.findProvision(no, 'shotoku') === null,
    `範囲記号「${wave}」を181-6へすり替えずnullを返す`);
}
const otherCommonRange = T.findProvision('183～193共-1', 'shotoku');
assert(otherCommonRange === null,
  '別の共通範囲183～193共-1も183-1へすり替えずnullを返す');

const shotokuRangeStart = T.findProvision('36-40～43', 'shotoku');
assert(!!shotokuRangeStart && shotokuRangeStart.no === '36-40',
  '通常の条文範囲36-40～43は引用されている左端36-40へ解決する');
const sozokuRangeStart = T.findProvision('3-18～3-20', 'sozoku');
assert(!!sozokuRangeStart && sozokuRangeStart.no === '3-18',
  '通常の条文範囲3-18～3-20は引用されている左端3-18へ解決する');

const direct181_6 = T.findProvision('181-6', 'shotoku');
assert(!!direct181_6 && direct181_6.no === '181-6',
  '181-6を直接指定した場合は従来どおり完全一致で解決する');

console.log('');
console.log('=== 既存の引用検出を維持する ===');
for (const [text, circular, no] of [
  ['所基通36-10', 'shotoku', '36-10'],
  ['消基通5-9-10', 'shohi', '5-9-10'],
  ['法人税基本通達9-2-9', 'hojin', '9-2-9'],
  ['相続税法基本通達11の2-1', 'sozoku', '11の2-1'],
]) {
  const result = T.checkCitations(text);
  assert(result.citations.length === 1 && result.citations[0].found
    && result.citations[0].circular === circular && result.citations[0].no === no,
  `${text}を従来どおり検出・照合する`);
}

console.log('');
console.log('=== 関係法令欄から通達原文を橋渡しする ===');
const SHITSUGI_DIR = path.join(ROOT, 'data', 'nta-sources', 'shitsugi');
function firstResolvableTopic(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = firstResolvableTopic(file);
      if (found) return found;
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      const topic = { source_url: record.url || '' };
      if (source.findTsutatsuFromSourceKankei(topic).length > 0) return topic;
    } catch (_error) { /* 実データ中の破損1件で走査全体を止めない */ }
  }
  return null;
}

const realTopic = firstResolvableTopic(SHITSUGI_DIR);
const realRefs = realTopic ? source.findTsutatsuFromSourceKankei(realTopic) : [];
const realBlock = realTopic ? source.buildTsutatsuBlockFromSourceKankei(realTopic) : '';
assert(!!realTopic && realBlock.length > 0, '通達を解決できる最初の質疑応答事例では原文ブロックが空でない');
const firstProvision = realRefs[0] && T.findProvision(realRefs[0].no, realRefs[0].circular);
assert(!!firstProvision && realBlock.includes(firstProvision.no) && realBlock.includes(firstProvision.body),
  '橋渡ししたブロックに実在する通達の条番号と原文が含まれる');

const stableLawOnly = { source_url: 'https://www.nta.go.jp/law/shitsugi/shotoku/07/05.htm' };
assert(source.buildTsutatsuBlockFromSourceKankei(stableLawOnly) === '',
  '関係法令が法律だけの質疑応答事例では通達ブロックを付けない');
assert(source.buildTsutatsuBlockFromSourceKankei({}) === '', '出典が無いトピックでは空文字を返す');
assert(source.buildTsutatsuBlockFromSourceKankei({ source_url: 'https://example.com/x.htm' }) === '',
  'カタログ外のURLでは空文字を返す');

function withMockedRecord(topic, raw, fn) {
  const target = path.resolve(source.resolveSourceFile(topic.source_url));
  const original = fs.readFileSync;
  fs.readFileSync = (file, ...args) => path.resolve(String(file)) === target ? raw : original(file, ...args);
  try { return fn(); } finally { fs.readFileSync = original; }
}

const limited = withMockedRecord(stableLawOnly,
  JSON.stringify({ kankei_hourei: '所得税基本通達999-999、2-1、3-3、2-2、2-3' }),
  () => ({
    refs: source.findTsutatsuFromSourceKankei(stableLawOnly),
    block: source.buildTsutatsuBlockFromSourceKankei(stableLawOnly),
  }));
assert(JSON.stringify(limited.refs.map(c => c.no)) === JSON.stringify(['2-1', '3-3', '2-2']),
  'カタログにある順で先頭3条までに制限する');
assert(!limited.block.includes('999-999') && !limited.block.includes(' 2-3'),
  'カタログに無い番号と4条目は原文ブロックへ混ぜない');

const unresolvedRange = withMockedRecord(stableLawOnly,
  JSON.stringify({ kankei_hourei: '所得税基本通達181～223共-6' }),
  () => ({
    refs: source.findTsutatsuFromSourceKankei(stableLawOnly),
    block: source.buildTsutatsuBlockFromSourceKankei(stableLawOnly),
  }));
assert(unresolvedRange.refs.length === 0 && unresolvedRange.block === '',
  '未解決の範囲表記を181-6由来の通達として橋渡ししない');

const broken = withMockedRecord(stableLawOnly, '{',
  () => source.buildTsutatsuBlockFromSourceKankei(stableLawOnly));
assert(broken === '', '壊れた出典レコードでも例外を投げず空文字を返す');
const deleted = withMockedRecord(stableLawOnly, JSON.stringify({ deleted: true, kankei_hourei: '所得税基本通達2-1' }),
  () => source.buildTsutatsuBlockFromSourceKankei(stableLawOnly));
assert(deleted === '', '削除済みの出典レコードでは静かに空文字を返す');

console.log('');
console.log('=== 差し戻し再生成へ二重添付しない ===');
const generateSource = fs.readFileSync(path.join(ROOT, 'scripts', 'generate-draft.js'), 'utf8');
const regenSource = generateSource.slice(
  generateSource.indexOf('function buildRegenSourceBlocks'),
  generateSource.indexOf('// ── 差し戻し対応の再生成', generateSource.indexOf('function buildRegenSourceBlocks')),
);
assert(!regenSource.includes('buildTsutatsuBlockFromSourceKankei')
  && !regenSource.includes('findTsutatsuFromSourceKankei'),
  '差し戻し再生成は本文引用ベースのprovisionsだけを使い、関係法令由来を二重添付しない');
assert(/ntaRefsBlock\s*=.*lawBlock\s*\+\s*tsutatsuBlock/.test(generateSource),
  '日次生成では法令ブロックの隣に通達ブロックを連結する');

console.log(`\n結果: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
