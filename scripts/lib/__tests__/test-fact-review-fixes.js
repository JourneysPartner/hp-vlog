'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const matter = require('gray-matter');
const F = require('../fact-check');
const G = require('../../generate-draft');
let pass = 0, fail = 0;
const groups = {};
async function test(group, fn) {
  groups[group] ||= { pass: 0, fail: 0 };
  try { await fn(); pass++; groups[group].pass++; console.log(`PASS ${group}`); }
  catch (e) { fail++; groups[group].fail++; console.error(`FAIL ${group}: ${e.stack}`); }
}
const sentence = '制度の期限は令和9年3月31日です。';
const claim = (s = sentence, type = '期限') => ({ sentence: s, type, subject: '制度', claim: s });
const raw = body => `---\nslug: test\ntitle: "制度の確認"\nrecommendation: "publish"\n---\n${body}`;
const refs = [{ id: 'e1', text: sentence, title: '根拠', url: 'https://example.jp/' }];
const judge = async req => req.task === 'extract' ? [claim(req.user)] : [{ id: 'c1', status: '裏付けあり', quote: sentence }];
async function main() {
  for (const status of ['ok', 'revise', 'not_run']) await test('F1', () => {
    const meta = matter(F.applyFactResult(raw(sentence), { body: sentence, record: { status, claims: [], summary: '結果' } })).data;
    assert.equal(meta.fact_check_blocking, status !== 'ok');
  });
  await test('F1', async () => {
    const approval = require('../../../netlify/functions/review-approve-background');
    for (const refresh of [false, true]) for (const status of ['revise', 'not_run']) {
      let writes = 0;
      const content = F.updateMeta(raw(sentence), { fact_check_blocking: true, fact_check_status: status });
      const r = await approval._handler({ httpMethod: 'POST', body: JSON.stringify({ filename: 'test.md', ...(refresh ? { ref: 'draft/refresh-test' } : {}) }) }, {
        getFile: async () => ({ content, sha: 's' }), putFile: async () => { writes++; }, sendNotification: async () => {},
      });
      assert.equal(r.statusCode, 400); assert.equal(writes, 0); assert.match(r.body, /事実の照合で承認できない/);
    }
  });
  await test('F2', async () => {
    let calls = 0;
    const options = { factCheck: async content => { calls++; return { content, record: { status: 'ok', summary: '' } }; } };
    await G.finalizeRegeneration(raw(sentence), raw(sentence + '本文を変更。'), { scope: 'frontmatter', type: 'title_only' }, options);
    assert.equal(calls, 1);
    await G.finalizeRegeneration(raw(sentence), raw(sentence).replace('制度の確認', '確定題名'), { scope: 'full' }, options);
    assert.equal(calls, 1);
  });
  await test('F3', async () => {
    for (const replace of [false, true]) {
      const order = [], t = { source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm', source_provenance: 'domain-fallback', title: '棚卸資産' };
      await G.prepareSources([t], { ensureSource: () => {}, enrichTaxTerms: async t => { order.push('terms'); t.tax_terms = '棚卸資産'; },
        enrichSource: async t => { order.push('select'); if (replace) t.source_url = 'https://example.jp/specific'; },
        resolveSupplement: async () => { order.push('supplement'); return null; } });
      assert.deepEqual(order.slice(0, 2), ['terms', 'select']);
      assert.equal(order.includes('supplement'), !replace);
    }
  });
  await test('F3', async () => {
    const meta = { slug: 'test', title: '贈与の非課税', tax_domain: 'inheritance_gift',
      source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm', source_provenance: 'domain-fallback' };
    const url = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm';
    const order = [];
    await G.buildRegenSourceBlocks(meta, '', { enrichTaxTerms: async topic => { order.push('terms'); topic.tax_terms = '贈与税 非課税'; },
      ensureSource: () => { throw new Error('主出典を選び直さない'); },
      enrichSource: async () => { throw new Error('主出典を選び直さない'); },
      resolveSupplement: async () => { order.push('supplement'); return { url, title: '贈与税の非課税', provenance: 'auto', confidence: 0.8 }; },
    });
    assert.deepEqual(order, ['terms', 'supplement', 'supplement']);
    const saved = matter(G.recordMaterialMetadata(raw(sentence), meta)).data;
    assert.equal(saved.source_url, meta.source_url); assert.equal(saved.source_provenance, 'domain-fallback');
    assert.ok(saved.source_bundle.includes(url));
  });
  await test('F4', async () => {
    const N = require('../draft-normalizer');
    for (const status of ['', 'ok', 'revise']) {
      let original = F.updateMeta(raw(sentence), { title: '[要レビュー] test', recommendation: 'revise', review_warning: N.PLACEHOLDER_TITLE_WARNING });
      if (status) original = F.updateMeta(original, { fact_check_version: 1, fact_check_status: status, fact_check_blocking: status === 'revise', fact_check_prev_recommendation: 'revise' });
      const result = await G.finalizeRegeneration(original, original.replace('[要レビュー] test', '確定した題名'), { scope: 'frontmatter' });
      const meta = matter(result).data;
      assert.equal(meta.recommendation, status === 'revise' ? 'revise' : 'publish');
      if (status === 'ok') assert.equal(meta.fact_check_prev_recommendation, 'publish');
    }
  });
  await test('F5a', async () => {
    const r = await F.checkFacts('本文の説明。'.repeat(50), { callLLM: async () => [] });
    assert.equal(r.record.status, 'not_run'); assert.match(r.record.summary, /主張を抜き出せませんでした/);
  });
  await test('F5b', async () => {
    const body = '**制度の期限**は[令和９年３月３１日](https://example.jp/)です。';
    const extracted = await F.extractClaims(body, async () => [claim(sentence)]);
    assert.equal(extracted.claims[0].sentence, body); assert.equal(extracted.discarded, 0);
    const r = await F.checkFacts(sentence, { repair: false, searchEvidence: () => refs, callLLM: async req => req.task === 'extract' ? [claim(), claim('存在しない主張。')] : judge(req) });
    assert.equal(r.record.status, 'revise'); assert.equal(r.record.discarded, 1);
  });
  await test('F5c', async () => {
    const wrong = '制度の期限は令和8年3月31日です。';
    const r = await F.checkFacts(wrong, { searchEvidence: () => refs, callLLM: async req => {
      if (req.task === 'extract') return req.user.includes(wrong) ? [claim(wrong)] : [];
      if (req.task === 'judge') return [{ id: 'c1', status: '食い違い', quote: sentence, correct: sentence }];
      return sentence;
    } });
    assert.equal(r.record.status, 'revise'); assert.equal(r.record.corrections[0].resolved, false);
  });
  for (const quote of ['令和', '。', '制度の期限について説明している原文です。']) await test('F6', async () => {
    const r = await F.judgeClaims([{ ...claim(), id: 'c1' }], { c1: [{ ...refs[0], text: quote }] }, sentence,
      async () => [{ id: 'c1', status: '裏付けあり', quote }]);
    assert.equal(r[0].status, '資料なし');
  });
  await test('F6', async () => {
    const quote = '制度の期限は令和九年三月三十一日です。';
    const r = await F.judgeClaims([{ ...claim(), id: 'c1' }], { c1: [{ ...refs[0], text: quote }] }, sentence,
      async () => [{ id: 'c1', status: '裏付けあり', quote }]);
    assert.equal(r[0].status, '裏付けあり');
  });
  await test('F8', () => {
    const B = require('../nta-source-body');
    assert.equal(B.buildSourceBodyBlock({ source_url: 'https://example.jp/' }, [], { log: () => {} }), '');
    assert.match(require('../grounding-rules').SOURCE_UNCONFIRMED_RULE, /制度の一般的な説明にとどめ/);
  });
  await test('F8', () => {
    const B = require('../nta-source-body');
    const topic = { source_url: 'https://www.nta.go.jp/law/shitsugi/shotoku/07/05.htm' };
    const target = path.resolve(B.resolveSourceFile(topic.source_url));
    const originalRead = fs.readFileSync;
    fs.readFileSync = (file, ...args) => path.resolve(String(file)) === target
      ? JSON.stringify({ kankei_hourei: '所得税基本通達2-1、3-3' }) : originalRead(file, ...args);
    try {
      const refs = B.findTsutatsuFromSourceKankei(topic);
      assert.equal(refs.length, 2);
      assert.equal(B.buildTsutatsuBlockFromSourceKankei(topic, { exclude: refs }), '');
    } finally { fs.readFileSync = originalRead; }
    const source = fs.readFileSync(path.join(__dirname, '../../generate-draft.js'), 'utf8');
    assert.ok(source.includes("てください\\n' + SOURCE_UNCONFIRMED_RULE"));
  });
  await test('F9', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-fixes-'));
    try {
      const r = await F.checkArticle(raw(sentence), { enabled: false, recordDir: dir });
      assert.equal(r.record.body_sha256, F.bodyHash(sentence));
      const page = require('../../../netlify/functions/review-page');
      const html = page.renderFactCheck({ fact_check_status: 'ok' }, { ...r.record, status: 'ok' }, sentence + '変更');
      assert.match(html, /古い記録/); assert.ok(!html.includes('（ok）'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('F9', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-failure-'));
    try {
      const content = await G.runFactCheckForArticle(raw(sentence), { recordDir: dir,
        factCheck: async () => { throw new Error('記録保存前の失敗'); },
      });
      const record = JSON.parse(fs.readFileSync(path.join(dir, 'test.json'), 'utf8'));
      assert.equal(record.status, 'not_run'); assert.equal(record.body_sha256, F.bodyHash(sentence));
      assert.equal(matter(content).data.fact_check_blocking, true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('F10', () => {
    const claims = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, evidence: Array.from({ length: 3 }, (_, j) => ({ id: `${i}-${j}`, text: `${i}-${j}` + '原文'.repeat(998) })) }));
    const record = F.compactRecord({ claims, corrections: claims, rechecked: claims, remaining: claims });
    assert.equal(Object.keys(record.evidence).length, 120);
    assert.ok(Buffer.byteLength(JSON.stringify(record)) < 600 * 1024);
    assert.ok(!record.claims[0].evidence); assert.equal(record.claims[0].evidence_ids.length, 3);
    assert.equal(F.evidenceRefs(record, record.claims[0])[0].text, claims[0].evidence[0].text);
  });
  await test('F11', async () => {
    let calls = 0;
    const r = await F.checkArticle(F.updateMeta(raw(sentence), { enabled: false, model: '偽の設定', provider: 'openai' }), {
      persist: false, repair: false, searchEvidence: () => refs, callLLM: async req => { calls++; return judge(req); },
    });
    assert.ok(calls > 0); assert.equal(r.record.model, 'claude-opus-5-5');
  });
  await test('F12', async () => {
    const api = require('../../../netlify/functions/lib/github-api'), page = require('../../../netlify/functions/review-page');
    const saved = api.getFile;
    try { api.getFile = async () => { throw new Error('503 秘密'); }; assert.match(page.renderFactCheck({}, await page.fetchFactCheck('test')), /照合の記録を読めませんでした/); }
    finally { api.getFile = saved; }
  });
  await test('F13', async () => {
    const r = await F.checkFacts(sentence, { provider: 'openai', callLLM: async () => { throw new Error('呼んではならない'); } });
    assert.equal(r.record.status, 'not_run'); assert.equal(r.record.summary, '照合のモデル設定が不正です'); assert.equal(r.record.calls.length, 0);
  });
  await test('F14', async () => {
    const claims = ['c1', 'c2'].map(id => ({ ...claim(sentence, '要件'), id }));
    const r = await F.judgeClaims(claims, { c1: refs, c2: refs }, '', async () => claims.map(c => ({ id: c.id, status: '期限の書き漏れ', quote: sentence, correct: sentence })));
    assert.equal(r.length, 1); assert.equal(r[0].status, '期限の書き漏れ');
  });
  await test('F15', () => {
    const page = require('../../../netlify/functions/review-page');
    const html = page.renderReviewPage('test.md', { recommendation: 'revise', review_warning: '<script>危険</script>' }, '', '');
    assert.ok(html.includes('&lt;script&gt;危険')); assert.ok(!html.includes('<script>危険'));
  });
  await test('F16', async () => {
    const r = await F.checkArticle(raw(sentence), { persist: false, timeoutMs: 5, callLLM: async () => new Promise(() => {}) });
    assert.equal(r.record.status, 'not_run'); assert.equal(matter(r.content).data.fact_check_blocking, true);
    assert.equal(F.config().timeoutMs, 600000);
  });
  for (const task of ['judge', 'repair']) await test('F16', async () => {
    const wrong = '制度の期限は令和8年3月31日です。';
    let signal;
    const r = await F.checkArticle(raw(wrong), { persist: false, timeoutMs: 5, searchEvidence: () => refs,
      callLLM: async req => {
        if (req.task === task) { signal = req.signal; return new Promise(() => {}); }
        if (req.task === 'extract') return [claim(wrong)];
        return [{ id: 'c1', status: '食い違い', quote: sentence, correct: sentence }];
      },
    });
    assert.equal(r.record.status, 'not_run'); assert.equal(matter(r.content).data.fact_check_blocking, true);
    assert.equal(signal.aborted, true); assert.equal(r.body, wrong);
  });
  console.log(`レビュー修正: PASS ${pass} / FAIL ${fail}\n${JSON.stringify(groups)}`);
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
