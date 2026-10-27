'use strict';

// AI・通信は偽装し、試験の生成物は OS の一時フォルダだけに保存する。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CM = require('../content-model');
const G = require('../../generate-draft');
const P = require('../body-patches');
const S = require('../article-prompt-static');
const W = require('../withdrawn-topics');
const { callGateway } = require('../gateway-model');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-review-fixes-2-'));
const savedEnv = { ...process.env };
const original = { fetch: global.fetch, log: console.log, warn: console.warn,
  generateContent: CM.generateContent, generateSimple: CM.generateSimple };
const ruleText = S.CONDITIONAL_RULES.small_depreciable_assets.text;
const groups = {};
const requests = [], logs = [];
const secret = 'test-only-private-generation-value';
const now = new Date('2026-10-19T00:00:00Z');
const topic = (slug = 'review-test') => ({ slug, title: '手続きで確認する書類と順序', persona: 'test',
  category: 'その他', article_type: 'basic_explainer' });
const body = (n = 550) => `## 書類\n\n${'初回の書類を確認します。'.repeat(n)}\n\n## 順序\n\n順序を確認します。\n\n${S.DISCLAIMER_TEXT}`;
const article = (text = body()) => `---\ntitle: "手続きで確認する書類と順序"\nsummary: "必要な書類と手続きの順序を確認する記事です。"\n---\n\n${text}`;
const gateway = (text = article(), finish = 'stop') => ({ ok: true, json: async () => ({
  choices: [{ message: { content: text }, finish_reason: finish }],
}) });
const anthropic = (text = article(), stop = 'end_turn') => ({ ok: true, json: async () => ({
  content: [{ type: 'text', text }], stop_reason: stop,
}) });
const http = status => ({ ok: false, status, text: async () => secret, body: { cancel: async () => {} } });
const freshDir = () => fs.mkdtempSync(path.join(temp, 'case-'));
let reply;

function restoreEnv() {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}
function reset() {
  restoreEnv();
  for (const key of ['CONTENT_MODEL_PROVIDER', 'CONTENT_MODEL', 'OPENAI_API_KEY', 'AUX_MODEL_ENABLED',
    'AUX_MODEL_PROVIDER', 'AUX_MODEL', 'LENGTH_FIX_MODE', 'LENGTH_RETRY_SHORT', 'RULE_FIX_MODE',
    'RULE_POSTFIX', 'WITHDRAWN_OUT', 'POSTGEN_DEDUP', 'GITHUB_OUTPUT']) delete process.env[key];
  process.env.ANTHROPIC_API_KEY = process.env.AI_GATEWAY_API_KEY = secret;
  process.env.ENABLE_LLM_SOURCE_SELECT = 'false';
  process.env.FACT_PLAN_ENABLED = 'false'; // 本文生成の既存の呼び出しと保全条件をそのまま確かめる。
  CM.generateContent = original.generateContent;
  CM.generateSimple = original.generateSimple;
  S.CONDITIONAL_RULES.small_depreciable_assets.text = ruleText;
  delete S.CONDITIONAL_RULES.review_rate;
  requests.length = logs.length = 0;
  reply = url => url.includes('ai-gateway') ? gateway() : anthropic();
  global.fetch = async (url, options) => {
    assert(/^(https:\/\/api\.anthropic\.com\/v1\/messages|https:\/\/ai-gateway\.vercel\.sh\/v1\/chat\/completions)$/.test(url), '未偽装の通信先');
    requests.push({ url, body: JSON.parse(options.body) });
    return reply(url, options);
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
    topics: ['a', 'b', 'c', 'd'].map(topic), env: {}, now, postsDir: dir, pendingDrafts: [], corpus: [],
    recorder: W.createWithdrawalRecorder({ file: path.join(dir, 'attempts.json'), env: {}, now }),
    context: { queryInputs: {}, targetQueryCorpus: [], takenUrlSlugs: new Set() },
    select: pool => ({ picks: pool.slice(0, 1), explanation: { steps: [], warnings: [] } }),
    ensureSource: t => { t.source_provenance = 'curated'; }, enrichSource: async () => {},
    resolveQuery: async t => ({ target_query: `検索語${t.slug}`, secondary_queries: [], slug_words: `url-${t.slug}` }),
    checkAI: async () => ({ results: [{ slug: '任意', duplicate: false }], skipped: false }),
    selfCheck: () => {}, factCheck: async content => ({ content, record: { status: 'ok', summary: '偽の照合' } }),
    ...extra,
  };
}
function failureReply(provider, kind) {
  if (kind === 'json') return { ok: true, json: async () => { throw new SyntaxError(secret); } };
  if (kind === 'shape') return { ok: true, json: async () => null };
  if (kind === 'empty') return provider === 'gateway' ? gateway('') : anthropic('');
  return provider === 'gateway' ? gateway('途中の本文', kind === 'filter' ? 'content_filter' : 'length')
    : anthropic('途中の本文', kind === 'filter' ? 'content_filter' : 'max_tokens');
}
const input = '## 工具\n\n減価償却の特例は30万円未満です。';
async function patch(text, options = {}, source = input) {
  const units = P.targetedSentences(source, topic(), S.findUnappliedRules(topic(), source), [], '');
  const unit = units.find(u => u.text.includes('30万円'));
  return P.postfixRules(source, { topic: topic(), articleType: 'basic_explainer', ...options,
    generateSimple: async prompt => {
      options.inspect?.(prompt);
      return { text: JSON.stringify({ replacements: [{ id: unit.id, text }] }) };
    } });
}

async function main() {
  await test('G1', 'ルール専用の指示文と成功時の確認警告', async () => {
    const result = await patch('減価償却の特例は40万円未満です。', { inspect: prompt => {
      assert(prompt.system.includes('ルールに合わせて書き換えてよい'));
      assert(prompt.system.includes('それ以外の数字・事実は変えない。新しい事実を足さない。'));
      assert(!prompt.system.includes('数字（金額・割合・期限・条番号）を書き換えない'));
    } });
    assert(result.applied);
    assert(result.warning.includes('論点別ルールを部分修正で反映: small_depreciable_assets（修正箇所が現行の制度に合うか確認してください）'));
  });
  await test('G1', '数字を変えない言い換えでも確認警告を残す', async () => {
    const result = await patch('減価償却の特例は30万円未満の資産です。');
    assert(result.applied); assert(result.warning.includes('部分修正で反映'));
  });
  await test('G1', '短縮の指示文は従来と同一、数字の変更も拒否', async () => {
    const result = await P.shortenBody(body(1000), { topic: topic(), articleType: 'basic_explainer',
      generateSimple: async prompt => {
        assert.equal(prompt.system, 'あなたは税務記事の編集者です。指定された番号の部分修正だけをJSONで返してください。全文・説明は返さないでください。見出し・表の列・免責文・CTA・出典の記載を削除変更しない。数字（金額・割合・期限・条番号）を書き換えない。削除は文ごとに行い、新しい事実を足さない。');
        return { text: JSON.stringify({ delete: [], replacements: [{ id: 2, text: '40万円です。' }] }) };
      } });
    assert.equal(result, null);
  });
  await test('G1', '成功警告と数字の変更履歴が下書きのreview_warningに残る', async () => {
    CM.generateContent = async () => ({ text: article(input), stopReason: 'end_turn' });
    CM.generateSimple = async () => ({ text: JSON.stringify({ replacements: [{ id: 1, text: '減価償却の特例は40万円未満です。' }] }) });
    const result = await G.generateArticle('2026-10-19', topic());
    const warning = G.parseFrontmatter(result.content).meta.review_warning;
    assert(warning.includes('論点別ルールを部分修正で反映: small_depreciable_assets'));
    assert(warning.includes('30万円→40万円（small_depreciable_assets）'));
  });
  for (const [replacement, allowed] of [['40万円', true], ['10万円', false], ['65%', false], ['10', false], ['30%', false]]) {
    await test('G2', `その文のルール本文だけで${replacement}を${allowed ? '許可' : '拒否'}`, async () => {
      S.CONDITIONAL_RULES.small_depreciable_assets.text = '取得価額40万円未満。根拠は第10条。';
      S.CONDITIONAL_RULES.review_rate = { scope: 'topic_specific', match: t => String(t.__body || '').includes('別の比率'), text: '別の比率は65%です。' };
      const source = input + '別の比率は50%です。';
      const result = await patch(`減価償却の特例は${replacement}未満です。`, {}, source);
      assert.equal(result.applied, allowed);
      if (allowed) assert(result.warning.includes('30万円→40万円（small_depreciable_assets）'));
      else { assert.equal(result.body, source); assert(result.warning.includes('論点別ルールが未反映')); }
    });
  }
  await test('G2', '前後の文には当該ルールの数字も追加できない', async () => {
    const source = input + '隣の説明は5件です。';
    const units = P.targetedSentences(source, topic(), S.findUnappliedRules(topic(), source), [], '');
    assert.equal(units[1].rules.length, 0);
    const result = await P.postfixRules(source, { topic: topic(), articleType: 'basic_explainer',
      generateSimple: async () => ({ text: JSON.stringify({ replacements: [{ id: units[1].id, text: '隣の説明は40万円です。' }] }) }) });
    assert(!result.applied); assert.equal(result.body, source);
  });
  await test('G2', '両方の文を直す場合も文ごとのルールと履歴を保持', async () => {
    S.CONDITIONAL_RULES.small_depreciable_assets.text = '40万円未満です。第10条。';
    S.CONDITIONAL_RULES.review_rate = { scope: 'topic_specific', match: t => String(t.__body || '').includes('別の比率'), text: '65%です。' };
    const source = input + '別の比率は50%です。';
    const result = await P.postfixRules(source, { topic: topic(), articleType: 'basic_explainer', generateSimple: async () => ({
      text: JSON.stringify({ replacements: [{ id: 1, text: '減価償却の特例は40万円未満です。' }, { id: 2, text: '別の比率は65%です。' }] }),
    }) });
    assert(result.applied);
    assert(result.warning.includes('30万円→40万円（small_depreciable_assets）'));
    assert(result.warning.includes('50%→65%（review_rate）'));
  });
  for (const unit of ['億円', '万円', '千円', '円', '%', '年度', '年分', '年', 'か月', 'ヶ月', 'カ月', '箇月', '月', '日', '時間', '時', '分', '秒', '倍', '人', '件', '歳']) {
    await test('G2', `単位「${unit}」を数字と組にして照合`, () => {
      assert(P.noNewNumbers(`30${unit}`, `40${unit}`, `40${unit}`));
      assert(!P.noNewNumbers(`30${unit}`, `10${unit}`, '第10条。'));
      assert(!P.noNewNumbers(`30${unit}`, '40', `40${unit}`));
    });
  }
  await test('G2', '全角・空白・桁区切りを正規化し、単位なしの数字は元の回数だけ許可', () => {
    assert(P.noNewNumbers('30万円', '４０ 万円', '40万円'));
    assert(P.noNewNumbers('500円', '1,000円', '１０００ 円'));
    assert(P.noNewNumbers('項目10と20万円', '項目10と40万円', '40万円。第10条'));
    assert(!P.noNewNumbers('項目10', '項目10と10', '第10条'));
  });
  await test('G2', '同じ文で金額と割合の順番が変わっても変更履歴の単位を対応づける', async () => {
    S.CONDITIONAL_RULES.small_depreciable_assets.text = '40万円未満、割合65%。';
    const result = await patch('減価償却の割合は65%で取得価額は40万円です。', {},
      '## 工具\n\n減価償却の特例は30万円で割合は20%です。');
    assert(result.applied);
    assert(result.warning.includes('30万円→40万円（small_depreciable_assets）'));
    assert(result.warning.includes('20%→65%（small_depreciable_assets）'));
    assert(!result.warning.includes('30万円→65%'));
  });
  for (const provider of ['gateway', 'anthropic']) for (const kind of ['length', 'empty', 'json', 'shape']) {
    await test('G3', `${provider} ${kind}は7日間除外し固定の理由を通知、保存・照合なし`, async () => {
      process.env.CONTENT_MODEL_PROVIDER = provider;
      reply = () => failureReply(provider, kind);
      const dir = freshDir(); let facts = 0;
      const opts = singleOptions(dir, { topics: [topic('a'), topic('b')], factCheck: async () => { facts++; } });
      const result = await G.runSingleDraft('2026-10-19', opts);
      assert.equal(result.results.length, 0); assert.equal(result.generations, 2); assert.equal(facts, 0);
      assert.equal(opts.recorder.additions.length, 2);
      for (const entry of opts.recorder.additions) {
        assert.equal(entry.stage, 'generation-failed-candidate');
        assert.equal(entry.expires_at, '2026-10-25T15:00:00.000Z');
      }
      assert(result.reason.includes(kind === 'length' ? '出力上限で途切れ' : '応答を読み取れない'));
      assert(!result.reason.includes('（Error）')); assert(!result.reason.includes(secret));
      assert(!logs.join('').includes(secret));
      assert.deepEqual(fs.readdirSync(dir), ['attempts.json']);
      assert(!fs.readFileSync(path.join(dir, 'attempts.json'), 'utf8').includes(secret));
    });
  }
  for (const provider of ['gateway', 'anthropic']) {
    for (const status of [402, 404]) await test('G4', `${provider} HTTP ${status}は当日終了し除外記録なし`, async () => {
      process.env.CONTENT_MODEL_PROVIDER = provider; reply = () => http(status);
      const opts = singleOptions(freshDir());
      const result = await G.runSingleDraft('2026-10-19', opts);
      assert.equal(result.generations, 1); assert.equal(requests.length, 1);
      assert.deepEqual(opts.recorder.additions, []); assert(result.reason.includes(`HTTP ${status}`));
      assert(!result.reason.includes(secret));
    });
    await test('G4', `${provider}同一状態番号が2候補連続したら3候補目を生成しない`, async () => {
      process.env.CONTENT_MODEL_PROVIDER = provider; reply = () => http(413);
      const opts = singleOptions(freshDir(), { env: { DRAFT_MAX_GENERATIONS: '4' } });
      const result = await G.runSingleDraft('2026-10-19', opts);
      assert.equal(result.generations, 2); assert.equal(result.candidates, 2); assert.equal(requests.length, 2);
      assert.equal(opts.recorder.additions.length, 1); assert(result.reason.includes('本日は生成しません'));
    });
    for (const middle of [422, 'shape']) await test('G4', `${provider}途中に${middle}を挟んだ同じ状態番号では終了しない`, async () => {
      process.env.CONTENT_MODEL_PROVIDER = provider;
      let count = 0;
      reply = () => {
        count++;
        if (count === 4) return provider === 'gateway' ? gateway() : anthropic();
        if (count === 2) return middle === 'shape' ? failureReply(provider, middle) : http(middle);
        return http(413);
      };
      const opts = singleOptions(freshDir(), { env: { DRAFT_MAX_GENERATIONS: '4' } });
      const result = await G.runSingleDraft('2026-10-19', opts);
      assert.equal(result.generations, 4); assert.equal(result.results.length, 1);
      assert.equal(opts.recorder.additions.length, 3);
    });
  }
  await test('G4', '2本・手動指定の経路も同一状態番号が続けば終了', async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway'; reply = () => http(422);
    const opts = singleOptions(freshDir());
    assert.deepEqual(await G.generateTopics(opts.topics, '2026-10-19', opts), []);
    assert.equal(requests.length, 2); assert.equal(opts.recorder.additions.length, 1);
  });
  for (const [date, expires] of [
    ['2026-10-18T14:59:59Z', '2026-10-24T15:00:00.000Z'],
    ['2026-10-18T15:00:00Z', '2026-10-25T15:00:00.000Z'],
    ['2026-10-19T14:59:59Z', '2026-10-25T15:00:00.000Z'],
    ['2026-12-31T16:00:00Z', '2027-01-07T15:00:00.000Z'],
  ]) await test('G5', `${date}の失敗はJSTの日付から7日後の0時まで`, () => {
    const recorder = W.createWithdrawalRecorder({ now: new Date(date), withdrawn: [], env: { WITHDRAWN_OUT: path.join(freshDir(), 'out.json') } });
    const entry = recorder.record(topic(), 'generation-failed-candidate');
    assert.equal(entry.expires_at, expires);
    assert(W.findWithdrawnTopic(topic(), recorder.entries, new Date(Date.parse(expires) - 1)));
    assert.equal(W.findWithdrawnTopic(topic(), recorder.entries, new Date(expires)), null);
  });
  await test('G5', '追記時に期限到達済みの一時除外だけを消し、恒久記録・順番・不明期限を保持', () => {
    const file = path.join(freshDir(), 'data.json');
    const permanent = { topic_id: 'permanent', stage: 'pregen-dedup', date: '2026-01-01', expires_at: '2026-01-01', reason: '恒久記録' };
    const live = { topic_id: 'live', stage: 'generation-failed-candidate', expires_at: '2026-10-20T00:00:00Z' };
    const invalid = { topic_id: 'invalid', stage: 'generation-failed-candidate', expires_at: '不明' };
    const expired = { topic_id: 'expired', stage: 'generation-failed-candidate', expires_at: now.toISOString() };
    fs.writeFileSync(file, JSON.stringify({ version: 1, comment: '旧説明', entries: [permanent, expired, live, invalid] }));
    const added = { topic_id: 'new', stage: 'select-dedup', date: '2026-10-19' };
    assert.deepEqual(W.appendWithdrawnTopics([added], file, now), [permanent, live, invalid, added]);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.comment, '日次生成で取り下げた題材。通常の選定では二度と選ばない（generation-failed-candidate は expires_at までの一時的な除外）。項目を消せば選定に戻る。');
    const before = fs.readFileSync(file, 'utf8');
    W.appendWithdrawnTopics([added], file, now); assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
  await test('G5', '項目数が同じになる追記でも後始末と新規追加を書き込む', () => {
    const file = path.join(freshDir(), 'data.json');
    fs.writeFileSync(file, JSON.stringify({ entries: [{ topic_id: 'old', stage: 'generation-failed-candidate', expires_at: '2026-10-18' }] }));
    W.appendWithdrawnTopics([{ topic_id: 'new', stage: 'pregen-dedup' }], file, now);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].topic_id, 'new');
  });
  await test('G5', '追加ゼロの書き込みでも期限切れ項目を後始末', () => {
    const file = path.join(freshDir(), 'data.json');
    fs.writeFileSync(file, JSON.stringify({ entries: [{ topic_id: 'old', stage: 'generation-failed-candidate', expires_at: '2026-10-18' }] }));
    assert.deepEqual(W.appendWithdrawnTopics([], file, now), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).entries, []);
  });
  await test('G6', 'Gatewayはcontent_filterを保持しlengthは従来どおりmax_tokens', async () => {
    for (const [finish, expected] of [['content_filter', 'content_filter'], ['length', 'max_tokens'], ['stop', 'end_turn']]) {
      reply = () => gateway('本文', finish);
      const result = await callGateway({ model: 'fake', system: '固定', user: '入力', maxTokens: 64000, task: '試験' });
      assert.equal(result.stopReason, expected);
    }
  });
  const routes = {
    full: () => G.regenerateWithContentModel(article(), '全体を整えてください'),
    targeted: () => G.regenerateTargeted(article(), '書類を確認してください'),
    section: () => G.regenerateSection(article(), '書類を確認してください', { type: 'section_rewrite', sectionHint: '書類' }),
    add_section: () => G.regenerateSection(article(), '補足を追加してください', { type: 'add_section' }),
  };
  for (const [name, run] of Object.entries(routes)) await test('G6', `Gateway ${name}のcontent_filterは失敗`, async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway'; reply = () => gateway('## 書類\n\n途中の本文', 'content_filter');
    await assert.rejects(run(), e => e.contentCandidateFailed && e.diagnostic === '応答を読み取れない');
    assert.equal(requests.length, 1);
  });
  await test('G6', 'Gatewayの日次content_filterも候補失敗として記録し保存しない', async () => {
    process.env.CONTENT_MODEL_PROVIDER = 'gateway'; reply = () => failureReply('gateway', 'filter');
    const opts = singleOptions(freshDir());
    const result = await G.runSingleDraft('2026-10-19', opts);
    assert.equal(result.results.length, 0); assert.equal(opts.recorder.additions.length, 2);
    assert(result.reason.includes('応答を読み取れない'));
  });
  for (const provider of ['gateway', 'anthropic']) for (const mode of ['h2', 'short', 'long']) for (const kind of ['length', 'json', 'shape']) {
    await test('G7', `${provider} ${mode}の2回目が${kind}でも完全な初回結果を保持`, async () => {
      process.env.CONTENT_MODEL_PROVIDER = provider;
      if (mode === 'short') process.env.LENGTH_RETRY_SHORT = 'true';
      if (mode === 'long') process.env.LENGTH_FIX_MODE = 'regenerate';
      const first = article(mode === 'h2' ? '初回の書類を確認します。'.repeat(550) + `\n\n${S.DISCLAIMER_TEXT}` : body(mode === 'short' ? 1 : 1500));
      let count = 0;
      reply = () => ++count === 1 ? (provider === 'gateway' ? gateway(first) : anthropic(first)) : failureReply(provider, kind);
      const result = await G.generateArticle('2026-10-19', topic());
      assert.equal(count, 2); assert(result.content.includes('初回の書類を確認します。'));
      assert(!result.content.includes('途中の本文')); assert(!result.content.includes(secret));
      assert(logs.some(line => line.includes('初回結果を使用')));
    });
  }
  await test('G8', '抽出・通知のidと段階別の結果をenv経由で受け取る', () => {
    const source = fs.readFileSync(path.join(root, '.github/workflows/regenerate-draft.yml'), 'utf8');
    assert.match(source, /name: Extract info for notification\s+id: fm/);
    assert.match(source, /name: Notify via Netlify\s+id: notify/);
    const failure = source.slice(source.indexOf('- name: 再生成の失敗を通知'));
    assert(failure.includes('EXTRACT_OUTCOME: ${{ steps.fm.outcome }}'));
    assert(failure.includes('NOTIFY_OUTCOME: ${{ steps.notify.outcome }}'));
    assert(failure.includes('if [ "$COMMIT_PUSH_OUTCOME" = "success" ] && { [ "$EXTRACT_OUTCOME" = "failure" ] || [ "$NOTIFY_OUTCOME" = "failure" ]; }; then'));
    assert(failure.includes('MESSAGE="完了通知に失敗（下書きは更新済み）。'));
    assert(failure.includes('MESSAGE="再生成処理に失敗しました（段階: $STAGE）'));
    assert(!failure.slice(failure.indexOf('run:')).includes('${{'));
  });
  await test('G8', '通知のrunにタイトル・イベント・入力の式を直接埋め込まない', () => {
    const source = fs.readFileSync(path.join(root, '.github/workflows/regenerate-draft.yml'), 'utf8');
    const notify = source.slice(source.indexOf('- name: Notify via Netlify'), source.indexOf('- name: 再生成の失敗を通知'));
    assert(notify.includes('REGEN_EVENT: ${{ steps.fm.outputs.event }}'));
    assert(notify.includes('REGEN_TITLE: ${{ steps.fm.outputs.title }}'));
    assert(notify.includes('--event "$REGEN_EVENT"')); assert(notify.includes('--title "$REGEN_TITLE"'));
    assert(!notify.slice(notify.indexOf('run:')).includes('${{'));
    assert(!/run:.*\$\{\{ inputs\./.test(source));
  });
}

main().finally(() => {
  global.fetch = original.fetch; console.log = original.log; console.warn = original.warn;
  CM.generateContent = original.generateContent; CM.generateSimple = original.generateSimple;
  S.CONDITIONAL_RULES.small_depreciable_assets.text = ruleText;
  delete S.CONDITIONAL_RULES.review_rate;
  restoreEnv(); fs.rmSync(temp, { recursive: true, force: true });
  let failed = 0;
  for (const [group, count] of Object.entries(groups)) {
    original.log(`${group}: PASS ${count.pass} / FAIL ${count.fail}`); failed += count.fail;
  }
  process.exitCode = failed ? 1 : 0;
}).catch(error => { original.log(error.stack); process.exitCode = 1; });
