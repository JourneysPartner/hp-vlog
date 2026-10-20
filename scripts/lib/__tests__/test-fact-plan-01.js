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
  CM.generateSimple = async (request, options) => {
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
test('P2', 'No.4452は関連条件を通るが本文中の制度名が多い質疑応答2件が上位（要判断）', () => {
  const ref = W.resolveMaterial('ta:4452'); const relation = P.relevantMaterial(exampleNames[3], ref, ref.text.split('関連リンク')[0]);
  assert(relation.titleMatch); assert(relation.condition);
  const rows = examples[3].materials;
  assert.deepEqual(rows.map(e => e.id), ['https://www.nta.go.jp/law/shitsugi/sozoku/16/05.htm', 'https://www.nta.go.jp/law/shitsugi/sozoku/16/07.htm']);
  assert(rows.every(e => P.relevantMaterial(exampleNames[3], e, e.text).occurrences > relation.occurrences));
});
test('P2', 'No.4103は関連条件3を通るが最後の検索点でQ&Aが上位（要判断）', () => {
  const ref = W.resolveMaterial('ta:4103'); const relation = P.relevantMaterial(exampleNames[4], ref, ref.text.split('関連リンク')[0]);
  assert(relation.titleMatch); assert(relation.condition);
  assert.deepEqual(examples[4].materials.map(W.materialId), ['qa:sozoku/r5kaisei-1-2', 'qa:sozoku/r5kaisei-2-1']);
  assert(examples[4].materials.every(e => P.relevantMaterial(exampleNames[4], e, e.text).occurrences === relation.occurrences));
  const ranking = W.searchWriterEvidence({ subject: exampleNames[4], claim: exampleNames[4] }, { writer_materials: ['ta:4103', ...examples[4].materials.map(W.materialId)] });
  assert(ranking.find(e => W.materialId(e) === 'ta:4103').score < ranking[1].score);
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
test('P3/P4', '切替falseは変更前のpromptIRと前付けにバイト単位で一致', () => env({ FACT_PLAN_ENABLED: 'false' }, () => generating(topic(), '[]', ({ prompts, simple, t }) => {
  assert.equal(simple.length, 0); assert.equal(hash(JSON.stringify(prompts[0])), '788d0a8c29123aea40f348336e7186ce44eacf53838c0d0819a6f7f4af364ff4');
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
    searchWriterEvidence: () => [a], searchEvidence: c => { assert.equal(c.id, 'c2'); return [b]; }, loadEvidenceText: e => e.text,
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
  assert(r.record.summary.includes('書き手の資料で判定 3 件・全体を探した 1 件')); assert.equal(r.record.logic_version, 'plan1');
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
test('P5', '資料なしと切替falseの呼び出し・記録は同じ（版はplan1）', async () => {
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
    searchWriterEvidence: () => [extracts > 1 ? decoy : original], searchEvidence: () => [decoy], loadEvidenceText: e => e.text,
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

(async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('試験中の通信は禁止'); };
  try {
    await env({ FACT_PLAN_ENABLED: undefined, FACT_CHECK_WRITER_MATERIALS: undefined, FACT_CHECK_MAX_CLAIMS: undefined }, async () => {
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
