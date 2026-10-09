'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadWithdrawnTopics, appendWithdrawnTopics, findWithdrawnTopic, findWithdrawnQuery, createWithdrawalRecorder } = require('../withdrawn-topics');
const { selectDailyTopics } = require('../topic-selector');
const { TOPICS } = require('../../topic-pool');
const { runSingleDraft, pickPair, prepareQueries, generateTopics, resolvePositiveLimit } = require('../../generate-draft');
const { recordWithdrawnFile } = require('../../record-withdrawn-topics');
const ROOT = path.join(__dirname, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'withdrawn-topics-'));
let passed = 0, failed = 0;
const groups = {};
function assert(ok, label, group = 'R1') {
  console.log(`  ${ok ? '✓' : '✗'} ${group}: ${label}`);
  ok ? passed++ : failed++;
  groups[group] ||= { PASS: 0, FAIL: 0 };
  groups[group][ok ? 'PASS' : 'FAIL']++;
}
const read = file => fs.readFileSync(file, 'utf8');
const now = new Date('2026-10-09T16:00:00Z'); // JST 10/10 01:00
const entry = { topic_id: 'a', stage: 'select-dedup', date: '2026-10-09', reason: '既存の記録' };
const dataFile = path.join(tmp, 'data.json');
const out = path.join(tmp, 'new.json');
const writeData = entries => fs.writeFileSync(dataFile, JSON.stringify({ version: 1, comment: '既存コメント', entries }, null, 2) + '\n');
const cloneData = data => JSON.parse(JSON.stringify(data));
// 初期記録は手で消してよい（README「元に戻す方法」）。残っている初期記録の中身だけを表と比べる。
function matchesInitialEntries(data, expected) {
  const fields = ['similar_to', 'url_slug', 'target_query', 'reason', 'run_url'];
  const keyOf = item => [item.topic_id, item.stage, item.date].join('\u0000');
  const byKey = new Map(data.entries.map(item => [keyOf(item), item]));
  return expected.every(entry => {
    const found = byKey.get(keyOf(entry));
    return !found || fields.every(field => found[field] === entry[field]);
  });
}
function throws(fn) {
  try { fn(); return false; } catch (_) { return true; }
}

// テスト中の LLM とファイル出力は、偽の関数と一時ディレクトリに限定する。
function fixture(config = {}) {
  const recorder = createWithdrawalRecorder({ file: dataFile, withdrawn: config.withdrawn || [], env: { WITHDRAWN_OUT: out }, now });
  const topics = (config.slugs || ['a', 'b', 'c', 'd', 'e', 'f']).map(slug => ({ slug, persona: 'general_individual_proprietor', category: '所得税', article_type: 'basic_explainer', demand_evidence: { kind: 'suggest' } }));
  const calls = { ai: [], query: [], body: [], source: [], self: [], post: [] };
  const options = {
    topics, recorder, env: config.env || {}, pendingDrafts: [], corpus: [], now,
    context: { queryInputs: {}, targetQueryCorpus: config.corpus || [], takenUrlSlugs: new Set(config.taken || []) },
    postsDir: path.join(tmp, `posts-${Math.random().toString(36).slice(2)}`),
    select(pool, selectionOptions) {
      const available = pool.filter(topic => !findWithdrawnTopic(topic, selectionOptions.withdrawn));
      return { picks: available.slice(0, selectionOptions.count), explanation: { steps: [], warnings: config.selectionWarnings || [] } };
    },
    async checkAI(picks) {
      calls.ai.push(...picks.map(topic => topic.slug));
      return { results: picks.map(topic => ({ slug: topic.slug, duplicate: (config.selectDuplicates || []).includes(topic.slug), similar_to: '既存選定記事', reason: config.reason || '選定時の重複理由' })) };
    },
    ensureSource(topic) { calls.source.push(topic.slug); topic.source_provenance = 'curated'; },
    async enrichTaxTerms() { throw new Error('curated 出典に論点語の LLM は呼ばない'); },
    async enrichSource() {},
    async resolveQuery(topic) { calls.query.push(topic.slug); return { target_query: config.queries?.[topic.slug] || `検索語 ${topic.slug}`, slug_words: config.urls?.[topic.slug] || `url-${topic.slug}`, secondary_queries: [], evidence: {} }; },
    async generateArticle(date, topic, paired) {
      calls.body.push({ slug: topic.slug, paired: paired?.slug || '' });
      return { content: `---\nslug: ${topic.url_slug}\n---\n偽の本文`, model: 'fake' };
    },
    selfCheck(content, type, slug) { calls.self.push(slug); },
    async checkGenerated(content, topic) { calls.post.push(topic.slug); return { duplicate: (config.postDuplicates || []).includes(topic.slug), similar_to: '既存生成記事', reason: '生成後の重複理由' }; },
  };
  return { recorder, calls, options };
}

async function quiet(fn) {
  const log = console.log, warn = console.warn;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  try { return { result: await fn(), logs }; }
  finally { console.log = log; console.warn = warn; }
}

async function main() {
  assert(loadWithdrawnTopics(path.join(tmp, 'missing')).entries.length === 0, 'ファイルが無ければ空');
  fs.writeFileSync(dataFile, '{壊れた JSON');
  const warnings = [];
  assert(loadWithdrawnTopics(dataFile, text => warnings.push(text)).entries.length === 0 && warnings.length === 1, '壊れた JSON は警告して空');
  const actions = process.env.GITHUB_ACTIONS;
  try {
    process.env.GITHUB_ACTIONS = 'true';
    for (const [label, source] of [['壊れた JSON', '{壊れた JSON'], ['entries が配列でない JSON', '{"version":1,"entries":{}}']]) {
      fs.writeFileSync(dataFile, source);
      assert(throws(() => appendWithdrawnTopics([entry], dataFile)) && read(dataFile) === source, label + ' への追記は例外で原文を保持', 'F2');
      fs.writeFileSync(out, JSON.stringify([entry]));
      assert(throws(() => recordWithdrawnFile(out, dataFile)) && read(dataFile) === source, label + ' は追記スクリプトでも原文を保持', 'F2');
      const localBroken = (await quiet(() => createWithdrawalRecorder({ file: dataFile, env: {}, now }))).result;
      assert(throws(() => localBroken.record({ slug: 'new' }, 'select-dedup')) && read(dataFile) === source, label + ' は手元実行でも原文を保持', 'F2');
      const messages = [];
      const fallback = loadWithdrawnTopics(dataFile, text => messages.push(text));
      const selection = selectDailyTopics(TOPICS, { now: new Date('2026-10-09T00:05:00Z'), count: 1, withdrawn: fallback });
      assert(fallback.entries.length === 0 && selection.picks.length === 1
        && messages.join() === '::warning::取り下げ記録が読めないため、記録による除外をせずに選定します', label + ' は Actions の警告付きで空として選定を続行', 'F2');
    }
  } finally {
    if (actions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = actions;
  }
  const unreadable = path.join(tmp, 'unreadable');
  fs.mkdirSync(unreadable);
  assert(throws(() => appendWithdrawnTopics([entry], unreadable)) && fs.statSync(unreadable).isDirectory(), '読み込めないパスへの追記は例外で書かない', 'F2');
  const newFile = path.join(tmp, 'missing', 'data.json');
  appendWithdrawnTopics([entry], newFile);
  assert(loadWithdrawnTopics(newFile).entries[0].topic_id === 'a', '記録ファイルが無ければ新規作成', 'F2');
  writeData([entry]);
  appendWithdrawnTopics([entry, { ...entry, topic_id: 'b' }, { ...entry, topic_id: 'b' }], dataFile);
  const added = loadWithdrawnTopics(dataFile);
  assert(added.entries.length === 2 && JSON.stringify(added.entries[0]) === JSON.stringify(entry) && added.comment === '既存コメント', '既存の中身と順番を保持し重複は追加しない');
  assert(read(dataFile).endsWith('\n') && !read(dataFile).includes('\r') && read(dataFile).includes('\n  "version"'), '2 スペースと LF・末尾改行');
  const before = read(dataFile);
  fs.writeFileSync(out, '[{"topic_id":"以前の実行"}]');
  const recorder = createWithdrawalRecorder({ file: dataFile, env: { WITHDRAWN_OUT: out, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '123' }, now });
  assert(read(out) === '[]\n' && read(dataFile) === before, '実行開始時に以前の出力を空にし今回の記録だけを残す');
  recorder.record({ slug: 'new', target_query: 'SEO　税金' }, 'postgen-dedup', { reason: '長'.repeat(220), similar_to: '既存' });
  recorder.record({ slug: 'new' }, 'postgen-dedup', { reason: '別の理由' });
  const current = JSON.parse(read(out));
  assert(read(dataFile) === before && current.length === 1 && current[0].topic_id === 'new', 'WITHDRAWN_OUT は今回の項目だけ、data は不変');
  assert(current[0].date === '2026-10-10' && current[0].run_url === 'https://github.com/owner/repo/actions/runs/123', 'JST 日付と run URL');
  assert(current[0].reason.length === 200 && current[0].url_slug === '', '理由は 200 文字、不明な情報は空文字');
  assert(findWithdrawnTopic({ slug: 'new' }, recorder.entries) && !findWithdrawnTopic({ slug: 'new-url' }, recorder.entries), '候補の topic.slug で完全一致');
  assert(findWithdrawnQuery('  seo 税金 ', recorder.entries) && !findWithdrawnQuery('SEO 税金 追加', recorder.entries) && !findWithdrawnQuery('', recorder.entries), '検索語の全角空白と大小をそろえ完全一致、空語は除外しない');
  const forced = createWithdrawalRecorder({ file: dataFile, force: true, env: { WITHDRAWN_OUT: path.join(tmp, 'forced.json') }, now });
  forced.record({ slug: 'forced' }, 'select-dedup');
  assert(forced.additions.length === 0 && !fs.existsSync(path.join(tmp, 'forced.json')) && read(dataFile) === before, '手動指定では記録しない');
  const local = createWithdrawalRecorder({ file: dataFile, env: {}, now });
  local.record({ slug: 'local' }, 'url-slug-taken');
  assert(loadWithdrawnTopics(dataFile).entries.at(-1).topic_id === 'local', 'WITHDRAWN_OUT 無しなら data に直接追記');
  recordWithdrawnFile(out, dataFile);
  recordWithdrawnFile(out, dataFile);
  assert(loadWithdrawnTopics(dataFile).entries.filter(item => item.topic_id === 'new').length === 1, 'main への追記スクリプトも同じ重複排除を使う', 'R5');

  const selectionNow = new Date('2026-10-09T00:05:00Z');
  const empty = selectDailyTopics(TOPICS, { now: selectionNow, count: 1, withdrawn: [] });
  const emptyAgain = selectDailyTopics(TOPICS, { now: selectionNow, count: 1, withdrawn: { entries: [] } });
  assert(JSON.stringify(empty.picks) === JSON.stringify(emptyAgain.picks), '空の取り下げ記録なら同じ選定結果', 'R2');
  const blocked = empty.picks[0];
  assert(!!blocked, '空記録の実プールに候補がある', 'R2');
  if (blocked) {
    const filtered = selectDailyTopics(TOPICS, { now: selectionNow, count: 1, withdrawn: [{ topic_id: blocked.slug, stage: 'select-dedup', date: '2026-10-09' }] });
    const step = filtered.explanation.steps.find(item => item.step === 'filter-withdrawn');
    const index = filtered.explanation.steps.indexOf(step);
    assert(step.blocked === 1 && step.blockedDetails[0].slug === blocked.slug && step.blockedDetails[0].stage === 'select-dedup' && step.blockedDetails[0].date === '2026-10-09' && !filtered.picks.some(topic => topic.slug === blocked.slug), 'topic_id を外し件数・詳細を記録', 'R2');
    assert(filtered.explanation.steps[index - 1].step === 'filter-denylist', '追加位置は denylist の直後', 'R2');
  }

  let f = fixture({ selectDuplicates: ['a'], postDuplicates: ['b'] });
  const retry = await quiet(() => runSingleDraft('2026-10-09', f.options));
  assert(retry.result.results.length === 1 && retry.result.results[0].slug === 'url-c' && retry.result.candidates === 3, '選定重複 → 生成後重複 → 3 件目で下書き', 'R3');
  assert(f.recorder.additions.map(item => item.stage).join() === 'select-dedup,postgen-dedup' && f.calls.body.length === 2, '取り下げ 2 件・本文生成 2 回', 'R3');
  assert(!fs.existsSync(path.join(f.options.postsDir, '2026-10-09-url-b.md')) && fs.existsSync(path.join(f.options.postsDir, '2026-10-09-url-c.md')), '重複ファイルを削除し確定した 1 本だけを残す', 'R3');
  assert(f.calls.self.length === 2 && f.calls.post.length === 2 && f.calls.source.join() === 'b,c', '選定通過後に出典補完・自己点検・生成後判定', 'R3');
  assert(retry.logs.filter(line => line.includes('[generate] 試行 ')).length === 3 && retry.logs.some(line => line.includes('=== topic selection ===')), '候補ごとのログと既存選定ログを残す', 'R3');
  f = fixture({ postDuplicates: ['a', 'b', 'c'] });
  const cap = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(cap.results.length === 0 && cap.generations === 2 && f.calls.body.length === 2 && f.calls.ai.length === 3 && cap.reason.includes('本文生成の上限 2 回'), '本文生成 2 回で停止し 3 件目は本文を作らない', 'R3');
  assert(cap.attempts.length === 3 && !/[\r\n]/.test(cap.reason) && [...cap.reason].length <= 600, '0 本の理由に各候補の結果・改行無し・600 文字以内', 'R3');
  assert(cap.reason === cap.attempts.join(' / ') + ' / 本文生成の上限 2 回に達したため本日は生成しません', '試行がある場合の理由の文面を保つ', 'F4');
  f = fixture({ selectDuplicates: ['a', 'b', 'c', 'd', 'e', 'f'] });
  const candidates = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(candidates.results.length === 0 && f.calls.ai.length === 5 && f.calls.body.length === 0 && candidates.attempts.length === 5 && candidates.reason.includes('確認上限 5 件'), '候補 5 件で停止し全 5 件の理由を残す', 'R3');
  f = fixture({ queries: { a: ' SEO　税金 ' }, withdrawn: [{ topic_id: 'old', stage: 'postgen-dedup', date: '2026-10-01', target_query: 'seo 税金' }] });
  const withdrawnQuery = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(withdrawnQuery.results[0].slug === 'url-b' && f.calls.body.map(item => item.slug).join() === 'b' && f.recorder.additions[0].stage === 'target-query-withdrawn', '取り下げ済み検索語は本文を作らず次へ', 'R3');
  f = fixture();
  const success = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(success.candidates === 1 && success.generations === 1 && success.results.length === 1 && f.recorder.additions.length === 0, '1 件目で確定すれば試行 1 件・記録 0 件', 'R3');
  f = fixture({ slugs: [] });
  const exhausted = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(exhausted.results.length === 0 && f.calls.ai.length === 0 && exhausted.reason.includes('候補が尽きた'), '候補枯渇は代替生成せず終了', 'R3');
  assert(exhausted.reason === '候補が尽きたため本日は生成しません', '試行 0 件・警告無しの理由は区切りで始めない', 'F4');
  f = fixture({ slugs: [], selectionWarnings: ['関連性ゲートで全候補を除外\n対象を確認してください'] });
  const gated = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(gated.candidates === 0 && !gated.reason.startsWith('/') && gated.reason.includes('関連性ゲートで全候補を除外 対象を確認してください') && !/[\r\n]/.test(gated.reason), '初回選定 0 件の理由に選定側の警告を含める', 'F4');
  f = fixture({ slugs: [], selectionWarnings: ['警'.repeat(650)] });
  const longWarning = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert([...longWarning.reason].length === 600 && !longWarning.reason.startsWith('/'), '選定警告を含めても理由は 600 文字以内', 'F4');
  f = fixture({ slugs: ['a'], selectDuplicates: ['a'] });
  const selectOnce = f.options.select;
  f.options.select = (pool, options) => {
    const selected = selectOnce(pool, options);
    selected.explanation.warnings = [pool.length ? '前の選定警告' : '最後の選定警告'];
    return selected;
  };
  const lastWarning = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(lastWarning.candidates === 1 && lastWarning.reason.includes('最後の選定警告') && !lastWarning.reason.includes('前の選定警告'), '最後に呼んだ選定の警告だけを理由に残す', 'F4');
  f = fixture({ taken: ['url-a', 'a'] });
  const collision = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(collision.results[0].slug === 'url-b' && f.recorder.additions[0].stage === 'url-slug-taken' && f.calls.body.length === 1, 'URL slug 衝突は記録して次へ', 'R3');
  f = fixture({ queries: { a: '所有検索語' }, corpus: [{ slug: 'owner', target_query: '所有検索語' }] });
  const owned = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(owned.results[0].slug === 'url-b' && f.recorder.additions[0].stage === 'target-query-owned' && f.recorder.additions[0].similar_to === 'owner', '検索語の持ち主ありは記録して次へ', 'R3');
  f = fixture({ taken: ['url-a'] });
  const fallback = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(fallback.results[0].slug === 'a' && f.recorder.additions.length === 0, 'URL 衝突時の topic.slug への既存フォールバックを保つ', 'R3');
  f = fixture({ env: { DRAFT_MAX_CANDIDATES: '1', DRAFT_MAX_GENERATIONS: '1' }, selectDuplicates: ['a'] });
  const limited = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(limited.candidates === 1 && f.calls.ai.length === 1, '候補上限の環境変数が効く', 'R3');
  f = fixture({ env: { DRAFT_MAX_GENERATIONS: '1' }, postDuplicates: ['a'] });
  const oneBody = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(oneBody.results.length === 0 && f.calls.body.length === 1, '本文上限の環境変数が効く', 'R3');
  for (const value of [undefined, '', '0', '-1', 'abc', '1.5', 'Infinity', '9007199254740992']) {
    assert(resolvePositiveLimit(value, 5) === 5 && resolvePositiveLimit(value, 2) === 2, `不正な上限 ${String(value)} は既定値`, 'R3');
  }

  f = fixture({ slugs: ['a', 'b', 'c', 'd', 'e'], selectDuplicates: ['a', 'b', 'c', 'd', 'e'] });
  const pair = (await quiet(() => pickPair('2026-10-09', 2, f.options))).result;
  assert(pair.length === 0 && f.calls.ai.join() === 'a,b,c,d' && f.recorder.additions.length === 4, '2 本モードは初回と従来の補充 1 回だけ、両方の除外を記録', 'R3');
  f = fixture({ slugs: ['a', 'b'] });
  const two = await quiet(async () => {
    const picks = await pickPair('2026-10-09', 2, f.options);
    const ready = await prepareQueries(picks, f.options);
    return generateTopics(ready, '2026-10-09', f.options);
  });
  assert(two.result.length === 2 && f.calls.body[0].paired === 'b' && f.calls.body[1].paired === 'a', '2 本モードのペア相手を保つ', 'R3');
  f = fixture({ slugs: ['a', 'b'], postDuplicates: ['a', 'b'] });
  const twoWithdrawn = await quiet(async () => {
    const ready = await prepareQueries(f.options.topics, f.options);
    return generateTopics(ready, '2026-10-09', f.options);
  });
  assert(twoWithdrawn.result.length === 0 && f.calls.body.length === 2 && f.recorder.additions.every(item => item.stage === 'postgen-dedup') && f.recorder.additions.length === 2, '2 本モードの生成後重複も記録し再生成はしない', 'R3');
  f = fixture({ queries: { a: '再利用検索語', b: '再利用検索語' }, postDuplicates: ['a'] });
  const sameRunQuery = (await quiet(() => runSingleDraft('2026-10-09', f.options))).result;
  assert(sameRunQuery.results[0].slug === 'url-c' && f.calls.body.map(item => item.slug).join() === 'a,c' && f.recorder.additions.map(item => item.stage).join() === 'postgen-dedup,target-query-withdrawn', '同じ実行で取り下げた検索語も次の候補から除く', 'R3');
  f = fixture({ slugs: ['a'], queries: { a: '再利用検索語' }, withdrawn: [{ topic_id: 'a', target_query: '再利用検索語' }] });
  const manual = (await quiet(() => prepareQueries(f.options.topics, { ...f.options, force: true, checkWithdrawnQuery: true }))).result;
  assert(manual.length === 1 && f.recorder.additions.length === 0, '手動指定の検索語は取り下げ記録を無視する', 'R3');

  const seed = loadWithdrawnTopics();
  const doc = read(path.join(ROOT, 'docs/codex-tasks/draft-supply/01-withdrawn-and-retry.md'));
  const rows = doc.split(/\r?\n/).filter(line => line.startsWith('| suggest-')).map(line => line.split('|').slice(1, -1).map(value => value.trim()));
  const expectedSeed = rows.map(([topic_id, stage, date, run, similar_to, url_slug, target_query, reason]) => ({ topic_id, stage, similar_to, reason, url_slug, target_query, date, run_url: `https://github.com/JourneysPartner/hp-vlog/actions/runs/${run}` }));
  assert(expectedSeed.length === 8 && matchesInitialEntries(seed, expectedSeed), '残っている初期記録が指示書の表どおり（総件数は固定しない）', 'F1');
  const ninth = cloneData(seed);
  ninth.entries = ninth.entries.concat({ ...entry, topic_id: '偽の9件目' });
  assert(matchesInitialEntries(ninth, expectedSeed), '偽の項目を足しても初期記録の検査は通る', 'F1');
  const removedSeed = cloneData(seed);
  removedSeed.entries = removedSeed.entries.filter(item => item.topic_id !== expectedSeed[0].topic_id);
  assert(matchesInitialEntries(removedSeed, expectedSeed), '初期記録を手で消しても検査は通る（README の元に戻す方法）', 'F1');
  for (let index = 0; index < 8; index++) {
    const at = seed.entries.findIndex(item => item.topic_id === expectedSeed[index].topic_id && item.stage === expectedSeed[index].stage && item.date === expectedSeed[index].date);
    if (at === -1) continue;
    for (const field of ['similar_to', 'url_slug', 'target_query']) {
      const changedSeed = cloneData(seed);
      changedSeed.entries[at][field] += '変更';
      assert(!matchesInitialEntries(changedSeed, expectedSeed), `初期 ${index + 1} 件目の ${field} の変更を検出`, 'F1');
    }
  }
  // 実データの候補一覧は週次の検索語更新で変わる。記録済みの題材が一覧に残っているかには頼らず、
  // 記録なしで選ばれる 1 件を記録に足して、その 1 件が外れて別の 1 件になることを確かめる。
  const baseline = selectDailyTopics(TOPICS, { now: selectionNow, count: 1, withdrawn: seed });
  const baselinePick = baseline.picks[0];
  const extended = { ...seed, entries: seed.entries.concat({ ...entry, topic_id: baselinePick.slug }) };
  const actual = selectDailyTopics(TOPICS, { now: selectionNow, count: 1, withdrawn: extended });
  const step = actual.explanation.steps.find(item => item.step === 'filter-withdrawn');
  const baselineStep = baseline.explanation.steps.find(item => item.step === 'filter-withdrawn');
  assert(baseline.picks.length === 1 && step.blocked === baselineStep.blocked + 1 && actual.picks.length === 1 && actual.picks.every(topic => topic.slug !== baselinePick.slug && !findWithdrawnTopic(topic, extended)), '実プールで取り下げ記録のある題材を外し別の 1 件を選定', 'R2');
  console.log('実データ: ' + JSON.stringify({ blocked: step.blocked, topic_ids: step.blockedDetails.map(item => item.slug), selected: actual.picks.map(topic => topic.slug) }));
  const workflow = read(path.join(ROOT, '.github/workflows/daily-draft.yml'));
  assert(workflow.includes('WITHDRAWN_OUT: /tmp/withdrawn-new.json') && /- name: Record withdrawn topics on main\s+if: always\(\)/.test(workflow), '生成失敗時も最後のステップに取り下げ記録を渡す', 'R5');
  const recordStep = workflow.slice(workflow.indexOf('      - name: Record withdrawn topics on main'));
  assert(recordStep.includes('git add -- data/withdrawn-topics.json') && recordStep.includes('git push origin HEAD:main') && recordStep.includes('for attempt in 0 1 2 3'), '記録ファイルだけを追加し push と最大 3 回の再試行', 'R5');
  const retryLoop = recordStep.slice(recordStep.indexOf('for attempt in 0 1 2 3'), recordStep.indexOf('\n          done'));
  assert(/git fetch origin main[\s\S]*git checkout -B withdrawn-record origin\/main[\s\S]*record_and_commit[\s\S]*git push origin HEAD:main/.test(retryLoop), '全試行で最新 main への切り替え・再追記・push の順を保つ', 'F3');
  assert((retryLoop.match(/continue/g) || []).length === 2 && !/git (?:pull|rebase)/.test(recordStep), '切り替え・追記失敗も次の試行へ進み pull と rebase は使わない', 'F3');
  const logIndex = recordStep.indexOf('cat /tmp/withdrawn-new.json');
  assert(logIndex !== -1 && logIndex < recordStep.indexOf('if ! node -e') && logIndex < recordStep.indexOf('git fetch origin main'), '保存前に今回の記録をログに出す', 'F3');
  assert(/done\s+echo '::warning::取り下げ記録を main に保存できませんでした'\s+exit 0/.test(recordStep), '最大 4 回の失敗後は警告付きで成功終了', 'F3');
  assert(!/git (?:reset --hard|clean)/.test(recordStep) && recordStep.includes('::warning::') && recordStep.trim().endsWith('exit 0'), '作業ツリーを消す操作なし・失敗は警告で終了', 'R5');
}

main().catch(error => { console.error(error); failed++; }).finally(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('R 別結果: ' + JSON.stringify(groups));
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  process.exitCode = failed ? 1 : 0;
});
