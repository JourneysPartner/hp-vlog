'use strict';

/**
 * content-model の provider/model 解決と fallback 安全性のテスト。
 *   node scripts/lib/__tests__/test-content-model-routing.js
 *
 * 重要検証:
 *   - CONTENT_MODEL_PROVIDER=anthropic → claude-sonnet-4-6
 *   - OpenAI fallback には gpt-5.4 を使う（claude ID を渡さない）
 *   - ANTHROPIC_API_KEY 未設定なら openai に fallback
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}
function reload(p) { delete require.cache[require.resolve(p)]; return require(p); }
function clearEnv() {
  for (const k of ['CONTENT_MODEL_PROVIDER','CONTENT_MODEL','OPENAI_MODEL',
                   'ANTHROPIC_API_KEY','OPENAI_API_KEY','CONTENT_MODEL_USE_PROMPT_CACHE']) delete process.env[k];
}

const CM = path.join(ROOT, 'scripts/lib/content-model');

// ── 1. anthropic + key → claude-sonnet-4-6 ──────────────────
console.log('\n=== Test 1: anthropic provider → Sonnet 4.6 ===');
{
  clearEnv();
  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  process.env.CONTENT_MODEL = 'claude-sonnet-4-6';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const cm = reload(CM);
  assert(cm.resolveProvider() === 'anthropic', 'provider=anthropic');
  assert(cm.resolveModel('anthropic') === 'claude-sonnet-4-6', 'model=claude-sonnet-4-6');
}

// ── 2. OpenAI fallback には gpt-5.4（claude を渡さない）──────
console.log('\n=== Test 2: OpenAI fallback は gpt-5.4 を使う ===');
{
  clearEnv();
  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  process.env.CONTENT_MODEL = 'claude-sonnet-4-6';  // ← これが OpenAI に渡ってはいけない
  process.env.OPENAI_MODEL = 'gpt-5.4';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const cm = reload(CM);
  const oaModel = cm.resolveModel('openai');
  assert(oaModel === 'gpt-5.4', `openai fallback model=${oaModel}（claude を渡さない）`);
  assert(!/claude/.test(oaModel), 'openai に claude ID を渡さない');
}

// ── 3. OPENAI_MODEL 未設定でも openai は gpt-5.4 デフォルト ──
console.log('\n=== Test 3: OPENAI_MODEL 未設定 → gpt-5.4 デフォルト ===');
{
  clearEnv();
  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  process.env.CONTENT_MODEL = 'claude-sonnet-4-6';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const cm = reload(CM);
  assert(cm.resolveModel('openai') === 'gpt-5.4', 'openai 既定 gpt-5.4');
}

// ── 4. ANTHROPIC_API_KEY 未設定 → openai に fallback ────────
console.log('\n=== Test 4: ANTHROPIC_API_KEY 未設定 → openai ===');
{
  clearEnv();
  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  process.env.CONTENT_MODEL = 'claude-sonnet-4-6';
  process.env.OPENAI_MODEL = 'gpt-5.4';
  // ANTHROPIC_API_KEY なし
  const cm = reload(CM);
  assert(cm.resolveProvider() === 'openai', 'キー無しは openai に fallback');
}

// ── 5. 既定（CONTENT_MODEL_PROVIDER 未設定）は openai ───────
console.log('\n=== Test 5: 既定は openai（本番互換）===');
{
  clearEnv();
  process.env.OPENAI_MODEL = 'gpt-5.4';
  const cm = reload(CM);
  assert(cm.resolveProvider() === 'openai', '既定 openai');
  assert(cm.resolveModel('openai') === 'gpt-5.4', 'openai model gpt-5.4');
}

// ── 6. useCache の解釈 ───────────────────────────────────────
console.log('\n=== Test 6: prompt cache フラグ ===');
{
  clearEnv();
  const cm = reload(CM);
  assert(cm.useCache() === true, '未設定は既定 true');
  process.env.CONTENT_MODEL_USE_PROMPT_CACHE = 'false';
  const cm2 = reload(CM);
  assert(cm2.useCache() === false, 'false で無効');
  process.env.CONTENT_MODEL_USE_PROMPT_CACHE = 'true';
  const cm3 = reload(CM);
  assert(cm3.useCache() === true, 'true で有効');
}

// ── 7. toAnthropicRequest が cache_control を付ける（cache=true）─
console.log('\n=== Test 7: Anthropic リクエストに cache_control ===');
{
  const builder = reload(path.join(ROOT, 'scripts/lib/article-prompt-builder'));
  const ir = { staticSystem: 'STATIC', dynamicSystem: 'DYN', user: 'U' };
  const req = builder.toAnthropicRequest(ir, { model: 'claude-sonnet-4-6', useCache: true });
  assert(req.system[0].cache_control && req.system[0].cache_control.type === 'ephemeral', '固定ブロックに ephemeral cache');
  assert(req.model === 'claude-sonnet-4-6', 'model 指定');
}

clearEnv();
console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
