'use strict';
/**
 * 検索サジェスト由来の記事候補（段階3改）のテスト
 *
 * 自サイトへのアクセスがほぼ無い現状では Search Console は分母にならないため、
 * 「世の中で実際に検索されている語」（Google サジェスト）から候補を起こす。
 * 取得もLLMもモック注入でテストし、実際の通信・実APIは使わない。
 *
 * 検証:
 *   1. 種語辞書が取得量の上限内（週1回・数百クエリ以内・1.5秒以上の間隔）
 *   2. 取得: 応答の整形・失敗の許容・キャッシュ書き出し
 *   3. 選別: 提案の検証（persona/税目/категория）・slug の決定性・追記マージ
 *   4. 接続: 妥当な候補だけがプール形式になり、無効化フラグが効く
 *   5. 需要の証拠: 検索語の数が点数になり、選定順に反映される
 *   6. 1日1件の上限が証拠の種類ごとに効く（質疑応答×2→1、質疑応答＋検索需要→両方可）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const U = require(path.join(ROOT, 'scripts/update-suggest-topics'));
const S = require(path.join(ROOT, 'scripts/lib/suggest-topics'));
const { enforceDemandKindDailyLimit, priorityBreakdown } = require(path.join(ROOT, 'scripts/lib/topic-selector'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-topics-'));
const SEEDS = path.join(TMP, 'seeds.json');
const RAW = path.join(TMP, 'raw.json');
const TOPICS = path.join(TMP, 'topics.json');

(async () => {
  console.log('=== 1. 種語辞書の上限 ===');
  {
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/search-suggest-seeds.json'), 'utf8'));
    assert(Array.isArray(real.seeds) && real.seeds.length > 0, '種語辞書が読める');
    assert(real.seeds.length <= 100, `1回の取得は100クエリ以内（実際 ${real.seeds.length}）`);
    assert(new Set(real.seeds.map(s => s.id)).size === real.seeds.length, '種語IDが一意');
    assert(real.seeds.every(s => s.term && s.term.length >= 3), '全種語に語がある');
    assert(U.FETCH_DELAY_MS >= 1500, `取得間隔は1.5秒以上（実際 ${U.FETCH_DELAY_MS}ms）`);
  }

  console.log('');
  console.log('=== 2. 取得 ===');
  {
    fs.writeFileSync(SEEDS, JSON.stringify({ seeds: [
      { id: 'a', persona_hint: 'general_individual_proprietor', term: '個人事業主 消費税' },
      { id: 'b', persona_hint: 'inheritance_client', term: '相続税 いくらから' },
      { id: 'c', persona_hint: 'youtuber', term: '取得に失敗する語' },
    ] }), 'utf8');
    const fetcher = async (term) => {
      if (term === '取得に失敗する語') return null;
      return [term, `${term} いくらから`, `${term} 計算`];   // 1件目は種語と同一 → 除かれる
    };
    const r = await U.fetchSuggests({ seedsFile: SEEDS, rawFile: RAW, fetcher, delayMs: 0, logger: null,
      nowFn: () => '2026-08-26T12:00:00.000Z' });
    assert(r.seedCount === 3 && r.failed === 1, '取得失敗があっても全体は続行する');
    const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
    assert(raw.fetched_at === '2026-08-26T12:00:00.000Z', '取得日時が記録される');
    const a = raw.seeds.find(s => s.id === 'a');
    assert(a.phrases.length === 2 && !a.phrases.includes('個人事業主 消費税'),
      '種語そのものと同一の候補は除かれる');
    assert(raw.seeds.find(s => s.id === 'c').failed === true, '失敗は failed として記録される');
  }

  console.log('');
  console.log('=== 3. 選別 ===');
  {
    const goodLLM = async () => JSON.stringify({ topics: [
      { seed_id: 'a', phrases: ['個人事業主 消費税 いくらから', '個人事業主 消費税 計算'],
        persona: 'general_individual_proprietor', tax_domain: 'consumption_tax', category: '消費税',
        article_type: 'basic_explainer',
        primary_question: '個人事業主は売上いくらから消費税を納めるのか？',
        reader_problem: '消費税の納税義務がいつ生じるか分からない' },
      { seed_id: 'a', phrases: ['個人事業主 消費税 経費'],
        persona: '知らないpersona', tax_domain: 'consumption_tax', category: '消費税',
        article_type: 'basic_explainer', primary_question: 'x', reader_problem: 'y' },
    ] });
    const stats = await U.selectTopics({ callLLM: goodLLM, rawFile: RAW, topicsFile: TOPICS,
      logger: null, nowFn: () => '2026-08-26T12:30:00.000Z' });
    assert(stats.proposed === 2 && stats.accepted === 1 && stats.invalid === 1,
      '不明な persona の提案は却下される');
    const saved = JSON.parse(fs.readFileSync(TOPICS, 'utf8'));
    assert(saved.topics.length === 1, '採用された候補だけが保存される');
    const slug1 = U.slugFor('a', '個人事業主 消費税 いくらから');
    assert(saved.topics[0].slug === slug1, 'slug は種語IDと検索語から決まる');
    assert(U.slugFor('a', '個人事業主 消費税 いくらから') === slug1, 'slug は決定的（再実行で変わらない）');

    // 追記マージ: 同じ提案を再実行しても重複しない
    const stats2 = await U.selectTopics({ callLLM: goodLLM, rawFile: RAW, topicsFile: TOPICS, logger: null });
    assert(stats2.duplicate === 1 && JSON.parse(fs.readFileSync(TOPICS, 'utf8')).topics.length === 1,
      '既出の候補は追記されない（slug 単位のマージ）');

    // 壊れた応答はリトライ→スキップ
    let calls = 0;
    const broken = async () => { calls++; return 'JSONではない'; };
    const stats3 = await U.selectTopics({ callLLM: broken, rawFile: RAW, topicsFile: TOPICS, logger: null });
    assert(calls === 2 && stats3.skippedBatches === 1, '壊れた応答は1回リトライしてスキップ');
  }

  console.log('');
  console.log('=== 4. 接続 ===');
  {
    const topics = S.expandSuggestTopics({ topicsFile: TOPICS, logger: null });
    assert(topics.length === 1, '保存済み候補がプール形式で接続される');
    const t = topics[0];
    assert(t.macro === '税目実務' && t.persona === 'general_individual_proprietor', 'macro が対応表から引かれる');
    assert(t.source_url === undefined, '出典は持たせない（既存の出典解決に委ねる）');
    assert(t.pain_point === t.slug && t.subcluster === t.slug, '重複検知の単位が一意');
    assert(t.demand_evidence.kind === 'search-suggest', '需要の証拠の種類が付く');
    assert(t.search_intent.includes('個人事業主 消費税 いくらから'), '実際の検索語が検索意図に入る');

    process.env.DISABLE_SUGGEST_TOPICS = 'true';
    assert(S.expandSuggestTopics({ topicsFile: TOPICS, logger: null }).length === 0, '無効化フラグが効く');
    delete process.env.DISABLE_SUGGEST_TOPICS;

    assert(S.expandSuggestTopics({ topicsFile: path.join(TMP, 'nai.json'), logger: null }).length === 0,
      'ファイルが無ければ空（初回状態で壊れない）');
  }

  console.log('');
  console.log('=== 5. 需要の証拠の点数 ===');
  {
    assert(S.scoreForPhrases(1) === 70 && S.scoreForPhrases(4) === 82 && S.scoreForPhrases(10) === 90,
      '検索語の数が点数になる（1語70点〜上限90点）');
    const now = new Date('2026-08-26T03:00:00.000Z');
    const p = priorityBreakdown({ demand_evidence: { kind: 'search-suggest', score: 82 } }, now);
    assert(Math.abs(p.demand - 0.82) < 1e-9, '点数が選定順に反映される');
    assert(p.demand * 3 > 2, '季節ブースト(2)より需要の証拠が優先される設計は保たれる');
  }

  console.log('');
  console.log('=== 6. 1日1件の上限（証拠の種類ごと）===');
  {
    const mk = (slug, kind, priority) => ({
      topic: { slug, search_intent: `${slug} テーマ`, article_type: 'basic_explainer',
        ...(kind ? { demand_evidence: { kind, score: 80 } } : {}) },
      priority, balance: 0,
    });
    const sameKind = [mk('sg-1', 'search-suggest', 3), mk('sg-2', 'search-suggest', 2), mk('plain-1', null, 1)];
    const picks1 = enforceDemandKindDailyLimit([sameKind[0].topic, sameKind[1].topic], sameKind);
    assert(picks1.length === 2 && picks1.some(t => t.slug === 'plain-1'),
      '同じ種類が2件 → 低優先度側を別種の次点へ差し替え');
    assert(picks1.some(t => t.slug === 'sg-1'), '優先度の高い方が残る');

    const mixed = [mk('sg-1', 'search-suggest', 3), mk('st-1', 'nta-shitsugi', 2)];
    const picks2 = enforceDemandKindDailyLimit([mixed[0].topic, mixed[1].topic], mixed);
    assert(picks2.length === 2, '種類が違えば両方選ばれてよい（質疑応答＋検索需要）');

    const noRepl = [mk('sg-1', 'search-suggest', 3), mk('sg-2', 'search-suggest', 2)];
    const picks3 = enforceDemandKindDailyLimit([noRepl[0].topic, noRepl[1].topic], noRepl);
    assert(picks3.length === 1 && picks3[0].slug === 'sg-1', '代替が無ければ1件に取り下げ');
  }

  console.log('');
  console.log('=== 結果 ===');
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
