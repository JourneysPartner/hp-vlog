'use strict';

// 03j の回帰確認。資料は合成し、LLM と外部通信は使わない。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../fact-check');
const U = require('../fact-units');
const page = require('../../../netlify/functions/review-page');
const groups = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`J${i + 1}`, { pass: 0, fail: 0 }]));
const now = new Date('2026-10-14T00:00:00Z');
const ref = text => ({ id: 'e1', title: '制度の原文', text, url: 'https://example.jp/source', law_version: '' });
const claim = (sentence, extra = {}) => ({ id: 'c1', sentence, heading: '制度', type: '金額', subject: '配偶者控除', claim: sentence, ...extra });
const options = extra => ({ now, loadEvidenceText: r => r.text, ...extra });
const support = (id, extra = {}) => ({ id, status: '裏付けあり', evidence_id: 1, basis: '1', correct: '', ...extra });
async function test(group, name, fn) {
  try { await fn(); groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (error) { groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
}
async function judge(claims, text, fake) {
  return F.judgeClaims(claims, Object.fromEntries(claims.map(c => [c.id, [ref(text)]])), claims.map(c => c.sentence).join('\n'), fake, options());
}
async function incremental(before, after, claims, inspect, mutate = r => r) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-03j-'));
  const raw = body => `---\nslug: review-fixes-4\nrecommendation: publish\n---\n${body}`;
  const calls = [];
  const text = claims.map(c => c.sentence).join('\n');
  const fake = async req => {
    calls.push(req);
    if (req.task === 'extract') {
      assert.ok(req.user.trim(), '空の本文をAPIへ送らない');
      return claims.flatMap(c => {
        const unit = [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)].find(m => m[2] === c.sentence);
        return unit ? [{ s: Number(unit[1]), type: c.type, subject: c.subject, claim: c.claim }] : [];
      });
    }
    return JSON.parse(req.user).claims.map(c => support(c.id));
  };
  try {
    const initial = await F.checkArticle(raw(before), options({ recordDir: dir, repair: false, searchEvidence: () => [ref(text)], callLLM: fake }));
    assert.equal(initial.record.status, 'ok');
    fs.writeFileSync(initial.recordFile, JSON.stringify(mutate(F.compactRecord(initial.record))) + '\n', 'utf8');
    calls.length = 0;
    const result = await F.checkArticle(raw(after), options({ recordDir: dir, persist: false, previousRaw: raw(before), repair: false,
      searchEvidence: () => [ref(text)], callLLM: fake }));
    await inspect(result.record, calls, initial.record);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  await test('J1', '配偶者控除の金額と誤った第21条の5を別々に判定する', async () => {
    const sentence = '贈与税の配偶者控除（相続税法第21条の5）では最高2,000万円まで控除できます。';
    const text = '贈与税の配偶者控除（相続税法第21条の6）では最高2,000万円まで控除できます。';
    const claims = [claim(sentence, { claim: '最高2,000万円' }), claim(sentence, { id: 'c2', type: '番号', claim: '相続税法第21条の5' })];
    const rows = await judge(claims, text, async req => {
      const sent = JSON.parse(req.user).claims;
      assert.equal(sent.length, 2);
      return sent.map(c => support(c.id, c.type === '番号' ? { status: '食い違い', correct: '相続税法第21条の6' } : {}));
    });
    assert.deepEqual(rows.map(c => c.status), ['裏付けあり', '食い違い']);
  });
  await test('J1', '同じ文・別の文とも代表にせず、要約の数字が同じでも全部判定する', async () => {
    const claims = [claim('控除100万円、限度200万円です。', { claim: '控除100万円' }),
      claim('控除100万円、限度200万円です。', { id: 'c2', claim: '控除100万円' }),
      claim('この控除は百万円です。', { id: 'c3', claim: '控除百万円' })];
    const rows = await judge(claims, '控除100万円、限度200万円です。', async req => {
      assert.deepEqual(JSON.parse(req.user).claims.map(c => c.id), ['c1', 'c2', 'c3']);
      return [support('c1'), support('c2'), support('c3')];
    });
    assert.equal(rows.length, 3); assert.equal(rows[2].status, '裏付けあり');
  });
  await test('J1', '要約の数字が異なれば同じ文の数字の集合でも別判定', async () => {
    const claims = [claim('控除100万円、限度200万円です。', { claim: '控除100万円' }),
      claim('限度200万円、控除100万円です。', { id: 'c2', claim: '限度200万円' })];
    await judge(claims, claims[0].sentence, async req => {
      assert.equal(JSON.parse(req.user).claims.length, 2); return [support('c1'), support('c2')];
    });
  });
  await test('J1', '番号の主張は最初から全部送り、それぞれの食い違いを記録する', async () => {
    const claims = [claim('根拠は第21条の5です。', { type: '番号', claim: '第21条の5' }),
      claim('この制度は第21条の5に規定されています。', { id: 'c2', type: '番号', claim: '第21条の5' })];
    const calls = [];
    const rows = await judge(claims, 'この制度は相続税法第21条の6に規定されています。', async req => {
      calls.push(req); return JSON.parse(req.user).claims.map(c => support(c.id, { status: '食い違い', correct: '第21条の6' }));
    });
    assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].user).claims.length, 2);
    assert.deepEqual(rows.map(c => c.status), ['食い違い', '食い違い']);
  });
  await test('J1', '番号の数字が同じでも2件目の資料なしを代表の結果で上書きしない', async () => {
    const claims = [claim('第21条の5が根拠です。', { type: '番号' }), claim('根拠を第21条の5としています。', { id: 'c2', type: '番号' })];
    let calls = 0;
    const rows = await judge(claims, 'この制度について原文の対象と条件を説明しています。\n' + '空'.repeat(301) + '第21条の5', async req => {
      calls++; return JSON.parse(req.user).claims.map(c => support(c.id, c.id === 'c2' ? { status: '資料なし' } : {}));
    });
    assert.equal(calls, 1); assert.equal(rows[1].status, '資料なし');
  });
  await test('J2', '期限の書き漏れと同じ数字の主張も最初から1回に送る', async () => {
    const claims = [claim('控除は100万円です。'), claim('上限の控除額は100万円です。', { id: 'c2' })];
    const calls = [];
    const rows = await judge(claims, '控除は100万円、令和9年3月31日まで適用します。', async req => {
      calls.push(req); return JSON.parse(req.user).claims.map(c => support(c.id, c.id === 'c1'
        ? { status: '期限の書き漏れ', correct: '令和9年3月31日まで' } : {}));
    });
    assert.equal(rows.length, 2); assert.equal(rows[1].status, '裏付けあり');
    assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0].user).claims.length, 2);
  });
  await test('J2', '2件目以降の期限も資料なしと理由を残し全主張を記録する', async () => {
    const claims = [claim('控除は100万円です。'), claim('別の控除は200万円です。', { id: 'c2' }), claim('別枠の控除額は200万円です。', { id: 'c3' })];
    const rows = await judge(claims, '控除は100万円と200万円で、令和9年3月31日までです。', async req => JSON.parse(req.user).claims.map(c =>
      support(c.id, { status: '期限の書き漏れ', correct: '令和9年3月31日まで' })));
    assert.deepEqual(rows.map(c => c.id), ['c1', 'c2', 'c3']); assert.ok(rows.slice(1).every(c => c.status === '資料なし'));
    assert.ok(rows[1].reject_reason); assert.equal(rows[1].type, '金額');
  });
  await test('J2', '個別の答えが無くても資料なしと理由を残し数字なら止める', async () => {
    const claims = [claim('控除は100万円です。'), claim('上限は100万円です。', { id: 'c2' })];
    let calls = 0;
    const rows = await judge(claims, '控除は100万円、令和9年3月31日までです。', async () => ++calls === 1
      ? [support('c1', { status: '期限の書き漏れ', correct: '令和9年3月31日まで' })] : []);
    assert.equal(rows[1].reject_reason, '答えが無い');
    calls = 0;
    const body = claims.map(c => c.sentence).join('\n');
    const result = await F.checkFacts(body, options({ repair: false, searchEvidence: () => [ref('控除は100万円、令和9年3月31日までです。')],
      callLLM: async req => req.task === 'extract' ? claims.map((c, i) => ({ s: i + 1, type: c.type, subject: c.subject, claim: c.claim }))
        : ++calls === 1 ? [support('c1', { status: '期限の書き漏れ', correct: '令和9年3月31日まで' })] : [] }));
    assert.equal(result.record.status, 'revise'); assert.ok(result.record.remaining.some(c => c.id === 'c2' && c.status === '資料なし'));
  });
  await test('J3', '空白だけの抜き出し・全削除はAPIを呼ばない', async () => {
    assert.equal((await F.extractClaims(' \n', () => { throw new Error('呼んではいけない'); })).claims.length, 0);
    const before = '控除は100万円です。';
    const result = await F.checkFacts('', options({ previousBody: before, previousClaims: [claim(before)], repair: false,
      callLLM: () => { throw new Error('呼んではいけない'); } }));
    assert.equal(result.record.status, 'ok'); assert.equal(result.record.calls.length, 0);
  });
  await test('J3', '削除だけの差し戻しは抜き出さず残る同制度を判定', async () => {
    const a = claim('配偶者控除の条件を満たします。', { type: '要件' });
    const b = claim('配偶者控除の申告を行います。', { id: 'c2', type: '手続' });
    await incremental(`${a.sentence}\n${b.sentence}`, b.sentence, [a, b], (record, calls) => {
      assert.equal(calls.filter(c => c.task === 'extract').length, 0);
      assert.equal(calls.filter(c => c.task === 'judge').length, 1); assert.equal(record.claims.length, 1);
    });
  });
  await test('J3', '修正文が変わらず差分が空なら再抜き出しを呼ばない', async () => {
    const body = '控除は100万円です。';
    const result = await F.checkFacts(body, options({ searchEvidence: () => [ref(body)], callLLM: async req => {
      if (req.task === 'extract') return [{ s: 1, type: '金額', subject: '配偶者控除', claim: body }];
      if (req.task === 'repair') return [{ id: 'c1', replacement: body }];
      return [support('c1', { status: '資料なし' })];
    } }));
    assert.equal(result.record.status, 'revise'); assert.deepEqual(result.record.calls.map(c => c.task), ['extract', 'judge', 'repair']);
  });
  await test('J4', '完全一致の文だけを直し、別文の対象外ですには触らない', async () => {
    const body = '対象外です。\n配偶者は贈与税の対象外です。\n対象外です。';
    const finding = { ...claim('対象外です。', { type: '要件' }), status: '食い違い', correct: '対象です。' };
    const result = await F.repairBody(body, [finding], async () => [{ id: 'c1', replacement: '対象です。' }]);
    assert.equal(result.body, '対象です。\n配偶者は贈与税の対象外です。\n対象です。');
    assert.equal(F.preservesOtherText(body, body.replaceAll('対象外です。', '対象です。'), [finding]), false);
  });
  await test('J4', '文の一部しか一致しない修正は採らない', async () => {
    const body = '配偶者は贈与税の対象外です。';
    const result = await F.repairBody(body, [claim('対象外です。')], async () => [{ id: 'c1', replacement: '対象です。' }]);
    assert.equal(result.body, body); assert.ok(result.rejected.has('c1'));
  });
  await test('J5', '見出しの年だけの変更でも文を再判定し新しい見出しを記録', async () => {
    const c = claim('基礎控除は48万円です。', { subject: '基礎控除', heading: '令和6年分の基礎控除' });
    await incremental(`## ${c.heading}\n${c.sentence}`, `## 令和7年分の基礎控除\n${c.sentence}`, [c], record => {
      assert.equal(record.incremental.rejudged, 1); assert.equal(record.incremental.reused, 0);
      assert.equal(record.claims[0].heading, '令和7年分の基礎控除');
    });
  });
  await test('J5', '表の見出し行だけの変更でも節内の主張を再判定', async () => {
    const c = claim('| 基礎控除の上限金額 | 48万円 |', { subject: '基礎控除' });
    const before = `## 制度\n| 項目 | 令和6年分 |\n| --- | --- |\n${c.sentence}`;
    await incremental(before, before.replace('令和6年分', '令和7年分'), [c], record => assert.equal(record.incremental.reused, 0));
  });
  await test('J5', '親見出しの変更は子の節も再判定する', async () => {
    const c = claim('基礎控除は48万円です。', { subject: '基礎控除' });
    const before = `## 令和6年分\n### 基礎控除\n${c.sentence}`;
    await incremental(before, before.replace('令和6年分', '令和7年分'), [c], record => assert.equal(record.incremental.reused, 0));
  });
  await test('J5', '制度名の語が重なれば別の節の残る主張も再判定', async () => {
    const a = claim('配偶者控除の申告を行います。', { type: '手続', subject: '贈与税の配偶者控除' });
    const b = claim('配偶者控除の条件を満たします。', { id: 'c2', type: '要件', subject: '配偶者控除の特例' });
    const before = `## 申告\n${a.sentence}\n## 条件\n${b.sentence}`;
    await incremental(before, before.replace(a.sentence, ''), [a, b], record => assert.equal(record.incremental.reused, 0));
  });
  for (const deadline of ['令和9年3月31日が期限です。', '適用期間までの間に申告します。', '改正以後は申告します。']) {
    await test('J5', `抜き出されなかった期限の削除で節と同制度を再判定: ${deadline}`, async () => {
      const a = claim('配偶者控除の条件を満たします。', { type: '要件' });
      const b = claim('控除の申告を行います。', { id: 'c2', type: '手続' });
      const before = `## 条件\n${a.sentence}\n${deadline}\n## 申告\n${b.sentence}`;
      await incremental(before, before.replace(deadline, ''), [a, b], (record, calls) => {
        assert.equal(record.incremental.reused, 0); assert.equal(record.incremental.rejudged, 2);
        assert.equal(calls.filter(c => c.task === 'extract').length, 0);
      });
    });
  }
  await test('J5', '無関係の節は使い回し、差分照合の版を記録する', async () => {
    const a = claim('配偶者控除の条件を満たします。', { type: '要件' });
    const b = claim('消費税の申告を行います。', { id: 'c2', type: '手続', subject: '消費税' });
    const before = `## 贈与\n${a.sentence}\n## 消費税\n${b.sentence}`;
    await incremental(before, before.replace(a.sentence, ''), [a, b], record => {
      assert.equal(record.logic_version, 'plan2-s2'); assert.equal(record.incremental.reused, 1);
    });
  });
  await test('J5', '主張に抜かれない期限の変更でも節と同制度を再判定する', async () => {
    const a = claim('配偶者控除の条件を満たします。', { type: '要件' });
    const b = claim('配偶者控除の申告を行います。', { id: 'c2', type: '手続' });
    const before = `## 条件\n${a.sentence}\n令和8年3月31日までです。\n## 申告\n${b.sentence}`;
    await incremental(before, before.replace('令和8年', '令和9年'), [a, b], record => {
      assert.equal(record.incremental.reused, 0); assert.equal(record.incremental.rejudged, 2);
    });
  });
  for (const [name, mutate] of [['版なし', r => { delete r.logic_version; return r; }], ['別の版', r => ({ ...r, logic_version: '03i' })],
    ['差分照合の記録', r => ({ ...r, incremental: { reused: 1, rejudged: 0, subjects: [] } })], ['不正な差分記録', r => ({ ...r, incremental: null })]]) {
    await test('J5', `${name}は全体照合へ戻す`, async () => {
      const a = claim('配偶者控除の条件を満たします。', { type: '要件' });
      const b = claim('消費税の申告を行います。', { id: 'c2', type: '手続', subject: '消費税' });
      await incremental(`${a.sentence}\n${b.sentence}`, b.sentence, [a, b], (record, calls) => {
        assert.equal(record.incremental, undefined); assert.ok(calls.some(c => c.task === 'extract'));
      }, mutate);
    });
  }
  for (const type of ['金額', '期限', '割合', '適用年', '番号']) await test('J6', `${type}の根拠3〜4文も確認を通る2文以内に絞って救う`, async () => {
    const text = '控除100万円、令和9年3月31日まで、割合10%、第21条です。\n制度の適用要件を説明しています。\n申告の手続を説明しています。\n参考の注意事項を説明しています。';
    for (const basis of ['1-2', '1-3', [1, 2, 3, 4]]) {
      const rows = await judge([claim(text.split('\n')[0], { type })], text, async () => [support('c1', { basis })]);
      assert.equal(rows[0].status, '裏付けあり');
      if (basis !== '1-2') { assert.equal(rows[0].quote, text.split('\n')[0]); assert.equal(rows[0].reject_reason, undefined); }
    }
  });
  await test('J6', '要件・判定・手続の根拠は4文まで維持する', async () => {
    const text = 'この制度は適用の対象です。申告の条件を確認します。原文に基づき判定します。申告の手続を説明します。';
    const claims = ['要件', '判定', '手続'].map((type, i) => claim(text, { id: `c${i + 1}`, type }));
    const rows = await judge(claims, text, async req => JSON.parse(req.user).claims.map(c => support(c.id, { basis: '1-4' })));
    assert.ok(rows.every(c => c.status === '裏付けあり'));
  });
  await test('J7', '指示文の末尾に指定の例を1行だけ追加', async () => {
    await judge([claim('控除は100万円です。')], '控除は100万円です。', async req => {
      const instruction = req.system.split('\n\n[資料 ')[0];
      assert.equal(instruction.split('\n').length, 2);
      assert.equal(instruction.split('\n').at(-1), '例: [{"id":"c1","status":"裏付けあり","evidence_id":3,"basis":"12-13"}]');
      return [support('c1')];
    });
  });
  await test('J8', '出力の切断は3段まで分割し同じ固定部分を使う', async () => {
    const claims = Array.from({ length: 8 }, (_, i) => claim(`控除額は${i + 1}万円です。`, { id: `c${i + 1}` }));
    const calls = [];
    const rows = await judge(claims, '原文に制度の適用要件と申告手続を記載しています。', async req => {
      calls.push(req); const cs = JSON.parse(req.user).claims;
      return cs.length > 1 ? { text: '[]', stopReason: 'max_tokens' } : cs.map(c => support(c.id, { status: '資料なし' }));
    });
    assert.equal(calls.length, 15); assert.equal(rows.length, 8);
    assert.equal(new Set(calls.map(c => c.staticSystem)).size, 1);
  });
  await test('J8', '3段目も壊れたら照合不能で部分結果を通さない', async () => {
    const claims = Array.from({ length: 16 }, (_, i) => claim(`控除額は${i + 1}万円です。`, { id: `c${i + 1}` }));
    let calls = 0;
    await assert.rejects(judge(claims, '制度の適用要件と申告手続を記載しています。', async () => { calls++; return '['; }), SyntaxError);
    assert.equal(calls, 15);
  });
  await test('J8', '修正の出力上限は8000', async () => {
    await F.repairBody('控除は100万円です。', [claim('控除は100万円です。')], async req => {
      assert.equal(req.maxTokens, 8000); return [{ id: 'c1', replacement: '控除は200万円です。' }];
    });
  });
  await test('J9', '10万バイト超の原文を展開し、承認画面は引用の前後だけ表示', () => {
    const quote = '配偶者控除の上限は2,000万円です。';
    const text = '先頭専用の文字列' + 'あ'.repeat(40000) + quote.replace('2,000', '２，０００') + 'い'.repeat(40000) + '末尾専用の文字列';
    const item = { ...claim(quote), status: '食い違い', correct: quote, quote, evidence_id: 'e1', evidence: [ref(text)], resolved: false };
    const record = F.compactRecord({ version: 1, status: 'revise', corrections: [item], remaining: [], review_items: [] });
    assert.equal(F.evidenceRefs(record, record.corrections[0])[0].text, text);
    const html = page.renderFactCheck({}, record);
    assert.ok(html.includes('２，０００')); assert.ok(!html.includes('先頭専用の文字列')); assert.ok(!html.includes('末尾専用の文字列'));
    const block = html.match(/<blockquote>([\s\S]*?)<\/blockquote>/)[1];
    assert.ok(block.length <= 2000); assert.ok(block.length <= quote.length + 600);
  });
  await test('J9', '引用のない候補は所在を表示し、全文を並べない', () => {
    const item = { ...claim('条件を確認します。', { type: '要件' }), evidence: [ref('画面に並べてはいけない原文全文')], status: '資料なし' };
    const html = page.renderFactCheck({}, { status: 'ok', review_items: [item] });
    assert.ok(html.includes('制度の原文')); assert.ok(!html.includes('画面に並べてはいけない原文全文'));
  });
  await test('J10', '句点を含む表は1行の文にし原文位置と列数の検査を保つ', async () => {
    const row = '| 控除。条件。 | 100万円です。 |';
    const body = `## 制度\n${row}\n次の案内です。`;
    const units = U.splitUnits(body);
    assert.equal(units.length, 3); assert.equal(units[1].text, row);
    assert.equal(body.slice(units[1].start, units[1].end), row);
    const result = await F.repairBody(body, [claim(row)], async () => [{ id: 'c1', replacement: '| 控除は200万円です。 |' }]);
    assert.equal(result.body, body); assert.equal(result.rejected.get('c1'), '表の列数が変わっています');
    assert.ok(U.splitUnits('| ' + '長'.repeat(700) + '。 |', { material: true }).every(u => u.text.length <= 300));
  });
  await test('J11', '本文番号にない旧形式の文はsentenceを渡す', async () => {
    const sentence = '控除は100万円です。';
    await F.judgeClaims([claim(sentence)], { c1: [ref(sentence)] }, '控除（は100万円です。次の文。', async req => {
      const c = JSON.parse(req.user).claims[0]; assert.equal(c.s, undefined); assert.equal(c.sentence, sentence); return [support('c1')];
    }, options());
  });
  await test('J11', '本文番号にある文はsだけを渡し文を書き写さない', async () => {
    await judge([claim('控除は100万円です。')], '控除は100万円です。', async req => {
      const c = JSON.parse(req.user).claims[0]; assert.equal(c.s, 1); assert.equal(c.sentence, undefined); return [support('c1')];
    });
  });
  await test('J12', '見出しを指した数字の主張を近くの数字をすべて含む文へ付け替える', async () => {
    const result = await F.extractClaims('## 配偶者控除100万円\n配偶者控除は100万円です。', async () => [{ s: 1, type: '金額', subject: '配偶者控除', claim: '100万円' }]);
    assert.equal(result.discarded, 0); assert.equal(result.claims[0].s, 2);
    const ambiguous = await F.extractClaims('## 控除100万円\n控除100万円です。控除100万円です。', async () => [{ s: 1, type: '金額', subject: '控除', claim: '100万円' }]);
    assert.equal(ambiguous.discarded, 1);
  });
  await test('J12', '数字のない見出しの主張を語が最も重なる本文へ付け替える', async () => {
    const result = await F.extractClaims('## 配偶者控除\n案内です。\n配偶者控除の申告条件を確認します。', async () => [{ s: 1, type: '要件', subject: '配偶者控除', claim: '申告条件を確認' }]);
    assert.equal(result.claims[0].s, 3);
  });
  await test('J12', '要約の語の重なりが0なら付け替え、制度名だけの一致では維持しない', async () => {
    const result = await F.extractClaims('制度の案内です。\n制度の配偶者控除の申告条件を確認します。', async () => [{ s: 1, type: '要件', subject: '制度', claim: '配偶者控除の申告条件を確認' }]);
    assert.equal(result.claims[0].s, 2);
    const retained = await F.extractClaims('alphaを案内します。betaを案内します。', async () => [{ s: 1, type: '要件', subject: 'alpha', claim: 'beta' }]);
    assert.equal(retained.claims[0].s, 2);
  });
  await test('J2', '多くの答えが不正なら修正せず照合不能とreject_reasonを維持', async () => {
    const body = '控除は100万円です。控除は200万円です。控除は300万円です。';
    const result = await F.checkFacts(body, options({ searchEvidence: () => [ref(body)], callLLM: async req => req.task === 'extract'
      ? [1, 2, 3].map(s => ({ s, type: '金額', subject: '配偶者控除', claim: `控除は${s * 100}万円` }))
      : JSON.parse(req.user).claims.map(c => support(c.id, { basis: '99' })) }));
    assert.equal(result.record.status, 'not_run'); assert.equal(result.body, body); assert.match(result.record.error, /確認を通りません/);
    assert.ok(!result.record.calls.some(c => c.task === 'repair'));
  });
  for (const [group, count] of Object.entries(groups)) console.log(`${group}: PASS ${count.pass} / FAIL ${count.fail}`);
  process.exitCode = Object.values(groups).some(c => c.fail) ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
