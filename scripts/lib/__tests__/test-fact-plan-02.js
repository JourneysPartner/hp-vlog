'use strict';

// 02の回帰試験。通信は偽LLM・偽Gatewayだけを使い、作業ファイルはTEMPへ置く。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../fact-check');
const W = require('../writer-materials');
const H = require('./fact-pages-test-helpers');
const cases = [], groups = {};
const test = (group, name, run) => cases.push({ group, name, run });
const opts = { now: new Date('2026-10-21T00:00:00Z'), provider: 'anthropic', model: 'claude-opus-5-5', enabled: true, batch: false, repair: false };
const ref = (id, title, text) => ({ id, kind: 'taxanswer', title, url: 'https://example.jp/' + id, text });
const extract = (req, type = '金額', subject = '試験制度') => [...req.user.matchAll(/^\[(\d+)\] (.*)$/gm)]
  .filter(m => !m[2].startsWith('#')).map(m => ({ s: +m[1], type, subject, claim: m[2] }));
const supported = req => H.readPayload(req).claims.map(c => ({ id: c.id, status: '裏付けあり', evidence_id: c.evidence_ids[0], basis: '1' }));
const writer = { writer_materials: ['ta:4103'] };
const condition = (verdict = '一致', correct = '') => ({ verdict, conditions: [{
  article: verdict === '不一致' ? '直系卑属または推定相続人' : '受贈者の条件',
  source: verdict === '不一致' ? '直系卑属である推定相続人または孫' : '受贈者の条件', match: verdict,
}], correct });
async function env(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await run(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const claim = (id, text, type = '金額', subject = '試験制度') => ({ id, sentence: text, heading: '', type, subject, claim: text });

test('W1〜W3', '1: 日次・全文差し戻し・更新案と計画に規則の原文が入り、切替falseでも出典の厳守6とW規則を保持', async () => {
  const CM = require('../content-model'), G = require('../../generate-draft'), P = require('../article-plan');
  const { WRITER_RULES } = require('../grounding-rules');
  const source = W.resolveMaterial('ta:4452');
  const t = { slug: 'plan02-write', title: '贈与税の配偶者控除を確認する', persona: 'test', article_type: 'basic_explainer',
    tax_domain: 'inheritance_gift_tax', tax_terms: '贈与税 配偶者控除', source_url: source.url, source_title: source.title, source_provenance: 'curated', source_confidence: 1 };
  const meta = { ...t, fact_plan_status: 'ok', fact_plan: '贈与税の配偶者控除', fact_plan_missing: '', fact_materials: 'ta:4452' };
  const matter = require('gray-matter'), raw = matter.stringify('## 確認\n確認します。', meta);
  const old = { content: CM.generateContent, simple: CM.generateSimple }; const prompts = [];
  const capture = req => { prompts.push([req.staticSystem, req.dynamicSystem, req.system, req.user].filter(Boolean).join('\n')); return { text: raw, provider: 'anthropic', model: 'fake', stopReason: 'end_turn' }; };
  CM.generateContent = async req => capture(req);
  CM.generateSimple = async req => req.system === P.PLAN_SYSTEM ? { text: '[{"name":"贈与税の配偶者控除"}]' } : capture(req);
  const hasRules = text => { for (const rule of WRITER_RULES) assert(text.includes(rule), rule); };
  try {
    await env({ FACT_PLAN_ENABLED: 'true' }, async () => {
      await G.generateWithContentModel('2026-10-21', { ...t }); const daily = prompts.pop(); hasRules(daily);
      assert(daily.includes('═══ この記事で扱う制度と資料 ═══'));
      for (const rule of WRITER_RULES) assert.equal(daily.split(rule).length - 1, 1, rule);
      await G.regenerateWithContentModel(raw, '確認する'); hasRules(prompts.pop());
      const blocks = await G.buildRegenSourceBlocks(meta, '確認します。', { enrichTaxTerms: async () => {}, resolveSupplement: async () => null });
      hasRules(blocks.combined); hasRules(P.buildPlanBlock([{ name: '贈与税の配偶者控除', materials: [source] }]));
      // 更新案が実際に使う差し戻し経路をTEMPの公開記事で通す。
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan02-refresh-'));
      try {
        const filename = '2026-10-01-plan02-write.md', reasonsFile = path.join(dir, 'reasons.json');
        fs.writeFileSync(path.join(dir, filename), raw.replace('確認します。', '令和7年分の申告を確認します。'));
        fs.writeFileSync(reasonsFile, JSON.stringify([{ kind: 'fiscal_year', detail: '年分', where: '## 確認' }]));
        const revise = async input => {
          const parsed = matter(input);
          const b = await G.buildRegenSourceBlocks(parsed.data, parsed.content, { enrichTaxTerms: async () => {}, resolveSupplement: async () => null });
          hasRules(b.combined); return input.replace('令和7年分', '令和8年分');
        };
        const r = await G.runRefreshMode([], { postsDir: dir, filename, reasonsFile, now: opts.now, factAudit: null,
          regenerateSection: revise, regenerateTargeted: revise, factCheck: async content => ({ content, record: { status: 'ok', summary: '確認済み' } }) });
        assert.equal(r.status, 'changed');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    await env({ FACT_PLAN_ENABLED: 'false' }, async () => {
      await G.generateWithContentModel('2026-10-21', { ...t }); const prompt = prompts.pop();
      hasRules(prompt); assert(!prompt.includes('═══ この記事で扱う制度と資料 ═══'));
      assert(prompt.includes('説明のための設例であっても、出典に無い数値を自分で作ってはならない'));
    });
  } finally { CM.generateContent = old.content; CM.generateSimple = old.simple; }
});

test('G1', '2: 全段を偽Gatewayへ送り、64,000 tokens・900秒・使用量・即時・鍵と応答を記録しないことを確認', async () => {
  const CM = require('../content-model'), previous = { fetch: global.fetch, log: console.log, warn: console.warn, timer: global.setTimeout, batch: CM.createBatchContext };
  const logs = [], requests = [], timers = [], secret = 'plan02-gateway-secret', wrong = '18歳以上の直系卑属または推定相続人が対象です。';
  const fixed = '18歳以上の直系卑属である推定相続人または孫が対象です。';
  const source = ref('gateway-source', '相続時精算課税', fixed + '\n限度額は200万円です。\n申請書を税務署へ提出します。');
  let round = 0;
  console.log = console.warn = (...args) => logs.push(args.join(' '));
  CM.createBatchContext = () => { throw new Error('GatewayでBatchを作ってはいけません'); };
  global.setTimeout = (fn, ms, ...args) => { timers.push(ms); return previous.timer(fn, ms, ...args); };
  global.fetch = async (url, input) => {
    const b = JSON.parse(input.body), system = b.messages[0].content, user = b.messages[1].content;
    requests.push({ url, body: b }); let answer;
    if (system.startsWith('記事本文から')) {
      round++; answer = extract({ user }, '要件', '相続時精算課税').map(c => c.claim.includes('万円') ? { ...c, type: '金額' } : c);
    } else if (system.startsWith('記事の文が')) {
      const pair = JSON.parse(user); answer = condition(pair.article === wrong ? '不一致' : '一致', fixed);
    } else {
      const p = JSON.parse(user);
      if (p.corrections) answer = p.corrections.map(c => ({ id: c.id, replacement: c.type === '金額' ? p.previous ? '限度額は200万円です。' : c.sentence : fixed }));
      else answer = p.claims.map(c => {
        if (c.claim.includes('申請書') && p.claims.length > 1) return { id: c.id, status: '資料なし' };
        return { id: c.id, status: c.type === '金額' && round === 1 ? '食い違い' : '裏付けあり', evidence_id: c.evidence_ids[0],
          basis: c.type === '金額' ? '2' : c.claim.includes('申請書') ? '3' : '1', correct: p.retry ? '限度額は200万円です。' : '限度額は999万円です。' };
      });
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 22 } }) };
  };
  try {
    await env({ FACT_CHECK_PROVIDER: 'gateway', FACT_CHECK_MODEL: 'zai/glm-5.3-flash', FACT_CHECK_EXTRACT_MODEL: 'zai/extract',
      FACT_CHECK_EFFORT: 'invalid', FACT_CHECK_EXTRACT_EFFORT: 'invalid', AI_GATEWAY_API_KEY: secret }, async () => {
      const result = await F.checkFacts([wrong, '限度額は100万円です。', '申請書を税務署へ提出します。'].join('\n'), {
        now: opts.now, enabled: true, repair: true, batch: true, ...writer, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
      });
      assert.equal(result.record.status, 'ok'); assert.equal(result.record.effort, null); assert.equal(result.record.extract_effort, null);
      const tasks = result.record.calls.map(c => c.task);
      for (const task of ['extract', 'judge', 'stage_b_judge', 'retry_judge', 'condition_check', 'repair', 'retry_repair', 'recheck_extract', 'recheck_judge', 'recheck_condition_check']) assert(tasks.includes(task), task);
      assert(result.record.calls.every(c => c.mode === 'sync' && c.usage.input_tokens === 11 && c.usage.output_tokens === 22));
      assert(requests.every(r => r.url === 'https://ai-gateway.vercel.sh/v1/chat/completions' && r.body.max_tokens === 64000 && !('effort' in r.body)));
      assert(requests.some(r => r.body.model === 'zai/extract')); assert(requests.some(r => r.body.model === 'zai/glm-5.3-flash'));
      assert(timers.length > 0 && timers.every(t => t === 900000));
      assert(!JSON.stringify(result.record).includes(secret)); assert(!logs.join('\n').includes(secret));
      assert(!logs.some(s => s.includes('"conditions"') || s.includes('"replacement"')));
      for (const task of tasks) assert(logs.some(s => s.includes(`task=${task} `)), task);
      // HTTPの本文・例外から鍵を反射させない。失敗時は承認を止める。
      global.fetch = async () => ({ ok: false, status: 401, body: { cancel: async () => {} }, text: async () => secret });
      const failed = await F.checkFacts('限度額は100万円です。', { now: opts.now, enabled: true });
      assert.equal(failed.record.status, 'not_run'); assert(!JSON.stringify(failed).includes(secret)); assert(!logs.join('\n').includes(secret));
      assert.equal(F.config({ provider: 'gateway', timeoutMs: 1000000 }).timeoutMs, 900000);
      assert.equal(F.config({ provider: 'gateway', timeoutMs: 100 }).timeoutMs, 100);
    });
  } finally { global.fetch = previous.fetch; console.log = previous.log; console.warn = previous.warn; global.setTimeout = previous.timer; CM.createBatchContext = previous.batch; }
});
test('G1', '2: 提供者/モデルの形でないGateway設定は呼び出す前に止める', async () => {
  for (const model of ['glm-5.3-flash', 'zai/', '/glm', 'zai/model extra']) {
    let called = false;
    const r = await F.checkFacts('限度額は100万円です。', { ...opts, provider: 'gateway', model, callLLM: async () => { called = true; } });
    assert.equal(r.record.status, 'not_run'); assert.equal(r.record.summary, '照合のモデル設定が不正です'); assert.equal(called, false);
  }
});

test('S1', '背景の再現: 所令101が主張の候補外でも、関連する書き手の資料なら食い違いを採る', async () => {
  const real = W.resolveMaterial('law:shotokuzei_rei:101'), other = ref('other', '別制度', '別制度の原文を確認するための資料です。');
  const claims = [
    { id: 'c1', type: '手続', subject: '棚卸資産の評価の方法の変更手続', sentence: '変更には届出が必要です。', claim: '変更には届出が必要です。' },
    { id: 'c2', type: '手続', subject: '棚卸資産', sentence: '別の手続です。', claim: '別の手続です。' },
  ];
  const result = await F.judgeClaims(claims, { c1: [other], c2: [real] }, claims.map(c => c.sentence).join('\n'), async req => [
    { id: 'c1', status: '食い違い', evidence_id: H.materials(req).find(p => p.url === real.url).number, basis: '1', correct: '変更には承認が必要です。' },
    { id: 'c2', status: '資料なし' },
  ], { writer_materials: ['law:shotokuzei_rei:101'] });
  assert.equal(result[0].status, '食い違い'); assert.equal(result[0].evidence_outside_candidates, true);
});

test('S3', '背景の再現: 受贈者の「または」を条件確認で捕捉し、修正と再照合まで行う', async () => {
  const wrong = '18歳以上の直系卑属または推定相続人が対象です。', correct = '18歳以上の直系卑属である推定相続人または孫が対象です。';
  const source = ref('gift', '相続時精算課税', correct); let extracts = 0;
  const result = await F.checkFacts(wrong, { ...opts, repair: true, writer_materials: ['ta:4103'], searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '要件', '相続時精算課税');
      if (req.task === 'condition_check') return { verdict: extracts++ ? '一致' : '不一致', conditions: [{ article: '直系卑属または推定相続人', source: '直系卑属である推定相続人または孫', match: '不一致' }], correct };
      if (req.task === 'repair') return [{ id: 'c1', replacement: correct }];
      return supported(req);
    } });
  assert.equal(result.body, correct); assert.equal(result.record.status, 'ok'); assert.equal(result.record.corrections[0].resolved, true);
  assert(result.record.calls.some(c => c.task === 'condition_check'));
});

test('S1', '3: 関連しない書き手の資料・書き手以外の候補外資料の食い違いを落とし、数字の歯止めも維持', async () => {
  const law = W.resolveMaterial('law:shotokuzei_rei:101'), gift = W.resolveMaterial('ta:4103');
  gift.text = gift.text.split('関連リンク')[0];
  const own = ref('candidate', '別の資料', '別の資料の本文を確認します。');
  const c = claim('c1', '変更には届出が必要です。', '手続', '棚卸資産の評価の方法の変更手続');
  for (const [offered, ids] of [[gift, ['ta:4103']], [law, ['ta:4103']]]) {
    const rows = [c, { ...c, id: 'c2' }];
    const result = await F.judgeClaims(rows, { c1: [own], c2: [offered] }, c.sentence, async req => [
      { id: 'c1', status: '食い違い', evidence_id: H.materials(req).find(p => p.url === offered.url).number, basis: '1', correct: '変更には承認が必要です。' }, { id: 'c2', status: '資料なし' },
    ], { writer_materials: ids, loadEvidenceText: e => e.text });
    assert.equal(result[0].status, '資料なし'); assert.equal(result[0].reject_reason, '資料の番号がこの主張の候補でない');
  }
  const numeric = claim('c1', '限度額は100万円です。'); const page = ref('n', '試験制度', '限度額は200万円です。');
  let calls = 0;
  const invalid = await F.judgeClaims([numeric], { c1: [page] }, numeric.sentence, async () => {
    calls++; return [{ id: 'c1', status: '食い違い', evidence_id: 1, basis: '1', correct: '限度額は999万円です。' }];
  }, { ...writer, loadEvidenceText: e => e.text });
  assert.equal(invalid[0].status, '資料なし'); assert.equal(calls, 2);
});
test('S1', '3: 所令101の候補外の食い違いが段Bで消えず修正・再照合へ進み、未修正の記録も差分照合で保つ', async () => {
  const law = W.resolveMaterial('law:shotokuzei_rei:101'), other = ref('other', '別制度', '別の手続の説明を確認する資料です。');
  const subject = '棚卸資産の評価の方法の変更手続', wrong = '変更には届出が必要です。', fixed = '変更には承認が必要です。';
  const options = { ...opts, writer_materials: ['law:shotokuzei_rei:101'], loadEvidenceText: e => e.text,
    searchWriterEvidence: c => c.subject === subject ? [other] : [law], searchEvidence: c => c.subject === subject ? [other] : [law],
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '手続').map(c => ({ ...c, subject: c.claim.includes('変更には') ? subject : '別制度' }));
      if (req.task === 'condition_check') return condition();
      if (req.task === 'repair') return [{ id: 'c1', replacement: fixed }];
      const pages = H.materials(req), p = JSON.parse(req.user);
      return p.claims.map(c => ({ id: c.id, status: c.claim === wrong ? '食い違い' : '裏付けあり', evidence_id: pages.find(e => e.url === law.url)?.number || c.evidence_ids[0], basis: '1', correct: fixed }));
    } };
  const body = '## 評価方法\n' + wrong + '\n## 別の話\n別の手続を確認します。';
  const repaired = await F.checkFacts(body, { ...options, repair: true });
  assert.equal(repaired.record.status, 'ok'); assert(repaired.body.includes(fixed)); assert.equal(repaired.record.claims[0].evidence_outside_candidates, true);
  assert.equal(repaired.record.claims[0].stage, 'A'); assert.equal(repaired.record.corrections[0].resolved, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan02-incremental-'));
  try {
    const raw = require('gray-matter').stringify(body, { slug: 'plan02-cache', fact_materials: 'law:shotokuzei_rei:101', fact_plan_status: 'ok' });
    const first = await F.checkArticle(raw, { ...options, recordDir: dir, persist: true });
    const next = await F.checkArticle(first.content.replace('別の手続を確認します。', '別の説明を確認します。'), { ...options, recordDir: dir, persist: false, previousRaw: first.content });
    assert.equal(next.record.incremental.reused, 1); assert(next.record.claims.some(c => c.sentence === wrong && c.evidence_outside_candidates));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('S1', '3: 数字の主張は3状態とも候補外を認めず、候補内でも引用の近くに無いcorrectは認めない', async () => {
  const real = W.resolveMaterial('ta:4103'); real.text = real.text.split('関連リンク')[0];
  const other = ref('decoy', '別の制度', '別の制度の本文を確認する資料です。');
  for (const outside of [true, false]) for (const [status, bad] of [['裏付けあり', false], ['食い違い', false], ['期限の書き漏れ', false], ['食い違い', true]]) {
    const c = claim('c1', status === '裏付けあり' ? '受贈者は18歳以上です。' : '受贈者は17歳以上です。', '金額', '相続時精算課税');
    const result = await F.judgeClaims([c, { ...c, id: 'c2' }], { c1: [outside ? other : real], c2: [outside ? real : other] }, c.sentence, async req => {
      const page = H.materials(req).find(p => p.url === real.url), row = page.rows.find(r => /18歳/.test(r.text)); assert(row);
      return [{ id: 'c1', status, evidence_id: page.number, basis: String(row.s), correct: bad ? '受贈者は999歳以上です。' : '受贈者は18歳以上です。' }, { id: 'c2', status: '資料なし' }];
    }, { ...writer, loadEvidenceText: e => e.text });
    assert.equal(result[0].status, bad || outside ? '資料なし' : status);
    if (outside) assert.equal(result[0].reject_reason, '資料の番号がこの主張の候補でない');
    else if (bad) assert.equal(result[0].reject_reason, '引用が短い・数字が引用の近くに無い');
    assert.equal(result[0].evidence_outside_candidates, undefined);
  }
});

for (const recover of [true, false]) test('S2', `4: 数字の近傍確認で落ちた主張だけを即時に1回聞き直す（${recover ? '回復' : '再度棄却'}）`, async () => {
  const source = ref('retry', '試験制度', '限度額は200万円です。'); const c = claim('c1', '限度額は100万円です。');
  const requests = [];
  const result = await F.judgeClaims([c], { c1: [source] }, c.sentence, async req => {
    requests.push(req); if (req.task === 'retry_judge') {
      const p = JSON.parse(req.user); assert.equal(p.retry[0].reason, '引用が短い・数字が引用の近くに無い');
      assert(req.system.includes('[資料 1]')); assert(req.system.includes('[1] 限度額は200万円です。')); assert.equal(req.immediate, true);
    }
    return [{ id: 'c1', status: '食い違い', evidence_id: 1, basis: '1', correct: requests.length === 2 && recover ? '限度額は200万円です。' : '限度額は999万円です。' }];
  }, { ...writer, loadEvidenceText: e => e.text });
  assert.deepEqual(requests.map(r => r.task), ['judge', 'retry_judge']); assert.equal(result[0].status, recover ? '食い違い' : '資料なし');
});
test('S2', '4: 聞き直しは最大10件・採用後の答えだけで歯止めを数え、再棄却が多ければfail-closed', async () => {
  const cs = Array.from({ length: 11 }, (_, i) => claim(`c${i + 1}`, `制度${i}は100万円です。`));
  const source = ref('many', '試験制度', '限度額は200万円です。'), evidence = Object.fromEntries(cs.map(c => [c.id, [source]]));
  const sizes = [];
  const result = await F.judgeClaims(cs, evidence, cs.map(c => c.sentence).join('\n'), async req => {
    const p = JSON.parse(req.user); if (req.task === 'retry_judge') sizes.push(p.claims.length);
    return p.claims.map(c => ({ id: c.id, status: '食い違い', evidence_id: 1, basis: req.task === 'retry_judge' ? '1' : '999', correct: '限度額は200万円です。' }));
  }, { ...writer, loadEvidenceText: e => e.text });
  assert.deepEqual(sizes, [10, 1]); assert(result.every(c => c.status === '食い違い'));
  await assert.rejects(F.judgeClaims(cs.slice(0, 3), evidence, cs.map(c => c.sentence).join('\n'), async req => JSON.parse(req.user).claims.map(c =>
    ({ id: c.id, status: '食い違い', evidence_id: 1, basis: '999', correct: '限度額は200万円です。' })), { ...writer, provider: 'gateway', loadEvidenceText: e => e.text }), /多くが確認を通りません/);
});

for (const answer of ['数字不正', 'correctなし', '一致', '記載なし', '失敗', '読めない', 'JSON不正']) test('S3', `5: 条件確認の${answer}は食い違いを捏造せず、必要な条件差だけを人の一覧へ`, async () => {
  const body = '18歳以上の子が対象です。', source = ref('condition', '相続時精算課税', '18歳以上の直系卑属である推定相続人または孫が対象です。');
  const result = await F.checkFacts(body, { ...opts, ...writer, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '要件', '相続時精算課税');
      if (req.task !== 'condition_check') return supported(req);
      if (answer === '失敗') throw new Error('secret');
      if (answer === '読めない') return '{}';
      if (answer === 'JSON不正') return '{';
      if (answer === '一致' || answer === '記載なし') return { text: JSON.stringify(condition(answer)) };
      return { verdict: '不一致', correct: answer === '数字不正' ? '99歳以上の子が対象です。' : '', conditions: [{ article: '<script>子</script>', source: '推定相続人または孫', match: '不一致' }] };
    } });
  assert.equal(result.record.status, 'ok'); assert.equal(result.record.claims[0].status, '裏付けあり'); assert.equal(result.body, body);
  const advisory = ['数字不正', 'correctなし'].includes(answer); assert.equal(result.record.review_items.length, advisory ? 1 : 0);
  assert(result.record.claims[0].condition_check);
  if (advisory) {
    const html = require('../../../netlify/functions/review-page').renderFactCheck({ fact_check_status: 'ok' }, result.record, body);
    assert(html.includes('条件の違い')); assert(html.includes('&lt;script&gt;子&lt;/script&gt;')); assert(!html.includes('<script>子</script>'));
  }
});
test('S3', '5: 条件確認は1組ずつ・同時4組まで、記事の文と引用と文脈を渡す', async () => {
  const source = ref('four', '制度', '対象者は申請書を提出します。'), body = Array.from({ length: 9 }, (_, i) => `対象者${i}は申請書を提出します。`).join('\n');
  let active = 0, maximum = 0, calls = 0;
  const r = await F.checkFacts(body, { ...opts, ...writer, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '手続');
      if (req.task !== 'condition_check') return supported(req);
      assert.deepEqual(Object.keys(JSON.parse(req.user)), ['article', 'source', 'heading', 'prev', 'next']);
      active++; maximum = Math.max(maximum, active); calls++; await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return condition();
    } });
  assert.equal(r.record.status, 'ok'); assert.equal(calls, 9); assert.equal(maximum, 4);
});

test('S5', '背景の再現: みなし仕入率の修正を、同じ行の変わらない試算の30%で未解決にしない', async () => {
  const row = '| 建設業 | 第4種・60% | 売上税額×30% |', fixed = '| 建設業 | 第3種・70% | 売上税額×30% |';
  const source = ref('rate', '建設業のみなし仕入率', '建設業は第3種事業でみなし仕入率は70%です。'); let extracts = 0;
  const result = await F.checkFacts('## 試算\n' + row, { ...opts, repair: true, writer_materials: ['ta:6509'], searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') { extracts++; const s = +req.user.match(/^\[(\d+)\] \|/m)[1]; return [
        { s, type: '割合', subject: '建設業のみなし仕入率', claim: extracts === 1 ? 'みなし仕入率は60%です。' : 'みなし仕入率は70%です。' },
        ...(extracts > 1 ? [{ s, type: '割合', subject: '建設業のみなし仕入率', claim: '売上税額に30%を掛けます。' }] : []),
      ]; }
      if (req.task === 'repair') return [{ id: 'c1', replacement: fixed }];
      return H.readPayload(req).claims.map(c => ({ id: c.id, status: c.claim.includes('30%') ? '資料なし' : extracts === 1 ? '食い違い' : '裏付けあり', evidence_id: 1, basis: '1', correct: '建設業の売上税額から計算するみなし仕入率は第3種の70%です。' }));
    } });
  assert.equal(result.body, '## 試算\n' + fixed); assert.equal(result.record.corrections[0].resolved, true); assert.equal(result.record.status, 'ok');
});

for (const recover of [true, false]) test('S4', `6: 資料の無い数字が残る修正だけを1回直させる（${recover ? '採用' : '元の文を保持'}）`, async () => {
  const body = '上限は100万円です。\n他の文はそのまま残します。', f = { ...claim('c1', '上限は100万円です。'), status: '資料なし', quote: '', correct: '', evidence: [] };
  const calls = [];
  const r = await F.repairBody(body, [f], async req => {
    calls.push(req.task);
    if (req.task === 'retry_repair') {
      assert.equal(req.immediate, true); const p = JSON.parse(req.user);
      assert.equal(p.previous[0].replacement, '上限100万円は国税庁で確認してください。'); assert.equal(p.previous[0].reason, '資料の無い数字が残っています');
    }
    return [{ id: 'c1', replacement: req.task === 'retry_repair' && recover ? '詳しくは国税庁の試験制度で確認してください。' : '上限100万円は国税庁で確認してください。' }];
  }, writer);
  assert.deepEqual(calls, ['repair', 'retry_repair']); assert.equal(r.body.includes('100万円'), !recover); assert(r.body.includes('他の文はそのまま残します。'));
});
test('S4', '6: 同じ文の複数指摘は同じ置き換えにまとめ、他の採用済みの修正を保持する', async () => {
  const text = '限度額は100万円、控除額は50万円です。', other = '別の限度額は80万円です。';
  const findings = [claim('c1', text), claim('c2', text), claim('c3', other)].map(c => ({ ...c, status: '食い違い', quote: '根拠の本文', correct: '修正' }));
  const fixed = '限度額は200万円、控除額は60万円です。';
  const r = await F.repairBody(text + '\n' + other, findings, async req => {
    const p = JSON.parse(req.user);
    if (req.task === 'retry_repair') {
      assert.deepEqual(p.corrections.map(c => c.id), ['c1', 'c2']); assert(p.instruction.includes('同じ1つの置き換え'));
      return p.corrections.map(c => ({ id: c.id, replacement: fixed }));
    }
    return [{ id: 'c1', replacement: fixed }, { id: 'c2', replacement: '控除額は60万円です。' }, { id: 'c3', replacement: '別の限度額は90万円です。' }];
  }, writer);
  assert.equal(r.body, fixed + '\n別の限度額は90万円です。'); assert.equal(r.rejected.size, 0);
});
test('S4', '6: 直しでも表の列・改行・保持する数字・長さ・元と同じ文の歯止めを再適用', async () => {
  const examples = [
    ['| 上限100万円 | 内容 |', '| 案内 |', '金額', []],
    ['上限は100万円です。', '案内\n## 見出し', '金額', []],
    ['上限100万円と控除50万円です。', '詳しくは国税庁で確認してください。', '金額', [{ claim: '控除は50万円', type: '金額' }]],
    ['上限は100万円です。', '案内'.repeat(120), '金額', []],
    ['上限は100万円です。', '上限は100万円です。', '金額', []],
  ];
  for (const [sentence, replacement, type, keep] of examples) {
    let calls = 0; const f = { ...claim('c1', sentence, type), claim: '上限は100万円', status: '資料なし', keep };
    const r = await F.repairBody(sentence + '\n他の文も残します。', [f], async () => { calls++; return [{ id: 'c1', replacement }]; }, writer);
    assert.equal(calls, 2); assert.equal(r.body, sentence + '\n他の文も残します。'); assert(r.rejected.has('c1'));
  }
});
test('S5', '7: 試算でも割合と計算式の無い金額を抽出に残す', async () => {
  const body = '## 試算\n| みなし仕入率70% | 売上税額×30% | 納税額30万円 |';
  const result = await F.extractClaims(body, async req => {
    assert(req.system.includes('計算に使った制度の数字')); const s = +req.user.match(/\[(\d+)\] \|/)[1];
    return [{ s, type: '割合', subject: '簡易課税', claim: 'みなし仕入率70%' }, { s, type: '割合', subject: '簡易課税', claim: '売上税額×30%' }, { s, type: '金額', subject: '簡易課税', claim: '納税額30万円' }];
  }, writer);
  assert.deepEqual(result.claims.map(c => c.claim), ['みなし仕入率70%', '売上税額×30%', '納税額30万円']); assert.equal(result.calculated_skipped, 0);
});
for (const [label, initial, changed] of [['新たな同じ数字', false, false], ['初回から資料なし', true, false], ['新しい数字', false, true]]) test('S5', `7: 再照合の${label}の扱いを区別する`, async () => {
  const before = 'みなし仕入率60%で売上税額に30%を掛けます。', after = changed ? 'みなし仕入率70%で売上税額に40%を掛けます。' : 'みなし仕入率70%で売上税額に30%を掛けます。';
  const source = ref('unchanged', 'みなし仕入率', 'みなし仕入率は70%です。'); let round = 0;
  const r = await F.checkFacts(before, { ...opts, ...writer, repair: true, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') { round++; const s = +req.user.match(/^\[(\d+)\]/m)[1]; return [
        { s, type: '割合', subject: 'みなし仕入率', claim: `みなし仕入率${round === 1 ? 60 : 70}%` },
        ...(initial || round > 1 ? [{ s, type: '割合', subject: 'みなし仕入率', claim: `売上税額に${round > 1 && changed ? 40 : 30}%を掛けます。` }] : []),
      ]; }
      if (req.task === 'repair' || req.task === 'retry_repair') return JSON.parse(req.user).corrections.map(c => ({ id: c.id, replacement: after }));
      return JSON.parse(req.user).claims.map(c => ({ id: c.id, status: c.claim.includes('売上税額') ? '資料なし' : round === 1 ? '食い違い' : '裏付けあり', evidence_id: c.evidence_ids[0], basis: '1', correct: 'みなし仕入率70%で売上税額を計算します。' }));
    } });
  if (!initial && !changed) { assert.equal(r.record.status, 'ok'); assert.equal(r.record.corrections[0].resolved, true); assert(r.record.review_items.some(c => c.unchanged_numeric)); }
  else { assert.equal(r.record.status, 'revise'); assert(r.record.remaining.length); }
});

async function missingReview(total, missing, replacement = '詳しくは国税庁の試験制度で確認してください。') {
  const body = Array.from({ length: total }, (_, i) => `${i < missing ? '架空条件を満たせば対象' : '申請書を提出'}となります（項目${i}）。`).join('\n');
  const source = ref('generalize', '試験制度', '申請書を提出して手続を行います。');
  return F.checkFacts(body, { ...opts, ...writer, repair: true, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '要件').filter(c => !c.claim.startsWith('詳しくは'));
      if (req.task === 'condition_check') return condition();
      if (req.task === 'repair' || req.task === 'retry_repair') return JSON.parse(req.user).corrections.map(c => ({ id: c.id, replacement }));
      return supported(req).map((row, i) => JSON.parse(req.user).claims[i].claim.includes('架空条件') ? { id: row.id, status: '資料なし' } : row);
    } });
}
test('S6', '8: 全体の20%ちょうどの要件は具体を外し、再照合で解決する', async () => {
  const r = await missingReview(5, 1); assert.equal(r.record.status, 'ok'); assert(!r.body.includes('架空条件'));
  assert.equal(r.record.corrections.length, 1); assert.equal(r.record.corrections[0].generalized, true); assert.equal(r.record.corrections[0].resolved, true);
  assert(r.record.calls.some(c => c.task === 'recheck_extract'));
});
for (const [total, missing, over] of [[5, 2, true], [45, 9, true], [40, 8, false]]) test('S6', `8: ${missing}/${total}文の件数・割合の歯止め（${over ? '具体を保持' : '8文まで外す'}）`, async () => {
  const r = await missingReview(total, missing); assert.equal(r.record.status, 'ok');
  assert.equal(r.record.summary.includes('・資料なしが多いため具体を外していません'), over);
  assert.equal(r.record.calls.some(c => c.task === 'repair'), !over);
  assert.equal(r.record.review_items.length, over ? missing : 0);
});
test('S6', '8: 具体を外す修正が採れなくても人の一覧に残し、承認を止めず、新しい数字を採らない', async () => {
  const r = await missingReview(5, 1, '対象は99歳以上です。');
  assert.equal(r.record.status, 'ok'); assert(r.body.includes('架空条件')); assert.equal(r.record.review_items.length, 1); assert(!r.body.includes('99歳'));
  assert(r.record.calls.some(c => c.task === 'retry_repair'));
});

test('従来互換', '9: 資料なし・全欠落・切替falseは同じ呼び出しと記録でS1〜S6を動かさない', async () => {
  const source = ref('legacy', '試験制度', '18歳以上の子が対象です。');
  const requests = [], run = extra => F.checkFacts(source.text, { ...opts, ...extra, searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => { requests.push({ task: req.task, system: req.system, user: req.user, maxTokens: req.maxTokens, model: req.model }); return req.task === 'extract' ? extract(req, '要件') : supported(req); } });
  const baseline = await run({}); const calls = requests.splice(0);
  assert.deepEqual(calls.map(c => c.task), ['extract', 'judge']); assert(!calls[0].system.includes('計算の途中の率'));
  const disabled = await env({ FACT_CHECK_WRITER_MATERIALS: 'false' }, () => run(writer));
  assert.deepEqual(requests.splice(0), calls); assert.deepEqual(disabled, baseline);
  for (const extra of [{ resolvedWriterMaterials: [W.resolveMaterial('ta:4103')] }, { ...writer, writerMaterials: false, resolvedWriterMaterials: [W.resolveMaterial('ta:4103')] }]) {
    assert.deepEqual(await run(extra), baseline); assert.deepEqual(requests.splice(0), calls);
  }
  const missing = await run({ writer_materials: ['ta:0000'] }); assert.deepEqual(requests.splice(0), calls);
  assert.deepEqual(await run({ writer_materials: ['ta:0000'], resolvedWriterMaterials: [W.resolveMaterial('ta:4103')] }), missing); assert.deepEqual(requests.splice(0), calls);
  assert.equal(missing.record.claims[0].condition_check, undefined); assert.equal(missing.record.status, baseline.record.status);
  const f = { ...claim('c1', '上限は100万円です。'), status: '資料なし' }; let repairs = 0;
  await F.repairBody(f.sentence, [f], async () => { repairs++; return [{ id: 'c1', replacement: f.sentence }]; }); assert.equal(repairs, 1);
  assert.equal(F.config({}).provider, 'anthropic'); assert.equal(F.config({}).model, 'claude-opus-5-5');
});
test('版', '10: 記録のLOGIC_VERSIONはplan2', async () => {
  const r = await F.checkFacts('', { ...opts }); assert.equal(r.record.logic_version, 'plan2-s1');
});

const catalogRef = id => { const r = W.resolveMaterial(id); assert(r, id); return { ...r, text: r.text.split('関連リンク')[0] }; };
const pageAnswer = (req, id, material, pattern, status, correct = '') => {
  const page = H.materials(req).find(p => p.url === material.url); assert(page, material.title);
  const row = page.rows.find(r => pattern.test(r.text)); assert(row, String(pattern));
  return { id, status, evidence_id: page.number, basis: String(row.s), correct };
};
test('02b-H1', '住宅資金1000万円を兄弟制度の1500万円に書き換えず段Bの住宅資金資料で判定する', async () => {
  const [home, education, family] = ['4508','4510','4511'].map(n => catalogRef('ta:' + n));
  const original = '住宅取得等資金の贈与は省エネ等住宅なら1,000万円まで非課税です。';
  const r = await F.checkFacts(original + '\n別の手続を確認します。', { ...opts, repair: true, writer_materials: ['ta:4508','ta:4510','ta:4511'],
    searchWriterEvidence: c => c.type === '金額' ? [home] : [education, family], searchEvidence: () => [home], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req).map(c => ({ ...c, type: c.claim.includes('非課税') ? '金額' : '手続', subject: '贈与税の非課税' }));
      if (req.task === 'condition_check') return condition();
      if (req.task === 'repair') return [{ id: 'c1', replacement: original.replace('1,000', '1,500') }];
      return JSON.parse(req.user).claims.map(c => c.type !== '金額' ? { id: c.id, status: '資料なし' } : req.stageB
        ? pageAnswer(req, c.id, home, /1,000万円/, '裏付けあり')
        : pageAnswer(req, c.id, education, /1,500万円/, c.claim.includes('1,500') ? '裏付けあり' : '食い違い', '非課税の限度額は1,500万円です。'));
    } });
  assert.equal(r.body, original + '\n別の手続を確認します。'); assert.equal(r.record.claims[0].stage, 'B'); assert.equal(r.record.status, 'ok');
});
test('02b-H2', '候補外の教育資金の30歳未満を条件確認で住宅資金の18歳以上に上書きしない', async () => {
  const home = catalogRef('ta:4508'), education = catalogRef('ta:4510'), original = '1月1日に18歳以上の受贈者が対象です。';
  const r = await F.checkFacts(original + '\n教育資金の手続を確認します。', { ...opts, repair: true, writer_materials: ['ta:4508','ta:4510'],
    searchWriterEvidence: c => c.subject === '住宅資金' ? [home] : [education], searchEvidence: () => [home, education], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '要件').map(c => ({ ...c, subject: c.claim.includes('受贈者') ? '住宅資金' : '教育資金' }));
      if (req.task === 'condition_check') return { verdict: '不一致', conditions: [{ article: '18歳以上の受贈者', source: '30歳未満の受贈者', match: '不一致' }], correct: '30歳未満の受贈者が対象です。' };
      if (req.task === 'repair') return [{ id: 'c1', replacement: '30歳未満の受贈者が対象です。' }];
      return JSON.parse(req.user).claims.map(c => c.subject !== '住宅資金' ? { id: c.id, status: '資料なし' } : pageAnswer(req, c.id, education, /30歳未満/, '裏付けあり'));
    } });
  assert.equal(r.body, original + '\n教育資金の手続を確認します。'); assert.equal(r.record.claims[0].status, '裏付けあり');
  assert(r.record.review_items.some(c => c.status === '条件の違いを要確認')); assert(!r.record.calls.some(c => c.task === 'repair'));
});
test('02b-H3', '本物の資料にある数字4件が範囲外、聞き直しも資料なしなら一般化でokにせずnot_run', async () => {
  const source = catalogRef('ta:4508');
  const body = ['甲','乙','丙','丁'].map(s => `${s}の省エネ等住宅の非課税限度額は1,000万円です。`).join('\n');
  const r = await F.checkFacts(body, { ...opts, repair: true, writer_materials: ['ta:4508'], searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '金額', '住宅取得等資金の贈与の非課税');
      if (req.task === 'repair') return JSON.parse(req.user).corrections.map(c => ({ id: c.id, replacement: c.sentence.replace('1,000万円', '一定の額') }));
      return JSON.parse(req.user).claims.map(c => req.task === 'retry_judge' ? { id: c.id, status: '資料なし' } : { id: c.id, status: '裏付けあり', evidence_id: 1, basis: '99999' });
    } });
  assert.equal(r.record.status, 'not_run'); assert.equal(r.body, body); assert(!r.record.calls.some(c => c.task === 'repair'));
});
test('02b-H3', '聞き直しの資料なしで元の保持数字・却下理由・回答を消さず、前回答を渡す', async()=>{
  const source=catalogRef('ta:4508'),c=claim('c1','省エネ等住宅の非課税限度額は1,000万円、追加の限度額は9,999万円です。','金額','住宅取得等資金の贈与の非課税');
  const first=req=>[pageAnswer(req,'c1',source,/1,000万円/,'裏付けあり')];
  const baseline=await F.judgeClaims([c],{c1:[source]},c.sentence,async req=>first(req),{loadEvidenceText:e=>e.text});
  const r=await F.judgeClaims([c],{c1:[source]},c.sentence,async req=>{
    if(req.task==='retry_judge'){
      const previous=JSON.parse(req.user).retry[0].answer;assert.equal(previous.evidence_id,1);assert.equal(previous.correct,'');assert.equal(previous.basis,first({system:req.system,user:req.user,task:'judge'})[0].basis);
      return [{id:'c1',status:'資料なし'}];
    }return first(req);
  },{writer_materials:['ta:4508'],loadEvidenceText:e=>e.text});
  assert.deepEqual(r,baseline);assert(r[0].supported_numbers.includes('1,000万円'));assert.equal(r[0].reject_reason,'引用が短い・数字が引用の近くに無い');
});
test('02b-H4', '試算見出しでも割合・期限・制度の金額を残し、計算結果の金額だけ件数つきで外す', async () => {
  const source = catalogRef('ta:6498');
  const rows = [
    ['割合', '2割特例は売上税額の2割を納付税額として計算する。'],
    ['割合', '第3種事業は70%で計算する。'],
    ['期限', '2割特例は令和8年9月30日を含む課税期間まで計算に使える。'],
    ['金額', '制度の控除額は1,000万円です。'],
    ['金額', '1,100万円×10%＝100万円と計算します。'],
  ];
  const r = await F.checkFacts('## 試算\n' + rows.map(r => r[1]).join('\n'), { ...opts, writer_materials: ['ta:6498'], searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => req.task === 'extract' ? extract(req).map((c,i) => ({ ...c, type: rows[i][0] })) : JSON.parse(req.user).claims.map(c => ({ id: c.id, status: '資料なし' })) });
  assert.equal(r.record.claims.length, 4); assert.equal(r.record.calculated_skipped, 1); assert(r.record.summary.includes('・試算の数字として照合しなかった 1 件'));
});
test('02b-R1', 'よくある誤解の「父母それぞれなら枠が2倍になると考える」を逆転させない', async () => {
  const source = catalogRef('ta:4508'), sentence = '父母それぞれから住宅資金をもらえば枠が2倍になると考える。';
  const body = '## よくある誤解\n' + sentence + '\n贈与を受けた人ごとの枠を確認しましょう。';
  const r = await F.checkFacts(body, { ...opts, repair: true, writer_materials: ['ta:4508'], searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '要件', '住宅取得等資金の贈与').slice(0,1).map(c => ({ ...c, claim: req.system.includes('誤りの例として') ? '父母それぞれからもらっても枠は2倍にならない。' : c.claim }));
      if (req.task === 'condition_check') {
        const p = JSON.parse(req.user);
        return p.heading?.includes('誤解') && req.system.includes('その考えは誤り') ? condition() : { verdict: '不一致', conditions: [{ article: '父母それぞれの贈与者', source: '受贈者ごと', match: '不一致' }], correct: sentence.replace('2倍になる', '2倍にならない') };
      }
      if (req.task === 'repair') return [{ id: 'c1', replacement: sentence.replace('2倍になる', '2倍にならない') }];
      return JSON.parse(req.user).claims.map(c => pageAnswer(req,c.id,source,/贈与を受けた人ごと/,'裏付けあり'));
    } });
  assert.equal(r.body, body); assert.equal(r.record.status, 'ok'); assert(!r.record.calls.some(c => c.task === 'repair'));
});
test('02b-R2', '値下げ販売を必要経費の一般論へ置き換える答えを落とし話題を保った直しに回す', async () => {
  const sentence = '値下げして販売した商品は、その販売価格で売上が立ち、取得価額が売上原価になります。';
  const unrelated = '必要経費に算入できるのは、総収入金額に対応する売上原価などです。';
  const fixed = '値下げして販売した商品は販売価格を売上に計上し、取得価額を売上原価にします。';
  const source = catalogRef('law:shotokuzei_hou:37'), tasks = [];
  const r = await F.repairBody(sentence, [{ ...claim('c1', sentence, '判定', '棚卸資産'), status: '食い違い', quote: source.text, correct: unrelated }], async req => {
    tasks.push(req.task); return [{ id: 'c1', replacement: req.task === 'retry_repair' ? fixed : unrelated }];
  }, { writer_materials: ['law:shotokuzei_hou:37'] });
  assert.equal(r.body, fixed); assert.deepEqual(tasks, ['repair','retry_repair']);
});

const siblingCases = [
  [['4508','4510','4511'], '贈与税の非課税', '4508', '4510'],
  [['4508','4510','4511'], '贈与税の非課税', '4508', '4511'],
  [['4103','4408','4161'], '暦年課税', '4408', '4103'],
  [['4103','4408','4161'], '相続時精算課税', '4103', '4408'],
  [['4103','4408','4161'], '相続時精算課税', '4103', '4161'],
  [['6498','6505','6351'], '2割特例', '6498', '6505'],
  [['6498','6505','6351'], '2割特例', '6498', '6351'],
];
test('02b-R2','資料なしの一般化には話題の重なりの歯止めをかけず、数字を外した案内を採る',async()=>{
  const sentence='試験制度の上限は100万円です。',tasks=[];
  const r=await F.repairBody(sentence,[{...claim('c1',sentence),status:'資料なし'}],async req=>{
    tasks.push(req.task);return[{id:'c1',replacement:req.task==='retry_repair'?'詳しくは国税庁の試験制度で確認してください。':'詳しくは国税庁で確認してください。'}];
  },writer);assert.deepEqual(tasks,['repair']);assert.equal(r.body,'詳しくは国税庁で確認してください。');assert.equal(r.rejected.size,0);
});
for (const [ids,subject,ownId,outsideId] of siblingCases) {
  test('02b-H1', `本文だけに制度名がある兄弟資料${outsideId}を${subject}の食い違いに使わない`, async () => {
    const own = catalogRef('ta:' + ownId), outside = catalogRef('ta:' + outsideId);
    const cs = [claim('c1','届出書を提出します。','手続',subject), claim('c2','他の制度を確認します。','手続','別制度')];
    const r = await F.judgeClaims(cs, { c1:[own], c2:[outside] }, cs.map(c=>c.sentence).join('\n'), async req => [
      pageAnswer(req,'c1',outside,/./,'食い違い','申請書を提出します。'), { id:'c2',status:'資料なし' },
    ], { writer_materials:ids.map(id=>'ta:'+id), loadEvidenceText:e=>e.text });
    assert.equal(r[0].status,'資料なし'); assert.equal(r[0].reject_reason,'資料の番号がこの主張の候補でない');
  });
  test('02b-H2', `兄弟資料${outsideId}から${subject}の条件変更をせず人の確認へ残す`, async () => {
    const own = catalogRef('ta:' + ownId), outside = catalogRef('ta:' + outsideId), body = '申請する対象者を確認します。\n他の制度を確認します。';
    const r = await F.checkFacts(body,{ ...opts,repair:true,writer_materials:ids.map(id=>'ta:'+id), searchWriterEvidence:c=>c.subject===subject?[own]:[outside], searchEvidence:()=>[own,outside],loadEvidenceText:e=>e.text,
      callLLM:async req=>{
        if(req.task==='extract') return extract(req,'要件').map((c,i)=>({...c,subject:i===0?subject:'別制度'}));
        if(req.task==='condition_check') return { verdict:'不一致', conditions:[{article:'申請する対象者',source:'別の対象者',match:'不一致'}],correct:'別の対象者が申請します。' };
        if(req.task==='repair') return [{id:'c1',replacement:'別の対象者が申請します。'}];
        return JSON.parse(req.user).claims.map(c=>c.subject===subject?pageAnswer(req,c.id,outside,/./,'裏付けあり'):{id:c.id,status:'資料なし'});
      } });
    assert.equal(r.body,body);assert.equal(r.record.status,'ok');assert(r.record.review_items.some(c=>c.status==='条件の違いを要確認'));assert(!r.record.calls.some(c=>c.task==='repair'));
  });
}
test('02b-H2','題名が一致する所令101の候補外資料なら条件の不一致を修正・再照合へ回す',async()=>{
  const law=catalogRef('law:shotokuzei_rei:101'),other=ref('law-decoy','別制度','別制度の申請者の手続を説明します。'),subject='棚卸資産の評価の方法の変更手続';
  const original='変更には届出が必要です。',fixed='変更には承認が必要です。';let round=0;
  const r=await F.checkFacts(original+'\n別制度の申請書を確認します。',{...opts,repair:true,writer_materials:['law:shotokuzei_rei:101'],loadEvidenceText:e=>e.text,searchWriterEvidence:c=>c.subject===subject?[other]:[law],searchEvidence:()=>[other],callLLM:async req=>{
    if(req.task==='extract'){round++;return extract(req,'手続').map(c=>({...c,subject:c.claim.includes('変更には')?subject:'別制度'}));}
    if(req.task==='condition_check')return round===1?{verdict:'不一致',conditions:[{article:'届出の申請者',source:'承認を受ける申請者',match:'不一致'}],correct:fixed}:condition();
    if(req.task==='repair')return[{id:'c1',replacement:fixed}];
    return JSON.parse(req.user).claims.map(c=>c.subject===subject?pageAnswer(req,c.id,law,/./,'裏付けあり'):{id:c.id,status:'資料なし'});
  }});assert.equal(r.record.status,'ok');assert(r.body.includes(fixed));assert.equal(r.record.claims[0].stage,'A');assert(r.record.claims[0].condition_mismatch);assert(r.record.corrections[0].resolved);
});
test('02b-M2', '本文だけの関連による手続の食い違いは段Bへ、所令101の題名の関連は従来どおり', async()=>{
  const own=catalogRef('ta:6498'), sibling=catalogRef('ta:6505');
  const r=await F.checkFacts('届出書を提出します。\n簡易課税制度の申請書を確認します。',{...opts,writer_materials:['ta:6498','ta:6505'],loadEvidenceText:e=>e.text,searchWriterEvidence:c=>c.subject==='2割特例'?[own]:[sibling],searchEvidence:()=>[own],
    callLLM:async req=>{
      if(req.task==='extract')return extract(req,'手続').map((c,i)=>({...c,subject:i?'別制度':'2割特例'}));
      if(req.task==='condition_check')return condition();
      return JSON.parse(req.user).claims.map(c=>c.subject!=='2割特例'?{id:c.id,status:'資料なし'}:pageAnswer(req,c.id,req.stageB?own:sibling,/./,req.stageB?'裏付けあり':'食い違い','届出書を確認します。'));
    }});
  assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].stage,'B'); assert.equal(r.record.claims[0].status,'裏付けあり'); assert(r.record.calls.some(c=>c.task==='stage_b_judge'));
  // 題名に関連する所令101の修正と段B省略は、既存S1の実カタログ試験でも必ず通す。
});

for(const kind of ['不一致行なし','元と同じ','記号だけ','句読点だけ','直接','原則','など']) test(kind==='直接'||kind==='原則'||kind==='など'?'02b-R3':'02b-M1',`${kind}による誤警報で本文を書き換えず差し止めない`,async()=>{
  const original=kind==='直接'?'必要な都度支払います。':kind==='原則'?'申請書を提出します。':kind==='など'?'子などが対象です。':'18歳以上の子が対象です。';
  const source=ref('m1','対象者',original), correct=kind==='直接'?'必要な都度直接支払います。':kind==='原則'?'原則、申請書を提出します。':kind==='など'?'子が対象です。':kind==='句読点だけ'?'「18歳以上の子」が対象です!':kind==='記号だけ'?' **18歳以上の子が対象です。** ':kind==='元と同じ'?original:'18歳以上の孫が対象です。';
  const r=await F.checkFacts(original,{...opts,...writer,repair:true,searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,
    callLLM:async req=>req.task==='extract'?extract(req,'要件'):req.task==='condition_check'?{verdict:'不一致',conditions:[{article:original,source:correct,match:kind==='不一致行なし'?'一致':'不一致'}],correct}:supported(req)});
  assert.equal(r.body,original);assert.equal(r.record.status,'ok');assert.equal(r.record.claims[0].status,'裏付けあり');assert(!r.record.calls.some(c=>c.task==='repair'));
});
test('02b-M1','数字の桁区切りだけの誤警報では修正を呼ばず、小数点の違いは実際の条件差として直す',async()=>{
  for(const [original,fixed,changes] of [['限度額は1,000万円です。','限度額は1000万円です。',false],['対象年齢は18歳で申請書を提出します。','対象年齢は1.8歳で申請書を提出します。',true]]){
    const source=ref('m1-numeric','限度額と対象年齢',fixed);let round=0;
    const r=await F.checkFacts(original,{...opts,...writer,repair:true,searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,callLLM:async req=>{
      if(req.task==='extract'){round++;return extract(req,'要件','対象年齢');}
      if(req.task==='condition_check')return round>1?condition():{verdict:'不一致',conditions:[{article:original,source:fixed,match:'不一致'}],correct:fixed};
      if(req.task==='repair')return[{id:'c1',replacement:fixed}];return supported(req);
    }});assert.equal(r.record.status,'ok');assert.equal(r.body,changes?fixed:original);assert.equal(r.record.calls.some(c=>c.task==='repair'),changes);
  }
});
for(const failure of ['同じ修正','修正失敗','再照合資料なし','再照合食い違い','再照合失敗','再照合の誤警報']) test('02b-M1',`${failure}は条件の確認一覧へ戻す`,async()=>{
  const original='18歳以上の子が対象です。',fixed='18歳以上の孫が対象です。',source=ref('m1-fallback','対象者',fixed); let round=0;
  const r=await F.checkFacts(original,{...opts,...writer,repair:true,searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,
    callLLM:async req=>{
      if(req.task==='extract'){round++;return extract(req,'要件');}
      if(req.task==='condition_check')return {verdict:'不一致',conditions:[{article:round>1?'孫':'子',source:round>1?'子':'孫',match:'不一致'}],correct:round>1?original:fixed};
      if(['repair','retry_repair'].includes(req.task)){if(failure==='修正失敗')throw Error('secret');return [{id:'c1',replacement:failure==='同じ修正'?original:fixed}];}
      if(round>1&&failure==='再照合失敗')throw Error('secret');
      return JSON.parse(req.user).claims.map(c=>({id:c.id,status:round>1&&failure==='再照合資料なし'?'資料なし':round>1&&failure==='再照合食い違い'?'食い違い':'裏付けあり',evidence_id:c.evidence_ids[0],basis:'1',correct:original}));
    }});
  assert.equal(r.record.status,'ok');assert.equal(r.record.remaining.length,0);assert(r.record.review_items.some(c=>c.status==='条件の違いを要確認'));
  assert.equal(r.body,failure==='再照合の誤警報'?fixed:original);
  assert(!r.record.corrections.some(c=>c.condition_mismatch&&!c.resolved));
});
test('02b-M1','条件の修正失敗を人へ戻しても判定自体の食い違いは差し止める',async()=>{
  const body='18歳以上の子が対象です。\n限度額は100万円です。', source=ref('mixed','制度','18歳以上の孫が対象です。\n限度額は200万円です。');
  const r=await F.checkFacts(body,{...opts,...writer,repair:false,searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,callLLM:async req=>{
    if(req.task==='extract')return extract(req).map((c,i)=>({...c,type:i?'金額':'要件'}));
    if(req.task==='condition_check')return {verdict:'不一致',conditions:[{article:'子',source:'孫',match:'不一致'}],correct:'18歳以上の孫が対象です。'};
    return supported(req).map((c,i)=>i?{...c,status:'食い違い',basis:'2',correct:'限度額は200万円です。'}:c);
  }});assert.equal(r.record.status,'revise');assert(r.record.remaining.some(c=>c.type==='金額'));assert.equal(r.record.claims[0].status,'裏付けあり');
});
test('02b-M1','複数文の条件修正が再照合できなければ丸ごと戻し、別の数字の確かめ済みの修正を保つ',async()=>{
  const original='18歳以上の子が対象です。', proposal='18歳以上の孫が対象です。申請書の案内も確認してください。';
  const source=ref('mixed-rollback','対象者と限度額','18歳以上の孫が対象です。\n限度額は200万円です。');let round=0;
  const r=await F.checkFacts(original+'\n限度額は100万円です。',{...opts,...writer,repair:true,searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,callLLM:async req=>{
    if(req.task==='extract'){round++;return extract(req).map(c=>({...c,type:c.claim.includes('万円')?'金額':'要件',subject:c.claim.includes('万円')?'限度額':'対象者'}));}
    if(req.task==='condition_check')return{verdict:'不一致',conditions:[{article:'子',source:'孫',match:'不一致'}],correct:proposal};
    if(req.task==='repair')return[{id:'c1',replacement:proposal},{id:'c2',replacement:'限度額は200万円です。'}];
    return JSON.parse(req.user).claims.map(c=>({id:c.id,status:c.type==='金額'?(round===1?'食い違い':'裏付けあり'):(round===1?'裏付けあり':'資料なし'),evidence_id:c.evidence_ids[0],basis:c.type==='金額'?'2':'1',correct:'限度額は200万円です。'}));
  }});assert.equal(r.record.status,'ok');assert.equal(r.body,original+'\n限度額は200万円です。');assert(r.record.corrections.some(c=>c.type==='金額'&&c.resolved));assert(!r.record.remaining.length);
});
test('02b-M1','条件修正が複数あるときも未確認の案だけ戻し、確かめ済みの別の条件修正を保つ',async()=>{
  const body='甲の対象者は18歳以上の子です。\n乙の対象者は18歳以上の子です。',source=ref('conditions-partial','対象者',body.replaceAll('子','孫'));let round=0;
  const r=await F.checkFacts(body,{...opts,...writer,repair:true,searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,callLLM:async req=>{
    if(req.task==='extract'){round++;return extract(req,'要件').map(c=>({...c,subject:c.claim.startsWith('甲')?'甲制度':'乙制度'}));}
    if(req.task==='condition_check'){const article=JSON.parse(req.user).article;return round>1?condition():{verdict:'不一致',conditions:[{article:'子',source:'孫',match:'不一致'}],correct:article.replace('子','孫')};}
    if(req.task==='repair')return JSON.parse(req.user).corrections.map(c=>({id:c.id,replacement:c.sentence.replace('子','孫')}));
    return JSON.parse(req.user).claims.map(c=>({id:c.id,status:round>1&&c.subject==='乙制度'?'資料なし':'裏付けあり',evidence_id:c.evidence_ids[0],basis:c.subject==='甲制度'?'1':'2'}));
  }});assert.equal(r.record.status,'ok');assert.equal(r.body,body.replace('甲の対象者は18歳以上の子','甲の対象者は18歳以上の孫'));assert.equal(r.record.corrections.length,1);assert(r.record.corrections[0].resolved);
});

test('02b-M3','20文40主張の8文16主張は20%超として具体を外さない',async()=>{
  const body=Array.from({length:20},(_,i)=>`${i<8?'架空条件を満たせば対象':'申請書を提出'}となります（項目${i}）。`).join('\n'),source=ref('m3','制度','申請書を提出して手続を行います。');
  const r=await F.checkFacts(body,{...opts,...writer,repair:true,searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,callLLM:async req=>{
    if(req.task==='extract')return extract(req,'要件').flatMap(c=>[c,{...c,type:'手続'}]);
    if(req.task==='condition_check')return condition();
    if(req.task==='repair')return JSON.parse(req.user).corrections.map(c=>({id:c.id,replacement:'詳しくは国税庁で確認してください。'}));
    return supported(req).map((c,i)=>JSON.parse(req.user).claims[i].claim.includes('架空条件')?{id:c.id,status:'資料なし'}:c);
  }});assert.equal(r.record.claims.length,40);assert.equal(r.body,body);assert(r.record.summary.includes('資料なしが多いため具体を外していません'));assert(!r.record.calls.some(c=>c.task==='repair'));assert.equal(r.record.review_items.length,16);
});

test('02b-L1','一方だけ直しの対象になる同じ文は部分採用せず、別の文の採用は保つ',async()=>{
  const sentence='限度額は100万円、控除額は50万円です。',other='別の限度額は80万円です。';
  const fs=[claim('c1',sentence),claim('c2',sentence),claim('c3',other)].map(c=>({...c,status:'食い違い'}));
  const r=await F.repairBody(sentence+'\n'+other,fs,async req=>req.task==='retry_repair'?[{id:'c1',replacement:'限度額は200万円、控除額は50万円です。'}]:[{id:'c1',replacement:sentence},{id:'c2',replacement:''},{id:'c3',replacement:'別の限度額は90万円です。'}],writer);
  assert.equal(r.body,sentence+'\n別の限度額は90万円です。');assert(r.rejected.has('c1')&&r.rejected.has('c2'));
});
test('02b-L2','同じ制度の別の修正文に新しく入った30%を変わっていない数字として通さない',async()=>{
  const a='みなし仕入率60%で売上税額に30%を掛けます。',b='控除率は50%で計算します。',aa=a.replace('60%','70%'),bb='控除率は80%で計算し、売上税額に30%を掛けます。';
  const source=ref('l2','みなし仕入率と控除率','みなし仕入率は70%です。\n控除率は80%です。');let round=0;
  const r=await F.checkFacts(a+'\n'+b,{...opts,...writer,repair:true,searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,callLLM:async req=>{
    if(req.task==='extract'){round++;return extract(req,'割合','みなし仕入率と控除率').flatMap((c,i)=>[{...c,claim:i===0?`みなし仕入率${round===1?60:70}%`:`控除率${round===1?50:80}%`},...(round>1&&i===1?[{...c,claim:'売上税額に30%を掛けます。'}]:[])]);}
    if(req.task==='repair')return [{id:'c1',replacement:aa},{id:'c2',replacement:bb}];
    return JSON.parse(req.user).claims.map(c=>({id:c.id,status:c.claim.includes('30%')?'資料なし':round===1?'食い違い':'裏付けあり',evidence_id:c.evidence_ids[0],basis:'1-2',correct:c.claim.includes('控除率')?'控除率は80%で計算します。':'みなし仕入率70%で売上税額を計算します。'}));
  }});assert.equal(r.record.status,'revise');assert(r.record.remaining.some(c=>c.claim.includes('30%')&&!c.unchanged_numeric));
});

test('02b-L4','計画のW規則は4〜6、出典も計画も無い日次・差し戻しにもW規則を渡す',async()=>{
  const P=require('../article-plan'),G=require('../../generate-draft'),CM=require('../content-model'),{WRITER_RULES}=require('../grounding-rules');
  const block=P.buildPlanBlock([{name:'制度',materials:[]}],[],[catalogRef('ta:4508')]);
  WRITER_RULES.forEach((rule,i)=>assert(block.includes(`\n${i+4}. ${rule}`)));assert(block.indexOf('4. '+WRITER_RULES[0])>block.indexOf('3. 「扱う制度」'));
  const old=CM.generateContent;let prompt='';CM.generateContent=async req=>{prompt=[req.staticSystem,req.dynamicSystem,req.user].join('\n');return {text:'## 確認\n確認します。',provider:'anthropic',model:'fake',stopReason:'end_turn'};};
  try{await env({FACT_PLAN_ENABLED:'false'},async()=>{await G.generateWithContentModel('2026-10-21',{slug:'unsourced-02b',title:'確認する',persona:'test',article_type:'basic_explainer'});WRITER_RULES.forEach(rule=>assert(prompt.includes(rule)));assert(!prompt.includes('═══ この記事で扱う制度と資料 ═══'));
    const blocks=await G.buildRegenSourceBlocks({slug:'unsourced-02b'},'確認します。',{enrichTaxTerms:async()=>{},resolveSupplement:async()=>null});WRITER_RULES.forEach(rule=>assert(blocks.combined.includes(rule)));});}finally{CM.generateContent=old;}
});

for(const result of ['回復','再度不正','空配列','失敗','JSON不正','別の文'])test('02b-R4',`主張の形式が不正な文だけを1回抜き出し直す（${result}）`,async()=>{
  const source=catalogRef('ta:4508'),body='## 本題\n住宅資金の非課税を確認します。\n## 手続\n手続の案内を確認します。',calls=[];
  const r=await F.checkFacts(body,{...opts,extractModel:'claude-sonnet-5-5',writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,callLLM:async req=>{
    calls.push(req);
    if(req.task==='extract')return extract(req,'要件').slice(0,1).map(c=>({...c,type:'制度説明'}));
    if(req.task==='retry_extract'){
      assert.equal(req.immediate,true);assert.equal(req.model,'claude-sonnet-5-5');assert.equal(req.system,calls[0].system);assert(!req.user.includes('手続の案内'));
      if(result==='失敗')throw Error('secret');if(result==='空配列')return [];
      if(result==='JSON不正')return '{';
      return extract(req,result==='再度不正'?'制度説明':'要件').map(c=>({...c,s:result==='別の文'?4:c.s}));
    }
    if(req.task==='condition_check')return condition();return supported(req);
  }});assert.equal(calls.filter(c=>c.task==='retry_extract').length,1);assert(r.record.calls.some(c=>c.task==='retry_extract'));
  assert.equal(r.record.discarded,result==='回復'?0:1);assert.equal(r.record.status,result==='回復'?'ok':'revise');
});

test('02c-H3', '段Aの範囲外4件は、聞き直しと段Bが資料なしでも歯止めに残る', async () => {
  const source = catalogRef('ta:4508');
  const body = ['甲','乙','丙','丁'].map(s => `${s}の省エネ等住宅の非課税限度額は1,000万円です。`).join('\n');
  const r = await F.checkFacts(body, { ...opts, repair: true, writer_materials: ['ta:4508'],
    searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '金額', '住宅取得等資金の贈与の非課税');
      if (req.task === 'repair') return JSON.parse(req.user).corrections.map(c => ({ id: c.id, replacement: c.sentence.replace('1,000万円', '一定の額') }));
      return JSON.parse(req.user).claims.map(c => req.stageB || req.task === 'retry_judge' ? { id: c.id, status: '資料なし' }
        : { id: c.id, status: '裏付けあり', evidence_id: 1, basis: '99999' });
    } });
  assert.equal(r.record.status, 'not_run'); assert.equal(r.body, body); assert(!r.record.calls.some(c => c.task === 'repair'));
});

for (const route of ['判定', '条件']) test('02c-N1', `4511の50歳未満を住宅資金へ持ち込まない（${route}）`, async () => {
  const home = catalogRef('ta:4508'), family = catalogRef('ta:4511');
  const sentence = '受贈者は18歳以上の者に限られます。', wrong = '受贈者は18歳以上50歳未満の者に限られます。';
  const ids = ['ta:4508','ta:4510','ta:4511'];
  const ranked = W.searchWriterEvidence(claim('c1', sentence, '要件', '直系尊属からの贈与の非課税'), { writer_materials: ids });
  assert.equal(ranked[0].id, home.id); assert(ranked.some(e => e.id === family.id));
  const r = await F.checkFacts(sentence, { ...opts, repair: true, writer_materials: ids, loadEvidenceText: e => W.resolveMaterial(W.materialId(e))?.text || e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '要件', '直系尊属からの贈与の非課税');
      if (req.task === 'condition_check') return route === '条件' ? { verdict: '不一致', conditions: [{ article: '18歳以上', source: '50歳未満', match: '不一致' }], correct: wrong } : condition();
      if (req.task === 'repair') return [{ id: 'c1', replacement: wrong }];
      return JSON.parse(req.user).claims.map(c => req.stageB ? pageAnswer(req, c.id, home, /18歳以上/, '裏付けあり')
        : pageAnswer(req, c.id, family, /50歳未満/, route === '条件' || c.claim === wrong ? '裏付けあり' : '食い違い', wrong));
    } });
  assert.equal(r.body, sentence); assert.equal(r.record.status, 'ok'); assert(!r.record.calls.some(c => c.task === 'repair'));
  if (route === '判定') assert.equal(r.record.claims[0].stage, 'B');
  else assert(r.record.review_items.some(c => c.status === '条件の違いを要確認'));
});

test('02c-N2', '要件だけ拾い直しても1,000万円と令和8年12月31日の未照合を消さない', async () => {
  const source = catalogRef('ta:4508'), sentence = '省エネ等住宅は1,000万円まで、令和8年12月31日までの贈与が対象です。';
  const r = await F.checkFacts(sentence, { ...opts, writer_materials: ['ta:4508'], searchEvidence: () => [source], loadEvidenceText: e => source.text,
    callLLM: async req => {
      if (req.task === 'extract') return [{ s: 1, type: '制度説明', subject: '住宅取得等資金の贈与の非課税', claim: sentence }];
      if (req.task === 'retry_extract') return [{ s: 1, type: '要件', subject: '住宅取得等資金の贈与の非課税', claim: '省エネ等住宅が対象です。' }];
      if (req.task === 'condition_check') return condition();
      return JSON.parse(req.user).claims.map(c => pageAnswer(req, c.id, source, /1,000万円/, '裏付けあり'));
    } });
  assert.equal(r.record.status, 'revise'); assert.equal(r.record.discarded, 1); assert.equal(r.body, sentence);
});

for (const [article, sourceText] of [['95%以上','95%未満'], ['届出書で足りる','承認申請書が必要'], ['戻れます','戻れません'], ['青色申告者は','青色申告者で届出をした者は']]) {
  test('02c-N3', `${article}と${sourceText}の不一致を黙って捨てない`, async () => {
    const source = catalogRef('law:shotokuzei_hou:37'), sentence = article + 'という条件です。';
    const r = await F.checkFacts(sentence, { ...opts, writer_materials: ['law:shotokuzei_hou:37'], searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
      callLLM: async req => {
        if (req.task === 'extract') return extract(req, '要件', '必要経費');
        if (req.task === 'condition_check') return { verdict: '不一致', conditions: [{ article, source: sourceText, match: '不一致' }], correct: sourceText + 'という条件です。' };
        return supported(req);
      } });
    assert(r.record.claims[0].status === '食い違い' || r.record.review_items.some(c => c.status === '条件の違いを要確認'));
  });
}

test('02c-N5', '子を孫に直した後の金額だけの裏付けで要件の修正を確定しない', async () => {
  const source = catalogRef('ta:4103'), amount = catalogRef('ta:2795'), sentence = '18歳以上の子が対象で、限度額は100万円です。', fixed = sentence.replace('子','孫'); let round = 0;
  const select = c => c.type === '金額' ? [amount] : [source];
  const r = await F.checkFacts(sentence, { ...opts, repair: true, writer_materials: ['ta:4103','ta:2795'], searchWriterEvidence: select, searchEvidence: select, loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') { round++; return extract(req, '要件', '相続時精算課税').flatMap(c => [c, { ...c, type: '金額', claim: '限度額は100万円です。' }]); }
      if (req.task === 'condition_check') return round === 1 ? { verdict: '不一致', conditions: [{ article: '18歳以上の子', source: '18歳以上の孫', match: '不一致' }], correct: '18歳以上の孫が対象です。' } : condition();
      if (req.task === 'repair') return [{ id: 'c1', replacement: fixed }];
      return JSON.parse(req.user).claims.map(c => round > 1 && c.type === '要件' ? { id: c.id, status: '資料なし' }
        : pageAnswer(req, c.id, c.type === '金額' ? amount : source, c.type === '金額' ? /税額 100万円以下/ : /推定相続人/, '裏付けあり'));
    } });
  assert.equal(r.body, sentence); assert.equal(r.record.status, 'ok'); assert(r.record.review_items.some(c => c.status === '条件の違いを要確認'));
});

const recordedCorrections = [
  ['売上原価', '値下げして販売した商品は、その販売価格で売上が立ち、取得価額が売上原価になります。', '必要経費に算入できるのは、総収入金額に対応する売上原価その他その総収入金額を得るために直接要した費用の額です。', 'law:shotokuzei_hou:37', /必要経費/],
  ['棚卸資産の評価', '値が付かないと説明できる根拠がない限り認められにくい処理です。', '期末棚卸資産の評価の方法は、政令で定める方法の中から選定でき、青色申告の承認を受けていない場合は原価法によります。', 'law:shotokuzei_hou:47', /評価/],
];
for (const [subject, sentence, correct, id, pattern] of recordedCorrections) for (const route of ['判定','条件']) test('02c-N6', `fcr2-642の${subject}を無関係な一般論に直さない（${route}）`, async () => {
  const source = catalogRef(id);
  const r = await F.checkFacts(sentence, { ...opts, repair: true, writer_materials: [id], searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extract(req, '判定', subject);
      if (req.task === 'condition_check') return { verdict: '不一致', conditions: [{ article: sentence, source: correct, match: '不一致' }], correct };
      if (req.task === 'repair') return [{ id: 'c1', replacement: correct }];
      return JSON.parse(req.user).claims.map(c => pageAnswer(req, c.id, source, pattern, route === '条件' || c.claim === correct ? '裏付けあり' : '食い違い', correct));
    } });
  assert.equal(r.body, sentence); assert.equal(r.record.status, 'ok'); assert(r.record.review_items.length > 0);
  assert(!r.record.calls.some(c => c.task === 'repair'));
  assert.equal(r.record.claims[0].status, route === '判定' ? '食い違い' : '裏付けあり');
});

for (const answer of ['候補なし','答えなし','却下','裏付けあり']) test('02c-H3', `段Bの${answer}による歯止めの引継ぎ`, async () => {
  const source = catalogRef('ta:4508'), body = ['甲','乙','丙','丁'].map(s => `${s}の省エネ等住宅の非課税限度額は1,000万円です。`).join('\n');
  const r = await F.checkFacts(body, { ...opts, writer_materials: ['ta:4508'], searchWriterEvidence: () => [source],
    searchEvidence: () => answer === '候補なし' ? [] : [source], loadEvidenceText: e => e.text, callLLM: async req => {
      if (req.task === 'extract') return extract(req, '金額', '住宅取得等資金の贈与の非課税');
      if (req.stageB && answer === '答えなし') return [];
      return JSON.parse(req.user).claims.map(c => req.stageB && answer === '裏付けあり' ? pageAnswer(req,c.id,source,/1,000万円/,'裏付けあり')
        : req.task === 'retry_judge' ? { id:c.id,status:'資料なし' } : { id:c.id,status:'裏付けあり',evidence_id:1,basis:'99999' });
    } });
  assert.equal(r.record.status, answer === '裏付けあり' ? 'ok' : 'not_run'); assert.equal(r.body, body);
});

test('02c-N2', '拾い直せた金額だけを消し、同じ文の期限の未照合を残す', async () => {
  const body = '省エネ等住宅は1,000万円まで、令和8年12月31日までの贈与が対象です。';
  const r = await F.extractClaims(body, async req => req.task === 'retry_extract' ? [{ s:1,type:'金額',subject:'住宅資金',claim:'限度額は1,000万円です。' }]
    : ['限度額は1,000万円です。','令和8年12月31日までの贈与が対象です。'].map(claim => ({s:1,type:'制度説明',subject:'住宅資金',claim})), writer);
  assert.equal(r.claims.length,1); assert.equal(r.discarded,1); assert(r.discardedClaims[0].claim.includes('令和8年12月31日'));
});

test('02c-H3', '段Aが資料なしでも段Bで却下された4件の歯止めを消さない', async () => {
  const source=catalogRef('ta:4508'),body=['甲','乙','丙','丁'].map(s=>`${s}の限度額は1,000万円です。`).join('\n');
  const r=await F.checkFacts(body,{...opts,repair:true,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,
    callLLM:async req=>req.task==='extract'?extract(req,'金額','住宅取得等資金の贈与の非課税'):JSON.parse(req.user).claims.map(c=>
      req.stageB && req.task!=='retry_judge'?{id:c.id,status:'裏付けあり',evidence_id:1,basis:'99999'}:{id:c.id,status:'資料なし'})});
  assert.equal(r.record.status,'not_run');assert.equal(r.body,body);assert(!r.record.calls.some(c=>c.task==='repair'));
});

test('02c-その他', '抜き出し直しは10文ずつ3回まで・同じ文を二度送らず、上限の外を未照合に残す', async () => {
  const body = Array.from({length:31},(_,i) => `項目${i}の対象者を確認します。`).join('\n'), calls=[];
  const r = await F.extractClaims(body, async req => {
    if (req.task === 'retry_extract') { calls.push(req); assert.equal(req.immediate,true); return extract(req,'要件'); }
    return extract(req,'制度説明');
  }, {...writer,maxClaims:80});
  assert.equal(calls.length,3); const numbers=calls.flatMap(req => extract(req,'要件').map(c=>c.s));
  assert(calls.every(req => extract(req).length===10)); assert.equal(new Set(numbers).size,30);
  assert.equal(r.claims.length,30); assert.equal(r.discarded,1); assert.equal(r.discardedClaims[0].s,31);
});

test('02c-N3', '言い回しだけの不一致も一覧に残し、書き換えと差し止めには使わない', async () => {
  const source=catalogRef('ta:4510'), sentence='必要な都度支払います。';
  const r=await F.checkFacts(sentence,{...opts,repair:true,writer_materials:['ta:4510'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,
    callLLM:async req=>req.task==='extract'?extract(req,'要件','教育資金'):req.task==='condition_check'?{
      verdict:'不一致',conditions:[{article:sentence,source:'必要な都度直接支払います。',match:'不一致'}],correct:'必要な都度直接支払います。'
    }:supported(req)});
  assert.equal(r.body,sentence);assert.equal(r.record.status,'ok');assert.equal(r.record.review_items[0].status,'条件の違いを要確認');
  assert(!r.record.calls.some(c=>c.task==='repair'));
});

test('02c-N7', '資料なしの対象者を「対象となる人の範囲は国税庁で確認してください。」に一般化できる', async () => {
  const sentence='18歳以上の子が対象です。', replacement='対象となる人の範囲は国税庁で確認してください。';
  const r=await F.repairBody(sentence,[{...claim('c1',sentence,'要件','相続時精算課税'),status:'資料なし'}],async()=>[{id:'c1',replacement}],writer);
  assert.equal(r.body,replacement);assert.equal(r.accepted,true);assert.equal(r.rejected.size,0);
});

test('02c-N6', '置き換えにも制度名の売上原価だけが残る一般論を落とし、同じ話題の直しを採る', async () => {
  const [subject,sentence,unrelated]=recordedCorrections[0], fixed='値下げして販売した商品は販売価格を売上に計上し、取得価額を売上原価にします。',calls=[];
  const r=await F.repairBody(sentence,[{...claim('c1',sentence,'判定',subject),status:'食い違い',correct:fixed}],async req=>{
    calls.push(req.task);return[{id:'c1',replacement:req.task==='retry_repair'?fixed:unrelated}];
  },{writer_materials:['law:shotokuzei_hou:37']});
  assert.deepEqual(calls,['repair','retry_repair']);assert.equal(r.body,fixed);assert.equal(r.rejected.size,0);
});

test('02c-N8', '注意点を誤りの例と扱わず、誤解の例だけを抽出・条件確認・修正に指定する', async () => {
  const source=catalogRef('ta:4508'), body='## 注意点\n受贈者は18歳以上の者に限られます。', seen=[];
  await F.checkFacts(body,{...opts,writer_materials:['ta:4508'],searchWriterEvidence:()=>[source],searchEvidence:()=>[source],loadEvidenceText:e=>e.text,
    callLLM:async req=>{seen.push(req);return req.task==='extract'?extract(req,'要件','住宅資金'):req.task==='condition_check'?condition():supported(req);}});
  const checks=seen.filter(req=>req.task==='condition_check');assert.equal(checks.length,1);
  assert(checks[0].system.includes('誤りの例（『よくある誤解』『NG例』『〜と考えるのは誤り』など）'));
  assert(!checks[0].system.includes('誤りの例・注意'));assert.equal(JSON.parse(checks[0].user).heading,'注意点');
  await F.repairBody('受贈者は18歳以上です。',[{...claim('c1','受贈者は18歳以上です。','要件'),status:'食い違い'}],async req=>{
    assert(req.system.includes('誤りの例（『よくある誤解』'));assert(!req.system.includes('誤りの例・注意'));return[{id:'c1',replacement:'受贈者は19歳以上です。'}];
  },writer);
});

test('02c-その他', '計画と出典の本文がある全文・部分差し戻しのW規則は各1回、計画なしでも1回', async () => {
  const G=require('../../generate-draft'), {WRITER_RULES}=require('../grounding-rules'), source=catalogRef('ta:4452');
  const base={title:'贈与税の配偶者控除',tax_domain:'inheritance_tax',tax_terms:'贈与税 配偶者控除',source_url:source.url,source_title:source.title};
  const check=text=>{for(const rule of WRITER_RULES)assert.equal(text.split(rule).length-1,1,rule);};
  await env({FACT_PLAN_ENABLED:'true'},async()=>{
    for(const meta of [base,{...base,fact_plan_status:'ok',fact_plan:'贈与税の配偶者控除',fact_materials:'ta:4452'}]){
      const b=await G.buildRegenSourceBlocks(meta,'確認します。',{enrichTaxTerms:async()=>{},resolveSupplement:async()=>null});
      check(b.combined);check(b.sourceBody+b.fullPlanBlock);
    }
  });
});

for (const setting of [undefined, '', 'false']) test('02d-既定', `未設定・空・falseでは資料の有無で呼び出し・記録・結果を変えない（${String(setting)}）`, async () => {
  await env({ FACT_CHECK_WRITER_MATERIALS: setting, FACT_CHECK_MAX_CLAIMS: undefined }, async () => {
    const source=catalogRef('ta:4452');
    for (const scenario of ['裏付けあり','食い違い','従来の修正','資料なし','確認落ち']) {
      const body=scenario==='資料なし'?'配偶者控除の対象者を確認します。':scenario==='確認落ち'
        ? ['甲','乙','丙'].map(s=>`${s}の控除額は2,000万円です。`).join('\n')
        : `贈与税の配偶者控除は${scenario==='裏付けあり'?'2,000':'2,500'}万円です。`;
      const run=async materials=>{
        const calls=[];let round=0;
        const result=await F.checkFacts(body,{...opts,...F.articleEvidenceOptions(materials?{fact_materials:'ta:4452'}:{}),repair:true,
          resolvedWriterMaterials:[source],searchWriterEvidence:()=>{throw Error('既定では書き手の資料を検索しない');},
          searchEvidence:()=>[source],loadEvidenceText:e=>e.text,callLLM:async req=>{
            calls.push(Object.fromEntries(Object.entries(req).filter(([key])=>key!=='signal')));
            if(req.task==='extract'){round++;return extract(req,scenario==='資料なし'?'要件':'金額','贈与税の配偶者控除');}
            if(req.task==='repair')return JSON.parse(req.user).corrections.map(c=>({id:c.id,replacement:scenario==='従来の修正'?c.sentence.replace('2,500','2,000'):c.sentence}));
            return JSON.parse(req.user).claims.map(c=>scenario==='資料なし'?{id:c.id,status:'資料なし'}:scenario==='確認落ち'
              ?{id:c.id,status:'裏付けあり',evidence_id:1,basis:'99999'}
              :pageAnswer(req,c.id,source,/2,000万円/,round===1&&['食い違い','従来の修正'].includes(scenario)?'食い違い':'裏付けあり','贈与税の配偶者控除は2,000万円です。'));
          }});
        return {calls,...result};
      };
      const baseline=await run(false),withMaterials=await run(true);
      assert.deepEqual(withMaterials,baseline,scenario);
      assert.equal(F.config({writer_materials:['ta:4452']}).maxClaims,40);
      for(const key of ['writer_materials','stages','calculated_skipped'])assert(!Object.hasOwn(withMaterials.record,key),key);
      assert(!withMaterials.calls.some(c=>['retry_extract','retry_judge','condition_check','retry_repair'].includes(c.task)));
      assert(withMaterials.record.claims.every(c=>!Object.hasOwn(c,'stage')));
      assert.equal(withMaterials.record.status,scenario==='確認落ち'?'not_run':scenario==='食い違い'?'revise':'ok');
      if(scenario==='資料なし'){assert.equal(withMaterials.body,body);assert.deepEqual(withMaterials.calls.map(c=>c.task),['extract','judge']);}
      if(scenario==='従来の修正'){assert(withMaterials.body.includes('2,000万円'));assert(withMaterials.record.corrections.some(c=>c.resolved));}
    }
  });
});

for (const setting of [undefined, '', 'false']) test('02d-既定', `資料の記録を追加しても従来の差分照合の指紋・呼び出し・記録を変えない（${String(setting)}）`, async () => {
  await env({FACT_CHECK_WRITER_MATERIALS:setting},async()=>{
    const matter=require('gray-matter'),source=catalogRef('ta:4452'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan02d-default-'));
    const meta={slug:'plan02d-default',source_url:source.url},body='贈与税の配偶者控除は2,000万円です。\n内容を確認します。';
    const before=matter.stringify(body,meta),after=matter.stringify(body.replace('内容を確認','記載内容を確認'),meta);
    try {
      const run=async materials=>{
        const calls=[],recordDir=path.join(dir,materials?'materials':'legacy');
        const options={...opts,recordDir,searchEvidence:()=>[source],loadEvidenceText:e=>e.text,callLLM:async req=>{
          calls.push(Object.fromEntries(Object.entries(req).filter(([key])=>key!=='signal')));
          return req.task==='extract'?extract(req,'金額','贈与税の配偶者控除').filter(c=>c.claim.includes('配偶者控除'))
            :JSON.parse(req.user).claims.map(c=>pageAnswer(req,c.id,source,/2,000万円/,'裏付けあり'));
        }};
        await F.checkArticle(before,options);calls.length=0;
        const raw=materials?matter.stringify(matter(after).content,{...meta,fact_plan_status:'ok',fact_plan:'贈与税の配偶者控除',fact_materials:'ta:4452'}):after;
        const result=await F.checkArticle(raw,{...options,previousRaw:before});
        if(materials){assert.equal(matter(result.content).data.fact_materials,'ta:4452');assert.equal(matter(result.content).data.fact_plan_status,'ok');}
        return {calls,body:result.body,record:result.record};
      };
      const baseline=await run(false),withMaterials=await run(true);
      assert.deepEqual(withMaterials,baseline);assert.equal(withMaterials.record.incremental.reused,1);
      assert.deepEqual(withMaterials.calls.map(c=>c.task),['extract']);assert(!Object.hasOwn(withMaterials.record,'writer_materials'));
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});

test('02d-既定','trueという文字列だけで有効になり、既定は40件・AnthropicのOpusのまま',async()=>{
  for(const setting of [undefined,'','false','TRUE','1',' true ','true'])await env({FACT_CHECK_WRITER_MATERIALS:setting,
    FACT_CHECK_MAX_CLAIMS:undefined,FACT_CHECK_PROVIDER:undefined,FACT_CHECK_MODEL:undefined},async()=>{
    const options={writer_materials:['ta:4452'],resolvedWriterMaterials:[catalogRef('ta:4452')]};
    assert.deepEqual(W.writerMaterials(options),setting==='true'?['ta:4452']:[]);
    assert.equal(F.config(options).maxClaims,setting==='true'?80:40);
    assert.equal(F.config(options).provider,'anthropic');assert.equal(F.config(options).model,'claude-opus-5-5');
    assert.deepEqual(W.writerMaterials({...options,writerMaterials:false}),[]);
  });
});

test('02d-既定','照合が既定オフでも計画・W1〜W3・前付けの資料の記録は既定で動く',async()=>{
  await env({FACT_CHECK_WRITER_MATERIALS:undefined,FACT_PLAN_ENABLED:undefined},async()=>{
    const P=require('../article-plan'),G=require('../../generate-draft'),matter=require('gray-matter'),{WRITER_RULES}=require('../grounding-rules');
    const source=catalogRef('ta:4452'),topic={title:source.title,tax_domain:'inheritance_tax',tax_terms:'贈与税 配偶者控除'};
    const block=await P.prepareArticlePlan(topic,{generate:async()=>'[{"name":"贈与税の配偶者控除"}]',references:[source]});
    assert.equal(P.enabled(),true);assert.equal(topic.fact_plan_status,'ok');assert(topic.fact_materials.split(';').includes('ta:4452'));
    for(const rule of WRITER_RULES)assert(block.includes(rule));
    const raw=G.recordMaterialMetadata(matter.stringify('確認します。',{slug:'plan02d-default'}),topic),meta=matter(raw).data;
    for(const key of P.META_FIELDS)assert.equal(meta[key],topic[key]);
    assert.deepEqual(W.writerMaterials(F.articleEvidenceOptions(meta)),[]);
  });
});

(async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('試験中の通信は禁止'); };
  try {
    await env({ FACT_CHECK_WRITER_MATERIALS: 'true' }, async () => {
      for (const { group, name, run } of cases) {
        const result = groups[group] ||= { pass: 0, fail: 0 };
        try { await run(); result.pass++; console.log(`PASS ${group}: ${name}`); }
        catch (error) { result.fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
      }
    });
  } finally { global.fetch = originalFetch; }
  const passed = Object.values(groups).reduce((n, r) => n + r.pass, 0), failed = Object.values(groups).reduce((n, r) => n + r.fail, 0);
  console.log(JSON.stringify({ passed, failed, groups })); if (failed) process.exitCode = 1;
})();
