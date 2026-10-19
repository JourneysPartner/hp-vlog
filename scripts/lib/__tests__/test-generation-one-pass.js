'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../article-prompt-static');
const P = require('../body-patches');
const CM = require('../content-model');
const G = require('../../generate-draft');
const { buildCandidateBlock } = require('../ai-dedup');
const { buildGenerationPrompt } = require('../article-prompt-builder');
const { checkBodyLength } = require('../article-length');
const results = {};
async function test(group, name, fn) {
  const r = results[group] ||= { pass: 0, fail: 0 };
  try { await fn(); r.pass++; console.log(`PASS ${group}: ${name}`); }
  catch (e) { r.fail++; console.error(`FAIL ${group}: ${name}\n${e.stack}`); }
}
const topic = () => ({ slug: 'one-pass', title: '手続きで確認する書類と順序', persona: 'test', category: 'その他', article_type: 'basic_explainer' });
const article = body => `---\ntitle: "手続きで確認する書類と順序"\nsummary: "手続きに必要な書類と順番を確認します。"\n---\n\n${body}`;
const body = (n = 1000) => `## 書類\n\n${'確認する書類です。'.repeat(n)}\n\n## 順序\n\n順番を確認します。\n\n## まとめ\n\n内容を確認します。\n\n${S.DISCLAIMER_TEXT}\n\nご不明な点がございましたらお気軽にご相談ください。`;
const options = { topic: topic(), articleType: 'basic_explainer' };
const envKeys = ['LENGTH_FIX_MODE', 'LENGTH_RETRY_SHORT', 'RULE_FIX_MODE', 'RULE_POSTFIX', 'POSTGEN_DEDUP'];
async function withEnv(values, fn) {
  const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  Object.assign(process.env, values);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
async function generation(input, response, env = {}, topicOverrides = {}) {
  const oldContent = CM.generateContent, oldSimple = CM.generateSimple, oldFetch = global.fetch;
  let contentCalls = 0, simpleCalls = 0;
  const prompts = [];
  global.fetch = async () => { throw new Error('試験中の通信は禁止'); };
  CM.generateContent = async () => { contentCalls++; return { text: article(contentCalls > 1 ? body(550) : input), provider: 'anthropic', model: 'fake', stopReason: 'end_turn' }; };
  CM.generateSimple = async prompt => { simpleCalls++; prompts.push(prompt); return { text: typeof response === 'function' ? response(prompt) : response }; };
  try {
    const generated = await withEnv(env, () => G.generateArticle('2026-10-19', { ...topic(), ...topicOverrides }));
    return { ...generated, contentCalls, simpleCalls, prompts };
  } finally { CM.generateContent = oldContent; CM.generateSimple = oldSimple; global.fetch = oldFetch; }
}
const answer = (id, text) => JSON.stringify({ delete: [], replacements: [{ id, text }] });

async function main() {
  await test('R1', '実測の比・未知モデル・指示上限', () => {
    assert.equal(S.LENGTH_OVERSHOOT_BY_MODEL['claude-sonnet-5-5'], 7760 / 6100);
    assert.equal(S.TOKEN_ESTIMATES_BY_MODEL['claude-sonnet-5-5'].tokensPerChar, (7793 - 910) / 7760);
    assert.deepEqual(S.calibratedRange({ min: 5000, max: 7000 }, 'unknown'), { min: 4500, max: 6100 });
    assert.deepEqual(S.calibratedRange({ min: 5000, max: 7000 }, 'claude-sonnet-5-5'), { min: 3900, max: 5300 });
  });
  await test('R1', '全記事型・意図型で上限の1.15倍を収める', () => {
    for (const range of [...Object.values(S.WORD_COUNT_RANGE), ...Object.values(S.WORD_COUNT_RANGE_BY_INTENT)]) {
      for (const model of ['claude-sonnet-5-5', 'unknown']) {
        const estimate = S.TOKEN_ESTIMATES_BY_MODEL[model] || { tokensPerChar: S.TOKENS_PER_CHAR, frontmatterTokens: 700 };
        // 同じ上限の実際の選択条件で確かめる。
        const intentType = Object.keys(S.WORD_COUNT_RANGE_BY_INTENT).find(k => S.WORD_COUNT_RANGE_BY_INTENT[k] === range);
        const articleType = Object.keys(S.WORD_COUNT_RANGE).find(k => S.WORD_COUNT_RANGE[k] === range) || 'basic_explainer';
        assert(S.maxTokensFor({ articleType, intentType, model }) >= range.max * 1.15 * estimate.tokensPerChar + estimate.frontmatterTokens);
      }
    }
  });
  await test('R2', '超過時は短縮だけ1回、見出し・免責文・CTAを保持', async () => {
    const input = body();
    const r = await generation(input, answer(2, '確認する書類です。'.repeat(550)));
    assert.equal(r.contentCalls, 1); assert.equal(r.simpleCalls, 1);
    assert(!checkBodyLength(r.content, 'basic_explainer').tooLong);
    assert.deepEqual(G.parseFrontmatter(r.content).body.match(/^## .*$/gm), input.match(/^## .*$/gm));
    assert(r.content.includes(S.DISCLAIMER_TEXT)); assert(r.content.includes('お気軽にご相談ください。'));
    assert(r.prompts[0].user.includes('目標6650文字以下'));
  });
  await test('R2', '題名・要約を後から補正しても短縮した本文を上書きしない', async () => {
    const r = await generation(body(), prompt => {
      if (prompt.user.includes('"delete"')) return answer(2, '確認する書類です。'.repeat(550));
      if (prompt.system.includes('タイトル')) return '申告の準備は何から始める？必要書類と手続きの順番';
      return '申告に必要な書類と提出までの順番を確認します。';
    }, {}, { target_query: '申告', secondary_queries: [] });
    assert.equal(r.contentCalls, 1); assert.equal(r.simpleCalls, 3);
    assert(!checkBodyLength(r.content, 'basic_explainer').tooLong);
    assert(!r.content.includes('確認する書類です。'.repeat(1000)));
  });
  for (const [label, response] of [
    ['見出し削除', JSON.stringify({ delete: [1], replacements: [] })],
    ['新しい数字', answer(2, '999万円です。')],
    ['上限超過のまま', answer(2, '確認する書類です。'.repeat(990))],
    ['JSON不正', '{壊れたJSON'],
    ['免責文削除', JSON.stringify({ delete: [7], replacements: [] })],
    ['CTA削除', JSON.stringify({ delete: [8], replacements: [] })],
    ['重複番号', JSON.stringify({ delete: [2], replacements: [{ id: 2, text: '書類です。' }] })],
    ['番号不明', answer(999, '書類です。')],
  ]) await test('R2', `${label}は元の本文と警告を維持`, async () => {
    const r = await generation(body(), response);
    assert.equal(r.contentCalls, 1); assert.equal(r.simpleCalls, 1);
    assert(r.content.includes('確認する書類です。'.repeat(1000)));
    assert(r.content.includes('本文が長い'));
  });
  await test('R2', '下限不足は既定で警告だけ、明示指定で1回増量', async () => {
    const r = await generation(body(10), '{}');
    assert.equal(r.contentCalls, 1); assert.equal(r.simpleCalls, 0); assert(r.content.includes('本文が短い'));
    const retry = await generation(body(10), '{}', { LENGTH_RETRY_SHORT: 'true' });
    assert.equal(retry.contentCalls, 2); assert.equal(retry.simpleCalls, 0);
  });
  await test('R2', '全文再生成への切り戻しは短縮を呼ばない', async () => {
    const r = await generation(body(), '{}', { LENGTH_FIX_MODE: 'regenerate' });
    assert.equal(r.contentCalls, 2); assert.equal(r.simpleCalls, 0);
  });
  await test('R2', '表・出典・下限割れ・変更なしは採用しない', async () => {
    const input = body() + '\n\n項目 | 値\n--- | ---\n対象 | 書類\n\n出典: 公的な説明資料';
    const units = P.splitParagraphs(input);
    for (const response of [
      { delete: [units.find(p => p.text.includes('項目 |')).id], replacements: [] },
      { delete: [units.find(p => p.text.includes('出典:')).id], replacements: [] },
      { delete: [2], replacements: [] },
      { delete: [], replacements: [{ id: 2, text: units[1].text }] },
    ]) {
      let calls = 0;
      const result = await P.shortenBody(input, { ...options, generateSimple: async () => { calls++; return { text: JSON.stringify(response) }; } });
      assert.equal(result, null); assert.equal(calls, 1);
    }
  });
  await test('R2', '禁止表現・未知通達・未知条文・不足ルールの増加を拒否', () => {
    const before = body(550);
    for (const addition of ['少額減価償却資産', '所基通999-999', '所得税法第9999条']) {
      assert.equal(P.validateBodyPatch(before, before + '\n' + addition, options), false);
    }
    const banned = '原則を3行で押さえる';
    assert(require('../banned-phrases').detectBannedInBody(banned).length > 0);
    assert.equal(P.validateBodyPatch(before, before + '\n' + banned, options), false);
    assert.equal(P.noNewNumbers('110万円と20%で期限は10月。', '110万円と21%です。'), false);
    assert.equal(P.noNewNumbers('110万円です。期限は10月。', '110万円です。'), true);
  });
  await test('R3', '相続税・贈与税の同名控除は扶養ルールを発火させない', () => {
    const match = S.CONDITIONAL_RULES.dependent_income_threshold.match;
    for (const title of ['贈与税の基礎控除', '贈与税の配偶者控除', '相続税の基礎控除', '相続税の配偶者控除', '贈与税 基礎控除', '贈与税の基礎控除と配偶者控除']) assert.equal(match({ title }), false);
    for (const title of ['所得税の扶養と基礎控除', '扶養の合計所得金額', '贈与税と所得税の扶養']) assert.equal(match({ title }), true);
    assert.equal(S.CONDITIONAL_RULES.income_tax_bracket.match({ title: '贈与税の累進税率と速算表' }), false);
    assert.equal(S.CONDITIONAL_RULES.income_tax_bracket.match({ title: '所得税の累進税率と速算表' }), true);
    assert.equal(S.CONDITIONAL_RULES.invoice_transition.match({ title: '相続税の経過措置' }), false);
    assert.equal(S.CONDITIONAL_RULES.expired_education_fund_gift.match({ tax_domain: 'inheritance_tax', title: '贈与税の非課税' }), false);
    assert.equal(S.CONDITIONAL_RULES.expired_education_fund_gift.match({ tax_domain: 'inheritance_tax', title: '教育資金の贈与' }), true);
  });
  await test('R3', '論点語・検索語・主出典・補助出典の題名を生成前に使う', () => {
    for (const extra of [{ tax_terms: '減価償却' }, { target_query: '少額減価償却資産' }, { secondary_queries: ['耐用年数'] },
      { source_title: '固定資産' }, { source_supplements: [{ title: '減価償却' }] }, { source_2_title: '減価償却' }]) {
      const ir = buildGenerationPrompt({ topic: { ...topic(), ...extra }, persona: { label: '' }, cta: '', articleType: 'basic_explainer', articleRole: 'main' });
      assert(ir.dynamicSystem.includes(S.CONDITIONAL_RULES.small_depreciable_assets.text));
    }
  });
  await test('R3', '引用だけでは部分修正も全文修正も呼ばない', async () => {
    for (const env of [{}, { RULE_FIX_MODE: 'rewrite' }]) {
      let calls = 0; const old = CM.generateSimple;
      CM.generateSimple = async () => { calls++; throw new Error('呼ばれない'); };
      try {
        await withEnv(env, () => G.applyMissingRulesToBody(article('## 根拠\n所基通37-14の取扱いです。'), { ...topic(), title: '通達の扱い' }, 'basic_explainer'));
        assert.equal(calls, 0);
      } finally { CM.generateSimple = old; }
    }
  });
  await test('R3', '該当文と前後一文だけを渡し1回修正、無関係な本文は渡さない', async () => {
    const input = `## 事例\n\n無関係な長い本文です。\n\n前の文です。減価償却の説明です。後の文です。さらに別の文です。\n\n## 結論\n\n別の結論です。`;
    let calls = 0;
    const r = await withEnv({}, () => P.postfixRules(input, { ...options, generateSimple: async prompt => {
      calls++; assert(!prompt.user.includes('無関係な長い本文')); assert(!prompt.user.includes('さらに別の文')); assert(!prompt.user.includes('別の結論'));
      assert(prompt.user.includes('前の文です。')); assert(prompt.user.includes('後の文です。'));
      const units = P.targetedSentences(input, topic(), S.findUnappliedRules(topic(), input), [], '');
      const hit = units.find(p => p.text.includes('減価償却'));
      return { text: JSON.stringify({ replacements: [{ id: hit.id, text: '減価償却を確認します。' }] }) };
    } }));
    assert.equal(calls, 1); assert.equal(r.applied, true); assert(r.body.includes('無関係な長い本文です。'));
  });
  await test('R3', '修正失敗・無効化・該当文なしは元の本文と不足キーを返す', async () => {
    for (const env of [{}, { RULE_POSTFIX: 'off' }]) {
      let calls = 0;
      const input = '## 工具\n\n減価償却を確認します。';
      const r = await withEnv(env, () => P.postfixRules(input, { ...options, generateSimple: async () => { calls++; return { text: '不正なJSON' }; } }));
      assert.equal(calls, env.RULE_POSTFIX ? 0 : 1); assert.equal(r.body, input); assert(r.failed); assert(r.names.includes('small_depreciable_assets'));
    }
    const r = await P.postfixRules('## 減価償却\n\n無関係です。', { ...options, generateSimple: async () => { throw new Error('呼ばれない'); } });
    assert(r.failed);
  });
  await test('R3', '全文修正への切り戻しと警告文の維持', async () => {
    let calls = 0; const old = CM.generateSimple;
    CM.generateSimple = async prompt => { calls++; assert(prompt.user.includes('無関係な本文')); return { text: '不正な短い出力' }; };
    try {
      const r = await withEnv({ RULE_FIX_MODE: 'rewrite' }, () => G.applyMissingRulesToBody(article('## 工具\n\n減価償却です。\n\n無関係な本文。'.repeat(10)), topic(), 'basic_explainer'));
      assert.equal(calls, 1); assert(r.failed);
    } finally { CM.generateSimple = old; }
    const r = await generation(body(550) + '\n\n減価償却です。', '不正なJSON');
    assert(r.content.includes('論点別ルールが未反映:'));
  });
  await test('R4', '候補に検索語・副検索語・URL・元検索語を含める', () => {
    const text = buildCandidateBlock({ slug: 'id', target_query: '主検索語', secondary_queries: ['副検索語'], url_slug: 'url-slug', phrases: ['元検索語'] }, 0);
    for (const word of ['主検索語', '副検索語', 'url-slug', '元検索語']) assert(text.includes(word));
  });
  await test('R4', '検索語確定後に1回、重複は候補数だけに数え次へ、生成後確認は既定なし', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-one-pass-'));
    const events = [], entries = [];
    const recorder = { entries, additions: entries, record(t, stage, detail) { entries.push({ topic_id: t.slug, stage, ...detail }); } };
    try {
      const run = async env => G.runSingleDraft('2026-10-19', {
        topics: ['a', 'b'].map(slug => ({ ...topic(), slug })), recorder, pendingDrafts: [], corpus: [],
        postsDir: dir, env, context: { queryInputs: {}, targetQueryCorpus: [], takenUrlSlugs: new Set() },
        select: (pool, opts) => ({ picks: pool.filter(t => !opts.withdrawn.some(e => e.topic_id === t.slug)).slice(0, 1), explanation: { steps: [], warnings: [] } }),
        ensureSource: t => { t.source_provenance = 'curated'; }, enrichSource: async () => {},
        resolveQuery: async t => { events.push(`query:${t.slug}`); return { target_query: `検索語${t.slug}`, secondary_queries: ['副'], slug_words: `url-${t.slug}` }; },
        checkAI: async picks => { const t = picks[0]; events.push(`dedup:${t.slug}`); assert(t.target_query && t.url_slug); return { results: [{ slug: t.slug, duplicate: t.slug === 'a', similar_to: 'old' }] }; },
        generateArticle: async (_, t) => { events.push(`body:${t.slug}`); return { content: article(body(550)) }; },
        checkGenerated: async () => { events.push('postgen'); return { duplicate: false }; },
        selfCheck: () => {}, factCheck: async content => ({ content, record: { status: 'ok', summary: '偽の照合' } }),
      });
      const r = await run({});
      assert.equal(r.generations, 1); assert.equal(r.candidates, 2); assert.equal(r.results.length, 1);
      assert.equal(entries[0].stage, 'pregen-dedup');
      assert.deepEqual(events, ['query:a', 'dedup:a', 'query:b', 'dedup:b', 'body:b']);
      events.length = entries.length = 0;
      await run({ POSTGEN_DEDUP: 'true' }); assert.equal(events.filter(e => e === 'postgen').length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('R4', '名指しした置き換え記事との重複は許容', async () => {
    let corpus;
    const ready = await G.checkPreparedDuplicates([{ ...topic(), replaces: ['old'] }], { corpus: [{ slug: 'old' }, { slug: 'other' }],
      checkAI: async (_, c) => { corpus = c; return { results: [{ slug: 'one-pass', duplicate: true, similar_to: 'old' }] }; } });
    assert.equal(ready.length, 1); assert.deepEqual(corpus, [{ slug: 'other' }]);
    const blocked = await G.checkPreparedDuplicates([{ ...topic(), replaces: ['old-more'] }], { corpus: [{ slug: 'old' }],
      checkAI: async (_, c) => { assert.equal(c.length, 1); return { results: [{ slug: 'one-pass', duplicate: true, similar_to: 'old' }] }; } });
    assert.equal(blocked.length, 0, '部分一致の slug は置き換え対象として許容しない');
  });
  await test('R4', '2本モードも検索語確定後に確認し、補充は1回だけ', async () => {
    const calls = [], entries = [];
    const topics = ['a', 'b', 'c', 'd', 'e'].map(slug => ({ ...topic(), slug }));
    const common = {
      topics, pendingDrafts: [], corpus: [], env: {},
      recorder: { entries, record(t, stage) { entries.push({ topic_id: t.slug, stage }); } },
      context: { queryInputs: {}, targetQueryCorpus: [], takenUrlSlugs: new Set() },
      ensureSource: t => { t.source_provenance = 'curated'; }, enrichSource: async () => {},
      resolveQuery: async t => { calls.push(`query:${t.slug}`); return { target_query: `検索語${t.slug}`, secondary_queries: [], slug_words: `url-${t.slug}` }; },
      checkAI: async picks => { const t = picks[0]; calls.push(`dedup:${t.slug}`); assert(t.target_query); return { results: [{ slug: t.slug, duplicate: true }] }; },
      select: pool => ({ picks: pool.slice(0, 2), explanation: { steps: [], warnings: [] } }),
    };
    const ready = await G.preparePairCandidates(topics.slice(0, 2), 2, common);
    assert.deepEqual(ready, []); assert.equal(entries.length, 4); assert(entries.every(e => e.stage === 'pregen-dedup'));
    assert.deepEqual(calls, ['query:a', 'query:b', 'dedup:a', 'dedup:b', 'query:c', 'query:d', 'dedup:c', 'dedup:d']);
  });
  await test('R2', '受入内の記事は本文生成が1回だけ', async () => {
    const r = await generation(body(550), '{}');
    assert.equal(r.contentCalls, 1); assert.equal(r.simpleCalls, 0);
  });
  for (const [group, r] of Object.entries(results)) console.log(`${group} PASS: ${r.pass} / FAIL: ${r.fail}`);
  process.exitCode = Object.values(results).some(r => r.fail) ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
