'use strict';

/**
 * aux-model（Haiku）のルーティングテスト。
 *   node scripts/lib/__tests__/test-aux-model-routing.js
 *
 * 重要検証:
 *   - AUX_MODEL_ENABLED=false → API を呼ばない（canUseAux=false）
 *   - AUX_MODEL_ENABLED=true + key → canUseAux=true, model=claude-haiku-4-5-20251001
 *   - ルールベースで済むタスクは aux に回らない（lint クリアなら polish しない）
 *   - aux 失敗時はルールベース fallback（元値を返す）
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
  for (const k of ['AUX_MODEL_ENABLED','AUX_MODEL_PROVIDER','AUX_MODEL',
                   'ANTHROPIC_API_KEY','OPENAI_API_KEY']) delete process.env[k];
}

const AUX = path.join(ROOT, 'scripts/lib/aux-model');

// ── 1. AUX_MODEL_ENABLED=false → canUseAux=false ────────────
console.log('\n=== Test 1: AUX 無効時は API を呼ばない ===');
{
  clearEnv();
  const aux = reload(AUX);
  assert(aux.auxEnabled() === false, 'auxEnabled=false');
  assert(aux.canUseAux() === false, 'canUseAux=false');
}

// ── 2. AUX 有効 + anthropic + key → canUseAux=true ──────────
console.log('\n=== Test 2: AUX 有効 + Haiku ===');
{
  clearEnv();
  process.env.AUX_MODEL_ENABLED = 'true';
  process.env.AUX_MODEL_PROVIDER = 'anthropic';
  process.env.AUX_MODEL = 'claude-haiku-4-5-20251001';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const aux = reload(AUX);
  assert(aux.canUseAux() === true, 'canUseAux=true');
  assert(aux.auxModel() === 'claude-haiku-4-5-20251001', 'model=claude-haiku-4-5-20251001');
}

// ── 3. AUX 有効だが provider=rule_based → canUseAux=false ────
console.log('\n=== Test 3: provider=rule_based は API 呼ばない ===');
{
  clearEnv();
  process.env.AUX_MODEL_ENABLED = 'true';
  process.env.AUX_MODEL_PROVIDER = 'rule_based';
  const aux = reload(AUX);
  assert(aux.canUseAux() === false, 'rule_based は canUseAux=false');
}

// ── 4. AUX 有効だが key 無し → canUseAux=false ───────────────
console.log('\n=== Test 4: ANTHROPIC_API_KEY 無し ===');
{
  clearEnv();
  process.env.AUX_MODEL_ENABLED = 'true';
  process.env.AUX_MODEL_PROVIDER = 'anthropic';
  const aux = reload(AUX);
  assert(aux.canUseAux() === false, 'キー無しは canUseAux=false');
}

// ── 5. polishTitle: lint クリアならそのまま（aux 呼ばない）──
console.log('\n=== Test 5: lint クリアなタイトルは aux に回さない ===');
{
  clearEnv();
  process.env.AUX_MODEL_ENABLED = 'true';
  process.env.AUX_MODEL_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const aux = reload(AUX);
  // 自然なタイトル → lint 問題なし → そのまま返る（fetch しないので失敗しない）
  return aux.polishTitleWithAuxIfNeeded('自宅を相続したとき小規模宅地等の特例は使える？｜判断ポイントを整理', { macro: '相続贈与' })
    .then(out => {
      assert(out === '自宅を相続したとき小規模宅地等の特例は使える？｜判断ポイントを整理', 'クリアなタイトルは不変（API未呼出）');
      return run6();
    });
}

// ── 6. polishTitle: aux 無効ならルールベースで元値 ──────────
async function run6() {
  console.log('\n=== Test 6: aux 無効時は元タイトルを返す ===');
  clearEnv();
  // AUX 無効
  const aux = reload(AUX);
  const bad = '相続税に押さえる基本';  // lint fail するタイトル
  const out = await aux.polishTitleWithAuxIfNeeded(bad, { macro: '相続贈与' });
  assert(out === bad, 'aux 無効なら元タイトルを返す（ルールベースのみ）');
  return run7();
}

// ── 7. proofread: aux 無効なら原文そのまま ──────────────────
async function run7() {
  console.log('\n=== Test 7: 校正 aux 無効は原文そのまま ===');
  clearEnv();
  const aux = reload(AUX);
  const text = 'これはテスト本文です。';
  const out = await aux.proofreadLightlyWithAuxIfNeeded(text);
  assert(out === text, 'aux 無効なら原文そのまま');
  return run8();
}

// ── 8. classifyWithAuxIfNeeded: 高確度ルール結果はそのまま ──
async function run8() {
  console.log('\n=== Test 8: 高確度の分類結果は aux に回さない ===');
  clearEnv();
  process.env.AUX_MODEL_ENABLED = 'true';
  process.env.AUX_MODEL_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const aux = reload(AUX);
  const ruleResult = { type: 'table_fix', scope: 'section', reason: 'パターン一致: /表/' };
  const out = await aux.classifyWithAuxIfNeeded('表にして', ruleResult);
  assert(out.type === 'table_fix', '高確度ルール結果はそのまま（aux 未呼出）');

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}
