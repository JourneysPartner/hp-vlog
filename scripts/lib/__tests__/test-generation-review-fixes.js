'use strict';

// 通信・AI を偽装し、作成物はすべて OS の一時フォルダに置く。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const CM = require('../content-model');
const G = require('../../generate-draft');
const P = require('../body-patches');
const S = require('../article-prompt-static');
const W = require('../withdrawn-topics');
const A = require('../ai-dedup');
const aux = require('../aux-model');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-review-fixes-'));
const savedEnv = { ...process.env };
const original = { fetch: global.fetch, timer: global.setTimeout, log: console.log, warn: console.warn,
  generateContent: CM.generateContent, generateSimple: CM.generateSimple };
const groups = {};
const requests = [], timers = [], logs = [];
let reply;
const secret = 'test-only-secret-for-generation-review';
const now = new Date('2026-10-19T00:00:00Z');
const topic = (slug = 'review-test') => ({ slug, title: '手続きで確認する書類と順序', persona: 'test',
  category: 'その他', article_type: 'basic_explainer' });
const body = (n = 550) => `## 書類\n\n${'確認する書類です。'.repeat(n)}\n\n## 順序\n\n順番を確認します。\n\n## まとめ\n\n内容を確認します。\n\n${S.DISCLAIMER_TEXT}\n\nご不明な点がございましたらお気軽にご相談ください。`;
const article = (text = body()) => `---\ntitle: "手続きで確認する書類と順序"\nslug: "review-test"\nsummary: "必要な書類と順番を確認します。"\ncategory: "その他"\nprimary_persona: "test"\narticle_type: "basic_explainer"\nreview_status: "needs_revision"\nreview_comment: "確認"\nreview_warning: "既存の警告"\n---\n\n${text}`;
const gateway = (text = article(), finish = 'stop') => ({ ok: true, json: async () => ({
  choices: [{ message: { content: text }, finish_reason: finish }],
}) });
const anthropic = (text = article(), stop = 'end_turn') => ({ ok: true, json: async () => ({
  content: [{ type: 'text', text }], stop_reason: stop,
}) });
const http = status => ({ ok: false, status, text: async () => secret, body: { cancel: async () => {} } });
const freshDir = () => fs.mkdtempSync(path.join(temp, 'case-'));

function restoreEnv() {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}
function reset() {
  restoreEnv();
  for (const key of ['CONTENT_MODEL_PROVIDER', 'CONTENT_MODEL', 'OPENAI_API_KEY', 'AUX_MODEL_ENABLED',
    'AUX_MODEL_PROVIDER', 'AUX_MODEL', 'LENGTH_FIX_MODE', 'LENGTH_RETRY_SHORT', 'RULE_FIX_MODE',
    'RULE_POSTFIX', 'WITHDRAWN_OUT', 'POSTGEN_DEDUP', 'GITHUB_OUTPUT']) delete process.env[key];
  process.env.ANTHROPIC_API_KEY = secret;
  process.env.AI_GATEWAY_API_KEY = secret;
  process.env.ENABLE_LLM_SOURCE_SELECT = 'false';
  CM.generateContent = original.generateContent;
  CM.generateSimple = original.generateSimple;
  requests.length = timers.length = logs.length = 0;
  reply = url => url.includes('ai-gateway') ? gateway() : anthropic();
  global.fetch = async (url, options) => {
    assert(/^(https:\/\/api\.anthropic\.com\/v1\/messages|https:\/\/ai-gateway\.vercel\.sh\/v1\/chat\/completions)$/.test(url), '未偽装の通信先');
    requests.push({ url, options, body: JSON.parse(options.body) });
    return reply(url, options);
  };
  global.setTimeout = (fn, ms, ...args) => {
    timers.push(ms);
    return original.timer(fn, ms === 15000 || ms === 30000 ? 0 : ms, ...args);
  };
  console.log = console.warn = (...args) => logs.push(args.join(' '));
}
async function test(group, name, run) {
  reset();
  const count = groups[group] ||= { pass: 0, fail: 0 };
  try { await run(); count.pass++; original.log(`PASS ${group}: ${name}`); }
  catch (error) { count.fail++; original.log(`FAIL ${group}: ${name}\n${error.stack}`); }
}

function singleOptions(dir, extra = {}) {
  return {
    topics: [topic('a'), topic('b')], env: {}, now, postsDir: dir, pendingDrafts: [], corpus: [],
    recorder: W.createWithdrawalRecorder({ file: path.join(dir, 'attempts.json'), env: {}, now }),
    context: { queryInputs: {}, targetQueryCorpus: [], takenUrlSlugs: new Set() },
    select: pool => ({ picks: pool.slice(0, 1), explanation: { steps: [], warnings: [] } }),
    ensureSource: t => { t.source_provenance = 'curated'; }, enrichSource: async () => {},
    resolveQuery: async t => ({ target_query: `検索語${t.slug}`, secondary_queries: [], slug_words: `url-${t.slug}` }),
    checkAI: async () => ({ results: [{ slug: '任意', duplicate: false }], skipped: false }),
    selfCheck: () => {},
    factCheck: async content => ({ content, record: { status: 'ok', summary: '偽の照合' } }),
    ...extra,
  };
}

async function main() {
  const routes = {
    full: () => G.regenerateWithContentModel(article(), '全体を整えてください'),
    targeted: () => G.regenerateTargeted(article(), '書類の説明を確認してください'),
    section: () => G.regenerateSection(article(), '書類を確認してください', { type: 'section_rewrite', sectionHint: '書類' }),
    add_section: () => G.regenerateSection(article(), '補足を追加してください', { type: 'add_section' }),
    refresh_targeted: () => G.regenerateTargeted(article(), '書類を確認してください', { preserveTitle: true }),
    refresh_section: () => G.regenerateSection(article(), '書類を確認してください', { type: 'section_rewrite', sectionHint: '書類' }, { preserveTitle: true }),
  };
  for (const [name, run] of Object.entries(routes)) {
    await test('F1', `Gateway ${name} は64000・15分`, async () => {
      process.env.CONTENT_MODEL_PROVIDER = 'gateway';
      reply = () => gateway(name.includes('section') ? '## 書類\n\n確認する書類です。' : article());
      await run();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].body.max_tokens, 64000);
      assert.deepEqual(timers, [900000]);
    });
    for (const provider of ['gateway', 'anthropic']) await test('F1', `${provider} ${name} の途切れは例外`, async () => {
      process.env.CONTENT_MODEL_PROVIDER = provider;
      const existing = article();
      reply = () => provider === 'gateway' ? gateway('## 書類\n\n途中の本文', 'length') : anthropic('## 書類\n\n途中の本文', 'max_tokens');
      await assert.rejects(run(), e => e.contentBodyTruncated === true);
      assert.equal(requests.length, 1, '途切れを縮みすぎの再試行や補完へ回さない');
      assert.equal(article(), existing);
    });
  }
  for (const provider of ['gateway', 'anthropic']) await test('F1', `${provider} 日次の途切れは下書きを保存せず照合もしない`, async () => {
    process.env.CONTENT_MODEL_PROVIDER = provider;
    reply = () => provider === 'gateway' ? gateway('## 書類\n途中', 'length') : anthropic('## 書類\n途中', 'max_tokens');
    const dir = freshDir();
    let facts = 0;
    const result = await G.generateTopics([topic()], '2026-10-19', { postsDir: dir, selfCheck: () => {},
      factCheck: async () => { facts++; throw new Error('照合しない'); } });
    assert.equal(result.length, 0); assert.equal(facts, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert(logs.some(line => line.includes('本文生成に失敗')));
  });
  await test('F1', '短い答えの上限は従来どおりで停止理由も保持', async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway';
    reply = () => gateway('短い答え', 'length');
    const result = await G.callSimpleOpenAI({ system: '固定', user: '入力' }, 200);
    assert.equal(result.stopReason, 'max_tokens');
    assert.equal(requests[0].body.max_tokens, 16000); assert.deepEqual(timers, [300000]);
  });
  await test('F1', '日次の再試行で途切れた場合も元の結果へ戻さない', async () => {
    let calls = 0;
    CM.generateContent = async () => (++calls === 1
      ? { text: article('見出しのない文です。'), stopReason: 'end_turn' }
      : { text: '## 書類\n途中', stopReason: 'max_tokens' });
    await assert.rejects(G.generateArticle('2026-10-19', topic()), e => e.contentBodyTruncated);
    assert.equal(calls, 2);
  });
  for (const slug of ['url-a', '別のslug']) await test('F2', `1候補1回答の ${slug} を重複として扱う`, async () => {
    const t = { ...topic('a'), url_slug: 'url-a' }, entries = [];
    const opts = { corpus: [], recorder: { record: (_, stage) => entries.push(stage) },
      checkAI: async () => ({ results: [{ slug, duplicate: true, similar_to: 'old' }] }) };
    assert.deepEqual(await G.checkPreparedDuplicates([t], opts), []);
    assert.deepEqual(entries, ['pregen-dedup']);
    const dir = freshDir();
    const result = await G.runSingleDraft('2026-10-19', singleOptions(dir, {
      topics: [t], checkAI: opts.checkAI, generateArticle: async () => { throw new Error('生成しない'); },
    }));
    assert.equal(result.generations, 0);
    assert.equal(result.results.length, 0);
  });
  await test('F2', '複数回答はURL slugでも照合し、既存のガードと置き換え許容を維持', async () => {
    const t = { ...topic('a'), url_slug: 'url-a', persona: '個人' };
    const ready = await G.checkPreparedDuplicates([t], { corpus: [], checkAI: async () => ({ results: [
      { slug: 'url-a', duplicate: true, similar_to: 'old' }, { slug: '別', duplicate: false },
    ] }) });
    assert.equal(ready.length, 0);
    const result = [{ slug: 'url-a', duplicate: true, similar_to: 'old' }];
    A.applyDeterministicGuard(result, [t], [{ slug: 'old', primary_persona: '法人' }]);
    assert.equal(result[0].duplicate, false);
    const allowed = await G.checkPreparedDuplicates([{ ...t, replaces: ['old'] }], { corpus: [],
      checkAI: async () => ({ results: [{ slug: 'url-a', duplicate: true, similar_to: 'old' }] }) });
    assert.equal(allowed.length, 1);
  });
  await test('F3', '再生成・Validate・commit/pushの失敗通知とenv経由の段階表示', () => {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/regenerate-draft.yml'), 'utf8');
    const notification = workflow.slice(workflow.indexOf('- name: 再生成の失敗を通知'));
    assert.match(notification, /if: failure\(\)\s*\n/);
    for (const step of ['regen', 'validate', 'commit_push']) assert(notification.includes(`steps.${step}.outcome`));
    assert(notification.includes('--event regenerate_failed'));
    assert(!notification.slice(notification.indexOf('run:')).includes('${{'));
    assert(!notification.includes('本文は更新していません'));
  });

  for (const provider of ['gateway', 'anthropic']) {
    for (const failure of [400, 'refusal', '形式不正', 'JSON不正']) await test('F4', `${provider} ${failure} は次の候補へ進み短期記録`, async () => {
      process.env.CONTENT_MODEL_PROVIDER = provider;
      let count = 0;
      reply = () => {
        if (++count > 1) return provider === 'gateway' ? gateway() : anthropic();
        if (failure === 400) return http(400);
        if (failure === 'JSON不正') return { ok: true, json: async () => { throw new SyntaxError(secret); } };
        if (failure === '形式不正') return { ok: true, json: async () => null };
        return provider === 'gateway'
          ? { ok: true, json: async () => ({ choices: [{ message: { content: null, refusal: secret }, finish_reason: 'stop' }] }) }
          : { ok: true, json: async () => ({ content: [], stop_reason: 'refusal' }) };
      };
      const dir = freshDir(), opts = singleOptions(dir);
      const result = await G.runSingleDraft('2026-10-19', opts);
      assert.equal(result.results.length, 1); assert.equal(result.candidates, 2); assert.equal(result.generations, 2);
      const entry = opts.recorder.additions[0];
      assert.equal(entry.stage, 'generation-failed-candidate');
      assert.equal(entry.expires_at, '2026-10-26T00:00:00.000Z');
      assert(!logs.join('').includes(secret));
      assert(!fs.readFileSync(path.join(dir, 'attempts.json'), 'utf8').includes(secret));
    });
    for (const failure of [401, 403, 408, 429, 503, '通信', '時間切れ']) await test('F4', `${provider} ${failure} はその日の生成を終了`, async () => {
      process.env.CONTENT_MODEL_PROVIDER = provider;
      reply = () => {
        if (failure === '通信') throw new TypeError(secret);
        if (failure === '時間切れ') throw Object.assign(new Error(secret), { name: 'TimeoutError' });
        return http(failure);
      };
      const dir = freshDir(), opts = singleOptions(dir);
      const result = await G.runSingleDraft('2026-10-19', opts);
      assert.equal(result.results.length, 0); assert.equal(result.candidates, 1); assert.equal(result.generations, 1);
      assert.deepEqual(opts.recorder.additions, []);
      assert(result.reason.includes('本文生成モデルの呼び出しに失敗'));
      assert(!logs.join('').includes(secret)); assert(!result.reason.includes(secret));
    });
  }
  await test('F4', '7日間だけ候補IDで除外し、検索語や恒久取り下げを変えない', () => {
    const dir = freshDir(), file = path.join(dir, 'attempts.json');
    const recorder = W.createWithdrawalRecorder({ file, now, env: {} });
    const t = { ...topic('a'), target_query: '同じ検索語' };
    recorder.record(t, 'generation-failed-candidate', { reason: '固定文' });
    const entries = W.loadWithdrawnTopics(file).entries;
    assert(W.findWithdrawnTopic(t, entries, new Date('2026-10-20T00:00:00Z')));
    assert.equal(W.findWithdrawnTopic(t, entries, new Date('2026-10-26T00:00:00Z')), null);
    assert.equal(W.findWithdrawnQuery(t.target_query, entries), null);
    assert.deepEqual([t, topic('b')].filter(p => !W.findWithdrawnTopic(p, entries, new Date('2026-10-20T00:00:00Z'))).map(p => p.slug), ['b']);
    const permanent = { topic_id: 'a', stage: 'pregen-dedup', target_query: t.target_query };
    assert.equal(W.findWithdrawnTopic(t, [...entries, permanent], new Date('2030-01-01')), permanent);
    assert.equal(W.findWithdrawnQuery(t.target_query, [...entries, permanent]), permanent);
    const output = path.join(dir, 'out.json');
    const runner = W.createWithdrawalRecorder({ env: { WITHDRAWN_OUT: output }, withdrawn: [], now });
    runner.record(t, 'generation-failed-candidate');
    require('../../record-withdrawn-topics').recordWithdrawnFile(output, path.join(dir, 'merged.json'));
    assert.deepEqual(W.loadWithdrawnTopics(path.join(dir, 'merged.json')).entries, runner.additions);
  });
  await test('F4', '実際の選定でも翌日は除外、期限に達したら候補に戻る', () => {
    const { selectDailyTopics } = require('../topic-selector');
    const { TOPICS } = require('../../topic-pool');
    const next = new Date('2026-10-20T00:00:00Z');
    const baseline = selectDailyTopics(TOPICS, { now: next, count: 1, withdrawn: [] });
    const first = baseline.picks[0]; assert(first);
    const entries = [{ topic_id: first.slug, stage: 'generation-failed-candidate', expires_at: '2026-10-26T00:00:00Z' }];
    const blocked = selectDailyTopics(TOPICS, { now: next, count: 1, withdrawn: entries });
    assert(!blocked.picks.some(t => t.slug === first.slug));
    assert.equal(blocked.explanation.steps.find(s => s.step === 'filter-withdrawn').blocked, 1);
    const expired = selectDailyTopics(TOPICS, { now: new Date('2026-10-26T00:00:00Z'), count: 1, withdrawn: entries });
    assert.equal(expired.explanation.steps.find(s => s.step === 'filter-withdrawn').blocked, 0);
  });

  await test('F5', 'コード囲み・前後の説明つきの短縮JSONを採用', async () => {
    const input = body(1000);
    const result = await P.shortenBody(input, { topic: topic(), articleType: 'basic_explainer',
      generateSimple: async () => ({ text: '結果です。\n```json\n' + JSON.stringify({ delete: [], replacements: [{ id: 2, text: '確認する書類です。'.repeat(550) }] }) + '\n```\n以上です。' }) });
    assert(result); assert(result.length < input.length); assert(result.includes(S.DISCLAIMER_TEXT));
  });
  const ruleBody = '## 工具\n\n減価償却の特例は30万円未満です。';
  for (const amount of ['40', '99999']) await test('F6', `ルール本文の${amount === '40' ? '数字は許可' : '外の数字は拒否'}`, async () => {
    const rules = S.findUnappliedRules(topic(), ruleBody);
    assert(rules.some(r => r.key === 'small_depreciable_assets'));
    const unit = P.targetedSentences(ruleBody, topic(), rules, [], '').find(u => u.text.includes('30万円'));
    const result = await P.postfixRules(ruleBody, { topic: topic(), articleType: 'basic_explainer',
      generateSimple: async () => ({ text: '```json\n' + JSON.stringify({ replacements: [{ id: unit.id, text: `減価償却の特例は${amount}万円未満です。` }] }) + '\n```' }) });
    assert.equal(result.applied, amount === '40');
    if (amount === '40') assert(result.body.includes('40万円'));
    else assert(result.warning.includes('論点別ルールが未反映: small_depreciable_assets（該当箇所が現行の制度に合うか確認してください）'));
  });
  await test('F6', '表は変更せず、表の該当行の確認を警告', async () => {
    for (const input of ['## 工具\n\n| 減価償却 | 金額 |\n| --- | --- |\n| 特例 | 30万円未満 |',
      '## 減価償却\n\n| 項目 | 金額 |\n| --- | --- |\n| 特例 | 30万円未満 |']) {
      let calls = 0;
      const result = await P.postfixRules(input, { topic: topic(), articleType: 'basic_explainer',
        generateSimple: async () => { calls++; throw new Error('表は渡さない'); } });
      assert.equal(result.body, input); assert.equal(calls, 0);
      assert(result.warning.includes('表の該当行が現行の制度に合うか確認してください'));
    }
  });
  await test('F6', '本文を修正できても未修正の表の警告は消さない', async () => {
    const table = '| 減価償却 | 金額 |\n| --- | --- |\n| 特例 | 30万円未満 |';
    const input = ruleBody + '\n\n' + table;
    const rules = S.findUnappliedRules(topic(), input);
    const unit = P.targetedSentences(input, topic(), rules, [], '').find(u => u.text.includes('30万円'));
    const result = await P.postfixRules(input, { topic: topic(), articleType: 'basic_explainer',
      generateSimple: async () => ({ text: JSON.stringify({ replacements: [{ id: unit.id, text: '減価償却の特例は40万円未満です。' }] }) }) });
    assert(result.applied); assert(result.failed); assert(result.body.includes(table));
    assert(result.warning.includes('表の該当行'));
  });
  await test('F6', '数字の許可はルール本文に限定し、短縮の数字保護を維持', () => {
    assert(P.noNewNumbers('30万円', '40万円', '40万円未満'));
    assert(!P.noNewNumbers('30万円', '40万円'));
    assert(!P.noNewNumbers('30万円', '999万円', 'ルール名は999_rule、本文は40万円'.split('本文は')[1]));
  });
  await test('F6', '未反映の確認文が生成した下書きに残る', async () => {
    CM.generateContent = async () => ({ text: article(body() + '\n\n減価償却の特例は30万円未満です。'), stopReason: 'end_turn' });
    CM.generateSimple = async () => ({ text: '読めないJSON' });
    const result = await G.generateArticle('2026-10-19', topic());
    assert(result.content.includes('該当箇所が現行の制度に合うか確認してください'));
  });
  await test('F7', '孫への生前贈与・非課税を含む従来のルール範囲を復元', () => {
    const match = S.CONDITIONAL_RULES.expired_education_fund_gift.match;
    for (const title of ['孫への生前贈与で使える非課税制度', '贈与税の非課税', '祖父母からの贈与']) {
      assert(match({ tax_domain: 'inheritance_tax', title }));
    }
    assert(!match({ tax_domain: 'income_tax', title: '業務の手続き' }));
  });

  for (const kind of ['API', 'JSON', 'length']) await test('F8', `${kind}失敗後に1回だけ再試行し成功`, async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway';
    process.env.AUX_MODEL_ENABLED = 'true'; process.env.AUX_MODEL_PROVIDER = 'gateway';
    let calls = 0;
    reply = () => {
      calls++;
      if (calls > 1) return gateway('[{"slug":"url-a","duplicate":false}]');
      if (kind === 'API') return http(400);
      return gateway(kind === 'JSON' ? '{読めない' : '[{"duplicate":false}]', kind === 'length' ? 'length' : 'stop');
    };
    const t = { ...topic('a'), url_slug: 'url-a' };
    assert.equal((await G.checkPreparedDuplicates([t], { corpus: [] })).length, 1);
    assert.equal(calls, 2); assert(!t.__dedupWarning);
  });
  for (const paired of [false, true]) await test('F8', `${paired ? '2本/手動の経路' : '1本の経路'}で再失敗の警告を下書きに保持`, async () => {
    const dir = freshDir(); let calls = 0;
    const opts = singleOptions(dir, { checkAI: async () => { calls++; return { results: [], skipped: true }; },
      generateArticle: async () => ({ content: article() }) });
    const result = paired
      ? await G.generateTopics(await G.checkPreparedDuplicates([topic('a')], { ...opts, force: true }), '2026-10-19', opts)
      : (await G.runSingleDraft('2026-10-19', opts)).results;
    assert.equal(calls, 2); assert.equal(result.length, 1);
    const meta = require('gray-matter')(fs.readFileSync(path.join(dir, result[0].filename), 'utf8')).data;
    assert(meta.review_warning.includes('既存の警告'));
    assert(meta.review_warning.includes('重複確認を実施できませんでした（AI の応答を得られず）'));
  });
  await test('F8', '無効時は再試行も警告もなく、例外時には再試行', async () => {
    let calls = 0;
    const t = topic();
    await G.checkPreparedDuplicates([t], { corpus: [], checkAI: async () => { calls++; return A.checkDuplicatesWithAI([t], []); } });
    assert.equal(calls, 1); assert(!t.__dedupWarning);
    calls = 0;
    await G.checkPreparedDuplicates([t], { corpus: [], checkAI: async () => { calls++; throw new Error(secret); } });
    assert.equal(calls, 2); assert(t.__dedupWarning);
    assert(!logs.join('').includes(secret));
    process.env.AUX_MODEL_ENABLED = 'true'; process.env.AUX_MODEL_PROVIDER = 'gateway';
    delete process.env.AI_GATEWAY_API_KEY;
    calls = 0;
    await G.checkPreparedDuplicates([t], { corpus: [], checkAI: async () => { calls++; return A.checkDuplicatesWithAI([t], []); } });
    assert.equal(calls, 2); assert(t.__dedupWarning, '認証情報不足を意図的な無効化と区別');
    assert.equal(requests.length, 0);
  });
  await test('L1', '贈与の扶養義務者・おしどり贈与で扶養所得ルールを発火させない', () => {
    const match = S.CONDITIONAL_RULES.dependent_income_threshold.match;
    assert.equal(match({ title: '扶養義務者からの生活費の贈与' }), false);
    assert.equal(match({ tax_domain: 'gift_tax', title: '配偶者控除（おしどり贈与）', __body: '所得税はかかりません。' }), false);
    assert.equal(match({ title: '所得税の扶養と配偶者控除' }), true);
    assert.equal(match({ title: '贈与税と所得税の扶養' }), true);
  });
  await test('L2', '文字列の副検索語は配列と同じルールを選ぶ', () => {
    const keys = t => S.selectConditionalRuleEntries(t).map(r => r.key);
    assert.deepEqual(keys({ ...topic(), secondary_queries: '減価償却,耐用年数' }), keys({ ...topic(), secondary_queries: ['減価償却', '耐用年数'] }));
    assert(keys({ secondary_queries: '少額減価償却資産' }).includes('small_depreciable_assets'));
  });
  await test('L3', '2本/手動指定の重複理由をログと0本通知に残す', async () => {
    const entries = [];
    const result = await G.checkPreparedDuplicates([topic('a'), topic('b')], { force: true, corpus: [],
      recorder: { record: (t, stage) => entries.push({ slug: t.slug, stage }) },
      checkAI: async ([t]) => ({ results: [{ slug: t.slug, duplicate: true, similar_to: 'old' }] }) });
    assert.deepEqual(result, []); assert.equal(entries.length, 2);
    assert(logs.some(line => line.includes('生成前に重複: a（相手 old）')));
    const source = fs.readFileSync(path.join(root, 'scripts/generate-draft.js'), 'utf8');
    assert(source.includes('lastSelectionWarnings.push(why)'));
    assert(source.includes("const reason = lastSelectionWarnings.join(' / ')"));
    assert(source.includes('outputs.single_reason = reason'));
  });
  await test('L5', '再生成の資格情報は既定AnthropicとGatewayに対応', () => {
    delete process.env.OPENAI_API_KEY;
    assert.equal(G.requireContentCredentials(), 'ANTHROPIC_API_KEY');
    delete process.env.ANTHROPIC_API_KEY;
    assert.throws(G.requireContentCredentials, /ANTHROPIC_API_KEY が必要です/);
    process.env.CONTENT_MODEL_PROVIDER = 'gateway';
    assert.equal(G.requireContentCredentials(), 'AI_GATEWAY_API_KEY');
    delete process.env.AI_GATEWAY_API_KEY;
    assert.throws(G.requireContentCredentials, /AI_GATEWAY_API_KEY が必要です/);
  });
  for (const provider of ['gateway', 'anthropic']) await test('L6', `${provider} の失敗診断は状態番号を残し鍵を出さない`, async () => {
    process.env.AUX_MODEL_ENABLED = 'true'; process.env.AUX_MODEL_PROVIDER = provider;
    reply = () => http(401);
    assert.equal(await aux.generateAux({ system: '固定', user: '入力', task: 'ai_dedup' }), null);
    assert(logs.some(line => line.includes('HTTP 401'))); assert(!logs.join('').includes(secret));
  });
  await test('L7', '通達引用だけなら既定は修正せずrewriteでだけ全文修正', async () => {
    let calls = 0;
    CM.generateSimple = async (_, opts) => { calls++; assert.equal(opts.kind, 'body'); return { text: article('短い本文') }; };
    const input = article('## 根拠\n所基通37-14の取扱いです。');
    await G.applyMissingRulesToBody(input, topic(), 'basic_explainer'); assert.equal(calls, 0);
    process.env.RULE_FIX_MODE = 'rewrite';
    await G.applyMissingRulesToBody(input, topic(), 'basic_explainer'); assert.equal(calls, 1);
    process.env.RULE_POSTFIX = 'off';
    await G.applyMissingRulesToBody(input, topic(), 'basic_explainer'); assert.equal(calls, 1);
  });
  await test('F8', 'Anthropic重複確認のリクエスト本文は既存のハッシュと一致', async () => {
    process.env.AUX_MODEL_ENABLED = 'true'; process.env.AUX_MODEL_PROVIDER = 'anthropic';
    reply = () => anthropic('[{"slug":"a","duplicate":false}]');
    await A.checkDuplicatesWithAI([{ slug: 'a' }], []);
    const hash = crypto.createHash('sha256').update(requests[0].options.body).digest('hex');
    assert.equal(hash, 'c06ed82d25d0bba329205519fd02fdd96e022c57e710dcbb37233f47f8492ac9');
  });
}

main().finally(() => {
  global.fetch = original.fetch; global.setTimeout = original.timer;
  console.log = original.log; console.warn = original.warn;
  CM.generateContent = original.generateContent; CM.generateSimple = original.generateSimple;
  restoreEnv();
  fs.rmSync(temp, { recursive: true, force: true });
  let failed = 0;
  for (const [group, count] of Object.entries(groups)) {
    original.log(`${group}: PASS ${count.pass} / FAIL ${count.fail}`); failed += count.fail;
  }
  process.exitCode = failed ? 1 : 0;
}).catch(error => { original.log(error.stack); process.exitCode = 1; });
