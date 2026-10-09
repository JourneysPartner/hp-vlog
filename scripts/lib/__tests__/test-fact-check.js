'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const matter = require('gray-matter');
const F = require('../fact-check');
const { searchEvidence } = require('../fact-evidence');
const model = require('../content-model');
const ROOT = path.join(__dirname, '..', '..', '..');
let passed = 0, failed = 0;
const groups = {};
async function test(group, label, fn) {
  groups[group] ||= { pass: 0, fail: 0 };
  try { await fn(); passed++; groups[group].pass++; console.log(`PASS ${group} ${label}`); }
  catch (e) { failed++; groups[group].fail++; console.error(`FAIL ${group} ${label}: ${e.stack}`); }
}
const wrong = '結婚・子育て資金の一括贈与は令和8年3月31日までの拠出が対象です。';
const correct = '結婚・子育て資金の一括贈与は令和9年3月31日までの拠出が対象です。';
const subject = '結婚・子育て資金の一括贈与';
const c = (sentence = wrong, type = '期限', extras = {}) => ({ id: 'c1', sentence, heading: '制度', type, subject, claim: sentence, ...extras });
const evidence = [{ id: 'test-source', kind: 'taxanswer', no: '4511', title: subject, url: 'https://www.nta.go.jp/example', text: correct, law_version: '令和8年4月1日現在法令等' }];
const now = new Date('2026-10-09T00:00:00Z');
const raw = (body = wrong, rec = 'publish') => `---\ntitle: "贈与税の非課税を確認する"\nslug: "fact-test"\nsource_guard_version: 1\nsource_provenance: "curated"\nsource_url: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4511.htm"\nsource_title: "直系尊属から結婚・子育て資金の一括贈与を受けた場合の非課税"\ntax_domain: "inheritance_tax"\npain_point: "gift-exemption"\narticle_type: "basic_explainer"\nreview_status: "draft"\nrecommendation: "${rec}"\nreview_warning: "既存の注意"\n---\n${body}`;
const body = `導入の説明です。\n\n## 制度\n${wrong}\nこの説明はそのまま残します。\n\n## 確認\n資料を確認してから相談してください。\n`;
function fake(options = {}) {
  const calls = [];
  const fn = async request => {
    calls.push(request);
    if (request.task === 'extract') {
      if (request.user.includes(wrong)) return [c()];
      if (request.user.includes(correct)) return [c(correct)];
      return [];
    }
    if (request.task === 'judge') {
      const data = JSON.parse(request.user);
      return data.claims.map(claim => ({ id: claim.id, status: options.remain || claim.sentence.includes('令和8年') ? '食い違い' : '裏付けあり',
        quote: correct, correct, evidence_id: 'test-source' }));
    }
    if (request.task === 'repair') return options.revised || JSON.parse(request.user).body.replace(wrong, correct);
    throw new Error('未定義の呼び出し');
  };
  return { fn, calls };
}

async function main() {
  await test('R1', '本文に無い文を捨て、原文と見出しを保持', async () => {
    const result = await F.extractClaims(wrong, async () => [c(), c('本文にない文。')]);
    assert.equal(result.claims.length, 1); assert.equal(result.discarded, 1);
    assert.equal(result.claims[0].sentence, wrong); assert.equal(result.claims[0].heading, '制度');
  });
  await test('R1', '40件上限と8種類の優先順、落とした数', async () => {
    const items = Array.from({ length: 48 }, (_, i) => c(`主張${i}。`, ['番号', '適用年', '手続', '割合', '金額', '判定', '要件', '期限'][i % 8]));
    const result = await F.extractClaims(items.map(x => x.sentence).join(''), async () => items);
    assert.equal(result.claims.length, 40); assert.equal(result.dropped, 8);
    assert.equal(result.claims[0].type, '期限'); assert.equal(result.claims.at(-1).type, '適用年');
  });
  await test('R1', '環境変数による上限', () => {
    const old = process.env.FACT_CHECK_MAX_CLAIMS;
    process.env.FACT_CHECK_MAX_CLAIMS = '7';
    try { assert.equal(F.config().maxClaims, 7); } finally { if (old === undefined) delete process.env.FACT_CHECK_MAX_CLAIMS; else process.env.FACT_CHECK_MAX_CLAIMS = old; }
  });
  await test('R1', '想定事例の額を除き、制度の控除額・税率は残す', async () => {
    const items = [c('想定事例として100万円を贈与します。', '金額'), c('控除額は110万円です。', '金額', { heading: '想定事例' }), c('税率は10%です。', '割合', { heading: '想定事例' })];
    const result = await F.extractClaims(items.map(x => x.sentence).join(''), async () => items);
    assert.equal(result.claims.length, 2);
    assert.ok(result.claims.some(x => x.type === '割合'));
  });
  await test('R1', 'JSON配列以外は未実施に倒す', async () => {
    const result = await F.checkFacts(wrong, { callLLM: async () => '{}', now });
    assert.equal(result.record.status, 'not_run');
  });

  const cases = [
    { subject, sentence: '結婚・子育て資金の一括贈与の非課税は令和8年3月31日までの拠出が対象', kind: 'taxanswer', no: '4511', text: '令和9年3月31日' },
    { subject: '贈与税の配偶者控除', sentence: '贈与税の配偶者控除は、居住しているか、その見込みがあればよい', kind: 'law', no: '21_6', text: '翌年三月十五日まで' },
    { subject: '住宅取得等資金の贈与の非課税', sentence: '住宅取得等資金の贈与の非課税', kind: 'taxanswer', no: '4508', text: '令和8年12月31日' },
    { subject: '二世帯住宅 小規模宅地', sentence: '二世帯住宅は構造や出入口で判断が変わる', kind: 'taxanswer', no: '4124', text: '区分所有' },
    { subject: '小規模宅地 居住用宅地', sentence: '居住の用に供されなくなる直前の居住の用（措法69の4①）は建替え中の扱い', kind: 'law', no: '69_4', text: '居住の用に供されなくなる直前' },
    { subject: '棚卸資産 評価損', sentence: '届出がなければ売れ残り在庫を低く評価できない', kind: 'tsutatsu', no: '47-22', text: '季節商品' },
  ];
  for (const item of cases) await test('R2', `実データ ${item.kind} ${item.no} が上位3件`, () => {
    const refs = searchEvidence({ ...item, claim: item.sentence });
    const matched = refs.find(r => r.kind === item.kind && r.no === item.no);
    assert.ok(matched, JSON.stringify(refs.map(r => [r.kind, r.no])));
    assert.ok(matched.text.includes(item.text));
    if (item.no === '4124') assert.ok(matched.text.includes('建物の区分所有等に関する法律第1条'));
    assert.ok(refs.every(r => r.text.length <= 2000));
    assert.ok(refs.filter(r => r.kind === 'taxanswer').every(r => r.law_version));
    const at = matched.text.indexOf(item.text);
    console.log('実データ 根拠:', JSON.stringify({ claim: item.sentence, rank: refs.indexOf(matched) + 1, kind: matched.kind, no: matched.no,
      url: matched.url, law_version: matched.law_version, quote: matched.text.slice(Math.max(0, at - 100), at + 210) }));
  });
  await test('R2', '番号とsource_bundleを直接検索、無関係な主張には根拠なし', () => {
    assert.ok(searchEvidence(c('相続税法21条の6の居住要件', '番号')).some(e => e.id === 'law:sozokuzei:21_6'));
    assert.ok(searchEvidence(c('TA No.4511', '番号')).some(e => e.no === '4511'));
    assert.equal(searchEvidence({ subject: 'zzzzzzz', claim: 'zzzzzzz', sentence: 'zzzzzzz' }).length, 0);
    assert.ok(searchEvidence(c(), { source_bundle: evidence[0].url }).length <= 3);
  });
  await test('R3', '捏造した引用の裏付けありは資料なし', async () => {
    const results = await F.judgeClaims([c()], { c1: evidence }, wrong, async () => [{ id: 'c1', status: '裏付けあり', quote: '資料にない期限' }], { now });
    assert.equal(results[0].status, '資料なし'); assert.equal(results[0].quote, '');
  });
  await test('R3', '根拠0件は判定モデルに送らない', async () => {
    const results = await F.judgeClaims([c()], {}, wrong, async () => { throw new Error('呼んではならない'); });
    assert.equal(results[0].status, '資料なし');
  });
  await test('R3', '10件ずつまとめ、基準日の古さに注意', async () => {
    const claims = Array.from({ length: 21 }, (_, i) => ({ ...c(correct), id: `c${i}` }));
    let calls = 0;
    const results = await F.judgeClaims(claims, Object.fromEntries(claims.map(x => [x.id, [{ ...evidence[0], law_version: '令和5年4月1日現在法令等' }]])), correct,
      async req => { calls++; const batch = JSON.parse(req.user).claims; assert.ok(batch.length <= 10); return batch.map(x => ({ id: x.id, status: '裏付けあり', quote: correct })); }, { now });
    assert.equal(calls, 3); assert.ok(results.every(r => r.warning === '注意: 根拠の基準日が古い'));
  });
  await test('R3', '空白・全角半角だけを揃えた引用が有効', async () => {
    const results = await F.judgeClaims([c()], { c1: evidence }, wrong, async () => [{ id: 'c1', status: '食い違い', quote: correct.replace('9', '９').replace('拠出', '拠 出'), correct }], { now });
    assert.equal(results[0].status, '食い違い');
  });
  await test('R3', '欠落・重複・未知の判定と空引用を資料なしへ戻す', async () => {
    for (const data of [[], [{ id: 'c1', status: '不明', quote: correct }], [{ id: 'c1', status: '裏付けあり', quote: '' }], [{ id: 'c1', status: '裏付けあり', quote: correct }, { id: 'c1', status: '裏付けあり', quote: correct }]]) {
      const r = await F.judgeClaims([c()], { c1: evidence }, wrong, async () => data, { now }); assert.equal(r[0].status, '資料なし');
    }
  });
  await test('R3', '照合のモデル設定は本文生成と独立し、失敗時にfallbackしない', async () => {
    assert.deepEqual([F.config({}).provider, F.config({}).model], ['anthropic', 'claude-opus-5-5']);
    const saved = model.generateContent, requests = [];
    model.generateContent = async (prompt, opts) => { requests.push(opts); throw new Error('秘密のテスト値'); };
    try {
      const r = await F.checkFacts(wrong, { provider: 'openai', model: 'test-model', now });
      assert.equal(r.record.status, 'not_run'); assert.equal(requests[0].model, 'test-model');
      assert.equal(requests[0].provider, 'openai'); assert.equal(requests[0].fallback, false);
      assert.ok(!JSON.stringify(r).includes('秘密のテスト値'));
    } finally { model.generateContent = saved; }
  });
  await test('R4', '食い違いの修正・文の対・直した文だけを1回再照合', async () => {
    const llm = fake();
    const r = await F.checkFacts(body, { callLLM: llm.fn, searchEvidence: () => evidence, now });
    assert.equal(r.record.status, 'ok'); assert.ok(r.body.includes(correct));
    assert.equal(llm.calls.filter(x => x.task === 'repair').length, 1);
    assert.equal(llm.calls.filter(x => x.task === 'extract').length, 2);
    assert.ok(!llm.calls.filter(x => x.task === 'extract')[1].user.includes('そのまま残します'));
    assert.equal(r.record.corrections[0].before, wrong); assert.equal(r.record.corrections[0].after, correct);
    assert.ok(JSON.parse(llm.calls.find(x => x.task === 'repair').user).corrections[0].evidence[0].text.includes(correct));
    assert.equal(r.record.calls.length, 5);
    console.log('照合費用の実測（偽LLM）:', JSON.stringify(r.record.calls));
  });
  await test('R4', '再照合で食い違いが残っても2回目の修正をしない', async () => {
    const llm = fake({ remain: true });
    const r = await F.checkFacts(body, { callLLM: llm.fn, searchEvidence: () => evidence, now });
    assert.equal(r.record.status, 'revise'); assert.equal(llm.calls.filter(x => x.task === 'repair').length, 1);
  });
  await test('R4', '期限の書き漏れは期限を1文足し、再照合する', async () => {
    const sentence = '住宅取得等資金の贈与の非課税制度があります。';
    const deadline = 'この制度は令和8年12月31日までの贈与が対象です。';
    const original = `## 制度\n${sentence}\n本文はそのまま残します。`;
    const source = [{ ...evidence[0], text: deadline }];
    const callLLM = async req => {
      if (req.task === 'extract') return [c(req.user.includes(deadline) ? deadline : sentence, '期限', { subject: '住宅取得等資金' })];
      if (req.task === 'judge') return JSON.parse(req.user).claims.map(x => ({ id: x.id, status: x.sentence === sentence ? '期限の書き漏れ' : '裏付けあり', quote: deadline, correct: deadline }));
      return original.replace(sentence, sentence + deadline);
    };
    const r = await F.checkFacts(original, { callLLM, searchEvidence: () => source, now });
    assert.equal(r.record.status, 'ok'); assert.ok(r.body.includes(deadline));
    assert.ok(r.record.corrections[0].after.includes(deadline));
  });
  await test('R4', '資料なしの期限を案内にし、番号は消す指示', async () => {
    const general = '詳しくは国税庁の結婚・子育て資金の資料で確認してください。';
    const calls = [];
    const r = await F.checkFacts(body, { searchEvidence: () => [], now, callLLM: async req => {
      calls.push(req); if (req.task === 'extract') return req.user.includes(wrong) ? [c()] : [];
      return JSON.parse(req.user).body.replace(wrong, general);
    } });
    assert.equal(r.record.status, 'ok'); assert.ok(r.body.includes(general)); assert.ok(r.record.corrections[0].generalized);
    assert.ok(F.repairInstructions([{ ...c(), status: '資料なし' }])[0].instruction.includes('具体的'));
    assert.ok(F.repairInstructions([{ ...c(wrong, '番号'), status: '資料なし' }])[0].instruction.includes('番号を消し'));
    assert.equal(calls.filter(x => x.task === 'judge').length, 0);
  });
  await test('R4', '短縮・見出し変更・他の文の書き換え・作業語の混入を拒否', async () => {
    for (const revised of ['短い。', body.replace('## 制度', '## 別の構成').replace(wrong, correct), body.replace('そのまま残します', '勝手に書き換えます').replace(wrong, correct), body.replace(wrong, '差し戻しコメントを確認しました。')]) {
      const llm = fake({ revised });
      const r = await F.checkFacts(body, { callLLM: llm.fn, searchEvidence: () => evidence, now });
      assert.equal(r.body, body); assert.equal(r.record.status, 'revise'); assert.ok(r.record.repair_warning);
    }
  });
  await test('R4', '具体が未修正なら資料なしでも止め、上限で未照合も止める', async () => {
    const unchanged = fake({ revised: body });
    const r = await F.checkFacts(body, { callLLM: unchanged.fn, searchEvidence: () => [], now });
    assert.equal(r.record.status, 'revise');
    const items = [c('期限の主張。'), c('要件の主張。', '要件')];
    const cap = await F.checkFacts(items.map(x => x.sentence).join(''), { maxClaims: 1, repair: false, searchEvidence: () => evidence, now,
      callLLM: async req => req.task === 'extract' ? items : [{ id: 'c1', status: '裏付けあり', quote: correct }] });
    assert.equal(cap.record.status, 'revise'); assert.equal(cap.record.dropped, 1);
  });
  await test('R4', '修正後に別制度の主張を足した場合も再照合で止める', async () => {
    const extra = '別制度では999万円を控除します。';
    const llm = fake({ revised: body.replace(wrong, correct + extra) });
    const call = async req => req.task === 'extract' && req.user.includes(extra) ? [c(correct), c(extra, '金額', { subject: '別制度' })] : llm.fn(req);
    const r = await F.checkFacts(body, { callLLM: call, searchEvidence: claim => claim.subject === '別制度' ? [] : evidence, now });
    assert.equal(r.record.status, 'revise'); assert.ok(r.record.remaining.some(x => x.subject === '別制度'));
  });

  await test('R5', 'okで既存frontmatter・注意を保持しJSONへ詳細を保存', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-record-'));
    try {
      const llm = fake();
      const r = await F.checkArticle(raw(body), { callLLM: llm.fn, searchEvidence: () => evidence, recordDir: dir, now });
      const meta = matter(r.content).data;
      assert.equal(meta.fact_check_version, 1); assert.equal(meta.fact_check_status, 'ok'); assert.equal(meta.recommendation, 'publish');
      assert.ok(meta.review_warning.includes('既存の注意'));
      const record = JSON.parse(fs.readFileSync(path.join(dir, 'fact-test.json'), 'utf8'));
      assert.equal(record.slug, 'fact-test'); assert.equal(record.corrections[0].before, wrong);
      assert.ok(!r.content.includes('evidence_id:'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('R5', 'revise・not_runで既存承認ゲートを止める', async () => {
    for (const options of [{ callLLM: async () => { throw new Error('秘密'); } }, { callLLM: fake({ remain: true }).fn, searchEvidence: () => evidence }]) {
      const result = await F.checkArticle(raw(body), { ...options, now, persist: false });
      assert.equal(matter(result.content).data.recommendation, 'revise');
      assert.ok(matter(result.content).data.review_warning.includes('既存の注意'));
    }
  });
  await test('R5', '無効化とfail-open、食い違いのfail-openは禁止', async () => {
    const disabled = await F.checkArticle(raw(), { enabled: false, persist: false, now });
    assert.equal(disabled.record.summary, '照合を無効にしています'); assert.equal(matter(disabled.content).data.recommendation, 'revise');
    const open = await F.checkArticle(raw(), { enabled: false, failOpen: true, persist: false, now });
    assert.equal(matter(open.content).data.recommendation, 'publish'); assert.equal(matter(open.content).data.fact_check_status, 'not_run');
    const remain = await F.checkArticle(raw(body), { failOpen: true, persist: false, callLLM: fake({ remain: true }).fn, searchEvidence: () => evidence, now });
    assert.equal(matter(remain.content).data.recommendation, 'revise');
  });
  await test('R5', '再照合で照合だけのreviseを外し、他のrevise・rejectを残す', async () => {
    for (const previous of ['publish', 'revise', 'reject']) {
      const blocked = await F.checkArticle(raw(body, previous), { enabled: false, persist: false, now });
      const fixed = await F.checkArticle(blocked.content, { persist: false, callLLM: fake().fn, searchEvidence: () => evidence, now });
      assert.equal(matter(fixed.content).data.recommendation, previous);
      assert.equal(matter(fixed.content).data.fact_check_prev_recommendation, previous);
      assert.ok(!matter(fixed.content).data.review_warning.includes('照合を無効'));
    }
  });
  await test('R5', '環境変数で無効化・fail-open、記録パスの逸脱禁止', async () => {
    const oldEnabled = process.env.FACT_CHECK_ENABLED, oldOpen = process.env.FACT_CHECK_FAIL_OPEN;
    process.env.FACT_CHECK_ENABLED = 'false'; process.env.FACT_CHECK_FAIL_OPEN = 'true';
    try { const r = await F.checkArticle(raw(), { persist: false }); assert.equal(r.record.status, 'not_run'); assert.equal(matter(r.content).data.recommendation, 'publish'); }
    finally { for (const [key, val] of [['FACT_CHECK_ENABLED', oldEnabled], ['FACT_CHECK_FAIL_OPEN', oldOpen]]) { if (val === undefined) delete process.env[key]; else process.env[key] = val; } }
    assert.throws(() => F.recordPath('../secret'));
  });
  await test('R5', '既存承認処理で照合reviseを400にする（外部書込み0）', async () => {
    const approval = require('../../../netlify/functions/review-approve-background');
    const blocked = await F.checkArticle(raw(), { enabled: false, persist: false });
    const sourceGuard = require('../source-guard');
    const saved = sourceGuard.evaluateSourceGuard;
    // 出典関門は他のテストで確認済み。ここは実在のcurated出典で承認処理に入る。
    assert.ok(!sourceGuard.evaluateSourceGuard(matter(blocked.content).data, { stage: 'approve' }).blocked);
    let writes = 0;
    const r = await approval._handler({ httpMethod: 'POST', body: JSON.stringify({ filename: '2026-10-09-fact-test.md' }) }, {
      getFile: async () => ({ content: blocked.content, sha: 'test-sha' }), putFile: async () => { writes++; }, sendNotification: async () => {},
    });
    assert.equal(r.statusCode, 400); assert.equal(writes, 0); assert.ok(r.body.includes('recommendation が revise'));
    assert.equal(sourceGuard.evaluateSourceGuard, saved);
  });
  await test('R6', '3状態と記録なしを描画、XSSをエスケープし欄を追加', () => {
    const page = require('../../../netlify/functions/review-page');
    for (const status of ['ok', 'revise', 'not_run']) {
      const html = page.renderFactCheck({ fact_check_status: status, fact_check_summary: '要約' }, { status, corrections: [], remaining: [] });
      assert.ok(html.includes('事実の照合') && html.includes(status) && html.includes('要約'));
    }
    assert.ok(page.renderFactCheck({}, null).includes('照合の記録なし'));
    const html = page.renderFactCheck({}, { corrections: [{ before: '<script>bad()</script>', after: '新しい文', evidence, generalized: false, resolved: true }],
      remaining: [{ sentence: '<img src=x>', status: '食い違い', correct, evidence }] });
    assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>bad'));
    assert.ok(html.includes('alert-danger') && html.includes('https://www.nta.go.jp/example'));
    const full = page.renderReviewPage('file.md', { refresh_of: 'published' }, '本文', 'draft/refresh-test', { available: true, diff: [] }, { corrections: [], remaining: [] });
    assert.ok(full.indexOf('変更箇所</div>') < full.indexOf('事実の照合</div>'));
  });
  await test('R6', 'JSONを指定した下書きの枝から読み、記録なしはnull', async () => {
    const page = require('../../../netlify/functions/review-page'), api = require('../../../netlify/functions/lib/github-api');
    const saved = api.getFile;
    try {
      api.getFile = async (file, ref) => { assert.equal(file, 'data/fact-check/fact-test.json'); assert.equal(ref, 'draft/test'); return { content: JSON.stringify({ version: 1, slug: 'fact-test' }) }; };
      assert.ok(await page.fetchFactCheck('fact-test', 'draft/test'));
      api.getFile = async () => { throw new Error('404'); };
      assert.equal(await page.fetchFactCheck('fact-test', 'draft/test'), null);
      assert.equal(await page.fetchFactCheck('../bad', 'draft/test'), null);
    } finally { api.getFile = saved; }
  });
  await test('R7', '新規・2本・force-slug相当、重複判定の後だけ照合', async () => {
    const generate = require('../../generate-draft');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-routes-'));
    const order = [];
    let selfChecks = 0;
    try {
      const topics = ['first', 'second'].map(slug => ({ slug, url_slug: slug, article_type: 'basic_explainer' }));
      const result = await generate.generateTopics(topics, '2026-10-09', { postsDir: dir, selfCheck: () => { selfChecks++; },
        generateArticle: async (_, t) => ({ content: raw(body).replace('fact-test', t.slug) }),
        checkGenerated: async (_, t) => { order.push(`dedup:${t.slug}`); return { duplicate: false }; },
        factCheck: async content => { const slug = matter(content).data.slug; order.push(`fact:${slug}`); return { content, record: { status: 'ok', summary: '照合済み' } }; },
      });
      assert.equal(result.length, 2); assert.deepEqual(order, ['dedup:first', 'fact:first', 'dedup:second', 'fact:second']);
      assert.equal(selfChecks, 2, '照合で本文を変えないときは点検を重複させない');
      const skipped = await generate.generateTopics([topics[0]], '2026-10-09', { postsDir: dir, selfCheck: () => {},
        generateArticle: async () => ({ content: raw(body) }), checkGenerated: async () => ({ duplicate: true, similar_to: 'existing', reason: '重複' }),
        factCheck: async () => { throw new Error('取り下げで呼んではならない'); } });
      assert.equal(skipped.length, 0);
      const zero = await generate.generateTopics([], '2026-10-09', { factCheck: async () => { throw new Error('0本で呼んではならない'); } });
      assert.equal(zero.length, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('R7', '照合で本文を直した場合は既存の自己点検を再実行する', async () => {
    const generate = require('../../generate-draft');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-self-check-'));
    let selfChecks = 0;
    try {
      await generate.generateTopics([{ slug: 'fact-test', article_type: 'basic_explainer' }], '2026-10-09', {
        postsDir: dir, selfCheck: () => { selfChecks++; }, generateArticle: async () => ({ content: raw(body) }),
        checkGenerated: async () => ({ duplicate: false }),
        factCheck: async content => ({ content: content.replace(wrong, correct), record: { status: 'ok', summary: '修正済み' } }),
      });
      assert.equal(selfChecks, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('R7', '差し戻し3経路・題名だけは前回結果を引継ぎ', async () => {
    const generate = require('../../generate-draft');
    const existing = (await F.checkArticle(raw(body), { enabled: false, persist: false })).content;
    for (const scope of ['targeted', 'section', 'full']) {
      let calls = 0;
      const result = await generate.finalizeRegeneration(existing, existing, { scope }, { factCheck: async content => {
        calls++; assert.equal(matter(content).data.fact_check_status, 'not_run');
        return F.checkArticle(content, { persist: false, callLLM: fake().fn, searchEvidence: () => evidence, now });
      } });
      assert.equal(calls, 1); assert.equal(matter(result).data.fact_check_status, 'ok'); assert.equal(matter(result).data.recommendation, 'publish');
    }
    const onlyTitle = await generate.finalizeRegeneration(existing, existing.replace('贈与税の非課税を確認する', '新しい題名'), { scope: 'frontmatter', type: 'title_only' },
      { factCheck: async () => { throw new Error('題名だけで呼んではならない'); } });
    assert.equal(matter(onlyTitle).data.fact_check_status, 'not_run'); assert.equal(matter(onlyTitle).content, matter(existing).content);
  });
  await test('R7', '更新案の最終本文だけ照合し、公開中の原本には書かない', async () => {
    const generate = require('../../generate-draft');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-refresh-'));
    try {
      const file = '2026-10-09-fact-test.md';
      fs.writeFileSync(path.join(dir, file), raw(body).replace('"draft"', '"published"'));
      const reasonsFile = path.join(dir, 'reasons.json');
      fs.writeFileSync(reasonsFile, JSON.stringify([{ kind: 'tax_reform', detail: '制度の期限を更新', where: '## 制度' }]));
      let calls = 0;
      const result = await generate.runRefreshMode([], { postsDir: dir, filename: file, reasonsFile,
        regenerateSection: async content => content.replace(wrong, correct), regenerateTargeted: async content => content.replace(wrong, correct),
        factCheck: async content => { calls++; assert.ok(matter(content).content.includes(correct)); return { content, record: { status: 'ok', summary: '照合済み' } }; }, now });
      assert.equal(result.status, 'changed'); assert.equal(calls, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('R7', '再生成で追加した注意と照合以外の新しいrevise・rejectを保持', async () => {
    for (const enabled of [true, false]) {
      const existing = (await F.checkArticle(raw(body), { enabled, persist: false, callLLM: fake().fn, searchEvidence: () => evidence, now })).content;
      for (const recommendation of ['revise', 'reject']) {
      const regenerated = F.updateMeta(existing, { recommendation, review_warning: '主出典が汎用ページで、論点に合う資料が見つからない' });
      const inherited = F.inheritFactMetadata(existing, regenerated);
      assert.equal(matter(inherited).data.fact_check_prev_recommendation, recommendation);
      const fixed = await F.checkArticle(inherited, { persist: false, callLLM: fake().fn, searchEvidence: () => evidence, now });
      assert.equal(matter(fixed.content).data.recommendation, recommendation);
      assert.ok(matter(fixed.content).data.review_warning.includes('主出典が汎用ページ'));
      assert.ok(matter(fixed.content).data.review_warning.includes('既存の注意'));
      }
    }
  });
  await test('R8', '手動スクリプトは既定で本文を変更せず、writeでだけ反映', async () => {
    const manual = require('../../fact-check-article');
    for (const write of [false, true]) {
      let writes = 0;
      const r = await manual.run(['content/posts/example.md', '--ref', 'draft/test', ...(write ? ['--write'] : [])], {
        readArticle: (_, ref) => { assert.equal(ref, 'draft/test'); return raw(body); },
        writeArticle: () => { writes++; }, log: () => {}, skipSummary: true, persist: false,
        callLLM: fake().fn, searchEvidence: () => evidence, now,
      });
      assert.equal(writes, write ? 1 : 0); assert.equal(r.record.status, write ? 'ok' : 'revise');
    }
    await assert.rejects(manual.run(['../outside.md']));
    await assert.rejects(manual.run(['article.md', '--ref', '--bad']));
  });
  await test('R8', 'ワークフローは手動・読取のみ、3経路で設定と対応記録を保存', () => {
    const workflows = ['daily-draft', 'regenerate-draft', 'refresh-article', 'fact-check'].map(name => fs.readFileSync(path.join(ROOT, `.github/workflows/${name}.yml`), 'utf8'));
    assert.ok(workflows.every(text => text.includes('FACT_CHECK_PROVIDER:') && text.includes('FACT_CHECK_MODEL:')));
    assert.ok(workflows.slice(0, 3).every(text => text.includes('git add') && text.includes('data/fact-check/')));
    assert.ok(workflows[0].includes('/tmp/fact-check1.json') && workflows[0].includes('/tmp/fact-check2.json'));
    assert.ok(workflows[1].includes('regenerated-fact-check.json'));
    assert.ok(workflows[3].includes('workflow_dispatch:') && workflows[3].includes('contents: read'));
    assert.ok(!/git commit|git push/.test(workflows[3]));
    const yaml = require('js-yaml'); for (const text of workflows) assert.ok(yaml.load(text));
  });
  console.log(`\n事実照合: PASS ${passed} / FAIL ${failed}`);
  console.log('R別集計:', JSON.stringify(groups));
  process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
