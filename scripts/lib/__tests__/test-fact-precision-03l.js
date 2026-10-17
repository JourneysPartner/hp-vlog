'use strict';

// 03l の再現・回帰試験。LLM は偽の関数、保存先は一時ディレクトリに限定する。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const matter = require('gray-matter');
const F = require('../fact-check');
const U = require('../fact-units');
const root = path.resolve(__dirname, '../../..');
const groups = Object.fromEntries(['L1', 'L2', 'L3'].map(k => [k, { pass: 0, fail: 0 }]));
const now = new Date('2026-10-17T00:00:00Z');
const options = extra => ({ now, enabled: true, provider: 'anthropic', model: 'claude-opus-5-5',
  loadEvidenceText: r => r.text, ...extra });
const ref = text => ({ id: 'e1', title: '制度の原文', url: 'https://example.jp/source', text, law_version: '' });
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, heading: '', type: '金額', subject: '制度', claim: sentence, ...extra });
const supported = id => ({ id, status: '裏付けあり', evidence_id: 1, basis: '1', correct: '' });
const giftRecord = JSON.parse(fs.readFileSync(path.join(root, 'data/fact-check/gift-cash-procedure-tax-return.json'), 'utf8'));
const giftAmount = giftRecord.claims.find(c => c.id === 'c3');
const giftRate = giftRecord.claims.find(c => c.id === 'c15');
const giftSentence = giftAmount.sentence;
const keep = [{ type: giftAmount.type, subject: giftAmount.subject, claim: giftAmount.claim }];
const source4103 = JSON.parse(fs.readFileSync(path.join(root, 'data/nta-sources/taxanswer/sozoku/4103.json'), 'utf8')).body;

async function test(group, name, fn) {
  try { await fn(); groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (error) { groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
}
function extracted(request, rows) {
  const units = [...request.user.matchAll(/^\[(\d+)\] (.*)$/gm)];
  return rows.flatMap(c => {
    const unit = units.find(u => u[2] === c.sentence);
    return unit ? [{ s: Number(unit[1]), type: c.type, subject: c.subject, claim: c.claim }] : [];
  });
}
async function giftRepair(replacement, extra = {}) {
  const sentence = extra.sentence || giftSentence;
  const amount = { ...giftAmount, sentence }, rate = { ...giftRate, sentence };
  const body = `## 相続時精算課税\n前の案内はそのまま残します。\n${sentence}\nただし、特定贈与者が亡くなったときは、相続税の計算にも関係します。`;
  const calls = [];
  const result = await F.checkFacts(body, options({ searchEvidence: () => [ref('贈与税の計算では、基礎控除額110万円と特別控除額2,500万円を控除します。')],
    callLLM: async request => {
      calls.push(request);
      if (request.task === 'extract') {
        return extracted(request, [amount, rate, { ...amount, sentence: replacement }]);
      }
      const rows = JSON.parse(request.user);
      if (request.task === 'repair') return rows.corrections.map(c => ({ id: c.id, replacement }));
      return rows.claims.map(c => c.type === '割合' ? { id: c.id, status: '資料なし' } : supported(c.id));
    } }));
  return { ...result, before: body, calls };
}
function assertBlocking(result, expected) {
  const raw = `---\nslug: precision-03l\nrecommendation: publish\n---\n${result.before}`;
  const meta = matter(F.applyFactResult(raw, result)).data;
  assert.equal(meta.fact_check_blocking, expected);
  assert.equal(meta.recommendation, expected ? 'revise' : 'publish');
}

async function main() {
  for (const text of ['一律20パーセントの税率', '20パーセント相当額', '100分の20', '20%', '２０％', '２０ﾊﾟｰｾﾝﾄ', '二十パーセント']) {
    await test('L1', `同じ割合として読む: ${text}`, () => assert.deepEqual(F.normalizedNumbers(text), ['割合:1/5']));
  }
  await test('L1', '#680 の20%を No.4103 の実在する原文で裏付ける', () => {
    const quote = source4103.match(/その贈与税の額は、[\s\S]*?算出します。/)[0];
    assert.ok(quote.includes('一律20パーセントの税率'));
    assert.ok(source4103.includes(quote));
    assert.equal(F.sufficientQuote(giftRate, { quote }, ref(source4103), '裏付けあり'), true);
    assert.equal(F.sufficientQuote({ ...giftRate, claim: giftRate.claim.replace('20%', '30%') }, { quote }, ref(source4103), '裏付けあり'), false);
  });
  await test('L1', '範囲の端で切れた百分率を採らず、完全な場合だけ採る', () => {
    for (const suffix of ['%', 'パーセント']) {
      const text = `前20${suffix}後`;
      for (let end = 2; end < text.length - 1; end++) assert.deepEqual(F.normalizedNumbers(text, [0, end]), []);
      assert.deepEqual(F.normalizedNumbers(text, [1, text.length - 1]), ['割合:1/5']);
      assert.deepEqual(F.normalizedNumbers(text, [2, text.length]), []);
      const fraction = `100分の20${suffix}`;
      assert.deepEqual(F.normalizedNumbers(fraction, [0, fraction.length - 1]), []);
      assert.deepEqual(F.normalizedNumbers(fraction, [0, fraction.length]), ['割合:1/500']);
    }
  });
  await test('L1', '小数・負数・不完全な割合の扱いと「割」は維持する', () => {
    assert.deepEqual(F.normalizedNumbers('2.5パーセント'), ['割合:1/40']);
    assert.deepEqual(F.normalizedNumbers('-20パーセント'), ['割合:-1/5']);
    assert.deepEqual(F.normalizedNumbers('0パーセント'), ['割合:0/1']);
    assert.deepEqual(F.normalizedNumbers('0分の20パーセント'), [null]);
    assert.deepEqual(F.normalizedNumbers('2割'), ['2']);
  });

  await test('L2', '#680 の案内への全置換を却下し、未解決として承認を止める', async () => {
    const result = await giftRepair('この制度の控除額や税率は、詳しくは国税庁の相続時精算課税のページで確認してください。');
    assert.equal(result.record.status, 'revise'); assert.equal(result.body, result.before);
    const correction = result.record.corrections.find(c => c.type === '割合');
    assert.equal(correction.reason, '裏付けのある数字を消しています'); assert.equal(correction.resolved, false);
    assert.ok(result.record.remaining.some(c => c.type === '割合'));
    assert.equal(result.calls.filter(c => c.task === 'judge').length, 1);
    assertBlocking(result, true);
  });
  await test('L2', '110万円・2,500万円を残して20%だけを外せば採用し、再照合する', async () => {
    const replacement = 'この制度を選ぶと、年110万円の基礎控除とは別に、特定贈与者ごとに累計2,500万円までの特別控除があります。';
    const result = await giftRepair(replacement);
    assert.equal(result.record.status, 'ok'); assert.equal(result.body, result.before.replace(giftSentence, replacement));
    assert.ok(result.record.corrections.find(c => c.type === '割合').resolved);
    assert.ok(result.record.rechecked.some(c => c.type === '金額' && c.status === '裏付けあり'));
    assert.equal(result.calls.filter(c => c.task === 'judge').length, 2);
    assertBlocking(result, false);
  });
  await test('L2', '修正AIに同じ文の裏付けありの要約をkeepとして渡す', async () => {
    const result = await giftRepair(giftSentence.replace('、超えた部分には一律20%の税率がかかります', 'ます'));
    const corrections = JSON.parse(result.calls.find(c => c.task === 'repair').user).corrections;
    assert.equal(corrections.length, 1); assert.equal(corrections[0].type, '割合');
    assert.deepEqual(corrections[0].keep, keep);
    assert.ok(corrections[0].instruction.includes('keep にある裏付けのある内容（数字を含む）は残し'));
  });
  for (const removed of ['110万円', '2,500万円']) await test('L2', `keepの数字は全て必要: ${removed}だけを削除しても却下`, async () => {
    const result = await giftRepair(giftSentence.replace(removed, '一定額').replace('20%', '一定の割合'));
    assert.equal(result.record.corrections[0].reason, '裏付けのある数字を消しています');
    assert.equal(result.body, result.before); assertBlocking(result, true);
  });
  await test('L2', '要約にだけある数字は要求せず、数字の表記違いは同じ値として残す', async () => {
    const sentence = '控除は110万円で、資料のない税率は20%です。';
    const finding = claim(sentence, { status: '資料なし', type: '割合', keep: [{ claim: '控除110万円、別の説明は999万円' }] });
    const replacement = '控除は百十万円です。税率は国税庁で確認してください。';
    const result = await F.repairBody(sentence, [finding], async () => [{ id: finding.id, replacement }]);
    assert.equal(result.accepted, true); assert.equal(result.rejected.size, 0); assert.equal(result.body, replacement);
  });
  await test('L2', 'keepが空でも同じ文以外の主張を混ぜず、従来どおり修正する', async () => {
    const sentence = '資料のない税率は20%です。', other = '別の制度の控除は110万円です。';
    const result = await F.checkFacts(`${sentence}\n${other}`, options({ searchEvidence: () => [ref(other)], callLLM: async request => {
      if (request.task === 'extract') return extracted(request, [claim(sentence, { type: '割合' }), claim(other)]);
      const payload = JSON.parse(request.user);
      if (request.task === 'repair') {
        assert.deepEqual(payload.corrections[0].keep, []);
        return payload.corrections.map(c => ({ id: c.id, replacement: '詳しくは国税庁で税率を確認してください。' }));
      }
      return payload.claims.map(c => c.type === '割合' ? { id: c.id, status: '資料なし' } : supported(c.id));
    } }));
    assert.equal(result.record.status, 'ok'); assert.ok(result.body.includes(other)); assert.ok(!result.body.includes('20%'));
  });
  for (const status of ['食い違い', '期限の書き漏れ']) await test('L2', `${status}にはkeepの数字の歯止めを掛けない`, async () => {
    const finding = claim('控除は110万円です。', { status, keep: [{ claim: '控除110万円' }] });
    const replacement = '控除は120万円です。';
    const result = await F.repairBody(finding.sentence, [finding], async request => {
      const c = JSON.parse(request.user).corrections[0];
      assert.equal(c.instruction, status === '食い違い' ? '根拠の原文に合わせて、この文だけを直す' : 'この制度の説明に、根拠の適用期限を1文で足す');
      return [{ id: c.id, replacement }];
    });
    assert.equal(result.rejected.size, 0); assert.equal(result.body, replacement);
  });
  await test('L2', '番号を消す指示は維持する', () => {
    assert.equal(F.repairInstructions([claim('番号110です。', { status: '資料なし', type: '番号' })])[0].instruction,
      '資料が無い番号を消し、番号を推測せず内容だけにする');
  });
  await test('L2', '外す数字とkeepが同じ値でもkeepを優先する', async () => {
    const finding = claim('控除は110万円で、別の限度も110万円です。', { status: '資料なし', keep: [{ claim: '控除110万円' }] });
    const replacement = '控除は110万円です。別の限度は国税庁で確認してください。';
    const result = await F.repairBody(finding.sentence, [finding], async () => [{ id: finding.id, replacement }]);
    assert.equal(result.rejected.size, 0); assert.equal(result.body, replacement);
  });
  await test('L2', 'keepを失う置換は同じ文の他の指摘も却下する', async () => {
    const first = claim(giftSentence, { status: '資料なし', type: '割合', keep });
    const second = { ...first, id: 'c2', status: '食い違い' };
    const result = await F.repairBody(giftSentence, [first, second], async () => [first, second].map(c => ({ id: c.id, replacement: '国税庁で確認してください。' })));
    assert.equal(result.body, giftSentence); assert.equal(result.replacements.size, 0);
    assert.equal(result.rejected.get('c1'), '裏付けのある数字を消しています');
    assert.equal(result.rejected.get('c2'), '同じ文の別の指摘の置き換えを採れませんでした');
  });

  await test('L3', '#680 の4行をそれぞれ1文にし、110万円を含む文として抽出する', async () => {
    const article = fs.readFileSync(path.join(root, 'content/posts/2026-10-16-gift-cash-procedure-tax-return.md'), 'utf8');
    const lines = article.split(/\r?\n/).filter(line => /^[1-4]\. <strong>/.test(line));
    assert.equal(lines.length, 4);
    for (const line of lines) {
      const units = U.splitUnits(line); assert.equal(units.length, 1); assert.equal(units[0].text, line);
    }
    const result = await F.extractClaims(lines.join('\n'), async () => [{ s: 1, type: '判定', subject: '贈与税の申告要否', claim: 'その年の受取合計が110万円以内なら通常は申告不要' }]);
    assert.equal(result.discarded, 0); assert.equal(result.claims[0].sentence, lines[0]);
  });
  for (const markup of ['<strong>A。</strong>', '<strong class="x">A。</strong>', '<b data-x="y">A。</b>', '<em>A。</em>', '**A。**', '<STRONG>A。</STRONG>', '<strong>A。<em>内。</em>続。</strong>']) {
    await test('L3', `閉じた強調内で切らず、その後は切る: ${markup}`, () => {
      const text = `${markup}B。C。`, units = U.splitUnits(text);
      assert.deepEqual(units.map(u => u.text), [`${markup}B。`, 'C。']);
      assert.ok(units.every(u => text.slice(u.start, u.end) === u.text));
      assert.deepEqual(U.splitUnits(text, { material: true }).map(u => u.text), units.map(u => u.text));
    });
  }
  await test('L3', '同じ行で閉じない強調は従来どおり切る', () => {
    for (const opening of ['<strong>', '<b>', '<em>', '**']) assert.deepEqual(U.splitUnits(`${opening}A。B。`).map(u => u.text), [`${opening}A。`, 'B。']);
    assert.deepEqual(U.splitUnits('<strong>A。B。\n</strong>C。').map(u => u.text), ['<strong>A。', 'B。', '</strong>C。']);
    assert.deepEqual(U.splitUnits('**A。B。\n**C。').map(u => u.text), ['**A。', 'B。', '**C。']);
  });
  await test('L3', '括弧・表の行・見出し・materialの300字と原文範囲を維持する', () => {
    const body = '## 見出し。\n外（内。さらに「内。」）外。次。\n| 見出し。 | 値。 |';
    const units = U.splitUnits(body);
    assert.deepEqual(units.map(u => u.text), ['## 見出し。', '外（内。さらに「内。」）外。', '次。', '| 見出し。 | 値。 |']);
    assert.equal(units[0].heading, true); assert.ok(units.every(u => body.slice(u.start, u.end) === u.text));
    const material = '字'.repeat(280) + '、' + '続'.repeat(290) + '（中。注）' + '字'.repeat(100) + '。';
    const parts = U.splitUnits(material, { material: true });
    assert.deepEqual(parts.map(u => u.text.length), [281, 300, 96]);
    assert.equal(U.rangeText(material, parts, '1-3').text, material);
    const ranged = U.splitUnits(material, { material: true, ranges: [[0, 281], [581, material.length]] });
    assert.deepEqual(ranged.map(u => u.segment), [0, 1]);
    assert.equal(U.rangeText(material, ranged, '1-2'), null);
  });
  await test('L3', '太字を含む1文のL2の修正が正しい位置に入り、前後の文を守る', async () => {
    const sentence = '<strong>年110万円の基礎控除です。</strong> 特定贈与者ごとに累計2,500万円までの特別控除があり、一律20%の税率がかかります。';
    const replacement = '<strong>年110万円の基礎控除です。</strong> 特定贈与者ごとに累計2,500万円までの特別控除があります。';
    const result = await giftRepair(replacement, { sentence });
    assert.equal(result.record.status, 'ok'); assert.equal(result.body, result.before.replace(sentence, replacement));
    assert.deepEqual(JSON.parse(result.calls.find(c => c.task === 'repair').user).corrections[0].keep, keep);
    const pairs = F.correctionPairs(result.before, result.body, result.record.corrections);
    assert.equal(pairs.get(sentence), replacement); assertBlocking(result, false);
    const rejected = await giftRepair('国税庁で確認してください。', { sentence });
    assert.equal(rejected.body, rejected.before); assert.equal(rejected.record.corrections[0].reason, '裏付けのある数字を消しています');
  });
  await test('L3', '03lを記録し、03kの記録は差分照合で使い回さない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-03l-version-'));
    const sentence = '基礎控除は110万円です。', calls = [];
    const raw = `---\nslug: precision-version\nrecommendation: publish\n---\n${sentence}`;
    const opts = options({ recordDir: dir, repair: false, searchEvidence: () => [ref(sentence)], callLLM: async request => {
      calls.push(request);
      return request.task === 'extract' ? extracted(request, [claim(sentence)]) : JSON.parse(request.user).claims.map(c => supported(c.id));
    } });
    try {
      const initial = await F.checkArticle(raw, opts);
      assert.equal(initial.record.logic_version, '03l'); assert.equal(initial.record.status, 'ok');
      const file = F.recordPath('precision-version', dir);
      const prior = JSON.parse(fs.readFileSync(file, 'utf8')); prior.logic_version = '03k';
      fs.writeFileSync(file, JSON.stringify(prior)); calls.length = 0;
      const result = await F.checkArticle(raw, { ...opts, persist: false, previousRaw: raw });
      assert.equal(result.record.incremental, undefined); assert.equal(result.record.logic_version, '03l');
      assert.ok(calls.some(c => c.task === 'extract')); assert.ok(calls.some(c => c.task === 'judge'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  console.log('03l集計:', JSON.stringify(groups));
  process.exitCode = Object.values(groups).some(g => g.fail) ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
