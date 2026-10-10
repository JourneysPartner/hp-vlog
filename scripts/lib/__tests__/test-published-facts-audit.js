'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const A = require('../../audit-published-facts');
const F = require('../fact-check');
const candidates = require('../freshness-candidates');
const refresh = require('../freshness-refresh');
let pass = 0, fail = 0; const groups = {};
async function test(group, fn) {
  groups[group] ||= { pass: 0, fail: 0 };
  try { await fn(); pass++; groups[group].pass++; console.log(`PASS ${group}`); }
  catch (e) { fail++; groups[group].fail++; console.error(`FAIL ${group}: ${e.stack}`); }
}
const text = '非課税制度の期限は令和9年3月31日です。';
const post = (slug, status = 'published', date = '2026-10-01') => ({ slug, title: slug, review_status: status, published_at: date, file: `${date}-${slug}.md`, body: text });
async function main() {
  await test('R1', () => {
    const posts = [post('a'), post('b'), post('c'), post('merged', 'merged'), post('draft', 'draft'), post('old', 'published', '2026-09-01')];
    assert.deepEqual(A.selectPosts(posts, A.parseArgs(['--limit', '1', '--offset', '1', '--since', '2026-10-01'])).map(p => p.slug), ['b']);
    assert.deepEqual(A.selectPosts(posts, A.parseArgs(['--slug', 'a,c'])).map(p => p.slug), ['a', 'c']);
    for (const args of [['--limit', '0'], ['--offset', '-1'], ['--since', '2026-02-30'], ['--slug', '../bad'], ['--unknown']]) assert.throws(() => A.parseArgs(args));
  });
  await test('R1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-dry-'));
    try {
      const result = await A.run(['--dry-run'], { posts: [post('a')], auditDir: dir, callLLM: async () => { throw new Error('呼ばない'); }, log: () => {} });
      assert.equal(result.estimate.articles, 1); assert.ok(result.estimate.claims > 0); assert.equal(fs.readdirSync(dir).length, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('R1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-')); let calls = 0;
    try {
      const options = { posts: [post('a'), post('b')], auditDir: dir, now: new Date('2026-10-10T00:00:00Z'), log: () => {},
        searchEvidence: () => [{ id: 'e', text, title: '国税庁', url: 'https://example.jp/' }],
        callLLM: async req => {
          calls++; if (req.task === 'repair') throw new Error('修正を呼ばない');
          if (req.task === 'extract') return [{ id: 'c1', sentence: text, claim: text, subject: '非課税制度', type: '期限' }];
          return [{ id: 'c1', status: '食い違い', quote: text, correct: text }];
        } };
      const r = await A.run([], options);
      assert.equal(r.records.length, 2); assert.equal(r.records[0].claims[0].status, '食い違い');
      const report = fs.readFileSync(path.join(dir, '2026-10-10/report.md'), 'utf8');
      assert.match(report, /食い違い 2 件/); assert.match(report, /https:\/\/example.jp/);
      const before = calls; await A.run(['--resume'], options); assert.equal(calls, before);
      await A.run(['--resume'], { ...options, now: new Date('2026-10-11T00:00:00Z') }); assert.equal(calls, before);
      const more = { ...r.records[1], slug: 'b', claims: [r.records[1].claims[0], { ...r.records[1].claims[0], id: 'c2' }] };
      assert.ok(A.renderReport([r.records[0], more], { skipped: 0 }).indexOf('## b') < A.renderReport([r.records[0], more], { skipped: 0 }).indexOf('## a'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('R1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-stop-'));
    try {
      let checked = 0;
      await assert.rejects(A.run([], { posts: [post('a'), post('b')], auditDir: dir, now: new Date('2026-10-10'), log: () => {}, checkFacts: async body => {
        if (++checked === 2) throw new Error('途中停止'); return { body, record: { version: 1, status: 'ok', claims: [], rechecked: [], corrections: [], body_sha256: F.bodyHash(body) } };
      } }));
      assert.ok(fs.existsSync(path.join(dir, '2026-10-10/a.json'))); assert.ok(fs.existsSync(path.join(dir, '2026-10-10/report.md')));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('R2', () => {
    const yaml = require('js-yaml'), text = fs.readFileSync(path.join(__dirname, '../../../.github/workflows/audit-published-facts.yml'), 'utf8');
    const workflow = yaml.load(text); assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    for (const name of ['limit', 'offset', 'since', 'dry_run']) assert.ok(workflow.on.workflow_dispatch.inputs[name]);
    assert.match(text, /audit\/facts-/); assert.match(text, /gh pr create/); assert.ok(!/git push[^\n]*\bmain\b/.test(text));
    assert.ok(workflow.jobs.audit.steps.filter(step => step.run).every(step => !/\$\{\{ inputs\./.test(step.run)));
  });
  await test('R1', async () => {
    // CLIは実行せず、読取専用の見積もりを公開記事10本と偽の抜き出し関数で確認する。
    const posts = A.selectPosts(candidates.readPosts(path.join(__dirname, '../../../content/posts')), A.parseArgs(['--dry-run']));
    let claims = 0, chars = 0;
    for (const p of posts) {
      const result = await F.extractClaims(p.body, async request => {
        chars += request.system.length + request.user.length;
        return A.estimateClaims(request.user).map(sentence => ({ sentence, claim: sentence, subject: '見積もり', type: '要件' }));
      });
      claims += result.claims.length + result.dropped;
    }
    const estimate = A.estimateAudit(posts);
    assert.equal(posts.length, 10); assert.ok(claims > 0); assert.ok(estimate.input_chars >= chars);
    console.log('公開記事10本の見積もり（偽LLM・照合なし）:', JSON.stringify({ fake_claims: claims, extraction_input_chars: chars, ...estimate }));
  });
  await test('R3', () => {
    const p = post('a');
    const record = { slug: 'a', status: 'revise', body_sha256: F.bodyHash(p.body), claims: [{ id: 'c1', sentence: text, status: '食い違い', correct: text, evidence: [] }] };
    const base = { posts: [p], sources: [], calendar: null, searchSnapshots: [] };
    const result = candidates.buildCandidates({ ...base, factAudits: { a: record } });
    assert.equal(result[0].score, Math.max(...Object.values(candidates.SIGNAL_WEIGHTS)));
    assert.equal(result[0].reasons[0].detail, '事実の照合で食い違い 1 件'); assert.equal(result[0].refreshable, true);
    assert.equal(result[0].reasons[0].audit.claims, undefined);
    const plan = refresh.buildRefreshPlan(p, [{ ...result[0].reasons[0], audit: record }]);
    assert.match(plan[0].instruction, /令和9年3月31日/);
    assert.deepEqual(candidates.buildCandidates({ ...base, factAudits: {} }), candidates.buildCandidates(base));
  });
  await test('R3', () => {
    const record = { claims: [{ sentence: text, status: '食い違い', correct: '原文に基づく修正内容', evidence: [] }] };
    const fact = { kind: 'fact_mismatch', detail: '事実の照合で食い違い 1 件', where: '本文', audit: record };
    const reasons = [
      [{ kind: 'fiscal_year', detail: '年分', where: '本文' }],
      ['甲', '乙', '丙'].map(heading => ({ kind: 'tax_reform', detail: '改正', where: `## ${heading}` })),
      [{ kind: 'source_updated', detail: '出典の更新', where: '本文' }],
    ];
    const p = { body: `## 甲\n${text}\n## 乙\n${text}\n## 丙\n${text}` };
    for (const existing of reasons) {
      const before = refresh.buildRefreshPlan(p, existing);
      const after = refresh.buildRefreshPlan(p, [...existing, fact]);
      assert.deepEqual(after.slice(0, before.length).map(s => [s.kind, s.scope, s.heading]), before.map(s => [s.kind, s.scope, s.heading]));
      assert.ok(after.some(s => s.instruction.includes('原文に基づく修正内容')));
    }
  });
  await test('R3', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-latest-'));
    try {
      for (const day of ['2026-10-09', '2026-10-10']) {
        fs.mkdirSync(path.join(dir, day)); fs.writeFileSync(path.join(dir, day, 'a.json'), JSON.stringify({ version: 1, slug: 'a', status: day.endsWith('10') ? 'ok' : 'revise', claims: [] }));
      }
      assert.equal(require('../fact-audit').readLatestAudits(dir).a.status, 'ok');
      assert.equal(require('../fact-audit').auditReason(post('a'), { slug: 'a', status: 'revise', body_sha256: F.bodyHash('古い本文'), claims: [{ status: '食い違い' }] }), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('R3', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-refresh-'));
    try {
      const file = '2026-10-01-a.md'; const original = `---\nslug: a\ntitle: "確認"\nreview_status: published\n---\n## 制度\n${text}\n`;
      fs.writeFileSync(path.join(dir, file), original); const reasonsFile = path.join(dir, 'reasons.json'); fs.writeFileSync(reasonsFile, '[]');
      const record = { slug: 'a', status: 'revise', body_sha256: F.bodyHash(require('gray-matter')(original).content), claims: [{ id: 'c1', heading: '制度', sentence: text, status: '食い違い', correct: '期限を原文で確認します。', evidence: [{ id: 'e', text, url: 'https://example.jp/' }] }] };
      let comment = '';
      await require('../../generate-draft').runRefreshMode([], { postsDir: dir, filename: file, reasonsFile, factAudit: record,
        regenerateSection: async (raw, instruction) => { comment = instruction; return raw.replace('令和9年', '令和8年'); },
        regenerateTargeted: async (raw, instruction) => { comment = instruction; return raw.replace('令和9年', '令和8年'); },
        factCheck: async content => ({ content, record: { status: 'revise', summary: '' } }), now: new Date('2026-10-10') });
      assert.match(comment, /期限を原文で確認/); assert.match(comment, /https:\/\/example.jp/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  console.log(`公開記事照合: PASS ${pass} / FAIL ${fail}\n${JSON.stringify(groups)}`); process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
