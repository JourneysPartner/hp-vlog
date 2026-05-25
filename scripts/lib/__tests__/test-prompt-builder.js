'use strict';

/**
 * プロンプトビルダー（静的/可変分離・provider 変換）のテスト。
 *   node scripts/lib/__tests__/test-prompt-builder.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

const builder = require(path.join(ROOT, 'scripts/lib/article-prompt-builder'));
const { STATIC_RULES } = require(path.join(ROOT, 'scripts/lib/article-prompt-static'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

const topic = {
  title: 'テストタイトル', slug: 'test-slug', category: '消費税',
  persona: 'domestic_ec_seller', macro: '物販', cluster: 'amazon',
  subcluster: 'amazon-x', tax_domain: 'consumption_tax',
  source_url: 'https://www.nta.go.jp/x', source_title: '国税庁X',
  search_intent: 'si', reader_problem: 'rp', success_outcome: 'so', primary_question: 'pq',
  business_stage: 'just-opened', pain_point: 'consumption-tax-judgement',
};
const persona = { label: '国内EC物販セラー' };

// ── 1. 生成プロンプト IR が3部構成 ───────────────────────────
console.log('\n=== Test 1: buildGenerationPrompt が静的/可変を分離 ===');
{
  const ir = builder.buildGenerationPrompt({
    topic, persona, cta: 'CTAテキスト', articleType: 'basic_explainer', articleRole: 'main',
    ntaRefsBlock: '', lawChangesBlock: '', revisionHint: '',
    relatedSlug: 'r', relatedTitle: 'rt', relatedLinkText: 'rl', now: '2026-05-25T00:00:00Z',
  });
  assert(ir.staticSystem === STATIC_RULES, 'staticSystem は固定ルール（キャッシュ対象）');
  assert(/テストタイトル/.test(ir.dynamicSystem), 'dynamicSystem に可変 topic が入る');
  assert(/テストタイトル/.test(ir.user), 'user に frontmatter テンプレ');
  assert(!/テストタイトル/.test(ir.staticSystem), '静的部分に可変情報が漏れていない');
}

// ── 2. OpenAI 変換 ───────────────────────────────────────────
console.log('\n=== Test 2: toOpenAIMessages ===');
{
  const ir = builder.buildGenerationPrompt({
    topic, persona, cta: 'C', articleType: 'comparison_decision', articleRole: 'main',
    now: '2026-05-25T00:00:00Z',
  });
  const msgs = builder.toOpenAIMessages(ir);
  assert(msgs.length === 2, 'system + user の2メッセージ');
  assert(msgs[0].role === 'system' && /最上位ルール/.test(msgs[0].content), 'system に固定ルール含む');
  assert(msgs[1].role === 'user', 'user メッセージ');
}

// ── 3. Anthropic 変換 + cache_control ────────────────────────
console.log('\n=== Test 3: toAnthropicRequest が cache_control を付ける ===');
{
  const ir = builder.buildGenerationPrompt({
    topic, persona, cta: 'C', articleType: 'basic_explainer', articleRole: 'main',
    now: '2026-05-25T00:00:00Z',
  });
  const req = builder.toAnthropicRequest(ir, { model: 'claude-sonnet-4-6', maxTokens: 4096, useCache: true });
  assert(req.model === 'claude-sonnet-4-6', 'モデルID');
  assert(Array.isArray(req.system) && req.system.length === 2, 'system は2ブロック');
  assert(req.system[0].cache_control && req.system[0].cache_control.type === 'ephemeral',
    '固定ルールブロックに cache_control: ephemeral');
  assert(!req.system[1].cache_control, '可変ブロックには cache_control なし');
  assert(req.messages[0].role === 'user', 'user メッセージ');
}

// ── 4. useCache=false で cache_control なし ──────────────────
console.log('\n=== Test 4: useCache=false ===');
{
  const ir = builder.buildGenerationPrompt({
    topic, persona, cta: 'C', articleType: 'basic_explainer', articleRole: 'main',
    now: '2026-05-25T00:00:00Z',
  });
  const req = builder.toAnthropicRequest(ir, { model: 'claude-sonnet-4-6', useCache: false });
  assert(!req.system[0].cache_control, 'useCache=false なら cache_control なし');
}

// ── 5. content-model の provider 解決（既定 openai）────────────
console.log('\n=== Test 5: content-model provider 解決 ===');
{
  delete process.env.CONTENT_MODEL_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  const cm = require(path.join(ROOT, 'scripts/lib/content-model'));
  assert(cm.resolveProvider() === 'openai', '既定は openai（本番互換）');

  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  delete process.env.ANTHROPIC_API_KEY;
  // キー無しなら openai に fallback
  assert(cm.resolveProvider() === 'openai', 'anthropic 指定でもキー無しは openai に fallback');

  process.env.ANTHROPIC_API_KEY = 'dummy';
  assert(cm.resolveProvider() === 'anthropic', 'anthropic + キーあり → anthropic');
  assert(cm.resolveModel('anthropic') === 'claude-sonnet-4-6', 'Anthropic 既定モデル = claude-sonnet-4-6');
  delete process.env.CONTENT_MODEL_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
}

// ── 6. 静的ルールに主要セクションが含まれる ──────────────────
console.log('\n=== Test 6: STATIC_RULES の網羅性 ===');
{
  for (const kw of ['最上位ルール', 'SEO', '文体', '禁止事項', '出典', 'タイトル自然化', '表・Markdown', '免責', '大分類別']) {
    assert(STATIC_RULES.includes(kw), `静的ルールに「${kw}」を含む`);
  }
}

// ── 7. 生成プロンプトが「frontmatter + Markdown本文」形式を指示 ──
console.log('\n=== Test 7: 出力形式が frontmatter + 本文 を指示 ===');
{
  const ir = builder.buildGenerationPrompt({
    topic, persona, cta: 'C', articleType: 'comparison_decision', articleRole: 'main',
    now: '2026-05-25T00:00:00Z',
  });
  // user に frontmatter テンプレ（--- 区切り）と本文指示が含まれる
  assert(/---/.test(ir.user), 'user に frontmatter 区切り（---）');
  assert(/title:/.test(ir.user) && /slug:/.test(ir.user) && /review_status:/.test(ir.user),
    'frontmatter テンプレに必須キー');
  assert(/Markdown本文|本文/.test(ir.user), '本文生成の指示を含む');
  assert(/コードブロック不要/.test(ir.user), 'コードブロック不要の指示');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
