'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const M = require('../materials-bundle');
const B = require('../nta-source-body');
const laws = require('../law-sources');
const rules = require('../grounding-rules');
const { resolveNtaUrlByNumber } = require('../tax-authority-refs');
const { normalizeGeneratedDraft } = require('../draft-normalizer');
const ROOT = path.join(__dirname, '..', '..', '..');
let passed = 0, failed = 0;
async function test(label, fn) {
  try { await fn(); passed++; console.log(`PASS ${label}`); }
  catch (e) { failed++; console.error(`FAIL ${label}: ${e.message}`); }
}
const page = no => ({ no, ...resolveNtaUrlByNumber(no) });
const topic644 = () => ({ slug: 'gift-exemption', title: '贈与税の非課税', source_url: page('4508').url,
  tax_terms: '住宅取得等資金 教育資金 結婚・子育て資金 非課税財産', source_supplements: ['4510', '4511', '4405'].map(page) });
const silent = { log: () => {} };

async function main() {
  await test('01 R1 実データ #644 の4ページの本文と現行期限', () => {
    const result = M.buildMaterialsBundle(topic644(), [], silent);
    assert.deepEqual(result.pages.sources.map(s => s.no), ['4508', '4510', '4511', '4405']);
    assert.ok(result.pages.sources.find(s => s.no === '4511').body.includes('令和9年3月31日'));
    assert.equal(result.pages.totalChars, 8197);
    console.log('実データ #644:', JSON.stringify({ pages: result.pages.sources.map(s => ({ kind: s.kind, no: s.no, chars: s.body.length, excerpt: s.truncated })),
      bodyChars: result.pages.totalChars, lawChars: result.chain.totalChars, bundleChars: result.combined.length, source_bundle: result.sourceBundle }));
  });
  await test('01 R1 主出典→補助→参考、URLの重複を除く', () => {
    const result = B.buildSourceBodyBundle(topic644(), [page('4510'), page('4152'), page('4103')], silent);
    assert.deepEqual(result.sources.map(s => s.no), ['4508', '4510', '4511', '4405', '4152']);
  });
  await test('01 R1 合計予算で題名だけにし、ログへ記録', () => {
    const logs = [];
    const r = B.buildSourceBodyBundle(topic644(), [], { maxTotal: 5000, log: s => logs.push(s) });
    assert.ok(r.totalChars <= 5000);
    assert.ok(r.dropped.some(s => s.no === '4511' && s.reason === '合計予算超過'));
    assert.ok(r.block.includes('題名のみ'));
    assert.ok(logs.some(s => s.includes('4511') && s.includes('予算')));
    assert.ok(r.block.indexOf(page('4510').url) < r.block.indexOf(page('4511').url));
  });
  await test('01 R1 長い実ページの論点段落を優先する', () => {
    const r = B.loadSourceBody(page('4124').url, { maxChars: 1200, query: '区分所有 一棟 建物' });
    assert.ok(r.body.includes('区分所有'));
    assert.ok(r.truncated && r.body.length <= 1200);
  });
  await test('01 R2 実データ10-05と4124、項指定でも条の全文', () => {
    const url = 'https://www.nta.go.jp/law/shitsugi/sozoku/10/05.htm';
    const r = M.buildMaterialsBundle({ source_url: url, source_supplements: [page('4124')] }, [], silent);
    assert.ok(r.chain.attached.some(a => a.key === 'sozeki_hou' && a.num === '69_4'));
    assert.equal(r.chain.attached.find(a => a.num === '69_4').text, laws.getArticle('sozeki_hou', '69_4').text);
    assert.ok(r.chain.unresolved.some(a => a.key === 'sozeki_rei' && a.num === '40_2'));
    console.log('実データ 法令連鎖:', JSON.stringify({ attached: r.chain.attached.map(a => ({ kind: a.kind, label: a.label, chars: a.text.length })),
      unresolved: r.chain.unresolved.map(a => a.label) }));
    assert.ok(!r.chain.unresolved.some(a => a.label === '租税特別措置法69条の4'));
  });
  await test('01 R2 条の件数・文字数の上限を守り、条を途中で切らない', () => {
    const topic = topic644();
    const r = M.buildMaterialsBundle(topic, [], { ...silent, maxArticles: 1, maxLawChars: 10000 });
    assert.equal(r.chain.attached.length, 1);
    assert.ok(r.chain.dropped.length > 0);
    const small = M.buildMaterialsBundle(topic, [], { ...silent, maxLawChars: 100 });
    assert.ok(small.chain.totalChars <= 100);
    assert.ok(small.chain.dropped.some(a => a.label === '措法70の2'));
  });
  await test('01 R3 curated・explicitでも論点別選定、主出典を保持', async () => {
    for (const provenance of ['curated', 'explicit', 'domain-fallback']) {
      const t = { ...page('2210'), source_url: page('2210').url, source_provenance: provenance };
      let termsCalls = 0, selectCalls = 0;
      await M.supplementGenericSource(t, { enrichTaxTerms: async x => { termsCalls++; x.tax_terms = '棚卸資産 低価法'; },
        resolveSource: async narrowed => { selectCalls++; assert.equal(narrowed.source_url, t.source_url); return page('2100'); } });
      assert.equal(termsCalls, 1); assert.equal(selectCalls, 2);
      assert.equal(t.source_url, page('2210').url); assert.equal(t.source_provenance, provenance);
      assert.equal(t.source_supplements.length, 1);
    }
  });
  await test('01 R3 資料なしの警告、使用回数での汎用判定', async () => {
    const t = { source_url: page('2210').url, title: '在庫' };
    await M.supplementGenericSource(t, { resolveSource: async () => null });
    assert.match(t.materials_warning, /主出典が汎用ページ/);
    const content = normalizeGeneratedDraft('## 確認\n本文です。', { ...t, slug: 'test' }).content;
    assert.match(content, /review_warning:.*主出典が汎用ページ/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'materials-count-'));
    try {
      for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `${i}.md`), '---\nreview_status: published\nsource_url: https://example.jp/specific\n---\n本文');
      assert.ok(M.isGenericSource({ source_url: 'https://example.jp/specific' }, { postsDir: dir }));
      assert.ok(!M.isGenericSource({ source_url: 'https://example.jp/specific' }, { postsDir: dir, genericThreshold: 11 }));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('01 R4 source_bundleは実際に渡した原文だけ、20件以内', () => {
    const t = topic644(), r = M.buildMaterialsBundle(t, [], silent);
    assert.equal(t.source_bundle, r.sourceBundle);
    assert.ok(r.sourceBundle.split(';').length <= 20);
    assert.ok(!r.sourceBundle.includes('措令40'));
    assert.match(normalizeGeneratedDraft('## 確認\n本文です。', t).content, /source_bundle:.*4508.htm/);
  });
  await test('02 R1・R2 新しい4・7、古い4がなく、他の規則を維持', () => {
    const block = B.buildSourceBodyBlock(topic644(), [], silent);
    assert.ok(block.includes('4. ' + rules.UNSOURCED_RULE));
    assert.ok(block.includes('7. ' + rules.DEADLINE_RULE));
    assert.ok(!block.includes('その旨が分かるように書く'));
    assert.ok(block.includes('必ず本文を優先') && block.includes('本文の列挙をそのまま守る') && block.includes('出典に無い数値を自分で作ってはならない'));
  });
  await test('02 R3・R4 法令の注意と記憶からの具体を書く禁止', () => {
    assert.ok(laws.buildLawProvisionBlock([{ law: '法', num: '1', text: '原文' }]).includes(rules.LAW_SCOPE_RULE));
    assert.ok(M.buildMaterialsBundle(topic644(), [], silent).chainBlock.includes(rules.LAW_SCOPE_RULE));
    const staticPrompt = fs.readFileSync(path.join(ROOT, 'scripts/lib/article-prompt-static.js'), 'utf8');
    assert.ok(staticPrompt.includes('抽象化する（具体的な要件・金額・期限は書かない）'));
    assert.ok(rules.SOURCE_UNCONFIRMED_RULE.includes(rules.UNSOURCED_RULE));
  });
  await test('01・02 3経路の共通部品と規則文の一致', async () => {
    const generate = require('../../generate-draft');
    const meta = { slug: 'test', source_url: page('4508').url, source_2_url: page('4511').url };
    const regen = await generate.buildRegenSourceBlocks(meta, '## 確認\n本文です。', { enrichTaxTerms: async () => {} });
    const regular = M.buildMaterialsBundle(M.topicFromMeta(meta), undefined, silent);
    assert.ok(regen.sourceBody.includes(rules.UNSOURCED_RULE) && regular.sourceBody.includes(rules.UNSOURCED_RULE));
    assert.ok(regen.sourceBody.includes(rules.DEADLINE_RULE) && regular.sourceBody.includes(rules.DEADLINE_RULE));
    assert.ok(regen.sourceBody.includes('令和9年3月31日'));
    const src = fs.readFileSync(path.join(ROOT, 'scripts/generate-draft.js'), 'utf8');
    assert.match(src, /materials\.buildMaterialsBundle\(topic, ntaRefs\)/);
    assert.match(src, /await buildRegenSourceBlocks\(meta, existingBody\)/);
    assert.equal((src.match(/await buildRegenSourceBlocks\(meta, body\)/g) || []).length, 2);
    assert.ok(src.includes('freshnessRefresh.runRefresh'));
  });
  console.log(`\n資料・規則: PASS ${passed} / FAIL ${failed}`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
