'use strict';

/**
 * LLM 出典選定（llm-source-selector）のテスト。
 *   node scripts/lib/__tests__/test-llm-source-selector.js
 *
 * LLM 呼び出しはフェイク関数を注入して検証する（実APIは呼ばない）。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const sel = require(path.join(ROOT, 'scripts/lib/llm-source-selector'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// 候補リスト内の [No.XXXX] 行番号を返すフェイク（confidence 指定）。無ければ null。
function fakePickByNo(targetNo, confidence = 0.9) {
  return async (_system, user) => {
    const re = new RegExp(`(\\d+)\\.\\s*\\[No\\.${targetNo}\\]`);
    const m = user.match(re);
    if (!m) return JSON.stringify({ choice: null, confidence: 0, reason: '該当なし' });
    return JSON.stringify({ choice: Number(m[1]), confidence, reason: `No.${targetNo} が適合` });
  };
}

(async () => {
  // ── 1. pickFromCandidates: 正常選択 ─────────────────────────
  console.log('\n=== Test 1: 候補から正常に選ぶ ===');
  {
    const cands = [
      { no: '1000', title: 'A', url: 'https://x/1000.htm' },
      { no: '2000', title: 'B', url: 'https://x/2000.htm' },
    ];
    const llm = async () => JSON.stringify({ choice: 2, confidence: 0.8, reason: 'B が適合' });
    const r = await sel.pickFromCandidates({}, cands, llm);
    assert(r && r.no === '2000' && r.url === 'https://x/2000.htm', '2番目の候補を選ぶ');
    assert(r && r.confidence === 0.8, 'confidence を反映');
  }

  // ── 2. 幻覚棄却: 候補範囲外の番号は null ─────────────────────
  console.log('\n=== Test 2: 範囲外番号を棄却（幻覚防止）===');
  {
    const cands = [{ no: '1', title: 'A', url: 'u1' }, { no: '2', title: 'B', url: 'u2' }];
    const outOfRange = async () => JSON.stringify({ choice: 9, confidence: 0.99, reason: '創作' });
    assert((await sel.pickFromCandidates({}, cands, outOfRange)) === null, '候補外(9)は不採用');

    const zero = async () => JSON.stringify({ choice: 0, confidence: 0.9, reason: '' });
    assert((await sel.pickFromCandidates({}, cands, zero)) === null, '0番は不採用');

    const nullChoice = async () => JSON.stringify({ choice: null, confidence: 0, reason: '該当なし' });
    assert((await sel.pickFromCandidates({}, cands, nullChoice)) === null, 'choice=null は不採用');

    const garbage = async () => 'これはJSONではありません';
    assert((await sel.pickFromCandidates({}, cands, garbage)) === null, '非JSON出力は不採用');

    const over = async () => JSON.stringify({ choice: 1, confidence: 5, reason: '' });
    const ro = await sel.pickFromCandidates({}, cands, over);
    assert(ro && ro.confidence === 1, 'confidence>1 は 1 にクランプ');
  }

  // ── 3. A→C エスカレーション（実カタログ）─────────────────────
  // #346: special-depreciation / bookkeeping_expenses。
  // A(税目カテゴリ=shotoku)には No.5433(hojin)が無い→C(全カテゴリ横断)で拾えるはず。
  console.log('\n=== Test 3: A で不発→C で No.5433 を選ぶ（実カタログ）===');
  const topic = {
    slug: 'special-depreciation-guide', tax_domain: 'bookkeeping_expenses',
    pain_point: 'special-depreciation', title: '中小企業向け特別償却制度',
    search_intent: '特別償却の対象資産と適用要件',
  };
  const res = await sel.resolveSourceWithLLM(topic, { callLLM: fakePickByNo('5433', 0.9) });
  assert(res && res.no === '5433', 'C 経由で No.5433 を選定');
  assert(res && res.provenance === 'llm-auto', "provenance が 'llm-auto'");
  assert(res && res.tier === 'C', 'tier=C（横断検索で発見）');
  assert(res && /nta\.go\.jp/.test(res.url), 'URL はカタログ由来（実在）');

  // ── 4. 低 confidence は不採用（minConfidence 未満）──────────
  console.log('\n=== Test 4: confidence が閾値未満なら不採用 ===');
  const low = await sel.resolveSourceWithLLM(topic, { callLLM: fakePickByNo('5433', 0.3), minConfidence: 0.5 });
  assert(low === null, 'confidence 0.3 < 0.5 は不採用（domain-fallback 維持）');

  // ── 5. どの候補にも該当がなければ null ─────────────────────
  console.log('\n=== Test 5: 適合候補が無ければ null ===');
  const none = await sel.resolveSourceWithLLM(topic, { callLLM: fakePickByNo('9999999', 0.9) });
  assert(none === null, '存在しない No 指定（＝該当なし）は null');

  console.log(`\n=== 結果 ===\nPASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
