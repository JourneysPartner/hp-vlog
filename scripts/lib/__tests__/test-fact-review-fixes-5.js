'use strict';

// 03k の回帰確認。LLM は偽の関数に置き換え、記録は一時ディレクトリだけに保存する。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');
const F = require('../fact-check');
const U = require('../fact-units');
const { LAW_SCOPE_RULE } = require('../grounding-rules');
const groups = Object.fromEntries(['K1', 'K2', 'K3', 'K4', 'K5'].map(key => [key, { pass: 0, fail: 0 }]));
const now = new Date('2026-10-14T00:00:00Z');
const ref = (text, extra = {}) => ({ id: 'e1', title: '制度の原文', text, url: 'https://example.jp/source', law_version: '', ...extra });
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, heading: '制度', type: '金額', subject: '基礎控除', claim: sentence, ...extra });
const options = extra => ({ now, loadEvidenceText: r => r.text, ...extra });
const support = (id, extra = {}) => ({ id, status: '裏付けあり', evidence_id: 1, basis: '1', correct: '', ...extra });
async function test(group, name, fn) {
  try { await fn(); groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (error) { groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
}
async function judge(claims, text, fake, extra = {}) {
  return F.judgeClaims(claims, Object.fromEntries(claims.map(c => [c.id, [ref(text)]])), claims.map(c => c.sentence).join('\n'), fake, options(extra));
}
function extracted(req, claims) {
  const units = [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)];
  return claims.flatMap(c => {
    const unit = units.find(u => u[2] === c.sentence);
    return unit ? [{ s: Number(unit[1]), type: c.type, subject: c.subject, claim: c.claim }] : [];
  });
}
async function regenerate(before, after, claims, inspect, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-03k-'));
  const raw = body => `---\nslug: review-fixes-5\nrecommendation: publish\n---\n${body}`;
  const old = ref(claims.map(c => c.sentence).join('\n'), { id: 'old', law_version: '2020-01-01' });
  const calls = [];
  try {
    const initial = await F.checkArticle(raw(before), options({ recordDir: dir, repair: false, searchEvidence: () => [old],
      callLLM: async req => req.task === 'extract' ? extracted(req, claims) : JSON.parse(req.user).claims.map(c => support(c.id)) }));
    assert.equal(initial.record.status, 'ok');
    assert.ok(initial.record.claims.every(c => c.warning && c.evidence_id === 'old'));
    const fake = extra.callLLM || (async req => req.task === 'extract' ? extracted(req, claims) : JSON.parse(req.user).claims.map(c => support(c.id)));
    const result = await F.checkArticle(raw(after), options({ recordDir: dir, persist: false, previousRaw: raw(before), repair: false,
      searchEvidence: () => [ref(old.text)], ...extra, callLLM: async req => { calls.push(req); return fake(req); } }));
    await inspect(result, calls, initial);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  const first = claim('基礎控除は48万円です。');
  const second = claim('所得が少なければ基礎控除は48万円です。', { id: 'c2' });
  const before = `## 令和6年分の基礎控除\n${first.sentence}\n${second.sentence}`;
  const after = before.replace('令和6年分', '令和7年分');
  await test('K1', '見出しの年だけ変えても2件を再判定し、片方の古い状態で承認を通さない', async () => {
    const repaired = claim('基礎控除は58万円です。');
    await regenerate(before, after, [first, second], (result, calls) => {
      const record = result.record;
      assert.deepEqual(record.incremental, { reused: 0, rejudged: 2, subjects: ['基礎控除'] });
      assert.deepEqual(record.claims.map(c => c.status), ['食い違い', '資料なし']);
      assert.ok(record.claims.every(c => c.heading === '令和7年分の基礎控除' && !c.warning));
      assert.equal(record.claims[0].evidence_id, 'e1');
      assert.equal(record.claims[1].evidence_id, '');
      assert.equal(record.claims[1].quote, ''); assert.equal(record.claims[1].correct, '');
      assert.equal(record.claims[1].reject_reason, '答えが無い');
      assert.ok(record.corrections.find(c => c.id === 'c1').resolved);
      assert.ok(record.remaining.some(c => c.id === 'c2' && c.status === '資料なし'));
      assert.equal(record.status, 'revise');
      assert.equal(matter(result.content).data.recommendation, 'revise');
      assert.equal(matter(result.content).data.fact_check_status, 'revise');
      assert.ok(result.body.includes(repaired.sentence) && result.body.includes(second.sentence));
      const judges = calls.filter(c => c.task === 'judge');
      assert.equal(JSON.parse(judges[0].user).claims.length, 2);
      assert.equal(judges[0].staticSystem, judges[1].staticSystem);
    }, { repair: true, searchEvidence: () => [ref('令和7年分の基礎控除は58万円です。')], callLLM: async req => {
      if (req.task === 'extract') return extracted(req, [first, second, repaired]);
      if (req.task === 'repair') return [{ id: 'c1', replacement: repaired.sentence }];
      return JSON.parse(req.user).claims.flatMap(c => c.claim.includes('58万円') ? [support(c.id)]
        : c.id === 'c1' ? [support(c.id, { status: '食い違い', correct: '基礎控除は58万円です。' })] : []);
    } });
  });
  await test('K1', '再判定した裏付けありも今回の引用・根拠だけで組み立てる', async () => {
    const current = '令和7年分の基礎控除は48万円として説明する試験資料です。';
    await regenerate(before, after, [first, second], result => {
      assert.deepEqual(result.record.claims.map(c => c.status), ['食い違い', '裏付けあり']);
      assert.equal(result.record.claims[1].quote, current);
      assert.equal(result.record.claims[1].evidence_id, 'e1');
      assert.equal(result.record.claims[1].warning, undefined);
      assert.equal(result.record.status, 'revise');
    }, { searchEvidence: () => [ref(current)], callLLM: async req => req.task === 'extract' ? [] : JSON.parse(req.user).claims.map(c =>
      support(c.id, c.id === 'c1' ? { status: '食い違い', correct: '基礎控除は48万円です。' } : {})) });
  });
  await test('K1', '差分照合で候補が無くなった2件に古い引用・根拠・警告を残さない', async () => {
    await regenerate(before, after, [first, second], (result, calls) => {
      assert.equal(result.record.status, 'revise');
      assert.ok(!calls.some(c => c.task === 'judge'));
      for (const c of result.record.claims) {
        assert.equal(c.status, '資料なし'); assert.equal(c.quote, ''); assert.equal(c.correct, '');
        assert.equal(c.evidence_id, ''); assert.equal(c.warning, undefined); assert.deepEqual(c.evidence, []);
      }
    }, { searchEvidence: () => [] });
  });
  await test('K1', '直接の判定でも入力の古い項目とAIの余計な項目を引き継がない', async () => {
    const stale = { ...first, status: '裏付けあり', quote: '古い引用', correct: '古い正しい内容', evidence_id: 'old', warning: '古い警告', reject_reason: '古い理由', extra: true };
    for (const refs of [[], [ref(first.sentence)]]) {
      const rows = await F.judgeClaims([stale], { c1: refs }, first.sentence, async () => [support('c1', { extra: true })], options());
      assert.equal(rows[0].warning, undefined); assert.equal(rows[0].reject_reason, undefined); assert.equal(rows[0].extra, undefined);
      assert.equal(rows[0].correct, ''); assert.equal(rows[0].s, 1);
      assert.equal(rows[0].quote, refs.length ? first.sentence : '');
    }
  });

  for (const [name, type, sentences, text, correct] of [
    ['贈与と入居の同じ期限', '期限', ['令和8年12月31日までの贈与が対象です。', '令和8年12月31日までに入居が必要です。'],
      '令和8年12月31日までの贈与が対象です。翌年3月15日までに居住する必要があります。', '翌年3月15日までに居住する必要があります。'],
    ['措法69の4の丸数字', '番号', ['措法69の4①が根拠です。', '根拠は措法69の4③です。'], 'この制度の根拠は措法69の4①です。', '措法69の4①です。'],
    ['70条の枝番号の重複', '番号', ['措法70条の2を適用します。', 'この制度は措法70条の2の2を適用します。'], 'この制度は措法70条の2を適用します。', '措法70条の2を適用します。'],
  ]) await test('K2', `${name}は両方を1回の判定に送り、別々の結果を残す`, async () => {
    const claims = sentences.map((sentence, i) => claim(sentence, { id: `c${i + 1}`, type }));
    let calls = 0;
    const rows = await judge(claims, text, async req => {
      calls++; assert.deepEqual(JSON.parse(req.user).claims.map(c => c.id), ['c1', 'c2']);
      assert.equal((req.staticSystem.match(/\[資料 1\]/g) || []).length, 1);
      return [support('c1'), support('c2', { status: '食い違い', correct })];
    });
    assert.equal(calls, 1); assert.deepEqual(rows.map(c => c.status), ['裏付けあり', '食い違い']);
  });
  await test('K2', '同じ数字・種類・要約でも資料なしと期限の書き漏れを他の文へ当てない', async () => {
    const claims = [claim('控除は100万円です。', { claim: '控除100万円' }), claim('上限の控除額は100万円です。', { id: 'c2', claim: '控除100万円' })];
    for (const status of ['資料なし', '期限の書き漏れ']) {
      let calls = 0;
      const rows = await judge(claims, '控除は100万円、令和9年3月31日まで適用します。', async req => {
        calls++; assert.equal(JSON.parse(req.user).claims.length, 2);
        return [support('c1', { status, correct: status === '資料なし' ? '' : '令和9年3月31日まで' }), support('c2')];
      });
      assert.equal(calls, 1); assert.deepEqual(rows.map(c => c.status), [status, '裏付けあり']);
    }
  });
  await test('K2', '期限の書き漏れは制度ごとに1件、他の主張も資料なしと理由を記録する', async () => {
    const claims = [claim('控除は100万円です。'), claim('上限は100万円です。', { id: 'c2' }), claim('別枠は100万円です。', { id: 'c3' })];
    let calls = 0;
    const rows = await judge(claims, '控除は100万円で、令和9年3月31日まで適用します。', async req => {
      calls++; return JSON.parse(req.user).claims.map(c => support(c.id, { status: '期限の書き漏れ', correct: '令和9年3月31日まで' }));
    });
    assert.equal(calls, 1); assert.deepEqual(rows.map(c => c.id), ['c1', 'c2', 'c3']);
    assert.deepEqual(rows.map(c => c.status), ['期限の書き漏れ', '資料なし', '資料なし']);
    assert.ok(rows.slice(1).every(c => c.reject_reason === '同じ制度の期限の書き漏れは記録済み'));
  });

  await test('K3', '小規模宅地等の短い誤りは3文目のまま判定・修正し、導入の文を守る', async () => {
    const subject = '小規模宅地等の特例';
    const intro = '小規模宅地等の特例は、一定の要件を満たす宅地の評価額を減額する特例です。';
    const wrong = '対象は配偶者だけです。', correct = '対象は配偶者だけに限りません。';
    const body = `## ${subject}\n${intro}\n${wrong}`;
    const sent = [];
    const result = await F.checkFacts(body, options({ searchEvidence: () => [ref(`${subject}の対象は配偶者だけに限りません。`)], callLLM: async req => {
      if (req.task === 'extract') return extracted(req, [claim(wrong, { type: '要件', subject, claim: '対象は配偶者だけ' }), claim(correct, { type: '要件', subject, claim: correct })]);
      if (req.task === 'repair') {
        assert.deepEqual(JSON.parse(req.user).corrections.map(c => c.sentence), [wrong]);
        return [{ id: 'c1', replacement: correct }];
      }
      const payload = JSON.parse(req.user); sent.push(payload);
      assert.ok(payload.body.includes(`[3] ${sent.length === 1 ? wrong : correct}`));
      assert.equal(payload.claims[0].s, 3);
      return [support('c1', sent.length === 1 ? { status: '食い違い', correct } : {})];
    } }));
    assert.equal(result.record.claims[0].sentence, wrong);
    assert.equal(result.record.status, 'ok'); assert.ok(result.record.corrections[0].resolved);
    assert.equal(result.body, `## ${subject}\n${intro}\n${correct}`);
  });
  await test('K3', '要約が1語でも重なる本文は、隣の文の重なりが多くても維持する', async () => {
    const result = await F.extractClaims('配偶者を対象とします。配偶者控除の申告条件を確認します。', async () =>
      [{ s: 1, type: '要件', subject: '配偶者控除', claim: '配偶者控除の申告条件を確認' }]);
    assert.equal(result.claims[0].s, 1);
  });
  for (const heading of [false, true]) await test('K3', `${heading ? '見出し' : '重なり0の本文'}からは制度名を除き要約の語だけで付け替える`, async () => {
    const body = `${heading ? '## 制度' : '制度の案内です。'}\n制度の案内を説明します。\n申告条件を確認します。`;
    const result = await F.extractClaims(body, async () => [{ s: 1, type: '要件', subject: '制度', claim: '申告条件を確認' }]);
    assert.equal(result.claims[0].s, 3);
  });
  for (const type of ['要件', '判定', '手続']) await test('K3', `${type}の付け替え先にも要約の数字がすべて必要`, async () => {
    const result = await F.extractClaims('## 申告条件\n申告条件は第21条の5と100万円です。\n第21条の6と100万円で申告条件を説明します。', async () =>
      [{ s: 1, type, subject: '申告条件', claim: '第21条の6と100万円の申告条件' }]);
    assert.equal(result.claims[0].s, 3);
    const absent = await F.extractClaims('## 申告条件\n申告条件は第21条の5と100万円です。', async () =>
      [{ s: 1, type, subject: '申告条件', claim: '第21条の6と100万円の申告条件' }]);
    assert.equal(absent.claims.length, 0); assert.equal(absent.discarded, 1);
    assert.equal(absent.discardedClaims[0].status, '本文に見つからない');
  });
  await test('K3', '制度名だけが一致し要約の語が無い場合は本文に見つからないとして捨てる', async () => {
    const result = await F.extractClaims('制度の案内です。制度の説明です。', async () => [{ s: 1, type: '要件', subject: '制度', claim: '申告条件を確認' }]);
    assert.equal(result.claims.length, 0); assert.equal(result.discarded, 1);
  });

  await test('K4', '判定の指示文は指定の括弧書き1つ以外を変えず、呼び出し設定を維持する', async () => {
    const previous = `主張を添付した原文だけで照合してください。evidence の中の、各主張の evidence_ids の資料だけを根拠にしてください。判断できなければ資料なしにする。記憶で補わない。括弧書き・ただし書きの対象を取り違えない。${LAW_SCOPE_RULE} 出力は [{id,status,evidence_id,basis,correct}] のJSON配列だけです。statusは裏付けあり／食い違い／資料なし／期限の書き漏れ。裏付けあり・食い違い・期限の書き漏れでは basis に根拠の文の番号（連続4つまで）を書き、evidence_id にその資料の番号を書いてください。食い違いには correct に原文に基づく正しい内容を書く。制度の適用期限が原文にあるのに番号付きの本文のどこにも書かれていない場合、制度ごとに1件だけ期限の書き漏れとし、correctに期限を書いてください。設例の額を制度の上限と混同しないでください。\n例: [{"id":"c1","status":"裏付けあり","evidence_id":3,"basis":"12-13","correct":""}]`;
    await judge([first], first.sentence, async req => {
      const instruction = req.system.split('\n\n[資料 ')[0];
      assert.equal(instruction.replace('（金額・期限・割合・適用年・番号の主張は連続2つまで）', ''), previous);
      assert.equal(req.system, req.staticSystem); assert.equal(req.maxTokens, 16000);
      assert.equal(F.config().model, 'claude-opus-5-5');
      return [support('c1')];
    });
  });
  for (const type of ['金額', '期限', '割合', '適用年', '番号']) await test('K4', `${type}の連続3〜4文は前から確認を通る1〜2文だけを採る`, async () => {
    const text = '控除100万円、令和9年3月31日まで、割合10%、第21条です。\n適用対象の条件を説明しています。\n申告の手続を説明しています。\n参考の注意事項を説明しています。';
    for (const basis of ['1-3', [1, 2, 3, 4], '1, 2, 3, 4']) {
      const rows = await judge([claim(text.split('\n')[0], { type })], text, async () => [support('c1', { basis })]);
      assert.equal(rows[0].status, '裏付けあり'); assert.equal(rows[0].quote, text.split('\n')[0]);
      assert.equal(rows[0].reject_reason, undefined);
    }
  });
  await test('K4', '先頭の短い引用を飛ばし、2文なら確認を通る最初の範囲を採る', async () => {
    const text = '案内\n控除の上限は100万円\n適用対象です。\n申告の手続を説明しています。';
    const rows = await judge([claim('控除の上限は100万円です。')], text, async () => [support('c1', { basis: '1-4' })]);
    assert.equal(rows[0].status, '裏付けあり'); assert.equal(rows[0].quote, '控除の上限は100万円\n適用対象です。');
  });
  await test('K4', '300字で分かれた長い法令の3文から連続2文を救う', async () => {
    const text = '条件'.repeat(148) + '控除100万円' + '対象'.repeat(296) + 'です。';
    assert.equal(U.splitUnits(text, { material: true }).length, 3);
    const rows = await judge([claim('控除は100万円です。')], text, async () => [support('c1', { basis: '1-3' })]);
    assert.equal(rows[0].status, '裏付けあり'); assert.ok(rows[0].quote.length <= 600);
    assert.ok(text.includes(rows[0].quote));
  });
  await test('K4', '食い違い・期限の書き漏れは正しい内容の数字で短い根拠を救う', async () => {
    for (const [status, type, sentence, correct] of [['食い違い', '金額', '控除は48万円です。', '控除は58万円です。'],
      ['期限の書き漏れ', '期限', '控除は100万円です。', '令和9年3月31日までです。']]) {
      const text = `${correct}\n制度の適用対象を説明しています。\n申告の手続を説明しています。`;
      const rows = await judge([claim(sentence, { type })], text, async () => [support('c1', { status, correct, basis: '1-3' })]);
      assert.equal(rows[0].status, status); assert.equal(rows[0].quote, correct); assert.equal(rows[0].correct, correct);
    }
  });
  await test('K4', '確認を通る短い引用が無ければ資料なしと元の理由を残す', async () => {
    const text = '制度の対象者と適用条件を説明しています。\n申告の手続を説明しています。\n参考の注意事項を説明しています。';
    for (const type of ['金額', '番号']) {
      const rows = await judge([claim('控除100万円、第21条です。', { type })], text, async () => [support('c1', { basis: '1-3' })]);
      assert.equal(rows[0].status, '資料なし'); assert.equal(rows[0].quote, '');
      assert.equal(rows[0].reject_reason, '数字の主張の根拠が2文を超える');
    }
  });
  await test('K4', '範囲外・非連続・5文・候補外の指定は救わない', async () => {
    const text = '控除は100万円です。\n制度の対象者を説明します。\n申告の条件を説明します。\n原文に基づき判断します。\n申告の手続を説明します。';
    for (const extra of [{ basis: '1-5' }, { basis: '0-3' }, { basis: '1-99' }, { basis: [1, 3, 4] }, { basis: '1-3', evidence_id: 2 }]) {
      const rows = await judge([claim('控除は100万円です。')], text, async () => [support('c1', extra)]);
      assert.equal(rows[0].status, '資料なし'); assert.ok(rows[0].reject_reason);
    }
  });
  await test('K4', 'M1の日付ひとかたまりとM2の前後300字を超えて数字を拾わない', async () => {
    const wrongDate = '令和9年3月31日までです。';
    const dateText = '令和8年3月31日までです。\n令和9年4月1日以後です。\n申告の手続を説明しています。';
    const dateRows = await judge([claim(wrongDate, { type: '期限' })], dateText, async () => [support('c1', { basis: '1-3' })]);
    assert.equal(dateRows[0].status, '資料なし');
    const farText = '制度の対象者と適用条件を説明しています。\n' + '空'.repeat(301) + '\n' + '白'.repeat(301) + '\n' + '地'.repeat(301) + '\n控除は100万円です。';
    const farRows = await judge([claim('控除は100万円です。')], farText, async () => [support('c1', { basis: '1-3' })]);
    assert.equal(farRows[0].status, '資料なし'); assert.equal(farRows[0].reject_reason, '数字の主張の根拠が2文を超える');
  });
  await test('K4', '半分以上の不正な答えは修正へ進まず照合不能で止める', async () => {
    const claims = [100, 200, 300, 400].map((n, i) => claim(`控除は${n}万円です。`, { id: `c${i + 1}` }));
    const body = claims.map(c => c.sentence).join('\n');
    const result = await F.checkFacts(body, options({ searchEvidence: () => [ref(body)], callLLM: async req => {
      if (req.task === 'extract') return extracted(req, claims);
      assert.equal(req.task, 'judge');
      return JSON.parse(req.user).claims.map(c => support(c.id, { basis: c.id === 'c4' ? '4' : '99' }));
    } }));
    assert.equal(result.record.status, 'not_run'); assert.match(result.record.error, /確認を通りません/);
    assert.equal(result.body, body); assert.deepEqual(result.record.corrections, []);
    assert.ok(!result.record.calls.some(c => c.task === 'repair'));
  });

  await test('K5', '文だけを令和6年分から令和7年分の節へ移すと再判定し承認を止める', async () => {
    const unrelated = claim('消費税の申告を行います。', { id: 'c2', type: '手続', subject: '消費税' });
    const beforeMove = `## 令和6年分\n${first.sentence}\n## 令和7年分\n制度の案内です。\n## 消費税\n${unrelated.sentence}`;
    const afterMove = `## 令和6年分\n## 令和7年分\n制度の案内です。\n${first.sentence}\n## 消費税\n${unrelated.sentence}`;
    await regenerate(beforeMove, afterMove, [first, unrelated], (result, calls) => {
      assert.equal(result.record.incremental.rejudged, 1); assert.equal(result.record.incremental.reused, 1);
      assert.equal(calls.filter(c => c.task === 'extract').length, 0);
      assert.equal(result.record.claims[0].heading, '令和7年分'); assert.equal(result.record.claims[0].status, '食い違い');
      assert.equal(result.record.claims[1].evidence_id, 'old');
      assert.equal(result.record.status, 'revise'); assert.equal(matter(result.content).data.recommendation, 'revise');
    }, { searchEvidence: () => [ref('令和7年分の基礎控除は58万円です。')], callLLM: async req => {
      assert.equal(req.task, 'judge'); assert.equal(JSON.parse(req.user).claims.length, 1);
      return [support('c1', { status: '食い違い', correct: '基礎控除は58万円です。' })];
    } });
  });
  await test('K5', '同じ見出しの節の中で移動した文は使い回す', async () => {
    await regenerate(`## 令和6年分\n${first.sentence}\n案内です。`, `## 令和6年分\n案内です。\n${first.sentence}`, [first], (result, calls) => {
      assert.equal(result.record.incremental.rejudged, 0); assert.equal(result.record.incremental.reused, 1);
      assert.equal(calls.length, 0); assert.equal(result.record.status, 'ok');
    });
  });
  await test('K5', '重複する文が別の見出しにも現れるなら再判定側に倒す', async () => {
    await regenerate(`## 令和6年分\n${first.sentence}\n## 令和7年分`, `## 令和6年分\n${first.sentence}\n## 令和7年分\n${first.sentence}`, [first], result => {
      assert.equal(result.record.incremental.rejudged, 1); assert.equal(result.record.incremental.reused, 0);
    });
  });
  for (const [group, counts] of Object.entries(groups)) console.log(`${group}: PASS ${counts.pass} / FAIL ${counts.fail}`);
  process.exitCode = Object.values(groups).some(c => c.fail) ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
