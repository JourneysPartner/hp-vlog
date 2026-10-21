'use strict';

// P1〜P8の回帰試験。生成も照合も偽LLMだけを使い、作業ファイルはTEMPに置く。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const matter = require('gray-matter');
const P = require('../article-plan');
const W = require('../writer-materials');
const E = require('../fact-evidence');
const F = require('../fact-check');
const CM = require('../content-model');
const G = require('../../generate-draft');
const N = require('../draft-normalizer');
const { splitUnits } = require('../fact-units');
const H = require('./fact-pages-test-helpers');
const { CHANGES } = require('../tax-law-changes');
const { SOURCE_UNCONFIRMED_RULE } = require('../grounding-rules');
const groups = {}, cases = [];
const test = (group, name, fn) => cases.push({ group, name, fn });
const hash = text => createHash('sha256').update(text).digest('hex');
const topic = () => ({ slug: 'plan-off', title: '贈与税の配偶者控除を確認する', persona: 'test', article_type: 'basic_explainer',
  tax_domain: 'inheritance_gift_tax', tax_terms: '贈与税 配偶者控除', primary_question: '贈与税の配偶者控除を使えるか',
  source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4452.htm',
  source_title: '夫婦の間で居住用の不動産を贈与したときの配偶者控除', source_provenance: 'curated', source_confidence: 1 });
const fakeBody = '## 確認\n\n確認します。';
const now = new Date('2026-10-20T00:00:00.000Z');
const opts = { now, repair: false, batch: false, enabled: true, provider: 'anthropic', model: 'claude-opus-5-5' };
async function env(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
async function generating(t, answer, fn) {
  const original = { simple: CM.generateSimple, content: CM.generateContent, Date: global.Date };
  const prompts = [], simple = [];
  global.Date = class extends original.Date { constructor(...args) { super(...(args.length ? args : [now.toISOString()])); } static now() { return now.getTime(); } };
  CM.generateSimple = async (request, options) => { simple.push({ request, options }); if (answer instanceof Error) throw answer; return { text: answer }; };
  CM.generateContent = async request => { prompts.push(request); return { text: fakeBody, provider: 'anthropic', model: 'fake', stopReason: 'end_turn' }; };
  try { await G.generateWithContentModel('2026-10-20', t); return await fn({ prompts, simple, t }); }
  finally { CM.generateSimple = original.simple; CM.generateContent = original.content; global.Date = original.Date; }
}
function textPrompt(prompt) { return [prompt.staticSystem, prompt.dynamicSystem, prompt.user].join('\n'); }

for (const [name, answer, expected] of [
  ['配列', '[{"name":"相続時精算課税制度","why":"対象を説明"}]', 'ok'],
  ['コード囲みと前後の文', '[企画案] 説明\n```json\n[{"name":"配偶者控除"}]\n```\n後の文', 'ok'],
  ['読めない答え', '秘密の本文を含む不正な答え', 'failed'],
  ['空配列', '[]', 'failed'],
  ['不正な要素だけ', '[null,{"name":"短"},{"name":42}]', 'failed'],
  ['途中で切れた配列', '[{"name":"配偶者控除"}', 'failed'],
]) test('P1', name, async () => {
  const result = await P.planSystems(topic(), { generate: async () => answer });
  assert.equal(result.status, expected);
  if (expected === 'failed') assert(!JSON.stringify(result).includes('秘密'));
});
test('P1', '8件上限・NFKCの重複・長さ・why・JSON文字列中の角括弧', async () => {
  const rows = [{ name: ' ２割特例 ', why: 'a'.repeat(40) }, { name: '2割特例' }, { name: 'ｶﾀｶﾅ制度' }, { name: 'カタカナ制度' },
    { name: '控除[試験]', why: '制度の]説明' }, { name: 'x'.repeat(41) }, ...Array.from({ length: 10 }, (_, i) => ({ name: `試験制度${i}` }))];
  const r = await P.planSystems({}, { generate: async () => ({ text: JSON.stringify(rows) }) });
  assert.equal(r.systems.length, 8); assert.equal(r.systems[0].name, '２割特例'); assert.equal(r.systems[0].why.length, 30);
  assert.equal(r.systems.filter(s => s.name.normalize('NFKC') === 'カタカナ制度').length, 1);
  assert(r.systems.some(s => s.name === '控除[試験]'));
});
test('P1', '既定の提供元・指示文・企画8項目・2000 tokens', async () => {
  const original = CM.generateSimple;
  CM.generateSimple = async (request, { signal, ...options }) => {
    assert(signal instanceof AbortSignal);
    assert.equal(request.system, P.PLAN_SYSTEM); assert.deepEqual(options, { maxTokens: 2000 });
    assert.equal(request.user.split('\n').length, 8); assert(request.user.includes('tax_terms: 贈与税 配偶者控除'));
    return { text: '[{"name":"配偶者控除"}]' };
  };
  try { assert.equal((await P.planSystems(topic())).status, 'ok'); } finally { CM.generateSimple = original; }
});
test('P1', '例外の秘密を返さず投げない', async () => {
  const r = await P.planSystems({}, { generate: async () => { throw new Error('sk-secret-token'); } });
  assert.equal(r.status, 'failed'); assert(!JSON.stringify(r).includes('secret'));
});

const exampleNames = ['２割特例（小規模事業者に係る税額控除に関する経過措置）', '3割特例', '棚卸資産の評価方法', '贈与税の配偶者控除',
  '相続時精算課税制度', '直系尊属から結婚・子育て資金の一括贈与を受けた場合の非課税', '低価法'];
let examples;
test('P2', '変更前の外れを再現し、段Bの候補・点・抜粋を維持', () => {
  const a = E.searchEvidence({ subject: exampleNames[0], claim: exampleNames[0] }, { tax_domain: 'consumption_tax' });
  assert.equal(W.materialId(a[0]), 'ta:6503'); assert(a.some(e => e.id === 'tsutatsu:shohi:21-1-2'));
  const b = E.searchEvidence({ subject: exampleNames[2], claim: exampleNames[2] }, { tax_domain: 'income_tax' });
  assert.equal(W.materialId(b[0]), 'ta:1110'); assert.equal(b[0].score, 32.78);
  assert(!E.evidenceCatalog().entries.some(e => e.kind === 'qa'));
});
test('P2', 'カタログ全体の7制度・関連条件・6000字・外れの除外', () => {
  examples = P.findSystemMaterials(exampleNames.map(name => ({ name, why: '制度を説明' })), {});
  for (const s of examples) {
    assert.equal(s.missing, false, s.name); assert(s.materials.length <= 2 && s.materials.length > 0);
    for (const ref of s.materials) { assert(P.relevantMaterial(s.name, ref, ref.text).condition); assert(ref.text.length <= 6000); }
    console.log(`資料選択 ${s.name}: ${s.materials.map(ref => `${ref.title} [${W.materialId(ref)}] 条件${P.relevantMaterial(s.name, ref, ref.text).condition}`).join(' ／ ')}`);
  }
  const two = examples[0].materials;
  assert(two.some(e => ['ta:6351', 'ta:6498', 'ta:6101', 'qa:invoice/114', 'qa:invoice/115', 'qa:invoice/116'].includes(W.materialId(e))));
  assert(two.every(e => /2割特例/.test(e.text.normalize('NFKC'))));
  assert(!two.some(e => /貸倒れ|基準期間がない法人/.test(e.title)));
  assert(examples[1].materials.some(e => ['ta:6505', 'qa:invoice/115-2', 'qa:invoice/117'].includes(W.materialId(e))));
  assert(examples[1].materials.every(e => /3割特例/.test(e.text.normalize('NFKC'))));
  assert(examples[2].materials.every(e => /棚卸資産の評価/.test(e.title + e.text) && W.materialId(e) !== 'ta:1110'));
  assert(examples[5].materials.some(e => W.materialId(e) === 'ta:4511'));
  assert(examples[6].materials.every(e => e.text.includes('低価法')));
});
test('01b-F5', '贈与税の配偶者控除はNo.4452を上位2件に含む', () => {
  const ref = W.resolveMaterial('ta:4452'); const relation = P.relevantMaterial(exampleNames[3], ref, ref.text.split('関連リンク')[0]);
  assert(relation.titleMatch); assert(relation.condition);
  const rows = examples[3].materials;
  assert(rows.some(e => W.materialId(e) === 'ta:4452'));
});
test('01b-F5', '相続時精算課税制度はNo.4103を上位2件に含む', () => {
  const ref = W.resolveMaterial('ta:4103'); const relation = P.relevantMaterial(exampleNames[4], ref, ref.text.split('関連リンク')[0]);
  assert(relation.titleMatch); assert(relation.condition);
  assert(examples[4].materials.some(e => W.materialId(e) === 'ta:4103'));
});
test('P2', '架空の制度・本文の関連リンクだけ・法令本文だけでは採らない', () => {
  assert.equal(P.findSystemMaterials([{ name: '宇宙猫事業者免税還付制' }], {})[0].missing, true);
  const entries = [
    { id: 'ta:test', kind: 'taxanswer', title: '別の制度', text: '関係のない本文。関連リンク\n宇宙猫制度の案内。' },
    { id: 'law:test:1', kind: 'law', title: '別の法令', text: '宇宙猫制度を定めます。' },
  ];
  assert.equal(P.findSystemMaterials([{ name: '宇宙猫制度' }], {}, { entries })[0].missing, true);
  assert.equal(P.relevantMaterial('贈与税の配偶者控除', { title: '夫婦の間の配偶者控除' }, '').condition, 3);
});
test('P2', '全体の字数とページ上限・既存資料の除外・上限はmissingにしない', () => {
  const names = ['宇宙猫税制', '深海犬税制', '天空鳥税制'];
  const entries = names.map((name, i) => ({ id: `ta:${i}`, kind: 'taxanswer', title: name, text: `${name}の本文です。` + '本文。'.repeat(3000) }));
  const result = P.findSystemMaterials(names.map(name => ({ name })), {}, { entries, maxChars: 6000, maxPages: 1 });
  assert.equal(result[0].materials[0].text.length, 6000);
  assert.equal(result[1].missing, false); assert.equal(result[1].note, '上限で添付せず'); assert.equal(result[1].materials.length, 0);
  const existing = P.findSystemMaterials(names.map(name => ({ name })), {}, { entries, existing: ['ta:0'], maxPages: 1, maxChars: 6000 });
  assert.equal(existing[1].materials.length, 1); assert.equal(existing[2].note, '上限で添付せず');
});

test('P3/P4', '計画・資料なしの指示・主出典の重複防止・前付け・注意書き', () => generating(topic(),
  '[{"name":"贈与税の配偶者控除"},{"name":"宇宙猫事業者免税還付制"}]', ({ prompts, simple, t }) => {
    const prompt = textPrompt(prompts[0]); assert.equal(simple.length, 1);
    assert(prompt.includes('═══ この記事で扱う制度と資料 ═══'));
    assert(prompt.includes('資料が見つからなかった制度: 宇宙猫事業者免税還付制（'));
    assert(prompt.includes('「扱う制度」に無い制度について'));
    const unique = W.resolveMaterial('ta:4452').text.slice(100, 200); assert.equal(prompt.split(unique).length - 1, 1);
    const meta = matter(N.buildCanonicalFrontmatter(t, { now: now.toISOString() }) + '\n' + fakeBody).data;
    assert.equal(meta.fact_plan_status, 'ok'); assert.equal(meta.fact_plan, '贈与税の配偶者控除 ／ 宇宙猫事業者免税還付制');
    assert(meta.fact_materials.includes('ta:4452')); assert(meta.review_warning.includes('計画: 資料が見つからない制度 宇宙猫事業者免税還付制'));
  }));
test('P3/P4', '計画の失敗は従来の生成に戻り、秘密なしの注意書きを記録', () => generating(topic(), new Error('sk-secret'), ({ prompts, t }) => {
  assert(!textPrompt(prompts[0]).includes('この記事で扱う制度と資料'));
  const fm = N.buildCanonicalFrontmatter(t, { now: now.toISOString() });
  assert.equal(matter(fm).data.fact_plan_status, 'failed'); assert(fm.includes('従来の資料だけで生成')); assert(!fm.includes('sk-secret'));
}));
test('P3/P4', '資料探しが失敗してもブロックなしで続行する', async () => {
  const t = topic(); const block = await P.prepareArticlePlan(t, { generate: async () => '[{"name":"配偶者控除"}]',
    entries: [{ id: 'broken', kind: 'qa', title: '配偶者控除' }], loadEvidenceText: () => { throw new Error('secret'); } });
  assert.equal(block, ''); assert.equal(t.fact_plan_status, 'failed'); assert(!JSON.stringify(t).includes('secret'));
});
test('P3', '出典未確定の題材でも計画し、既存の断定禁止を保つ', () => generating({ ...topic(), source_provenance: 'ultimate', source_confidence: 0.1, tax_domain: 'unknown' },
  '[{"name":"相続時精算課税制度"}]', ({ t, prompts }) => {
    assert.equal(t.fact_plan_status, 'ok'); assert(textPrompt(prompts[0]).includes('この記事で扱う制度と資料'));
    assert(textPrompt(prompts[0]).includes(SOURCE_UNCONFIRMED_RULE));
  }));
test('P3/P4', '切替falseでもW規則を含むpromptIRと従来の前付けにバイト単位で一致', () => env({ FACT_PLAN_ENABLED: 'false' }, () => generating(topic(), '[]', ({ prompts, simple, t }) => {
  assert.equal(simple.length, 0); assert.equal(hash(JSON.stringify(prompts[0])), 'f011154dac683ddab95be613331555b19b902ba34891763c706a326e868d5880');
  assert.equal(hash(N.buildCanonicalFrontmatter(t, { now: now.toISOString() })), '97303caf7d917e593c1117b473153a1c0b12b1cdd9f75f97e39fc716f246b29a');
  assert(!Object.keys(t).some(k => k.startsWith('fact_')));
})));

test('P4', '6種類の短いIDを往復する', () => {
  const catalog = E.evidenceCatalog().entries;
  const ids = ['ta:4452', catalog.find(e => e.kind === 'shitsugi').id, catalog.find(e => e.kind === 'law').id,
    catalog.find(e => e.kind === 'tsutatsu').id, 'qa:invoice/114', `change:${CHANGES[0].key}`];
  for (const id of ids) { const ref = W.resolveMaterial(id); assert(ref && typeof ref.text === 'string' && ref.text.length, id); assert.equal(W.materialId(ref), id); }
  const law = W.resolveMaterial(ids[2]); assert.equal(W.materialId({ url: law.url }), ids[2]);
  const change = W.resolveMaterial(ids[5]); assert(change.text.includes(CHANGES[0].reference));
  assert.equal(W.resolveMaterial('ta:0000'), null); assert.equal(W.resolveMaterial('qa:unknown/xxx'), null);
});
test('P4', '同じPDFにある別の問を混ぜずに往復・検索・資料表へ渡す', () => {
  const ids = ['qa:kasou/faq-1-1', 'qa:kasou/faq-1-2'];
  const refs = ids.map(W.resolveMaterial); assert(refs.every(Boolean));
  assert.equal(refs[0].url, refs[1].url); assert.notEqual(refs[0].id, refs[1].id); assert.notEqual(refs[0].text, refs[1].text);
  assert.deepEqual(refs.map(W.materialId), ids);
  const found = W.searchWriterEvidence({ subject: '暗号資産', claim: '暗号資産を確認します。' }, { writer_materials: ids });
  assert.equal(found.length, 2);
  const pack = require('../fact-pages').buildPages([{ id: 'c1' }], { c1: found }, { loadEvidenceText: ref => W.resolveMaterial(W.materialId(ref)).text });
  assert.equal(pack.pages.length, 2);
});
test('P4', '復元できないIDは固定の注意書きで従来生成へ戻る', () => {
  const meta = { fact_plan_status: 'ok', fact_plan: '配偶者控除', fact_materials: 'qa:missing/secret' };
  assert.equal(P.restoreArticlePlan(meta), ''); assert(meta.materials_warning.includes('従来の資料だけで生成')); assert(!meta.materials_warning.includes('secret'));
});
test('P4', '主・補助・Q&Aの問・法令・通達・改正情報を記録する', async () => {
  const refs = ['ta:4452', 'ta:4103', 'qa:invoice/114', 'law:minpo:915', 'tsutatsu:shotoku:47-11'].map(W.resolveMaterial);
  assert(refs.every(Boolean)); const t = topic();
  await P.prepareArticlePlan(t, { generate: async () => '[{"name":"配偶者控除"}]', existing: refs, changes: [CHANGES[0]] });
  const ids = t.fact_materials.split(';');
  for (const id of [...refs.map(W.materialId), `change:${CHANGES[0].key}`]) assert(ids.includes(id), id);
});
test('P4', '実際の生成経路で主・補助・Q&A・改正情報のIDを収集する', () => generating({ ...topic(), tax_domain: 'invoice_system',
  tax_terms: 'インボイス 2割特例 3割特例 簡易課税', primary_question: 'インボイスの2割特例と3割特例', persona: 'domestic_ec_seller',
  source_supplements: [{ url: W.resolveMaterial('ta:6505').url, title: W.resolveMaterial('ta:6505').title }] },
  '[{"name":"２割特例"}]', ({ t, prompts }) => {
    assert(t.fact_materials.includes('ta:4452')); assert(t.fact_materials.includes('ta:6505'));
    const ids = t.fact_materials.split(';'); assert(ids.some(id => id.startsWith('qa:invoice/'))); assert(ids.some(id => id.startsWith('change:')));
    for (const id of ids.filter(id => id.startsWith('qa:'))) assert(textPrompt(prompts[0]).includes(W.resolveMaterial(id).url));
  }));
test('P4', '差し戻しは計画を呼ばず復元・新しい通達を追加・管理項目を保全', async () => {
  const meta = { ...topic(), fact_plan_status: 'ok', fact_plan: '贈与税の配偶者控除', fact_plan_missing: '', fact_materials: 'ta:4452;qa:invoice/114' };
  const original = CM.generateSimple; CM.generateSimple = async () => { throw new Error('計画を呼んではいけない'); };
  try {
    const blocks = await G.buildRegenSourceBlocks(meta, '所得税基本通達47-11を確認します。', { enrichTaxTerms: async () => {}, resolveSupplement: async () => null });
    assert(blocks.combined.includes('この記事で扱う制度と資料')); assert(meta.fact_materials.includes('tsutatsu:shotoku:47-11'));
    const raw = '---\nslug: plan-regen\nrecommendation: publish\n---\n本文です。';
    const recorded = G.recordMaterialMetadata(raw, meta); assert.equal(matter(recorded).data.fact_plan_status, 'ok');
    const changed = F.updateMeta(raw, { fact_materials: 'ta:4103' });
    const kept = F.inheritFactMetadata(recorded, changed); assert.equal(matter(kept).data.fact_plan, meta.fact_plan);
    assert(matter(kept).data.fact_materials.includes('ta:4103'));
    const result = await G.finalizeRegeneration(recorded, changed, { scope: 'body' }, { persist: false });
    assert.equal(matter(result).data.fact_plan_status, 'ok');
    const legacy = await G.buildRegenSourceBlocks(topic(), '', { enrichTaxTerms: async () => {}, resolveSupplement: async () => null });
    assert(!legacy.combined.includes('この記事で扱う制度と資料'));
  } finally { CM.generateSimple = original; }
});
test('P4', '全文差し戻しでも実際に添付した資料の本文と管理項目が残る', async () => {
  const source = `---\nslug: plan-full\ntitle: "確認する項目"\nsource_url: "${topic().source_url}"\nfact_plan_status: "ok"\nfact_plan: "贈与税の配偶者控除"\nfact_plan_missing: ""\nfact_materials: "ta:4452;qa:invoice/114"\n---\n${fakeBody}`;
  const original = CM.generateSimple; let calls = 0;
  CM.generateSimple = async req => {
    calls++; assert.notEqual(req.system, P.PLAN_SYSTEM); assert(req.system.includes('この記事で扱う制度と資料'));
    assert(req.system.includes(W.resolveMaterial('qa:invoice/114').text));
    return { text: source, provider: 'anthropic', model: 'fake', stopReason: 'end_turn' };
  };
  try { const result = await G.regenerateWithContentModel(source, '説明を確認'); assert.equal(calls, 1); assert.equal(matter(result).data.fact_plan_status, 'ok'); }
  finally { CM.generateSimple = original; }
});
test('P4', '更新案で計画のAIを呼ばず復元し、最終前付けにも記録を残す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-plan-refresh-'));
  const original = CM.generateSimple;
  CM.generateSimple = async () => { throw new Error('更新で計画を呼んではいけない'); };
  try {
    const filename = '2026-10-01-plan-refresh.md', reasonsFile = path.join(dir, 'reasons.json');
    const source = `---\nslug: plan-refresh\ntitle: "確認する項目"\nreview_status: published\nfact_plan_status: ok\nfact_plan: "配偶者控除"\nfact_plan_missing: ""\nfact_materials: "ta:4452"\n---\n## 年分\n令和7年分の申告について要件と必要な書類を確認します。`;
    fs.writeFileSync(path.join(dir, filename), source); fs.writeFileSync(reasonsFile, JSON.stringify([{ kind: 'fiscal_year', detail: '年分', where: '## 年分' }]));
    const revise = async raw => {
      const { data: meta, content: body } = matter(raw);
      const blocks = await G.buildRegenSourceBlocks(meta, body, { enrichTaxTerms: async () => {}, resolveSupplement: async () => null });
      assert(blocks.combined.includes('この記事で扱う制度と資料'));
      return G.recordMaterialMetadata(raw.replace('令和7年分', '令和8年分'), meta);
    };
    const result = await G.runRefreshMode([], { postsDir: dir, filename, reasonsFile, now, factAudit: null,
      regenerateSection: revise, regenerateTargeted: revise,
      factCheck: async content => { assert.equal(matter(content).data.fact_plan_status, 'ok'); return { content, record: { status: 'ok', summary: '確認済み' } }; } });
    assert.equal(result.status, 'changed'); assert.equal(matter(result.content).data.fact_plan_status, 'ok');
  } finally { CM.generateSimple = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

const ref = (id, text) => ({ id, kind: 'taxanswer', title: `試験資料${id}`, url: `https://example.jp/${id}`, text });
function extracted(request, type = '金額') {
  return [...request.user.matchAll(/^\[(\d+)\] (.*)$/gm)].filter(m => !m[2].startsWith('#')).map(m => ({ s: +m[1], type, subject: m[2].split('は')[0], claim: m[2] }));
}
function supported(request, choose = () => '裏付けあり') {
  const payload = H.readPayload(request); const pages = H.materials(request);
  return payload.claims.map(c => ({ id: c.id, status: choose(c), evidence_id: c.evidence_ids[0],
    basis: H.basisFor(pages.find(p => p.number === c.evidence_ids[0]), c.sentence), correct: c.sentence }));
}
test('P5', '段Aは書き手の4件だけを同じ検索点順に選ぶ', async () => {
  const ids = ['ta:4452', 'ta:4103', 'qa:invoice/114', 'qa:invoice/115', `change:${CHANGES[0].key}`];
  const ranked = W.searchWriterEvidence({ subject: '配偶者控除', claim: '控除の要件を確認します。' }, { writer_materials: ids });
  assert.equal(ranked.length, 4); assert(ranked.every(e => ids.includes(W.materialId(e))));
  const body = '配偶者控除の要件を確認します。';
  const r = await F.checkFacts(body, { ...opts, writer_materials: ids, searchEvidence: () => { throw new Error('段Bに回してはいけない'); }, callLLM: async req => {
    if (req.task === 'extract') return [{ s: 1, type: '要件', subject: '配偶者控除', claim: body }];
    assert(H.materials(req).every(p => ids.map(W.resolveMaterial).some(e => e.url === p.url)));
    return [{ id: 'c1', status: '裏付けあり', evidence_id: 1, basis: '1' }];
  } });
  assert.equal(r.record.claims[0].stage, 'A');
});
test('P5', '段Aの資料なしだけ段Bへ・食い違い/期限は維持・Batchでも段Bは即時', async () => {
  const lines = ['制度甲は100万円です。', '制度乙は200万円です。', '制度丙は300万円です。', '制度丁は400万円です。'];
  const a = ref('a', lines.join('\n')), b = ref('b', lines.join('\n')); let aJudges = 0, bJudges = 0;
  const r = await F.checkFacts(lines.join('\n'), { ...opts, batch: true, writer_materials: ['ta:4452'],
    searchWriterEvidence: () => [a], searchEvidence: c => {
      if (['c3', 'c4'].includes(c.id)) return [a]; // 段Aで確定する食い違い・期限は全体検索にも同じ根拠を置く。
      assert.equal(c.id, 'c2'); return [b];
    }, loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extracted(req);
      if (req.stageB) { bJudges++; assert.deepEqual(H.readPayload(req).claims.map(c => c.id), ['c2']); assert.deepEqual(H.materials(req).map(p => p.url), [b.url]); return supported(req); }
      aJudges++; assert.deepEqual(H.materials(req).map(p => p.url), [a.url]);
      return supported(req, c => ({ c1: '裏付けあり', c2: '資料なし', c3: '食い違い', c4: '期限の書き漏れ' })[c.id]);
    } });
  assert.equal(r.record.status, 'revise'); assert.equal(aJudges, 1); assert.equal(bJudges, 1);
  assert.deepEqual(r.record.claims.map(c => c.stage), ['A', 'B', 'A', 'A']);
  assert.deepEqual(r.record.claims.map(c => c.status), ['裏付けあり', '裏付けあり', '食い違い', '期限の書き漏れ']);
  assert.equal(r.record.calls.find(c => c.task === 'stage_b_judge').mode, 'sync');
  assert.equal(r.record.calls.find(c => c.task === 'judge').mode, 'batch');
  assert.deepEqual(r.record.writer_materials, W.materialFingerprint(['ta:4452']));
  assert.equal(r.record.stages.A.claims, 4); assert.equal(r.record.stages.B.claims, 1);
  assert.equal(r.record.stages.A.pages, 1); assert.equal(r.record.stages.B.pages, 1);
  assert.equal(r.record.stages.A.input_chars, r.record.calls.filter(c => c.task === 'judge').reduce((n, c) => n + c.input_chars, 0));
  assert.equal(r.record.stages.B.input_chars, r.record.calls.filter(c => c.task === 'stage_b_judge').reduce((n, c) => n + c.input_chars, 0));
  assert(r.record.stages.A.input_chars > 0 && r.record.stages.B.input_chars > 0);
  assert(r.record.summary.includes('書き手の資料で判定 3 件・全体を探した 1 件')); assert.equal(r.record.logic_version, 'plan2');
});
test('P5', '既定の呼び出し部でも段BだけBatchを渡さず即時で呼ぶ', async () => {
  const a = ref('default-a', '試験制度は100万円です。'), b = ref('default-b', a.text), original = CM.generateContent, calls = [];
  CM.generateContent = async (ir, config) => {
    calls.push(config);
    if (ir.dynamicSystem) return extracted({ user: ir.user });
    const request = { task: 'judge', system: ir.staticSystem, user: ir.user };
    return config.batch ? [{ id: 'c1', status: '資料なし' }] : supported(request);
  };
  try {
    const result = await F.checkFacts(a.text, { ...opts, batch: true, writer_materials: ['ta:4452'], searchWriterEvidence: () => [a], searchEvidence: () => [b], loadEvidenceText: ref => ref.text });
    assert.equal(result.record.status, 'ok'); assert.deepEqual(calls.map(c => c.batch !== null), [true, true, false]);
    assert.deepEqual(calls.map(c => c.maxTokens), [8000, 16000, 16000]);
  } finally { CM.generateContent = original; }
});
for (const allRejected of [false, true]) test('P5', allRejected ? '全体の確認落ちが多い場合はfail-closed' : '段Bの3件だけが確認落ちでも全体で歯止めを判定', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `試験制度${i}は${100 + i}万円です。`), source = ref('all', lines.join('\n'));
  const r = await F.checkFacts(lines.join('\n'), { ...opts, writer_materials: ['ta:4452'], searchWriterEvidence: () => [source], searchEvidence: () => [source],
    loadEvidenceText: e => e.text, callLLM: async req => {
      if (req.task === 'extract') return extracted(req);
      return supported(req).map((row, i) => req.stageB ? { ...row, evidence_id: 999 } : (allRejected || i < 3) ? { id: row.id, status: '資料なし' } : row);
    } });
  assert.equal(r.record.status, allRejected ? 'not_run' : 'revise');
  if (!allRejected) assert.equal(r.record.claims.filter(c => c.stage === 'A').length, 7);
});
test('P5', '候補なし・答えなし・引用/数字の確認落ちを段Bへ回す', async () => {
  for (const variant of ['候補なし', '答えなし', '確認落ち']) {
    const source = ref('b', '試験制度は100万円です。'); let bCalls = 0;
    const r = await F.checkFacts(source.text, { ...opts, writer_materials: ['ta:4452'],
      searchWriterEvidence: () => variant === '候補なし' ? [] : [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
      callLLM: async req => {
        if (req.task === 'extract') return extracted(req);
        if (req.stageB) { bCalls++; return supported(req); }
        return variant === '答えなし' ? [] : [{ id: 'c1', status: '裏付けあり', evidence_id: 999, basis: '1' }];
      } });
    assert.equal(bCalls, 1); assert.equal(r.record.status, 'ok'); assert.equal(r.record.claims[0].stage, 'B');
  }
});
test('P5', '段Aで3件の確認が落ちても段Bの採用した答えで数え直す', async () => {
  const source = ref('retry-all', ['制度甲は100万円です。', '制度乙は200万円です。', '制度丙は300万円です。'].join('\n'));
  const result = await F.checkFacts(source.text, { ...opts, writer_materials: ['ta:4452'], searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: ref => ref.text,
    callLLM: async req => req.task === 'extract' ? extracted(req) : supported(req).map(row => req.stageB ? row : { ...row, evidence_id: 999 }) });
  assert.equal(result.record.status, 'ok'); assert(result.record.claims.every(c => c.stage === 'B' && c.status === '裏付けあり'));
});
test('P5', '従来経路から歯止めを延期する指定を渡してもfail-closed', async () => {
  const source = ref('legacy-guard', ['制度甲は100万円です。', '制度乙は200万円です。', '制度丙は300万円です。'].join('\n'));
  const result = await F.checkFacts(source.text, { ...opts, deferTally: true, searchEvidence: () => [source], loadEvidenceText: ref => ref.text,
    callLLM: async req => req.task === 'extract' ? extracted(req) : supported(req).map(row => ({ ...row, evidence_id: 999 })) });
  assert.equal(result.record.status, 'not_run');
});
test('P5', '資料なしと切替falseの呼び出し・記録は同じ（版はplan2）', async () => {
  const source = ref('old', '試験制度は100万円です。'); const requests = [];
  const callLLM = async req => { requests.push(JSON.stringify({ task: req.task, system: req.system, user: req.user, maxTokens: req.maxTokens, model: req.model })); return req.task === 'extract' ? extracted(req) : supported(req); };
  const options = { ...opts, callLLM, searchEvidence: () => [source], loadEvidenceText: e => e.text };
  const old = await F.checkFacts(source.text, options); const originalCalls = requests.splice(0);
  const off = await env({ FACT_CHECK_WRITER_MATERIALS: 'false' }, () => F.checkFacts(source.text, { ...options, writer_materials: ['ta:4452'] }));
  assert.deepEqual(requests, originalCalls); assert.deepEqual(off.record, old.record);
  assert(!old.record.writer_materials); assert(!old.record.stages); assert(!('stage' in old.record.claims[0]));
});
test('P5', '80/40/明示上限・数字120件を維持', async () => {
  const body = Array.from({ length: 85 }, (_, i) => `制度の要件${i}を確認します。`).join('\n');
  for (const [writer, limit, expected] of [[true, undefined, 80], [false, undefined, 40], [true, '53', 53]]) {
    await env({ FACT_CHECK_MAX_CLAIMS: limit }, async () => {
      const options = { ...opts, ...(writer ? { writer_materials: ['ta:4452'] } : {}), searchWriterEvidence: () => [], searchEvidence: () => [],
        callLLM: async req => extracted(req, '要件') };
      assert.equal(F.config(options).maxNumericClaims, 120); const r = await F.checkFacts(body, options); assert.equal(r.record.claims.length, expected);
    });
  }
  const numbers = Array.from({ length: 125 }, (_, i) => `制度の限度額は${100 + i}万円です。`).join('\n');
  const numeric = await F.checkFacts(numbers, { ...opts, writer_materials: ['ta:4452'], searchWriterEvidence: () => [], searchEvidence: () => [], callLLM: async req => extracted(req) });
  assert.equal(numeric.record.claims.length, 120); assert.equal(numeric.record.dropped, 5); assert.equal(numeric.record.status, 'revise');
});
for (const retry of [false, true]) test('P5', `再照合の必須根拠を段Aの先頭に置く${retry ? '、資料なしは段Bへ' : ''}`, async () => {
  const before = '試験制度は100万円です。', after = '試験制度は200万円です。';
  const original = ref('required', after), decoy = ref('decoy', '別の制度の資料です。'); let extracts = 0;
  const r = await F.checkFacts(before, { ...opts, repair: true, writer_materials: ['ta:4452'],
    searchWriterEvidence: () => [extracts > 1 ? decoy : original], searchEvidence: () => [original, decoy], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') { extracts++; return extracted(req); }
      if (req.task === 'repair') return [{ id: 'c1', replacement: after }];
      const input = H.readPayload(req), pages = H.materials(req);
      if (extracts > 1) assert.equal(pages.find(p => p.number === input.claims[0].evidence_ids[0]).url, original.url);
      const page = pages.find(p => p.url === original.url); assert(page);
      return [{ id: 'c1', status: extracts === 1 ? '食い違い' : retry && !req.stageB ? '資料なし' : '裏付けあり',
        evidence_id: page.number, basis: '1', correct: after }];
    } });
  assert.equal(r.body, after); assert.equal(r.record.status, 'ok'); assert(r.record.corrections[0].resolved);
  assert.equal(r.record.rechecked[0].stage, retry ? 'B' : 'A');
  assert.equal(r.record.calls.filter(c => c.task === 'recheck_stage_b_judge').length, retry ? 1 : 0);
});
test('P5', '書き手の資料の指紋が違う前回記録を使い回さない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-plan-reuse-')), source = ref('a', '試験制度は100万円です。');
  const raw = ids => `---\nslug: plan-reuse\nfact_materials: "${ids}"\n---\n${source.text}`;
  const options = { ...opts, recordDir: dir, searchWriterEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => req.task === 'extract' ? extracted(req) : supported(req) };
  try {
    await F.checkArticle(raw('ta:4452'), options);
    const same = await F.checkArticle(raw('ta:4452'), { ...options, persist: false, previousRaw: raw('ta:4452') }); assert(same.record.incremental);
    const changed = await F.checkArticle(raw('ta:4103'), { ...options, persist: false, previousRaw: raw('ta:4452') }); assert.equal(changed.record.incremental, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('P6', '生成3本・照合5本の切替とQ&A取り出し', () => {
  const root = path.resolve(__dirname, '../../..');
  for (const name of ['daily-draft', 'regenerate-draft', 'refresh-article', 'fact-check', 'audit-published-facts']) {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows', name + '.yml'), 'utf8');
    assert(workflow.includes('FACT_CHECK_WRITER_MATERIALS: ${{ vars.FACT_CHECK_WRITER_MATERIALS }}'));
    if (['daily-draft', 'regenerate-draft', 'refresh-article'].includes(name)) assert(workflow.includes('FACT_PLAN_ENABLED: ${{ vars.FACT_PLAN_ENABLED }}'));
    if (name === 'fact-check') assert(workflow.split('\n').some(line => line.includes('git checkout FETCH_HEAD --') && line.includes('data/nta-qa/')));
  }
});

for (const status of ['ok', 'failed']) test('01b-F1', `${status}の計画の注意は部分差し戻し2回でも1件、照合okでpublishに戻る`, async () => {
  const wrong = '試験制度は100万円です。', correct = '試験制度は600万円です。';
  const source = ref('warning-guard', correct), original = CM.generateSimple;
  const t = { ...topic(), slug: `01b-warning-${status}`, fact_plan_status: status, fact_plan: status === 'ok' ? '贈与税の配偶者控除' : '',
    fact_plan_missing: status === 'ok' ? '資料のない制度' : '', fact_materials: status === 'ok' ? 'ta:4452' : '' };
  const warning = P.planWarning(t);
  let raw = F.updateMeta(N.buildCanonicalFrontmatter(t, { now: now.toISOString() }) + '\n## 制度\n' + wrong, { recommendation: 'publish' });
  const check = content => F.checkArticle(content, { ...opts, persist: false, writer_materials: [], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extracted(req).filter(c => c.claim.includes('試験制度は'));
      return H.readPayload(req).claims.map(c => ({ id: c.id, status: c.sentence.includes('600万円') ? '裏付けあり' : '食い違い', evidence_id: 1, basis: '1', correct }));
    } });
  await env({ CONTENT_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '01b-fake-content-key' }, async () => {
    try {
      raw = (await check(raw)).content;
      assert.equal(matter(raw).data.fact_check_prev_recommendation, 'publish');
      for (const suffix of ['説明を確認します。', '申告の書類を確認します。']) {
        CM.generateSimple = async () => ({ text: `## 制度\n${wrong}\n\n${suffix}`, provider: 'anthropic', model: 'fake', stopReason: 'end_turn' });
        const regenerated = await G.regenerateSection(raw, '制度の補足を確認', { type: 'content', sectionHint: '制度' }, { preserveTitle: true });
        raw = await G.finalizeRegeneration(raw, regenerated, { scope: 'section' }, { factCheck: check, persist: false });
        const meta = matter(raw).data;
        assert.equal(String(meta.review_warning).split(warning).length - 1, 1);
        assert.equal(meta.fact_check_prev_recommendation, 'publish'); assert.equal(meta.recommendation, 'revise');
      }
      raw = (await check(F.updateMeta(raw, {}, matter(raw).content.replace(wrong, correct)))).content;
      assert.equal(matter(raw).data.fact_check_status, 'ok'); assert.equal(matter(raw).data.recommendation, 'publish');
      assert.equal(String(matter(raw).data.review_warning).split(warning).length - 1, 1);
    } finally { CM.generateSimple = original; }
  });
});
test('01b-F1', '復元の解決は1回、2種類のブロックを作っても引けない資料の注意を重ねない', async () => {
  const meta = { ...topic(), fact_plan_status: 'ok', fact_plan: '贈与税の配偶者控除', fact_materials: 'ta:4452;ta:0000' };
  const originalResolve = P.resolveArticlePlan, originalRestore = P.restoreArticlePlan;
  let resolutions = 0, blocks = 0, resolved;
  P.resolveArticlePlan = (...args) => { resolutions++; resolved = originalResolve(...args); return resolved; };
  P.restoreArticlePlan = (m, existing, plan) => { blocks++; assert.equal(plan, resolved); return originalRestore(m, existing, plan); };
  try {
    await G.buildRegenSourceBlocks(meta, '', { enrichTaxTerms: async () => {}, resolveSupplement: async () => null });
    assert.equal(resolutions, 1); assert.equal(blocks, 2);
    assert.equal(meta.materials_warning.split('記録した資料のうち引けない 1 件').length - 1, 1);
    const raw = G.recordMaterialMetadata('---\nslug: warning-restore\n---\n確認します。', meta);
    assert.equal(G.recordMaterialMetadata(raw, meta), raw);
  } finally { P.resolveArticlePlan = originalResolve; P.restoreArticlePlan = originalRestore; }
});

for (const status of ['食い違い', '期限の書き漏れ']) for (const inGlobal of [false, true]) test('01b-F2', `${status}の根拠が全体候補に${inGlobal ? 'あると段Aのまま' : '無いと段Bへ'}`, async () => {
  const body = '試験制度は100万円です。';
  const correction = status === '食い違い' ? '試験制度は200万円です。' : '試験制度の適用期限は令和9年3月31日です。';
  const a = ref('other-system', correction), b = ref('right-system', body); let bCalls = 0, searches = 0;
  const result = await F.checkFacts(body, { ...opts, writer_materials: ['ta:4452'], searchWriterEvidence: () => [a],
    searchEvidence: () => { searches++; return inGlobal ? [a, b] : [b]; }, loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extracted(req);
      if (req.stageB) { bCalls++; assert.deepEqual(H.materials(req).map(p => p.url), [b.url]); return supported(req); }
      return [{ id: 'c1', status, evidence_id: 1, basis: '1', correct: correction }];
    } });
  assert.equal(searches, 1); assert.equal(bCalls, inGlobal ? 0 : 1);
  assert.equal(result.record.claims[0].stage, inGlobal ? 'A' : 'B');
  assert.equal(result.record.claims[0].status, inGlobal ? status : '裏付けあり');
  const unrelatedDeadline = inGlobal && status === '期限の書き漏れ';
  assert.equal(result.record.status, inGlobal && !unrelatedDeadline ? 'revise' : 'ok');
  if (unrelatedDeadline) {
    assert.equal(result.record.claims[0].correct_requires_review, true);
    assert(result.record.review_items.some(c => c.status === status));
    assert.equal(result.record.remaining.length, 0);
  }
});
test('01b-F3', '改正情報は記録と復元に残し、段Aの候補・資料表から外す', async () => {
  const change = `change:${CHANGES[0].key}`, ids = ['ta:4452', change];
  assert.equal(W.resolveMaterial(change).url, CHANGES[0].reference.match(/https?:\/\/[^\s<>「」）)]+/)[0]);
  assert(W.searchWriterEvidence({ subject: '基礎控除', claim: '基礎控除を確認します。' }, { writer_materials: ids }).every(e => e.kind !== 'change'));
  const result = await F.checkFacts('控除の要件を確認します。', { ...opts, writer_materials: ids, searchEvidence: () => [], callLLM: async req => {
    if (req.task === 'extract') return extracted(req, '要件');
    assert(!req.system.includes(CHANGES[0].summary)); return H.readPayload(req).claims.map(c => ({ id: c.id, status: '資料なし' }));
  } });
  assert.equal(result.record.writer_materials.count, 2); assert.equal(result.record.writer_materials.resolved, 2);
  const meta = { fact_plan_status: 'ok', fact_plan: '贈与税の配偶者控除', fact_materials: ids.join(';') };
  assert(P.restoreArticlePlan(meta).includes(CHANGES[0].summary)); assert(meta.fact_materials.includes(change));
});

test('01b-F4', '8制度を記録資料だけで振り分け、無関係の資料はその他、欠落1件でも復元する', () => {
  const names = ['贈与税の配偶者控除', '相続時精算課税制度', '小規模宅地等の特例', W.resolveMaterial('ta:4508').title,
    W.resolveMaterial('ta:4510').title, W.resolveMaterial('ta:4511').title, '贈与税の基礎控除', W.resolveMaterial('ta:4161').title];
  const ids = ['ta:4452', 'ta:4103', 'ta:4124', 'ta:4508', 'ta:4510', 'ta:4511', 'law:sozokuzei:21_5', 'ta:4161'];
  const meta = { fact_plan_status: 'ok', fact_plan: names.join(' ／ '), tax_domain: 'inheritance_tax', fact_materials: [...ids, 'ta:1110', 'ta:0000'].join(';') };
  const plan = P.resolveArticlePlan(meta);
  assert.equal(plan.systems.length, 8);
  for (let i = 0; i < names.length; i++) {
    const system = plan.systems[i]; assert(system.materials.some(e => W.materialId(e) === ids[i]), names[i]);
    assert(system.materials.every(e => P.relevantMaterial(system.name, e, e.text).condition));
  }
  assert(plan.otherMaterials.some(e => W.materialId(e) === 'ta:1110'));
  const block = P.restoreArticlePlan(meta, [], plan); assert(block.includes('その他の資料'));
  for (const name of names) assert(block.includes(`制度: ${name}\n`));
  assert.equal(meta.materials_warning, '計画: 記録した資料のうち引けない 1 件');
  assert(P.restoreArticlePlan(meta).includes('この記事で扱う制度と資料')); assert.equal(meta.materials_warning, '計画: 記録した資料のうち引けない 1 件');
});
test('01b-F4', '復元の長い資料は計画全体でなく各制度名の付近を抜粋する', () => {
  const id = 'qa:invoice/114', original = W.qaCatalog().find(e => e.material_id === id), saved = original.text;
  try {
    original.text = '無関係な説明。'.repeat(2000) + '\n2割特例の資料です。\n' + saved;
    const meta = { fact_plan_status: 'ok', fact_plan: '配偶者控除 ／ 2割特例', fact_materials: id };
    const plan = P.resolveArticlePlan(meta); const system = plan.systems[1];
    assert.equal(plan.systems[0].materials.length, 0); assert(system.materials[0].text.includes('2割特例の資料です。'));
    assert(system.materials[0].text.length <= 6000);
  } finally { original.text = saved; }
});

const f5Examples = [
  [exampleNames[0], 'invoice_system', ids => ids.includes('qa:invoice/114') && !ids.some(id => ['ta:6503', 'ta:6118', 'tsutatsu:shohi:21-1-2'].includes(id))],
  ['3割特例', 'invoice_system', ids => ids.includes('qa:invoice/114-2')],
  ['棚卸資産の評価方法', 'bookkeeping_expenses', ids => ids.every(id => /^(law:shotokuzei_|tsutatsu:shotoku:)/.test(id))],
  ['低価法', 'bookkeeping_expenses', ids => ids.some(id => ['tsutatsu:shotoku:47-9', 'tsutatsu:shotoku:47-11'].includes(id)) && ids.every(id => !id.startsWith('tsutatsu:hojin:'))],
  ['贈与税の配偶者控除', 'inheritance_tax', ids => ids.includes('ta:4452')],
  ['相続時精算課税制度', 'inheritance_tax', ids => ids.includes('ta:4103')],
  ['贈与税の基礎控除', 'inheritance_tax', ids => !ids.includes('ta:1199')],
  ['小規模宅地等の特例', 'inheritance_tax', ids => ids.includes('ta:4124')],
  ['簡易課税制度', 'invoice_system', ids => ids.includes('ta:6505')],
];
for (const [name, tax_domain, expected] of f5Examples) test('01b-F5', `${name}（${tax_domain}）の本物のカタログ`, () => {
  const system = P.findSystemMaterials([{ name }], { tax_domain, tax_terms: '所得税の基礎控除 法人の棚卸資産 雑損控除' })[0];
  const ids = system.materials.map(W.materialId); assert(ids.length > 0); assert(expected(ids), JSON.stringify(ids));
  assert(system.materials.every(e => P.relevantMaterial(name, e, e.text).condition));
  console.log(`01b-F5 選択 ${name}: ${system.materials.map(e => `${e.title} [${W.materialId(e)}]`).join(' ／ ')}`);
});
test('01b-F5', '制度名の明示税目は記事税目より優先し、tax_termsを採点に混ぜない', () => {
  const name = '贈与税の配偶者控除';
  const plain = P.findSystemMaterials([{ name }], { tax_domain: 'invoice_system' });
  const noisy = P.findSystemMaterials([{ name }], { tax_domain: 'invoice_system', tax_terms: 'No.1199 所得税 基礎控除 消費税' });
  assert.deepEqual(plain, noisy); assert(plain[0].materials.some(e => W.materialId(e) === 'ta:4452'));
});

for (const count of [5, 7]) test('01b-F6', `必須根拠${count}件は再照合の段Bへ直接回し、全体を止めない`, async () => {
  const before = Array.from({ length: count }, (_, i) => `試験制度は${100 + i}万円です。`).join('\n'), after = '試験制度は600万円です。';
  const refs = Array.from({ length: count }, (_, i) => ref(`required-${i}`, after)), extra = ref('extra', after); let extracts = 0;
  const result = await F.checkFacts(before, { ...opts, repair: true, writer_materials: ['ta:4452'], loadEvidenceText: e => e.text,
    searchWriterEvidence: c => [refs[Number(c.id.slice(1)) - 1] || extra], searchEvidence: () => extracts === 1 ? refs : [extra],
    callLLM: async req => {
      if (req.task === 'extract') { extracts++; const rows = extracted(req); return (extracts === 1 ? rows : rows.slice(0, 1)).map(c => ({ ...c, subject: '共通制度' })); }
      if (req.task === 'repair') return JSON.parse(req.user).corrections.map(c => ({ id: c.id, replacement: after }));
      const input = H.readPayload(req), pages = H.materials(req);
      if (extracts > 1) {
        assert(req.stageB); assert.equal(input.claims[0].evidence_ids.length, Math.min(7, count + 1));
        assert.deepEqual(input.claims[0].evidence_ids.slice(0, count).map(no => pages.find(p => p.number === no).url), refs.map(e => e.url));
      }
      return input.claims.map(c => {
        const page = pages.find(p => p.number === c.evidence_ids[0]);
        return { id: c.id, status: extracts === 1 ? '食い違い' : '裏付けあり', evidence_id: page.number, basis: '1', correct: after };
      });
    } });
  assert.equal(result.record.status, 'ok'); assert(result.record.corrections.every(c => c.resolved));
  assert.equal(result.record.rechecked[0].stage, 'B'); assert.equal(result.record.stages.A.claims, count);
});
test('01b-F7', '同じ制度の期限の2件目は段Bへ回さず、段Aの資料なしを保つ', async () => {
  const body = '制度甲は贈与の対象です。\n制度甲は申告の対象です。', source = ref('deadline', '制度甲の適用期限は令和9年3月31日です。');
  const result = await F.checkFacts(body, { ...opts, writer_materials: ['ta:4452'], searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => {
      if (req.task === 'extract') return extracted(req, '要件');
      assert(!req.stageB); return H.readPayload(req).claims.map(c => ({ id: c.id, status: '期限の書き漏れ', evidence_id: 1, basis: '1', correct: source.text }));
    } });
  assert.equal(result.record.claims[1].stage, 'A'); assert.equal(result.record.claims[1].status, '資料なし');
  assert.equal(result.record.claims[1].reject_reason, '同じ制度の期限の書き漏れは記録済み');
  assert(!result.record.calls.some(c => c.task === 'stage_b_judge'));
});
for (const status of ['食い違い', '期限の書き漏れ']) test('01b-F7', `確認で落ちた${status}を段Bが裏付けても、人の確認欄に根拠と種類を残す`, async () => {
  const source = ref('suspected-source', '試験制度は100万円です。'), body = source.text;
  const result = await F.checkFacts(body, { ...opts, writer_materials: ['ta:4452'], searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => req.task === 'extract' ? extracted(req) : req.stageB ? supported(req)
      : [{ id: 'c1', status, evidence_id: 1, basis: '1', correct: '適用する額は999万円です。' }] });
  assert.equal(result.record.status, 'ok'); assert.equal(result.record.claims[0].stage, 'B');
  const item = result.record.review_items[0]; assert(item); assert.equal(item.stage_a_answer.status, status);
  assert.equal(item.stage_a_answer.evidence, source.id); assert.equal(item.stage_a_answer.url, source.url);
  const approved = F.applyFactResult('---\nslug: advisory\nrecommendation: publish\n---\n'+body, result);
  assert.equal(matter(approved).data.recommendation, 'publish'); assert.equal(matter(approved).data.fact_check_blocking, false);
  const html = require('../../../netlify/functions/review-page').renderFactCheck(matter(approved).data, result.record, body);
  assert(html.includes(`段Aの${status}を要確認（段Bは裏付けあり）`));
  assert(html.includes(source.title)); assert(html.includes(source.url));
});
test('01b-F7', '差分照合で使い回した主張も段Aの疑いを確認欄に残す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '01b-review-reuse-')), source = ref('suspected', '試験制度は100万円です。');
  const raw = `---\nslug: 01b-review-reuse\nfact_materials: ta:4452\nrecommendation: publish\n---\n${source.text}`;
  const options = { ...opts, recordDir: dir, searchWriterEvidence: () => [source], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => req.task === 'extract' ? extracted(req) : req.stageB ? supported(req)
      : [{ id: 'c1', status: '食い違い', evidence_id: 1, basis: '1', correct: '限度額は999万円です。' }] };
  try {
    await F.checkArticle(raw, options);
    const next = await F.checkArticle(raw, { ...options, persist: false, previousRaw: raw });
    assert.equal(next.record.incremental.reused, 1); assert.equal(next.record.review_items[0].stage_a_answer.status, '食い違い');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('01b-F7', '別の主張に提示したページを引用した疑いも題名とリンクを残す', async () => {
  const source = ref('peer-source', '試験制度は100万円です。'), decoy = ref('own-source', '別の制度の資料です。');
  const body = source.text + '\n別制度は届出の要件を確認します。';
  const result = await F.checkFacts(body, { ...opts, writer_materials: ['ta:4452'], loadEvidenceText: e => e.text,
    searchWriterEvidence: c => [c.id === 'c1' ? decoy : source], searchEvidence: () => [source],
    callLLM: async req => {
      if (req.task === 'extract') return extracted(req).map((c, i) => ({ ...c, type: i ? '要件' : '金額' }));
      if (req.stageB) return supported(req, c => c.id === 'c1' ? '裏付けあり' : '資料なし');
      return H.readPayload(req).claims.map(c => c.id === 'c1'
        ? { id: c.id, status: '食い違い', evidence_id: H.materials(req).find(p => p.url === source.url).number, basis: '1', correct: source.text }
        : { id: c.id, status: '資料なし' });
    } });
  const item = result.record.review_items.find(c => c.stage_a_answer);
  assert(item); assert.equal(item.stage_a_answer.title, source.title); assert.equal(item.stage_a_answer.url, source.url);
  const html = require('../../../netlify/functions/review-page').renderFactCheck({ fact_check_status: 'ok' }, F.compactRecord(result.record), body);
  assert(html.includes(source.title)); assert(html.includes(source.url));
});

test('01b-F8', '引けた件数と欠落数を記録し、全欠落ならBatchの従来経路と同じ呼び出し', async () => {
  const source = ref('legacy-all-missing', '試験制度は100万円です。'), calls = [];
  const options = { ...opts, batch: true, batchRuntime: { now: () => 0 }, searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => { calls.push({ task: req.task, system: req.system, user: req.user, stageB: req.stageB }); return req.task === 'extract' ? extracted(req) : supported(req); } };
  const old = await F.checkFacts(source.text, options), oldCalls = calls.splice(0);
  const missing = await F.checkFacts(source.text, { ...options, writer_materials: ['ta:0000', 'qa:missing/0'] });
  assert.deepEqual(calls, oldCalls); assert.deepEqual(missing.record.calls, old.record.calls); assert.deepEqual(missing.record.claims, old.record.claims);
  assert(!missing.record.stages); assert.equal(missing.record.writer_materials.resolved, 0);
  assert(missing.record.calls.every(c => c.mode === 'batch')); assert(missing.record.summary.includes('書き手の資料のうち引けない 2 件'));
  const partial = await F.checkFacts('控除の要件を確認します。', { ...opts, writer_materials: ['ta:4452', 'ta:0000'], searchEvidence: () => [],
    callLLM: async req => req.task === 'extract' ? extracted(req, '要件') : H.readPayload(req).claims.map(c => ({ id: c.id, status: '資料なし' })) });
  assert.equal(partial.record.writer_materials.resolved, 1); assert(partial.record.summary.includes('書き手の資料のうち引けない 1 件'));
});
test('01b-F8', '壊れたQ&A1問を飛ばし、別の問で照合を続ける（dataは変更しない）', async () => {
  const originalRead = fs.readFileSync, entry = require('../nta-qa').loadIndex().find(e => e.source_key === 'invoice' && e.id === '114');
  const target = path.join(require('../nta-qa').QA_DIR, entry.file_path), before = W.qaCatalog().length;
  fs.readFileSync = (file, ...args) => { if (String(file) === target) throw new Error('秘密を含む破損エラー'); return originalRead(file, ...args); };
  W.resetQaCatalogForTest();
  try {
    assert.equal(W.qaCatalog().length, before - 1); assert.equal(W.resolveMaterial('qa:invoice/114'), null); assert(W.resolveMaterial('qa:invoice/115'));
    const result = await F.checkFacts('申告の要件を確認します。', { ...opts, writer_materials: ['qa:invoice/114', 'qa:invoice/115'], searchEvidence: () => [],
      callLLM: async req => req.task === 'extract' ? extracted(req, '要件') : H.readPayload(req).claims.map(c => ({ id: c.id, status: '資料なし' })) });
    assert.equal(result.record.status, 'ok'); assert.equal(result.record.writer_materials.resolved, 1);
    assert(!JSON.stringify(result.record).includes('秘密'));
  } finally { fs.readFileSync = originalRead; W.resetQaCatalogForTest(); }
});
test('01b-F8', 'PDFだけのURLは単独の問に決まる場合だけ記録する', () => {
  const unique = W.resolveMaterial('qa:invoice/114'), shared = W.resolveMaterial('qa:kasou/faq-1-1');
  assert.equal(W.materialId({ url: unique.url }), 'qa:invoice/114');
  assert.equal(W.materialId({ url: shared.url }), ''); assert.equal(W.materialId({ id: shared.url, url: shared.url, kind: 'qa' }), '');
  assert.equal(W.materialId({ id: 'faq-1-1', source_key: 'kasou', url: shared.url }), 'qa:kasou/faq-1-1');
});
test('01b-F9', 'whyを出さず、資料のない制度名の数字・期間も具体に書かせない', () => {
  const block = P.buildPlanBlock([{ name: '相続開始前3年以内の贈与加算', why: '控除額は12345万円で期間は99年です', materials: [], missing: true }]);
  assert(!block.includes('12345')); assert(!block.includes('99年')); assert(!block.includes('控除額は'));
  assert(block.includes('名前に含まれる数字・期間も書かない'));
});
test('01b-F10', '90秒のsignalを渡し、時間切れは固定ログ1行とfailedだけにする', async () => {
  const original = AbortSignal.timeout, originalSimple = CM.generateSimple, originalWarn = console.warn;
  const controller = new AbortController(), logs = []; let timeout;
  AbortSignal.timeout = ms => { timeout = ms; return controller.signal; };
  console.warn = (...args) => logs.push(args.join(' '));
  CM.generateSimple = async (_, options) => { assert.equal(options.signal, controller.signal); queueMicrotask(() => controller.abort(new Error('secret-timeout-key'))); return new Promise(() => {}); };
  try {
    const result = await P.planSystems(topic()); assert.equal(timeout, 90000); assert.equal(result.status, 'failed');
    assert.deepEqual(logs, ['[fact-plan] 計画を作れませんでした（従来の資料だけで生成）']); assert(!JSON.stringify(result).includes('secret'));
  } finally { AbortSignal.timeout = original; CM.generateSimple = originalSimple; console.warn = originalWarn; }
});
test('01b-F10', 'Anthropicの計画にもsignalが届き、例外を固定文で伏せる', async () => {
  const originalFetch = global.fetch, originalWarn = console.warn, logs = [];
  console.warn = (...args) => logs.push(args.join(' '));
  global.fetch = async (_, options) => { assert(options.signal instanceof AbortSignal); throw new Error('secret-api-key'); };
  try {
    await env({ CONTENT_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'secret-api-key' }, async () => {
      assert.equal((await P.planSystems(topic())).status, 'failed'); assert.equal(logs.length, 1); assert(!logs.join('\n').includes('secret'));
    });
  } finally { global.fetch = originalFetch; console.warn = originalWarn; }
});
test('01b-F11', '資料と後続の論点別ルールを規則1の範囲に含める', () => {
  assert(P.buildPlanBlock([{ name: '配偶者控除', materials: [], missing: true }]).includes('添付した資料（このブロックと上の資料）と、この後の論点別ルールに書いてあることだけを書く'));
});
for (const failPlan of [false, true]) test('01b-F12', `既定のGatewayで${failPlan ? '計画HTTP500でも本文を生成し注意書きを残す' : '計画・本文の2回の通信と同じモデルを確かめる'}`, async () => {
  const originalFetch = global.fetch, originalLog = console.log, originalWarn = console.warn, originalTimer = global.setTimeout;
  const requests = [], logs = [], secret = '01b-private-gateway-key';
  await env({ FACT_PLAN_ENABLED: undefined, CONTENT_MODEL_PROVIDER: 'gateway', CONTENT_MODEL: 'deepseek/deepseek-v4.1-flash-1017', AI_GATEWAY_API_KEY: secret }, async () => {
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://ai-gateway.vercel.sh/v1/chat/completions'); const request = JSON.parse(options.body); requests.push(request);
      const planning = request.messages[0].content === P.PLAN_SYSTEM;
      if (planning && failPlan) return { ok: false, status: 500, body: { cancel: async () => {} }, text: async () => secret };
      return { ok: true, json: async () => ({ choices: [{ message: { content: planning ? '[{"name":"贈与税の配偶者控除"}]' : fakeBody }, finish_reason: 'stop' }] }) };
    };
    console.log = console.warn = (...args) => logs.push(args.join(' '));
    global.setTimeout = (fn, ms, ...args) => originalTimer(fn, [15000, 30000].includes(ms) ? 0 : ms, ...args);
    try {
      const t = topic(), generated = await G.generateWithContentModel('2026-10-20', t);
      const fm = N.buildCanonicalFrontmatter(t, { now: now.toISOString() }); assert(generated.raw.includes('## 確認'));
      assert.equal(requests.length, failPlan ? 4 : 2); assert(requests.every(r => r.model === 'deepseek/deepseek-v4.1-flash-1017'));
      assert.equal(requests[0].max_tokens, 16000); assert.equal(requests.at(-1).max_tokens, 64000);
      assert.equal(t.fact_plan_status, failPlan ? 'failed' : 'ok');
      if (failPlan) { assert(fm.includes('計画を作れませんでした（従来の資料だけで生成）')); assert(!requests.at(-1).messages[0].content.includes('この記事で扱う制度と資料')); }
      else assert(requests.at(-1).messages[0].content.includes('この記事で扱う制度と資料'));
      assert(!logs.join('\n').includes(secret)); assert(!fm.includes(secret)); assert(!JSON.stringify(t).includes(secret));
    } finally { global.fetch = originalFetch; console.log = originalLog; console.warn = originalWarn; global.setTimeout = originalTimer; }
  });
});

test('01c-G1', '記録済みの欠落1件でも部分差し戻し2回後までpublishを保持し、照合okで戻す', async () => {
  const wrong = '試験制度は100万円です。', correct = '試験制度は600万円です。';
  const source = ref('01c-warning', correct), original = CM.generateSimple;
  const t = { ...topic(), slug: '01c-warning', fact_plan_status: 'ok', fact_plan: '贈与税の配偶者控除',
    fact_plan_missing: '資料のない制度', fact_materials: 'ta:4452;ta:0000' };
  let raw = F.updateMeta(N.buildCanonicalFrontmatter(t, { now: now.toISOString() }) + '\n## 制度\n' + wrong,
    { recommendation: 'publish', review_warning: '以前からの注意 / ' + P.planWarning(t) });
  const check = content => F.checkArticle(content, { ...opts, persist: false, writer_materials: [], searchEvidence: () => [source], loadEvidenceText: e => e.text,
    callLLM: async req => req.task === 'extract' ? extracted(req).filter(c => c.claim.includes('試験制度は'))
      : H.readPayload(req).claims.map(c => ({ id: c.id, status: c.sentence.includes('600万円') ? '裏付けあり' : '食い違い', evidence_id: 1, basis: '1', correct })) });
  const parts = content => String(matter(content).data.review_warning).replace(F.WARNING_RE, '').split(' / ').map(s => s.trim()).filter(Boolean);
  await env({ CONTENT_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '01c-fake-key' }, async () => {
    try {
      raw = (await check(raw)).content;
      let first;
      for (const suffix of ['説明を確認します。', '申告の書類を確認します。']) {
        CM.generateSimple = async () => ({ text: `## 制度\n${wrong}\n\n${suffix}`, provider: 'anthropic', model: 'fake', stopReason: 'end_turn' });
        const regenerated = await G.regenerateSection(raw, '制度の補足を確認', { type: 'content', sectionHint: '制度' }, { preserveTitle: true });
        raw = await G.finalizeRegeneration(raw, regenerated, { scope: 'section' }, { factCheck: check, persist: false });
        assert.equal(matter(raw).data.fact_check_prev_recommendation, 'publish');
        assert.equal(matter(raw).data.recommendation, 'revise');
        assert.equal(parts(raw).filter(s => s === '計画: 記録した資料のうち引けない 1 件').length, 1);
        assert.equal(parts(raw).length, new Set(parts(raw)).size);
        if (first) assert.deepEqual(parts(raw), first); else first = parts(raw);
      }
      raw = (await check(F.updateMeta(raw, {}, matter(raw).content.replace(wrong, correct)))).content;
      assert.equal(matter(raw).data.fact_check_status, 'ok'); assert.equal(matter(raw).data.recommendation, 'publish');
      assert.deepEqual(parts(raw), first);
    } finally { CM.generateSimple = original; }
  });
});
test('01c-G1', '差し戻しの範囲引用からIDを作らず、引ける新資料だけを記録する', async () => {
  const body = '## 制度\n所基通37-5～37-6の内容を確認します。';
  const cited = require('../nta-tsutatsu').checkCitations(body).citations;
  assert(cited.some(c => c.found && /[～〜~]/.test(c.no)));
  for (const wave of ['～', '〜', '~']) {
    assert.equal(W.materialId({ kind: 'tsutatsu', circular: 'shotoku', no: `37-5${wave}37-6` }), '');
    assert.equal(W.materialId({ id: `tsutatsu:shotoku:37-5${wave}37-6` }), '');
  }
  const meta = { ...topic(), fact_plan_status: 'ok', fact_plan: '贈与税の配偶者控除', fact_materials: 'ta:4452' };
  await G.buildRegenSourceBlocks(meta, body, { enrichTaxTerms: async () => {}, resolveSupplement: async () => null });
  assert(!/[～〜~]/.test(meta.fact_materials));
  assert(meta.fact_materials.split(';').every(id => W.resolveMaterial(id)));
  assert(!String(meta.materials_warning || '').includes('引けない'));
});
test('01c-G1', '欠落数は記録済みだけを数え、新規の欠落は捨て、記録済みの欠落は残す', () => {
  const meta = { fact_plan_status: 'ok', fact_plan: '贈与税の配偶者控除', fact_materials: 'ta:4452;ta:0000' };
  P.resolveArticlePlan(meta, [W.resolveMaterial('ta:4103'), { id: 'ta:0001' }, { kind: 'tsutatsu', circular: 'shotoku', no: '37-5～37-6' }]);
  assert.equal(meta.fact_materials, 'ta:4452;ta:0000;ta:4103');
  assert.equal(meta.materials_warning, '計画: 記録した資料のうち引けない 1 件');
  P.resolveArticlePlan(meta, [{ id: 'ta:0001' }]);
  assert.equal(meta.materials_warning, '計画: 記録した資料のうち引けない 1 件');
});
test('01c-G1', 'カタログに実在する共通関係のIDを保ち、範囲の引用からも引ける', () => {
  const refs = E.evidenceCatalog().entries.filter(e => e.kind === 'tsutatsu' && /[～〜~]/.test(e.no));
  assert(refs.length > 0);
  for (const ref of refs) {
    assert.equal(W.materialId(ref), ref.id); assert.equal(W.materialId(W.resolveMaterial(ref.id)), ref.id);
    assert.equal(W.materialId({ kind: 'tsutatsu', circular: ref.circular, no: ref.no }), ref.id);
  }
});
for (const planned of [false, true]) test('01c-G1', `注意書きの継承は${planned ? '計画ありだけ部分ごとに統合' : '計画なしなら従来の文字列全体で統合'}`, () => {
  const before = F.updateMeta('---\nslug: 01c-inherit\n---\n本文です。', { recommendation: 'revise', fact_check_version: 1,
    fact_check_prev_recommendation: 'publish', review_warning: '既存の注意 / 別の注意', fact_materials: 'ta:4452',
    ...(planned ? { fact_plan_status: 'ok' } : {}) });
  const after = F.updateMeta(before, { review_warning: '既存の注意 / 別の注意 / 計画: 記録した資料のうち引けない 1 件',
    fact_materials: 'ta:4452;ta:4103;ta:0000;tsutatsu:shotoku:37-5～37-6' });
  const meta = matter(F.inheritFactMetadata(before, after)).data;
  assert.equal(meta.fact_check_prev_recommendation, planned ? 'publish' : 'revise');
  assert.equal(meta.review_warning, (planned ? '' : '既存の注意 / 別の注意 / ') + '既存の注意 / 別の注意 / 計画: 記録した資料のうち引けない 1 件');
  assert.equal(meta.fact_materials, planned ? 'ta:4452;ta:4103' : 'ta:4452;ta:4103;ta:0000;tsutatsu:shotoku:37-5～37-6');
});
for (const recommendation of ['revise', 'reject']) test('01c-G1', `計画ありでも新しい品質の注意と${recommendation}は差し止める`, () => {
  const before = F.updateMeta('---\nslug: 01c-quality\n---\n本文です。', { recommendation: 'revise', fact_check_version: 1,
    fact_check_prev_recommendation: 'publish', fact_plan_status: 'ok', review_warning: '既存の注意' });
  const after = F.updateMeta(before, { recommendation, review_warning: '既存の注意 / 計画: 資料の注意 / 新しい品質の注意' });
  const meta = matter(F.inheritFactMetadata(before, after)).data;
  assert.equal(meta.fact_check_prev_recommendation, recommendation); assert.equal(meta.recommendation, recommendation);
  assert.equal(meta.review_warning, '既存の注意 / 計画: 資料の注意 / 新しい品質の注意');
});

const g2Examples = [
  ['相続財産を譲渡した場合の取得費の特例', 'income_tax', 'income', ids => ids.includes('ta:3267')],
  ['被相続人の居住用財産（空き家）を売ったときの特例', 'income_tax', 'income', ids => ids.includes('ta:3306')],
  ['準確定申告', 'inheritance_tax', 'income', ids => ids.includes('ta:2022') && !ids.some(id => id.includes('/shitsugi/sozoku/'))],
  ['医療費控除', 'inheritance_tax', 'income', ids => ids.some(id => ['ta:1122', 'ta:1119', 'ta:1127'].includes(id)) && !ids.includes('law:sozeki_hou:41_17')],
  ['少額減価償却資産の特例', 'bookkeeping_expenses', 'income', ids => ids.includes('law:sozeki_hou:28_2') && !ids.some(id => ['ta:5408', 'law:sozeki_hou:67_5'].includes(id))],
  ['棚卸資産の評価方法の届出', 'bookkeeping_expenses', 'income', ids => ids.length === 0],
  ['贈与税の基礎控除', 'inheritance_tax', 'inheritance', ids => ids.includes('law:sozokuzei:21_5') && !ids.includes('ta:1199')],
];
for (const [name, tax_domain, tax, expected] of g2Examples) test('01c-G2', `${name}（${tax_domain}）の本物のカタログ`, () => {
  const s = P.findSystemMaterials([{ name }], { tax_domain })[0], ids = s.materials.map(W.materialId);
  assert.equal(s.tax, tax); assert(expected(ids), JSON.stringify(ids)); assert.equal(s.missing, ids.length === 0);
  console.log(`01c-G2 選択 ${JSON.stringify({ name, tax: s.tax, pages: s.materials.map(e => ({ title: e.title, id: W.materialId(e) })) })}`);
});
for (const [name, tax_domain, expected] of f5Examples) test('01c-G2', `F5の期待も維持: ${name}`, () => {
  const s = P.findSystemMaterials([{ name }], { tax_domain })[0], ids = s.materials.map(W.materialId);
  assert(ids.length > 0); assert(expected(ids));
  assert.equal(s.tax, tax_domain === 'invoice_system' ? 'consumption' : tax_domain === 'bookkeeping_expenses' ? 'income' : 'inheritance');
  console.log(`01c-F5 選択 ${JSON.stringify({ name, tax: s.tax, pages: s.materials.map(e => ({ title: e.title, id: W.materialId(e) })) })}`);
});
test('01c-G2', '税目決定の優先順・会社員の部分一致を避ける・質疑応答は税目決定に使わない', () => {
  const entry = (id, kind, title, category, scoreText = '') => ({ id, kind, title, url: `https://www.nta.go.jp/taxes/shiraberu/taxanswer/${category}/9999.htm`,
    text: `${title}。${scoreText}`, ...(kind === 'qa' ? { tax_category_code: category, material_id: id } : {}) });
  const choose = (name, tax_domain, entries) => P.findSystemMaterials([{ name }], { tax_domain }, { entries });
  assert.equal(choose('会社員の試験制度', 'income_tax', [entry('ta:employee', 'taxanswer', '会社員の試験制度', 'shotoku')])[0].tax, 'income');
  const title = '共通試験制度', income = entry('ta:income', 'taxanswer', title, 'shotoku'), corp = entry('ta:corp', 'taxanswer', title, 'hojin');
  assert.equal(choose(title, 'income_tax', [corp, income])[0].tax, 'income');
  assert.equal(choose('贈与税の試験制度', 'income_tax', [entry('ta:explicit', 'taxanswer', '贈与税の試験制度', 'shotoku')])[0].tax, 'inheritance');
  assert.equal(choose(title, 'income_tax', [entry('other', 'shitsugi', title, 'sozoku')])[0].tax, 'income');
  assert.equal(choose(title, '', [entry('other', 'shitsugi', title, 'sozoku')])[0].tax, undefined);
  const law = { id: 'law:shotokuzei_hou:test', key: 'shotokuzei_hou', kind: 'law', title, text: title };
  assert.equal(choose(title, 'income_tax', [law, corp])[0].tax, 'income');
  assert.equal(choose(title, '', [corp])[0].tax, 'corporate');
});
test('01c-G2', '共通法令の題名で税目を補い、税目なしは残しつつ決まった税目を先に並べる', () => {
  const name = '試験特例', titles = ['必要経費', '所得税', '譲渡所得', '事業所得', '損金', '益金', '法人', '贈与', '相続', '消費税', '仕入税額'];
  const entries = titles.map((word, i) => ({ id: `law:sozeki_hou:${i}`, key: 'sozeki_hou', kind: 'law', title: `${name} ${word}`, text: `${name}の条文。` }));
  entries.unshift({ id: 'ta:unknown', kind: 'taxanswer', title: name, text: name, url: 'https://example.jp/unknown' });
  for (const [tax_domain, explicit, tax, allowed] of [
    ['income_tax', name, 'income', [0, 1, 2, 3]], ['income_tax', `法人税の${name}`, 'corporate', [4, 5, 6]],
    ['income_tax', `贈与税の${name}`, 'inheritance', [7, 8]], ['income_tax', `消費税の${name}`, 'consumption', [9, 10]],
  ]) {
    const s = P.findSystemMaterials([{ name: explicit }], { tax_domain }, { entries })[0];
    assert.equal(s.tax, tax); assert.equal(s.materials.length, 2);
    assert(s.materials.every(e => allowed.some(i => e.id === `law:sozeki_hou:${i}`))); // 税目のないTAより同じ税目の条を優先する。
  }
});

for (const status of ['食い違い', '期限の書き漏れ']) test('01c-G3', `確認を通った段Aの${status}も段Bが裏付けたら修正案と出典を人の確認欄に残す`, async () => {
  const body = '試験制度は100万円です。', correction = status === '食い違い' ? '試験制度は200万円です。' : '試験制度の適用期限は令和9年3月31日です。';
  const a = ref('01c-a', correction), b = ref('01c-b', body);
  const result = await F.checkFacts(body, { ...opts, writer_materials: ['ta:4452'], searchWriterEvidence: () => [a], searchEvidence: () => [b], loadEvidenceText: e => e.text,
    callLLM: async req => req.task === 'extract' ? extracted(req) : req.stageB ? supported(req)
      : [{ id: 'c1', status, evidence_id: 1, basis: '1', correct: correction }] });
  assert.equal(result.record.status, 'ok'); assert.equal(result.record.claims[0].status, '裏付けあり'); assert.equal(result.record.claims[0].stage, 'B');
  assert.equal(result.record.review_items.length, 1);
  const item = result.record.review_items[0]; assert.equal(item.stage_a_answer.status, status); assert.equal(item.stage_a_answer.correct, correction);
  assert.equal(item.stage_a_answer.evidence, a.id); assert.equal(item.stage_a_answer.url, a.url);
  const approved = F.applyFactResult('---\nslug: 01c-advisory\nrecommendation: publish\n---\n' + body, result);
  assert.equal(matter(approved).data.recommendation, 'publish'); assert.equal(matter(approved).data.fact_check_blocking, false);
  const page = require('../../../netlify/functions/review-page');
  const html = page.renderFactCheck(matter(approved).data, F.compactRecord(result.record), body);
  assert(html.includes(`段Aの${status}を要確認`)); assert(html.includes(a.title)); assert(html.includes(a.url)); assert(html.includes(correction));
  const altered = { ...result.record, review_items: [{ ...item, stage_a_answer: { ...item.stage_a_answer, correct: '<script>alert(1)</script>' } }] };
  assert(!page.renderFactCheck(matter(approved).data, altered, body).includes('<script>alert(1)</script>'));
});
test('01c-G3', '確認を通った疑いの修正案も差分照合で保持し、表示要約は200字まで', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '01c-review-reuse-'));
  const body = '試験制度は100万円です。', correction = '試験制度は200万円です。' + '要件を確認します。'.repeat(25);
  const a = ref('01c-reuse-a', correction), b = ref('01c-reuse-b', body);
  const raw = `---\nslug: 01c-review-reuse\nfact_materials: ta:4452\nrecommendation: publish\n---\n${body}`;
  const options = { ...opts, recordDir: dir, searchWriterEvidence: () => [a], searchEvidence: () => [b], loadEvidenceText: e => e.text,
    callLLM: async req => req.task === 'extract' ? extracted(req) : req.stageB ? supported(req)
      : [{ id: 'c1', status: '食い違い', evidence_id: 1, basis: '1', correct: correction }] };
  try {
    const first = await F.checkArticle(raw, options);
    assert.equal(first.record.review_items[0].stage_a_answer.correct.length, 200);
    const next = await F.checkArticle(raw, { ...options, persist: false, previousRaw: raw });
    assert.equal(next.record.incremental.reused, 1); assert.equal(next.record.review_items.length, 1);
    assert.deepEqual(next.record.review_items[0].stage_a_answer, first.record.review_items[0].stage_a_answer);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const h1Examples = [
  ['交際費', 'bookkeeping_expenses', 'income', ids => ids.length > 0 && !ids.some(id => ['ta:6463', 'ta:6917'].includes(id))],
  ['交際費等の損金不算入', 'bookkeeping_expenses', 'corporate', ids => ids.some(id => ['law:sozeki_hou:61_4', 'ta:5265'].includes(id))],
  ['相続税額の取得費加算の特例', 'income_tax', 'income', ids => ids.length > 0 && !ids.some(id => id.includes('/shitsugi/sozoku/'))],
];
for (const [name, tax_domain, tax, expected] of h1Examples) test('01d-H1', `${name}（${tax_domain}）の本物のカタログ`, () => {
  const s = P.findSystemMaterials([{ name }], { tax_domain })[0], ids = s.materials.map(W.materialId);
  assert.equal(s.tax, tax); assert(expected(ids), JSON.stringify(ids));
  console.log(`01d-H1 選択 ${JSON.stringify({ name, tax: s.tax, pages: s.materials.map(e => ({ title: e.title, id: W.materialId(e) })) })}`);
});
test('01d-H1', '税目名の直後が額なら明示税目にせず、損金・益金・必要経費を記事税目より優先する', () => {
  const decide = (name, tax_domain = 'invoice_system') => P.findSystemMaterials([{ name }], { tax_domain }, { entries: [] })[0].tax;
  for (const [name, tax] of [['所得税', 'income'], ['法人税', 'corporate'], ['消費税', 'consumption'], ['相続税', 'inheritance'], ['贈与税', 'inheritance']]) {
    const domain = tax === 'consumption' ? 'income_tax' : 'invoice_system', fallback = tax === 'consumption' ? 'income' : 'consumption';
    assert.equal(decide(`${name}の試験特例`, domain), tax);
    assert.equal(decide(`${name}額の試験特例`, domain), fallback);
  }
  for (const name of ['インボイスの特例', '適格請求書の特例']) assert.equal(decide(name, 'income_tax'), 'consumption');
  assert.equal(decide('損金の試験特例', 'bookkeeping_expenses'), 'corporate');
  assert.equal(decide('益金の試験特例', 'bookkeeping_expenses'), 'corporate');
  assert.equal(decide('必要経費の試験特例', 'inheritance_tax'), 'income');
  assert.equal(decide('所得税の損金の試験特例'), 'income');
  assert.equal(decide('相続税の必要経費の試験特例'), 'inheritance');
});
test('01d-H1', '題名の当たる通達でも記事税目を確定し、他税目のTAの検索点に引かれない', () => {
  const entries = [
    { id: 'ta:other-tax', kind: 'taxanswer', title: '交際費', url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/9999.htm', text: '交際費の扱い。' },
    { id: 'tsutatsu:shotoku:test', kind: 'tsutatsu', circular: 'shotoku', title: '交際費の取扱い', text: '交際費の原文。' },
  ];
  const s = P.findSystemMaterials([{ name: '交際費' }], { tax_domain: 'bookkeeping_expenses' }, { entries })[0];
  assert.equal(s.tax, 'income'); assert.deepEqual(s.materials.map(W.materialId), ['tsutatsu:shotoku:test']);
});

const h2Examples = [
  ['相続人に対する書類の送達', 'income_tax', 'income', 'law:tsusoku_hou:13'],
  [W.resolveMaterial('law:sozeki_hou:70_7_9').title.replace(/^租税特別措置法 /, ''), 'inheritance_tax', 'inheritance', 'law:sozeki_hou:70_7_9'],
];
for (const [name, tax_domain, tax, required] of h2Examples) test('01d-H2', `${required}を本物のカタログで選ぶ`, () => {
  const s = P.findSystemMaterials([{ name }], { tax_domain })[0];
  assert.equal(s.tax, tax); assert(s.materials.some(e => W.materialId(e) === required));
  console.log(`01d-H2 選択 ${JSON.stringify({ name, tax: s.tax, pages: s.materials.map(e => ({ title: e.title, id: W.materialId(e) })) })}`);
});
test('01d-H2', '通則法13・5と民法951は題名の語で税目を付けず、どの記事税目でも残す', () => {
  for (const id of ['law:tsusoku_hou:13', 'law:tsusoku_hou:5', 'law:minpo:951']) {
    const ref = W.resolveMaterial(id); assert(ref);
    for (const [tax_domain, tax] of [['income_tax', 'income'], ['inheritance_tax', 'inheritance'], ['invoice_system', 'consumption']]) {
      const s = P.findSystemMaterials([{ name: ref.title }], { tax_domain }, { entries: [ref] })[0];
      assert.equal(s.tax, tax); assert.deepEqual(s.materials.map(W.materialId), [id]);
    }
  }
});
test('01d-H2', '医療法人の持分の措法・措令12条は法人より明示された相続税・贈与税を優先する', () => {
  const refs = E.evidenceCatalog().entries.filter(e => /^law:sozeki_(?:hou:70_7|rei:40_8)_(?:9|1[0-4])$/.test(e.id));
  assert.equal(refs.length, 12);
  for (const ref of refs) {
    const s = P.findSystemMaterials([{ name: ref.title }], { tax_domain: 'inheritance_tax' }, { entries: [ref] })[0];
    assert.equal(s.tax, 'inheritance'); assert.deepEqual(s.materials.map(W.materialId), [ref.id]);
    const wrong = P.findSystemMaterials([{ name: '医療法人の持分' }], { tax_domain: 'income_tax' }, { entries: [ref] })[0];
    assert.equal(wrong.tax, 'income'); assert.equal(wrong.materials.length, 0); // 税目なしとして通すこともない。
  }
});

test('01d-H3', '実在する共通関係の本文引用を差し戻しのfact_materialsに足し、実在しない範囲は足さない', async () => {
  const body = '## 制度\n所基通23～35共-6と所基通37-5～37-6の内容を確認します。';
  const refs = require('../nta-tsutatsu').checkCitations(body).citations;
  assert(refs.some(c => c.found && c.no === '23～35共-6')); assert(refs.some(c => c.found && c.no === '37-5～37-6'));
  const meta = { ...topic(), fact_plan_status: 'ok', fact_plan: '贈与税の配偶者控除', fact_materials: 'ta:4452' };
  await G.buildRegenSourceBlocks(meta, body, { enrichTaxTerms: async () => {}, resolveSupplement: async () => null });
  const raw = G.recordMaterialMetadata('---\nslug: 01d-range\n---\n' + body, meta), ids = matter(raw).data.fact_materials.split(';');
  assert(ids.includes('tsutatsu:shotoku:23～35共-6')); assert(!ids.includes('tsutatsu:shotoku:37-5～37-6'));
  assert(ids.every(id => W.resolveMaterial(id))); assert(!String(meta.materials_warning || '').includes('引けない'));
});
test('01d-H3', '範囲を含む引用は候補IDの優先順とカタログの実在だけで決める', () => {
  const good = 'tsutatsu:shotoku:23～35共-6', bad = 'tsutatsu:shotoku:37-5～37-6';
  const quote = { circular: 'shotoku', no: '23～35共-6' };
  assert.equal(W.materialId(quote), good);
  assert.equal(W.materialId({ ...quote, id: good }), good);
  assert.equal(W.materialId({ ...quote, id: bad }), '');
  assert.equal(W.materialId({ ...quote, id: bad, material_id: good }), good);
  assert.equal(W.materialId({ ...quote, id: good, material_id: bad }), '');
  assert.equal(W.materialId({ circular: 'shotoku', no: '37-5～37-6' }), '');
});

(async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('試験中の通信は禁止'); };
  try {
    await env({ FACT_PLAN_ENABLED: undefined, FACT_CHECK_WRITER_MATERIALS: 'true', FACT_CHECK_MAX_CLAIMS: undefined }, async () => {
      for (const { group, name, fn } of cases) {
        const result = groups[group] ||= { pass: 0, fail: 0 };
        try { await fn(); result.pass++; console.log(`PASS ${group}: ${name}`); }
        catch (error) { result.fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
      }
    });
  } finally { global.fetch = originalFetch; }
  const passed = Object.values(groups).reduce((n, r) => n + r.pass, 0), failed = Object.values(groups).reduce((n, r) => n + r.fail, 0);
  console.log(JSON.stringify({ passed, failed, groups })); if (failed) process.exitCode = 1;
})();
