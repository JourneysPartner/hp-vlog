'use strict';

// C: 書いた後の本文で速算表の決まりを当てる試験。
const assert = require('assert/strict');
const { detectRulesFromBody, selectConditionalRuleEntries, CONDITIONAL_RULES } = require('../article-prompt-static');
const { postfixRules } = require('../body-patches');
const fixture = require('../../../docs/codex-tasks/fact-consistency/fixtures/pr796.json');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const keys = rules => rules.map(rule => rule.key);
const sentence = '課税所得が195万円を超えて330万円以下の人（税率10%）なら、所得20万円の増加で所得税は約2万円です（復興特別所得税を除く）。';

test('T19 本文の1文に金額と税率があれば検出する', () => {
  assert.ok(keys(detectRulesFromBody({ title: fixture.title }, sentence)).includes('income_tax_bracket'));
});

test('T28 相続税・贈与税や別の文では当たらない', () => {
  const no = body => !keys(detectRulesFromBody({ title: fixture.title }, body)).includes('income_tax_bracket');
  assert.ok(no('課税遺産総額が4,000万円の場合、相続税の税率は20%です。'));
  assert.ok(no('贈与額が900万円なら贈与税の税率は30%です。'));
  assert.ok(no('課税所得の考え方を説明します。売上が900万円の年もありました。'));
  assert.ok(!keys(detectRulesFromBody({ title: fixture.title, tax_domain: 'inheritance_tax' }, '課税所得が195万円を超えると税率が変わります。')).includes('income_tax_bracket'));
  assert.ok(keys(detectRulesFromBody({ title: fixture.title }, sentence)).includes('income_tax_bracket'));
});

test('T20 書く前の選び方には入れない', () => {
  assert.ok(!keys(selectConditionalRuleEntries({ title: fixture.title })).includes('income_tax_bracket'));
});

test('T21 金額だけ、税率だけの文では検出しない', () => {
  assert.ok(!keys(detectRulesFromBody({ title: fixture.title }, '売上が330万円を超えた。')).includes('income_tax_bracket'));
  assert.ok(!keys(detectRulesFromBody({ title: fixture.title }, '税率10%です。')).includes('income_tax_bracket'));
});

test('T22 決まりの文に文の中の書き方の例を足した', () => {
  const text = CONDITIONAL_RULES.income_tax_bracket.text;
  assert.ok(text.includes('195万円以上330万円未満'));
  assert.ok(text.includes('1,950,000円から3,299,000円まで'));
  assert.ok(text.includes('「195万円未満 → 5%」'));
});

test('T23 postfixRules の依頼に決まりと本文の文が入る', async () => {
  const requests = [];
  const result = await postfixRules(fixture.original_body, {
    topic: { title: fixture.title },
    generateSimple: async request => { requests.push(request); return { text: '{"replacements":[]}' }; },
  });
  assert.ok(requests.length, '部分修正の依頼がある');
  assert.equal(result.applied, false);
  assert.ok(requests[0].user.includes('195万円以上330万円未満'));
  assert.ok(requests[0].user.includes('文の中で書くときも同じ'));
  assert.ok(requests[0].user.includes('課税所得が195万円を超えて330万円以下'));
});

async function main() {
  let passed = 0, failed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
  }
  console.log(`速算表の決まり: PASS ${passed} / FAIL ${failed}`);
  if (failed) process.exitCode = 1;
}

main();
