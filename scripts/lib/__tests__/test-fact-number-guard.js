'use strict';

// 03g の回帰確認。判定の LLM はすべて偽の関数に置き換える。
const assert = require('assert/strict');
const F = require('../fact-check');
const groups = { M1: { pass: 0, fail: 0 }, M2: { pass: 0, fail: 0 } };
const now = new Date('2026-10-12T00:00:00Z');
const ref = (text, extra = {}) => ({ id: '資料1', title: '制度の原文', url: 'https://example.jp/制度', law_version: '', text, ...extra });
async function test(group, name, fn) {
  try { await fn(); groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (error) { groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
}
async function judge(sentence, text, quote, options = {}) {
  const c = { id: 'c1', sentence, claim: options.claim ?? sentence, type: options.type || '期限', subject: '制度', heading: '制度' };
  const rows = await F.judgeClaims([c], { c1: options.refs || [ref(text)] }, sentence, async request => {
    assert.equal(request.task, 'judge');
    return [{ id: c.id, status: options.status || '裏付けあり', quote, correct: options.correct || '', evidence_id: '資料1' }];
  }, { now });
  if (rows[0].status === '資料なし') {
    assert.equal(rows[0].quote, ''); assert.equal(rows[0].correct, ''); assert.equal(rows[0].evidence_id, '');
  }
  return rows[0].status;
}

async function main() {
  await test('M1', '和暦の漢数字とアラビア数字は同じ一つの日付', () => {
    assert.deepEqual(F.normalizedNumbers('令和九年三月三十一日'), ['日付:令和9-3-31']);
    assert.deepEqual(F.normalizedNumbers('令和9年3月31日'), ['日付:令和9-3-31']);
  });
  await test('M1', '和暦の漢数字とアラビア数字の期限を裏付けありにする', async () => {
    const quote = 'この制度は令和9年3月31日までの申請が対象です。';
    assert.equal(await judge('この制度は令和九年三月三十一日までです。', quote, quote), '裏付けあり');
  });
  await test('M1', '令和8年と令和9年の期限は資料なし', async () => {
    const quote = 'この制度は令和9年3月31日までの申請が対象です。';
    assert.equal(await judge('この制度は令和8年3月31日までです。', quote, quote), '資料なし');
  });
  await test('M1', '基準日の年と別の期限の月日を組み合わせない', async () => {
    const quote = 'この制度は令和9年3月31日までの申請が対象です。';
    const text = `令和8年4月1日現在法令等\n${quote}`;
    assert.deepEqual(F.normalizedNumbers(text), ['日付:令和8-4-1', '日付:令和9-3-31']);
    assert.equal(await judge('この制度は令和8年3月31日までです。', text, quote), '資料なし');
  });
  for (const [sentence, quote] of [
    ['この制度は2027年3月31日までです。', 'この制度は令和9年3月31日までの申請が対象です。'],
    ['この制度は令和9年3月31日までです。', 'この制度は2027年3月31日までの申請が対象です。'],
  ]) await test('M1', `和暦と西暦を換算しない: ${sentence}`, async () => {
    assert.equal(await judge(sentence, quote, quote), '資料なし');
  });
  for (const [text, expected] of [
    ['令和元年 平成元年 昭和元年 大正元年 明治元年', ['日付:令和1', '日付:平成1', '日付:昭和1', '日付:大正1', '日付:明治1']],
    ['令和九年 令和九年三月 令和九年三月三十一日', ['日付:令和9', '日付:令和9-3', '日付:令和9-3-31']],
    ['2027年 2027年3月 2027年3月31日', ['日付:2027', '日付:2027-3', '日付:2027-3-31']],
    ['3月31日 翌年三月十五日', ['日付:-3-31', '日付:-3-15']],
    ['令和９年３月３１日 ２０２７年３月３１日', ['日付:令和9-3-31', '日付:2027-3-31']],
    ['上限110万円、令和9年3月31日まで、税率10%、3年、18歳、二件、六ヶ月、2027年間', ['1100000', '日付:令和9-3-31', '割合:1/10', '3', '18', '2', '6', '2027']],
  ]) await test('M1', `日付と日付以外の読み取り: ${text}`, () => {
    assert.deepEqual(F.normalizedNumbers(text), expected);
  });
  await test('M1', '年の無い月日の漢数字とアラビア数字は一致する', async () => {
    const quote = 'この制度は翌年三月十五日までの申請が対象です。';
    assert.equal(await judge('この制度は翌年3月15日までです。', quote, quote), '裏付けあり');
  });
  await test('M1', '日付の一部を年数として使わない', async () => {
    const quote = 'この制度は令和9年3月31日までの申請が対象です。';
    assert.equal(await judge('この制度の適用期間は9年です。', quote, quote, { type: '適用年' }), '資料なし');
  });
  await test('M1', '日付の粒度と元号の違いは資料なし', async () => {
    const quote = 'この制度は令和9年3月31日までの申請が対象です。';
    for (const date of ['令和9年', '令和9年3月', '3月31日', '平成9年3月31日']) {
      assert.equal(await judge(`この制度は${date}までです。`, quote, quote), '資料なし');
    }
  });
  await test('M1', 'H1の要約と本文の数字の一致を保つ', async () => {
    const quote = 'この制度は令和9年3月31日までの申請が対象です。';
    assert.equal(await judge('この制度は令和8年3月31日までです。', quote, quote, { claim: '期限は令和9年3月31日です。' }), '資料なし');
    assert.equal(await judge('この制度は令和九年三月三十一日までです。', quote, quote, { claim: '期限のある制度です。' }), '裏付けあり');
  });
  await test('M1', 'G3の一般・一定と万・億、H2の割合を保つ', () => {
    assert.deepEqual(F.normalizedNumbers('一般の一定の要件'), []);
    assert.deepEqual(F.normalizedNumbers('110万円 百十万円 1億2,500万円 一億二千五百万円'), ['1100000', '1100000', '125000000', '125000000']);
    assert.deepEqual(F.normalizedNumbers('50% 二分の一'), ['割合:1/2', '割合:1/2']);
    assert.deepEqual(F.normalizedNumbers('0分の1'), [null]);
    assert.deepEqual(F.normalizedNumbers('3分の2027年'), ['割合:2027/3']);
    assert.deepEqual(F.normalizedNumbers('3分の令和9年3月31日'), [null]);
    assert.deepEqual(F.normalizedNumbers('令和元年間'), ['1']);
  });

  const sentence = '非課税枠は1,000万円（うち結婚費用300万円）です。';
  const quote = '結婚・子育て資金の非課税枠は1,000万円です。';
  const other = '結婚費用については300万円までです。';
  await test('M2', '隣り合う文の1,000万円と300万円は裏付けあり', async () => {
    assert.equal(await judge(sentence, `${quote}\n${other}`, quote, { type: '金額' }), '裏付けあり');
    assert.equal(await judge(sentence, `${other}\n${quote}`, quote, { type: '金額' }), '裏付けあり');
  });
  await test('M2', '引用から300文字より離れた数字は資料なし', async () => {
    assert.equal(await judge(sentence, `${quote}${'あ'.repeat(301)}${other}`, quote, { type: '金額' }), '資料なし');
    assert.equal(await judge(sentence, `${other}${'あ'.repeat(301)}${quote}`, quote, { type: '金額' }), '資料なし');
  });
  const plainQuote = 'この制度の対象と申請手続について説明します。';
  const amount = '300万円';
  for (const before of [false, true]) for (const distance of [300, 301]) {
    await test('M2', `引用の${before ? '前' : '後'}${distance}文字の境界で完全な数字だけを使う`, async () => {
      const adjacent = before ? amount + 'あ'.repeat(distance - amount.length) : 'あ'.repeat(distance - amount.length) + amount;
      const text = before ? adjacent + plainQuote : plainQuote + adjacent;
      assert.equal(await judge('上限は300万円です。', text, plainQuote, { type: '金額' }), distance === 300 ? '裏付けあり' : '資料なし');
    });
  }
  await test('M2', '空白も原文の300文字に数える', async () => {
    assert.equal(await judge('上限は300万円です。', plainQuote + ' '.repeat(301) + amount, plainQuote, { type: '金額' }), '資料なし');
    assert.equal(await judge('上限は300万円です。', amount + '\n'.repeat(301) + plainQuote, plainQuote, { type: '金額' }), '資料なし');
  });
  await test('M2', '引用内の空白と全角数字を従来どおり揃える', async () => {
    const text = quote.replace('1,000', '１，０００').replace('資金', '資 金') + '\n' + other;
    assert.equal(await judge(sentence, text, quote, { type: '金額' }), '裏付けあり');
  });
  await test('M2', '半角の濁点を含む引用位置を原文へ戻す', async () => {
    const kanaQuote = 'ガイドではこの制度の申請手続について説明します。';
    const half = kanaQuote.replace('ガイド', 'ｶﾞｲﾄﾞ');
    assert.equal(await judge('上限は300万円です。', amount + 'あ'.repeat(300 - amount.length) + half, kanaQuote, { type: '金額' }), '裏付けあり');
    assert.equal(await judge('上限は300万円です。', half + ' '.repeat(301) + amount, kanaQuote, { type: '金額' }), '資料なし');
  });
  await test('M2', '範囲の端で切れた金額を小さい額に読み替えない', async () => {
    const text = '300万円' + 'あ'.repeat(299 - '00万円'.length) + plainQuote;
    assert.equal(await judge('上限は0万円です。', text, plainQuote, { type: '金額' }), '資料なし');
  });
  await test('M2', '範囲の端で切れた日付を年の無い月日に読み替えない', async () => {
    const text = '令和9年3月31日' + 'あ'.repeat(300 - '3月31日'.length) + plainQuote;
    assert.equal(await judge('期限は3月31日までです。', text, plainQuote), '資料なし');
  });
  await test('M2', '範囲の端で切れた百分率と分数の断片を使わない', async () => {
    assert.equal(await judge('割合は50%です。', plainQuote + 'あ'.repeat(298) + '50%', plainQuote, { type: '割合' }), '資料なし');
    assert.equal(await judge('上限は1円です。', '二分の1' + 'あ'.repeat(299) + plainQuote, plainQuote, { type: '金額' }), '資料なし');
  });
  await test('M2', '同じ資料でも離れた抜粋の数字を合算しない', async () => {
    const text = `${quote}\n${other}`;
    const refs = [ref(text, { text_ranges: [[0, quote.length], [quote.length + 1, text.length]] })];
    assert.equal(await judge(sentence, text, quote, { type: '金額', refs }), '資料なし');
  });
  await test('M2', '別の候補資料の数字を合算しない', async () => {
    const refs = [ref(quote), ref(other, { id: '資料2' })];
    assert.equal(await judge(sentence, quote, quote, { type: '金額', refs }), '資料なし');
  });
  await test('M2', '同じ引用の離れた出現位置の数字を合算しない', async () => {
    const text = `${quote}${'あ'.repeat(700)}${plainQuote}${other}`;
    const repeated = text.replace(quote, plainQuote + '1,000万円');
    assert.equal(await judge(sentence, repeated, plainQuote, { type: '金額' }), '資料なし');
    assert.equal(await judge(sentence, repeated + '1,000万円', plainQuote, { type: '金額' }), '裏付けあり');
  });
  for (const status of ['食い違い', '期限の書き漏れ']) await test('M2', `${status}のcorrectも引用の近くで照合する`, async () => {
    const options = { type: '金額', status, correct: sentence };
    assert.equal(await judge('非課税枠は900万円です。', `${quote}\n${other}`, quote, options), status);
    assert.equal(await judge('非課税枠は900万円です。', `${quote}${'あ'.repeat(301)}${other}`, quote, options), '資料なし');
  });
  await test('M2', '実在しない引用と15文字未満の断片は資料なし', async () => {
    for (const bad of ['原文に無い制度の申請手続について説明します。', '1,000万円']) {
      assert.equal(await judge(sentence, `${quote}\n${other}`, bad, { type: '金額' }), '資料なし');
    }
  });
  await test('M2', '短くても一文全体の引用は従来どおり使う', async () => {
    assert.equal(await judge(sentence, `対象です。\n${quote}\n${other}`, '対象です。', { type: '金額' }), '裏付けあり');
  });
  await test('M2', 'H1の要約だけの数字とH2の不正な割合は通さない', async () => {
    assert.equal(await judge('上限は300万円です。', quote, quote, { type: '金額', claim: '上限は1,000万円です。' }), '資料なし');
    assert.equal(await judge('割合は50%です。', plainQuote + ' 0分の1 50%', plainQuote, { type: '割合' }), '資料なし');
  });
  await test('M2', '引用範囲外の不正な割合も従来どおり照合不能で止める', async () => {
    assert.equal(await judge('割合は50%です。', plainQuote + '50%' + 'あ'.repeat(301) + '0分の1', plainQuote, { type: '割合' }), '資料なし');
  });
  for (const [group, counts] of Object.entries(groups)) console.log(`${group}: PASS ${counts.pass} / FAIL ${counts.fail}`);
  process.exitCode = Object.values(groups).some(counts => counts.fail) ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
