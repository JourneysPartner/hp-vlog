'use strict';

/**
 * GitHub Actions 想定の env が正しく解決されるかのテスト。
 *   node scripts/lib/__tests__/test-env-resolution.js
 *
 * - CONTENT_MODEL_* / OPENAI_MODEL / AUX_MODEL_* の読み取り
 * - CONTENT_MODEL_USE_PROMPT_CACHE は secrets/vars どちらの値でも文字列として解釈できる
 * - daily-draft.yml / regenerate-draft.yml が必要な env を generate-draft に渡しているか
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..', '..');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}
function reload(p) { delete require.cache[require.resolve(p)]; return require(p); }

// ── 1. GitHub Actions 想定 env をまとめてセット → 解決確認 ──
console.log('\n=== Test 1: 本番想定 env の解決 ===');
{
  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  process.env.CONTENT_MODEL = 'claude-sonnet-4-6';
  process.env.CONTENT_MODEL_USE_PROMPT_CACHE = 'true';
  process.env.OPENAI_MODEL = 'gpt-5.4';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  process.env.AUX_MODEL_ENABLED = 'true';
  process.env.AUX_MODEL_PROVIDER = 'anthropic';
  process.env.AUX_MODEL = 'claude-haiku-4-5-20251001';

  const cm = reload(path.join(ROOT, 'scripts/lib/content-model'));
  const aux = reload(path.join(ROOT, 'scripts/lib/aux-model'));

  assert(cm.resolveProvider() === 'anthropic', 'content provider=anthropic');
  assert(cm.resolveModel('anthropic') === 'claude-sonnet-4-6', 'content model=claude-sonnet-4-6');
  assert(cm.resolveModel('openai') === 'gpt-5.4', 'openai fallback=gpt-5.4');
  assert(cm.useCache() === true, 'prompt cache=true');
  assert(aux.canUseAux() === true, 'aux 利用可能');
  assert(aux.auxModel() === 'claude-haiku-4-5-20251001', 'aux model 確認');
}

// ── 2. CONTENT_MODEL_USE_PROMPT_CACHE は secret/var どちらでも同じ解釈 ──
console.log('\n=== Test 2: prompt cache フラグは値が同じなら出所を問わない ===');
{
  // workflow では `vars.X || secrets.X` で1つの env に解決される想定。
  // どちらから来ても "true"/"false" の文字列であれば content-model は同じ解釈をする。
  for (const v of ['true', 'TRUE', '1', 'on']) {
    process.env.CONTENT_MODEL_USE_PROMPT_CACHE = v;
    const cm = reload(path.join(ROOT, 'scripts/lib/content-model'));
    const expect = !(v === 'false' || v === '0');
    assert(cm.useCache() === expect, `"${v}" → useCache=${cm.useCache()}`);
  }
  for (const v of ['false', '0']) {
    process.env.CONTENT_MODEL_USE_PROMPT_CACHE = v;
    const cm = reload(path.join(ROOT, 'scripts/lib/content-model'));
    assert(cm.useCache() === false, `"${v}" → useCache=false`);
  }
}

// ── 3. daily-draft.yml が必要 env を渡しているか ─────────────
console.log('\n=== Test 3: daily-draft.yml の env 受け渡し ===');
{
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/daily-draft.yml'), 'utf8');
  for (const key of ['ANTHROPIC_API_KEY', 'CONTENT_MODEL_PROVIDER', 'CONTENT_MODEL',
                     'CONTENT_MODEL_USE_PROMPT_CACHE', 'AUX_MODEL_ENABLED',
                     'AUX_MODEL_PROVIDER', 'AUX_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL']) {
    assert(yml.includes(`${key}:`), `daily-draft が ${key} を env に渡す`);
  }
}

// ── 4. regenerate-draft.yml が必要 env を渡しているか ────────
console.log('\n=== Test 4: regenerate-draft.yml の env 受け渡し ===');
{
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/regenerate-draft.yml'), 'utf8');
  for (const key of ['ANTHROPIC_API_KEY', 'CONTENT_MODEL_PROVIDER', 'CONTENT_MODEL',
                     'CONTENT_MODEL_USE_PROMPT_CACHE', 'AUX_MODEL_ENABLED',
                     'AUX_MODEL_PROVIDER', 'AUX_MODEL', 'ENABLE_PARTIAL_REVISE',
                     'OPENAI_API_KEY', 'OPENAI_MODEL']) {
    assert(yml.includes(`${key}:`), `regenerate-draft が ${key} を env に渡す`);
  }
}

// ── 5. OpenAI fallback に claude ID が渡らない（再掲の安全確認）──
console.log('\n=== Test 5: OpenAI に claude ID を渡さない ===');
{
  process.env.CONTENT_MODEL_PROVIDER = 'anthropic';
  process.env.CONTENT_MODEL = 'claude-sonnet-4-6';
  process.env.OPENAI_MODEL = 'gpt-5.4';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const cm = reload(path.join(ROOT, 'scripts/lib/content-model'));
  assert(!/claude/.test(cm.resolveModel('openai')), 'openai 解決に claude が混入しない');
}

console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
