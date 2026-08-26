'use strict';
/**
 * 質疑応答候補の LLM 全件選別（段階1.5）のテスト
 *
 * 手動採用（adopted）は276件で停滞し精度も出ていなかったため、LLM に全件選別させて
 * 手動採用作業を廃止する。LLM はモック注入でテストし、実 API は呼ばない。
 *
 * 検証:
 *   1. 選別結果の書き戻し形式（decision / reason / judged_at / model）
 *   2. 再開: 選別済みはスキップ、--force で再判定
 *   3. 壊れた応答 → リトライ → それでも壊れたらバッチをスキップして続行
 *   4. 接続: adopt は接続・reject は接続されない・未選別は手動採用にフォールバック
 *   5. 読者想定の補正（corrected_persona）と macro の引き直し
 *   6. 優先度: 高得点の候補が先に並ぶ。点数の無い需要の証拠は従来どおり
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const { runTriage, validateResults, SYSTEM_PROMPT } = require(path.join(ROOT, 'scripts/triage-shitsugi-topics'));
const { expandShitsugiTopics, isConnectable, MACRO_BY_PERSONA } = require(path.join(ROOT, 'scripts/lib/shitsugi-topics'));
const { priorityBreakdown } = require(path.join(ROOT, 'scripts/lib/topic-selector'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// ── テスト用のデータ一式を一時ディレクトリに用意 ──────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsugi-triage-'));
const DATA_FILE = path.join(TMP, 'candidates.json');
const SRC_ROOT = path.join(TMP, 'nta-sources');

function makeCandidate(overrides = {}) {
  const base = {
    shitsugi_url: 'https://www.nta.go.jp/law/shitsugi/shohi/19/18.htm',
    shitsugi_title: '土地付建物の仲介手数料の仕入税額控除',
    tax_category: '消費税', tax_category_code: 'shohi',
    section: '19', id: '18', file_path: 'shitsugi/shohi/19/18.json',
    score: 91, score_breakdown: { search_need: 20, judgment_ambiguity: 6 },
    proposed: { persona: 'domestic_ec_seller', macro: '物販', article_type: 'case_study' },
    adopted: false, target_segments: ['ec_seller'], article_potential: 'high',
  };
  return { ...base, ...overrides };
}

function writeData(candidates) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 1, candidates }, null, 2) + '\n', 'utf8');
}

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeSourceBody(candidate, shokai) {
  const file = path.join(SRC_ROOT, candidate.file_path.replace(/\//g, path.sep));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    title: candidate.shitsugi_title,
    shokai_yoshi: shokai,
    kaitou_yoshi: '回答の要旨です。',
    body_combined: `${shokai} 回答の要旨です。`,
  }), 'utf8');
}

const okLLM = (decision, extra = {}) => async (system, user) => {
  const count = (user.match(/## 候補 /g) || []).length;
  return JSON.stringify({
    results: Array.from({ length: count }, (_, i) => ({
      item: i + 1, decision, reason: 'テスト判定', ...extra,
    })),
  });
};

(async () => {
  console.log('=== 1. 書き戻し形式 ===');
  {
    const c = makeCandidate();
    writeSourceBody(c, '土地と建物を一括して譲渡しました。仲介手数料の仕入税額控除はどうなりますか。');
    writeData([c]);
    const stats = await runTriage({
      callLLM: okLLM('adopt'), candidateFile: DATA_FILE, sourceRoot: SRC_ROOT,
      logger: null, model: 'test-model', nowFn: () => '2026-08-26T10:00:00.000Z',
    });
    const saved = readData().candidates[0].llm_triage;
    assert(stats.judged === 1 && stats.adopt === 1, '1件が adopt と判定される');
    assert(saved.decision === 'adopt', 'decision が書き戻される');
    assert(saved.reason === 'テスト判定', 'reason が書き戻される');
    assert(saved.judged_at === '2026-08-26T10:00:00.000Z', 'judged_at が書き戻される');
    assert(saved.model === 'test-model', 'model が書き戻される');
    assert(saved.corrected_persona === undefined, '補正が無ければ corrected_persona は付かない');
  }

  console.log('');
  console.log('=== 2. 再開と --force ===');
  {
    let calls = 0;
    const countingLLM = async (s, u) => { calls++; return okLLM('reject')(s, u); };
    const statsResume = await runTriage({
      callLLM: countingLLM, candidateFile: DATA_FILE, sourceRoot: SRC_ROOT, logger: null,
    });
    assert(statsResume.targeted === 0 && calls === 0, '選別済みはスキップ（LLM を呼ばない）');
    const statsForce = await runTriage({
      callLLM: countingLLM, candidateFile: DATA_FILE, sourceRoot: SRC_ROOT, logger: null, force: true,
    });
    assert(statsForce.judged === 1 && calls === 1, '--force で判定し直す');
    assert(readData().candidates[0].llm_triage.decision === 'reject', '再判定の結果で上書きされる');
  }

  console.log('');
  console.log('=== 3. 壊れた応答の扱い ===');
  {
    const cs = [makeCandidate({ id: '1', file_path: 'shitsugi/shohi/19/1.json' }),
                makeCandidate({ id: '2', file_path: 'shitsugi/shohi/19/2.json' })];
    cs.forEach(c => writeSourceBody(c, '照会要旨です。'));
    writeData(cs);
    let attempts = 0;
    const brokenLLM = async () => { attempts++; return 'これはJSONではありません'; };
    const stats = await runTriage({
      callLLM: brokenLLM, candidateFile: DATA_FILE, sourceRoot: SRC_ROOT, logger: null, batchSize: 2,
    });
    assert(attempts === 2, '形式不正は1回だけリトライする');
    assert(stats.skippedBatches === 1 && stats.judged === 0, 'それでも壊れたらバッチをスキップして続行');
    assert(readData().candidates.every(c => !c.llm_triage), 'スキップした候補には何も書き込まない');

    // 途中のバッチが壊れても後続バッチは処理される
    let n = 0;
    const flakyLLM = async (s, u) => { n++; return n <= 2 ? '壊れた応答' : okLLM('adopt')(s, u); };
    const stats2 = await runTriage({
      callLLM: flakyLLM, candidateFile: DATA_FILE, sourceRoot: SRC_ROOT, logger: null, batchSize: 1,
    });
    assert(stats2.skippedBatches === 1 && stats2.judged === 1, '壊れたバッチの後も続行して残りを判定する');

    // 番号が欠けた応答も形式不正として扱う
    assert(validateResults({ results: [{ item: 1, decision: 'adopt', reason: 'x' }] }, 2) === null,
      '全件そろわない応答は形式不正として扱う');
    assert(validateResults({ results: [{ item: 1, decision: '不明', reason: 'x' }] }, 1) === null,
      'adopt/reject 以外の判定は受け付けない');
  }

  console.log('');
  console.log('=== 4. 接続の切り替え ===');
  {
    assert(isConnectable({ llm_triage: { decision: 'adopt' } }) === true, '選別 adopt は接続される');
    assert(isConnectable({ llm_triage: { decision: 'reject' }, adopted: true }) === false,
      '選別 reject は手動採用済みでも接続されない');
    assert(isConnectable({ adopted: true }) === true, '未選別は手動採用にフォールバック');
    assert(isConnectable({ adopted: false }) === false, '未選別・未採用は接続されない');

    const cs = [
      makeCandidate({ id: '10', file_path: 'shitsugi/shohi/19/10.json', adopted: false,
        llm_triage: { decision: 'adopt', reason: 'x', judged_at: 'x', model: 'x' } }),
      makeCandidate({ id: '11', file_path: 'shitsugi/shohi/19/11.json', adopted: true,
        llm_triage: { decision: 'reject', reason: 'x', judged_at: 'x', model: 'x' } }),
      makeCandidate({ id: '12', file_path: 'shitsugi/shohi/19/12.json', adopted: true }),
    ];
    cs.forEach(c => writeSourceBody(c, '照会要旨です。'));
    writeData(cs);
    const topics = expandShitsugiTopics({
      candidateFile: DATA_FILE, sourceRoot: SRC_ROOT, logger: null, filterRelevance: false,
    });
    const slugs = topics.map(t => t.slug).sort().join(',');
    assert(slugs === 'shitsugi-shohi-19-10,shitsugi-shohi-19-12',
      `adopt と未選別採用だけが接続される（実際: ${slugs}）`);
  }

  console.log('');
  console.log('=== 5. 読者想定の補正 ===');
  {
    const cs = [
      makeCandidate({ id: '20', file_path: 'shitsugi/shohi/19/20.json', adopted: false,
        proposed: { persona: 'influencer_creator', macro: 'インフルエンサー', article_type: 'case_study' },
        llm_triage: { decision: 'adopt', reason: 'x', corrected_persona: 'general_corporation',
          judged_at: 'x', model: 'x' } }),
      makeCandidate({ id: '21', file_path: 'shitsugi/shohi/19/21.json', adopted: false,
        llm_triage: { decision: 'adopt', reason: 'x', corrected_persona: '存在しないpersona',
          judged_at: 'x', model: 'x' } }),
    ];
    cs.forEach(c => writeSourceBody(c, '照会要旨です。'));
    writeData(cs);
    const topics = expandShitsugiTopics({
      candidateFile: DATA_FILE, sourceRoot: SRC_ROOT, logger: null, filterRelevance: false,
    });
    const fixed = topics.find(t => t.slug === 'shitsugi-shohi-19-20');
    assert(fixed && fixed.persona === 'general_corporation', '補正された読者想定に置き換わる');
    assert(fixed && fixed.macro === MACRO_BY_PERSONA.general_corporation, 'macro も対応表で引き直される');
    assert(!topics.some(t => t.slug === 'shitsugi-shohi-19-21'),
      '対応表に無い補正はその候補をスキップする');

    // 選別スクリプト側でも、対応表に無い persona 補正は受け付けない
    const v = validateResults({ results: [{ item: 1, decision: 'adopt', reason: 'x',
      corrected_persona: 'そんなpersonaは無い' }] }, 1);
    assert(v && v.get(1).corrected_persona === undefined, '選別段階でも不正な補正は落とす');
    assert(SYSTEM_PROMPT.includes('general_corporation'), '使える persona ID が判定基準に明記されている');
  }

  console.log('');
  console.log('=== 6. 優先度の点数連動 ===');
  {
    const now = new Date('2026-08-26T03:00:00.000Z');
    const p91 = priorityBreakdown({ demand_evidence: { kind: 'nta-shitsugi', score: 91 } }, now);
    const p72 = priorityBreakdown({ demand_evidence: { kind: 'nta-shitsugi', score: 72 } }, now);
    const pNoScore = priorityBreakdown({ demand_evidence: { kind: 'future-source' } }, now);
    const pNone = priorityBreakdown({}, now);
    assert(p91.priority > p72.priority, `高得点が先に並ぶ（91点 ${p91.priority.toFixed(2)} > 72点 ${p72.priority.toFixed(2)}）`);
    assert(Math.abs(p91.demand - 0.91) < 1e-9, '91点 → 需要の証拠 0.91');
    assert(pNoScore.demand === 1, '点数の無い需要の証拠は従来どおり 1');
    assert(pNone.demand === 0, '証拠なしは 0');
    assert(p72.demand * 3 > 2, '最低点(70点台)でも季節ブースト(2)は上回る');
  }

  console.log('');
  console.log('=== 結果 ===');
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
