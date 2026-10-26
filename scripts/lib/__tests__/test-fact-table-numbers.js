'use strict';

// 表の数字・行・列の回帰試験。LLM は偽物にし、通信や記録の書き込みは行わない。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const U = require('../fact-units');
// 非公開関数も実装そのものを確かめる。試験のために本番の公開 API は増やさない。
const filename = require.resolve('../fact-check');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.tableTests = { normalizedNumberText, quoteExists, numberCheckText, numberCheckClaim, quoteSupportsNumbers, supportedNumberForms, partialQuoteNumbers, numbersInSentence, expandYearDates };', filename);
const F = loaded.exports, T = F.tableTests;
const tests = [];
const test = (group, name, run) => tests.push({ group, name, run });
const options = { now: new Date('2026-10-26T00:00:00Z'), provider: 'anthropic', batch: false, loadEvidenceText: e => e.text };
const previousWriterMode = process.env.FACT_CHECK_WRITER_MATERIALS;
process.env.FACT_CHECK_WRITER_MATERIALS = 'true';
const ref = text => ({ id: 'e1', kind: 'taxanswer', no: '9999', title: '試験資料', url: 'https://example.jp/table', text });
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, claim: sentence, type: '割合', subject: '試験制度', heading: '', ...extra });
const quote = '特定事業用宅地等に該当する宅地等 400 80％';
const source = `${quote}\n貸付事業用宅地等に該当する宅地等 200　50％\n特定居住用宅地等に該当する宅地等 330 80％`;
const enhanced = { writer_materials: ['ta:9999'], resolvedWriterMaterials: [ref(source)] };
const supports = (c, text = source, q = quote, status = '裏付けあり', correct = '') => F.sufficientQuote(c, { quote: q, correct }, ref(text), status);

for (const [text, expected] of [
  [quote, ['400', '割合:4/5']],
  ['200　50％', ['200', '割合:1/2']],
  ['2 1以外の者', ['2', '1']],
  ['一 二千五百万円', ['25000000']],
  ['0.5 1 100', ['0.5', '1', '100']],
  ['1,000 万円', ['10000000']],
  ['令和8年 4月1日', ['日付:令和8-4-1']],
  ['2・3割', ['割合:1/5', '割合:3/10']],
  ['2、3割', ['2', '割合:3/10']],
  ['1/2', ['1', '2']], // スラッシュは従来どおり。日本語の分数とは別の扱い。
  ['二分の一', ['割合:1/2']],
  ['1.5', ['1.5']],
  ['40080%', ['割合:2004/5']],
  ['百分の十二百万円', ['割合:21000/1']],
  ['80％ 50％', ['割合:4/5', '割合:1/2']],
  ['億 2', ['2']],
  ['1 億円', ['100000000']],
]) test('1', `数字の読み方: ${text}`, () => assert.deepEqual(F.normalizedNumbers(text), expected));

for (const gap of [' ', '　', '\n', '\t', ' \t\r\n　']) {
  test('1', `空白の連なり ${JSON.stringify(gap)} と全角数字`, () => {
    assert.deepEqual(F.normalizedNumbers(`４００${gap}８０％`), ['400', '割合:4/5']);
    assert.deepEqual(F.normalizedNumbers(`一${gap}二千五百万円`), ['25000000']);
    assert.deepEqual(F.normalizedNumbers(`0.5${gap}1${gap}100`), ['0.5', '1', '100']);
  });
}
test('1', 'NUL の区切りは日付・分数・小数・割の共有を作らない', () => {
  assert.equal(T.normalizedNumberText('2 3割'), '2\u00003割');
  assert.deepEqual(F.normalizedNumbers('2\u00003割'), ['2', '割合:3/10']);
  assert.deepEqual(F.normalizedNumbers('1\u00002'), ['1', '2']);
  assert.deepEqual(F.normalizedNumbers('8\u00004月1日'), ['8', '日付:-4-1']);
  assert.deepEqual(F.normalizedNumbers('0.5\u00001'), ['0.5', '1']);
  assert.deepEqual(F.normalizedNumbers('2・3割、1/2、1.5'), ['割合:1/5', '割合:3/10', '1', '2', '1.5']);
});
test('1', '位置あり・なしの正規化は同じで、原文の表記へ戻せる', () => {
  const text = 'ﾊﾟ ４００ \n\t８０％ 1,000 万円';
  const positions = [];
  const normalized = T.normalizedNumberText(text, positions);
  assert.equal(normalized, T.normalizedNumberText(text));
  assert.equal(positions.length, normalized.length);
  const forms = [];
  F.normalizedNumbers(normalized, undefined, forms);
  assert.deepEqual(forms.map(f => text.slice(positions[f.start][0], positions[f.end - 1][1])), ['４００', '８０％', '1,000 万円']);
});
test('1', '要約・本文・正しい内容の経路と年の補完で区切りを維持する', () => {
  const text = 'No.9999 限度面積400 80% 令和8年 4月1日';
  const r = ref(source);
  const expected = ['400', '割合:4/5', '日付:令和8-4-1'];
  assert.deepEqual(F.normalizedNumbers(T.numberCheckText(text, r)), expected);
  const checked = T.numberCheckClaim(claim(text), r);
  assert.deepEqual(F.normalizedNumbers(checked.claim), expected);
  assert.deepEqual(F.normalizedNumbers(checked.sentence), expected);
  assert.equal(T.numbersInSentence(expected, text), true);
  assert.equal(T.numbersInSentence(['割合:2004/5'], text), false);
  assert.deepEqual(T.expandYearDates(['日付:令和8'], text), ['日付:令和8', '日付:令和8-4-1']);
  assert.equal(supports(claim('| A | 400㎡ | 80% |'), source, quote, '食い違い', '限度面積400 80%'), true);
});

test('2', '引用の空白の有無で検索結果・位置の扱いを変えない', () => {
  const r = ref('前文 ' + quote + ' 貸付の案内');
  for (const q of [quote, quote.replace(/\s/g, '')]) {
    assert.equal(T.quoteExists(q, r), true);
    assert.equal(F.normalizedQuote(r.text).indexOf(F.normalizedQuote(q)), 2);
    assert.equal(T.quoteExists(q, { ...r, text_ranges: [[0, 2]] }), false);
  }
  assert.equal(T.quoteExists('資料に無い引用', r), false);
});
test('3', '表の80%を裏付け、結合した40080%は通さない', () => {
  assert.equal(supports(claim('| A | 400㎡ | 80% |', { claim: '減額割合は80%' })), true);
  assert.equal(supports(claim('| A | 40080% |', { claim: '減額割合は40080%' })), false);
  assert.equal(supports(claim('| A | 400㎡ | 80% |', { claim: '減額割合は40080%' })), false);
  assert.equal(T.quoteSupportsNumbers(['400', '割合:4/5'], { quote }, ref(source)), true);
});
for (const before of [false, true]) for (const distance of [300, 301]) {
  test('3', `原文の${before ? '前' : '後'}${distance}字の境界と途中で切れた数`, () => {
    const number = '50％';
    const padding = 'あ'.repeat(distance - number.length);
    const text = before ? number + padding + quote : quote + padding + number;
    assert.equal(supports(claim('割合は50%'), text), distance === 300);
  });
}
test('3', '空白が消えても原文の300字より外の数は通さない', () => {
  const c = claim('割合は50%');
  assert.equal(supports(c, quote + ' '.repeat(301) + '50％'), false);
  assert.equal(supports(c, '50％' + '　'.repeat(301) + quote), false);
  assert.equal(supports(c, quote + 'ﾊﾟ'.repeat(150) + '50％'), false);
});
test('3', '分かれた2つの引用はその近傍だけを合わせ、3つは採らない', () => {
  const q2 = '貸付事業用宅地等に該当する宅地等 200 50％';
  const text = quote + 'あ'.repeat(700) + q2;
  assert.equal(supports(claim('割合は80%と50%'), text, quote + '\n…\n' + q2), true);
  assert.equal(supports(claim('割合は80%と50%'), text), false);
  assert.equal(supports(claim('割合は80%'), text, quote + '\n…\n' + q2 + '\n…\n' + quote), false);
});
test('3', '同じ引用の別の出現位置の数字を混ぜない', () => {
  const q = 'この表の数値は次の案内で確認してください。';
  const text = q + ' 400' + 'あ'.repeat(700) + q + ' 80%';
  assert.equal(supports(claim('限度面積400 80%'), text, q), false);
});

test('4', '小数と数が並ぶ資料を読め、資料全体の歯止めも通る', () => {
  const text = source + '\n' + 'あ'.repeat(700) + '0.5 \n1\n100';
  assert.deepEqual(F.normalizedNumbers('0.5 \n1\n100'), ['0.5', '1', '100']);
  assert.equal(F.normalizedNumbers(text).includes(null), false);
  assert.equal(supports(claim('割合は80%'), text), true);
});
test('4', '本当に読めない数の断片は離れた位置でも資料全体を止める', () => {
  for (const broken of ['1.二割', '1.2.5%', '0分の1']) {
    assert.deepEqual(F.normalizedNumbers(broken), [null]);
    assert.equal(supports(claim('割合は80%'), source + 'あ'.repeat(700) + broken), false);
  }
});

test('5', '表の原文で文章にある面積・割合を裏付ける', () => {
  const c = claim('- 「貸付用でも80%」と覚えている：貸付事業用は50%・200㎡です。', { claim: '貸付事業用は減額割合50%・限度面積200㎡' });
  assert.equal(supports(c), true);
});
test('5', '一部の数字だけの裏付けと残す数字の本文表記を保つ', async () => {
  const c = claim('貸付事業用は５０％・３００㎡です。', { claim: '減額割合50%・限度面積300㎡' });
  assert.equal(supports(c), false);
  assert.deepEqual(T.partialQuoteNumbers(c, { quote }, ref(source)), { forms: ['５０％'] });
  assert.deepEqual(T.supportedNumberForms(c.sentence, ref(source), ['割合:1/2']), ['５０％']);
  const plain = claim('貸付事業用は50%・300㎡です。', { claim: c.claim });
  assert.deepEqual(T.partialQuoteNumbers(plain, { quote }, ref(source)), { forms: ['50%'] });
  const rows = await F.judgeClaims([plain], { c1: [ref(source)] }, plain.sentence,
    async () => [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }], options);
  assert.equal(rows[0].status, '資料なし');
  assert.deepEqual(rows[0].supported_numbers, ['50%']);
});
test('5', '数字が隣接する本文の保持表記も別の数として抜き出す', () => {
  assert.deepEqual(T.supportedNumberForms('400 80% 50％', ref(source), ['割合:4/5']), ['80%']);
  assert.deepEqual(T.supportedNumberForms('No.9999 ４００ ８０％', ref(source), ['400', '割合:4/5']), ['４００', '８０％']);
});

const table = [
  '| 宅地等の区分 | 限度面積 | 減額割合 |',
  '|---|---|---|',
  '| 特定事業用宅地等 | 400㎡ | 80% |',
  '| 特定同族会社事業用宅地等 | 400㎡ | 80% |',
  '| 特定居住用宅地等 | 330㎡ | 80% |',
  '| 貸付事業用宅地等 | 200㎡ | 50% |',
].join('\n');
const extract = (body, s, summary, type = '要件') => F.extractClaims(body, async () => [{ s, type, subject: '試験制度', claim: summary }], options);
for (const [s, summary, type, expected, notExpected] of [
  [3, '限度面積は400㎡', '要件', 3],
  [5, '限度面積は330㎡', '要件', 5],
  [6, '限度面積は200㎡', '要件', 6],
  [3, '減額割合は80%', '割合', 3],
  [5, '限度面積は400㎡', '要件', null, 5],
]) test('6', `基準の表: s${s} ${summary}`, async () => {
  const out = await extract(table, s, summary, type);
  if (expected) assert.equal(out.claims[0]?.sentence, U.splitUnits(table)[expected - 1].text);
  else assert.notEqual(out.claims[0]?.sentence, U.splitUnits(table)[notExpected - 1].text);
});
for (const type of ['要件', '判定', '手続']) test('6', `${type}でも近傍の見出し語と行内の数字を使う`, async () => {
  const out = await extract(table, 4, '限度面積は330㎡', type);
  assert.equal(out.claims[0]?.s, 5);
  assert.equal((await extract(table, 5, '限度面積は330㎡で割合は50%', type)).claims.length, 0);
});
test('6', '表の見出し行・区切り行を結び付け先にしない', async () => {
  for (const s of [1, 2]) {
    const out = await extract(table, s, '限度面積を確認');
    assert.ok(out.claims.length);
    assert.equal(out.claims[0].s, 3);
  }
});
test('6', '空行や文章や別の表を越えて見出しを使わない', async () => {
  for (const boundary of ['\n\n', '\n案内を確認します。\n', '\n\n| 区分 | 値 |\n|---|---|\n']) {
    const text = table + boundary + '| 別の区分 | 999㎡ |';
    const out = await extract(text, U.splitUnits(text).at(-1).s, '限度面積は999㎡');
    assert.equal(out.claims.length, 0);
  }
});
test('6', '文章の文の結び付けを変えない', async () => {
  const text = '受贈者は直系卑属である推定相続人または孫です。';
  assert.equal((await extract(text, 1, text)).claims[0]?.sentence, text);
});

const row = '| A | 400㎡ | 80% |';
const both = '| A | 国税庁の案内で確認 | 国税庁の案内で確認 |';
const onlyRatio = '| A | 400㎡ | 国税庁の案内で確認 |';
const finding = (extra = {}) => claim(row, { status: '資料なし', claim: '減額割合は80%', ...extra });
const repair = (body, findings, replacement, opts = {}, inspect = () => {}) => F.repairBody(body, findings, async req => {
  inspect(req);
  return findings.map(f => ({ id: f.id, replacement }));
}, opts);
for (const [mode, opts, type] of [
  ['通常の割合', {}, '割合'],
  ['enhancedの要件', enhanced, '要件'],
]) {
  test('7', `${mode}: 外さない面積の列を書き換えたら採らない`, async () => {
    const result = await repair(row, [finding({ type })], both, opts);
    assert.equal(result.body, row);
    assert.equal(result.rejected.get('c1'), '外さない列を書き換えています');
    assert.equal(result.replacements.size, 0);
  });
  test('7', `${mode}: 割合の列だけの修正は採る`, async () => {
    const result = await repair(row, [finding({ type })], onlyRatio, opts, req => {
      assert.ok(JSON.parse(req.user).corrections[0].instruction.includes('表の行は、外す数字のある列だけを書き換え、他の列は元のまま残す'));
    });
    assert.equal(result.body, onlyRatio);
    assert.equal(result.rejected.size, 0);
  });
  test('7', `${mode}: 同じ行の指摘を合わせれば両方の列を書き換えられる`, async () => {
    const findings = [finding({ type }), finding({ id: 'c2', type: '要件', claim: '限度面積は400㎡' })];
    const result = await repair(row, findings, both, opts);
    assert.equal(result.body, both);
    assert.equal(result.rejected.size, 0);
  });
}
test('7', '外さない列の幅・空白の違いだけは認める', async () => {
  const replacement = '| Ａ |　４００㎡　| 国税庁の案内で確認 |';
  const result = await repair(row, [finding()], replacement);
  assert.equal(result.body, replacement);
  assert.equal(result.rejected.size, 0);
});
test('7', '数字の無いラベルの列も保護する', async () => {
  const result = await repair(row, [finding()], onlyRatio.replace('A', 'B'));
  assert.equal(result.body, row);
  assert.equal(result.rejected.get('c1'), '外さない列を書き換えています');
});
test('7', 'enhancedの書き換える列に未裏付けの数字が残れば採らない', async () => {
  const result = await repair(row, [finding({ type: '要件' })], '| A | 400㎡ | 70%程度 |', enhanced);
  assert.equal(result.body, row);
  assert.equal(result.rejected.get('c1'), '資料の無い数字が残っています');
});
test('7', '文章の修正は列の制約を加えず、enhancedの歯止めを維持する', async () => {
  const sentence = '面積は400㎡、減額割合は80%です。';
  const replacement = '面積・減額割合は国税庁の案内で確認してください。';
  assert.equal((await repair(sentence, [finding({ sentence })], replacement)).body, replacement);
  const result = await repair(sentence, [finding({ sentence, type: '要件' })], '面積は400㎡、減額割合は国税庁の案内で確認してください。', enhanced);
  assert.equal(result.body, sentence);
  assert.equal(result.rejected.get('c1'), '資料の無い数字が残っています');
});
test('7', '外す数字が無い表の行の指摘は従来どおり', async () => {
  const result = await repair(row, [finding({ type: '要件', claim: '区分の要件がある' })], '| B | 国税庁の案内で確認 | 国税庁の案内で確認 |');
  assert.equal(result.rejected.size, 0);
  assert.equal(result.body.startsWith('| B |'), true);
});
for (const status of ['食い違い', '期限の書き漏れ']) test('7', `${status}の修正は列の保護を加えない`, async () => {
  const result = await repair(row, [finding({ status })], both);
  assert.equal(result.body, both);
  assert.equal(result.rejected.size, 0);
});
test('7', '却下した列の修正は未解決のまま承認を差し止める', async () => {
  const result = await F.checkFacts(row, { ...options, enabled: true, searchEvidence: () => [], callLLM: async req => {
    if (req.task === 'extract') return [{ s: 1, type: '割合', subject: '試験制度', claim: '減額割合は80%' }];
    if (req.task === 'repair') return [{ id: 'c1', replacement: both }];
    assert.fail(`予定外の呼び出し: ${req.task}`);
  } });
  assert.equal(result.body, row);
  assert.equal(result.record.corrections[0].resolved, false);
  assert.equal(result.record.corrections[0].reason, '外さない列を書き換えています');
  assert.ok(result.record.remaining.some(c => c.id === 'c1'));
  const raw = '---\nslug: table-test\nrecommendation: publish\n---\n' + row;
  assert.ok(F.applyFactResult(raw, result).includes('fact_check_blocking: true'));
});

test('8', 'LOGIC_VERSION は plan2-s2', async () => {
  const result = await F.checkFacts('', { ...options, enabled: true });
  assert.equal(result.record.logic_version, 'plan2-s2');
});

(async () => {
  let passed = 0;
  for (const t of tests) {
    try { await t.run(); passed++; console.log(`PASS ${t.group}: ${t.name}`); }
    catch (error) { console.error(`FAIL ${t.group}: ${t.name}\n${error.stack}`); }
  }
  console.log(`表の数字・行・列: ${passed}/${tests.length} 成功`);
  if (previousWriterMode === undefined) delete process.env.FACT_CHECK_WRITER_MATERIALS;
  else process.env.FACT_CHECK_WRITER_MATERIALS = previousWriterMode;
  if (passed !== tests.length) process.exitCode = 1;
})();
