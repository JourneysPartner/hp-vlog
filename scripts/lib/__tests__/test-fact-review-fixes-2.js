'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');
const F = require('../fact-check');
const G = require('../../generate-draft');
const A = require('../fact-audit');
const C = require('../freshness-candidates');
const N = require('../draft-normalizer');
const M = require('../materials-bundle');
const page = require('../../../netlify/functions/review-page');
const github = require('../../../netlify/functions/lib/github-api');
const model = require('../content-model');
const ROOT = path.join(__dirname, '../../..');
const correct = '制度の期限は令和9年3月31日です。';
const wrong = correct.replace('9年', '8年');
const primary = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm';
const generic = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm';
const supplement = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4511.htm';
const raw = (body = correct, updates = {}) => F.updateMeta(`---\nslug: review-fixes-test\ntitle: "制度の確認"\nrecommendation: "publish"\nreview_status: "draft"\nsource_url: "${primary}"\nsource_title: "贈与税の非課税"\nsource_provenance: "curated"\nsource_confidence: 1\n---\n${body}`, updates);
const claim = (sentence, type = '期限', summary = sentence) => ({ id: 'c1', sentence, claim: summary, type, subject: '制度' });
const groups = {};
let pass = 0, fail = 0;
async function test(group, name, fn) {
  groups[group] ||= { pass: 0, fail: 0 };
  try { await fn(); pass++; groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (e) { fail++; groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${e.stack}`); }
}
async function temporary(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-review-fixes-2-'));
  try { return await fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function audit(body = correct, slug = 'review-fixes-test') {
  return { version: 1, slug, status: 'revise', checked_at: '2026-10-10T00:00:00.000Z', body_sha256: F.bodyHash(body),
    claims: [{ ...claim(body), status: '食い違い', correct: '原文に合わせた修正内容', quote: correct,
      evidence: [{ id: 'e1', title: '根拠', text: correct, url: supplement }] }] };
}
async function judged(sentence, quote, type = '期限', summary = sentence) {
  const result = await F.judgeClaims([claim(sentence, type, summary)], { c1: [{ id: 'e1', text: quote }] }, sentence,
    async () => [{ id: 'c1', status: '裏付けあり', quote, evidence_id: 'e1' }]);
  return result[0].status;
}

async function main() {
  await test('G1', '実際の生成・保存からレビュー画面まで修正結果を表示', () => temporary(async dir => {
    await G.generateTopics([{ slug: 'review-fixes-test', title: '制度の確認', persona: 'test' }], '2026-10-10', {
      postsDir: dir, generateArticle: async () => ({ content: raw(wrong), model: '偽のモデル' }),
      selfCheck: () => {}, checkGenerated: async () => ({ duplicate: false }),
      factCheck: (content, options) => F.checkArticle(content, { ...options, searchEvidence: () => [{ id: 'e1', text: correct }],
        callLLM: async request => request.task === 'extract' ? [claim(request.user.trim())]
          : request.task === 'repair' ? correct
            : [{ id: 'c1', status: request.user.includes(wrong) ? '食い違い' : '裏付けあり', quote: correct, correct, evidence_id: 'e1' }] }),
    });
    const filename = '2026-10-10-review-fixes-test.md';
    const content = fs.readFileSync(path.join(dir, filename), 'utf8');
    const record = fs.readFileSync(path.join(dir, '.fact-check/review-fixes-test.json'), 'utf8');
    assert.equal(JSON.parse(record).corrections.length, 1);
    const oldGet = github.getFile, oldToken = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = 'テスト専用の偽認証';
      github.getFile = async file => ({ content: file.startsWith('data/fact-check/') ? record : content });
      const response = await page.handler({ httpMethod: 'GET', queryStringParameters: { file: filename, ref: 'draft/test' } });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /照合済み/); assert.match(response.body, /直した箇所/);
      assert.match(response.body, /令和8年3月31日/); assert.match(response.body, /令和9年3月31日/);
      assert.ok(!response.body.includes('古い記録'));
    } finally {
      github.getFile = oldGet;
      if (oldToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = oldToken;
    }
  }));
  for (const body of [correct, correct + '\n', correct + '  \r\n\t\r\n']) await test('G1', '改行・末尾空白の差で古い記録にしない', async () => {
    const saved = github.getFile;
    try {
      github.getFile = async () => ({ content: JSON.stringify({ ...audit(correct), status: 'ok' }) });
      const record = await page.fetchFactCheck('review-fixes-test', 'draft/test', body);
      assert.ok(!record.stale); assert.match(page.renderFactCheck({}, record, body), /照合済み/);
    } finally { github.getFile = saved; }
  });
  await test('G1', '一文字の変更は古い記録、行内の空白は保持', async () => {
    const record = { ...audit(correct), corrections: [{ before: wrong, after: correct, resolved: true }] };
    const html = page.renderFactCheck({}, record, wrong);
    assert.match(html, /古い記録/); assert.ok(!html.includes('直した箇所'));
    assert.equal(F.bodyHash('本文  \r\n続き\t\r\n'), F.bodyHash('本文\n続き'));
    assert.notEqual(F.bodyHash('本文 続き'), F.bodyHash('本文続き'));
  });

  await test('G2', '各300KBの監査30件でも候補JSONは200KB未満', () => {
    const posts = [], factAudits = {};
    for (let i = 0; i < 30; i++) {
      const slug = `audit-${i}`;
      posts.push({ slug, title: `確認${i}`, review_status: 'published', body: correct });
      factAudits[slug] = audit(correct, slug);
      factAudits[slug].claims[0].evidence[0].text = 'あ'.repeat(100 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(factAudits[slug])) >= 300 * 1024);
    }
    const output = C.buildOutput({ posts, factAudits }, { limit: 30, now: new Date('2026-10-10') });
    assert.equal(output.candidates.length, 30);
    assert.ok(Buffer.byteLength(JSON.stringify(output, null, 2)) < 200 * 1024);
    for (const candidate of output.candidates) {
      const summary = candidate.reasons.find(r => r.kind === 'fact_mismatch').audit;
      assert.deepEqual(Object.keys(summary).sort(), ['body_sha256', 'checked_at', 'mismatch_count', 'record_path']);
      assert.equal(summary.mismatch_count, 1); assert.equal(summary.body_sha256, F.bodyHash(correct));
      assert.match(summary.record_path, /^data\/fact-check\/audit\/2026-10-10\/audit-\d+\.json$/);
    }
  });
  await test('G2', 'ディスク上の監査記録のパスを候補に残す', () => temporary(async dir => {
    fs.mkdirSync(path.join(dir, '2026-10-10'));
    const file = path.join(dir, '2026-10-10/review-fixes-test.json');
    fs.writeFileSync(file, JSON.stringify(audit()));
    const reason = A.auditReason({ body: correct }, A.readLatestAudits(dir)['review-fixes-test']);
    assert.equal(path.resolve(ROOT, reason.audit.record_path), file);
    assert.equal(reason.audit.claims, undefined);
  }));
  await test('G2', '更新案は要約ではなくディスクから読んだ原文を渡す', () => temporary(async dir => {
    const filename = '2026-10-10-review-fixes-test.md';
    const original = raw('## 制度\n' + wrong, { review_status: 'published' });
    const record = audit(matter(original).content);
    const auditDir = path.join(dir, 'audit'); fs.mkdirSync(path.join(auditDir, '2026-10-10'), { recursive: true });
    fs.writeFileSync(path.join(auditDir, '2026-10-10/review-fixes-test.json'), JSON.stringify(record));
    fs.writeFileSync(path.join(dir, filename), original);
    const reasonsFile = path.join(dir, 'reasons.json');
    fs.writeFileSync(reasonsFile, JSON.stringify([A.auditReason({ body: matter(original).content }, record)]));
    let instruction = '';
    const result = await G.runRefreshMode([], { postsDir: dir, filename, reasonsFile, auditDir,
      regenerateTargeted: async (content, comment) => { instruction = comment; return content.replace(wrong, correct); },
      factCheck: async content => ({ content, record: { status: 'ok', summary: '照合済み' } }) });
    assert.equal(result.status, 'changed');
    assert.match(instruction, /原文に合わせた修正内容/); assert.ok(instruction.includes(supplement));
    assert.ok(instruction.includes(correct)); assert.equal(matter(result.content).data.source_url, primary);
  }));

  await test('G3', '一定の要件と正しい令和9年の期限は裏付けあり', async () => {
    assert.equal(await judged('一定の要件を満たせば、令和9年3月31日までの贈与が対象です。',
      '令和9年3月31日までの間に行われた贈与が対象となります。'), '裏付けあり');
    assert.deepEqual(F.normalizedNumbers('一定の要件を一般に確認する。'), []);
  });
  for (const [sentence, quote, type] of [
    ['控除額は110万円です。', '控除額は百十万円です。', '金額'],
    ['控除額は百十万円です。', '控除額は110万円です。', '金額'],
    [correct, '制度の期限は令和九年三月三十一日です。', '期限'],
    ['控除額は1,100,000円です。', '控除額は110万円です。', '金額'],
    ['上限は1億2,500万円です。', '上限は一億二千五百万円です。', '金額'],
    ['割合は12.5％です。', '割合は12.5%です。', '割合'],
  ]) await test('G3', '数字の表記差を揃える: ' + sentence, async () => assert.equal(await judged(sentence, quote, type), '裏付けあり'));
  await test('G3', '令和8年と令和9年は裏付けありにしない', async () => assert.equal(await judged(wrong, correct), '資料なし'));
  await test('G3', 'ゼロ・不正な桁区切り・精度を超える別の額は一致させない', async () => {
    assert.deepEqual(F.normalizedNumbers('0万円 零万円'), ['0', '0']);
    for (const [sentence, quote] of [
      ['上限は0万円です。', '上限は1万円です。'],
      ['上限は1,2万円です。', '上限は12万円です。'],
      ['上限は10000000000000001円です。', '上限は10000000000000000円です。'],
    ]) assert.equal(await judged(sentence, quote, '金額'), '資料なし');
  });
  await test('G3', '文の別の数字を照合する主張へ混ぜない', async () => {
    assert.equal(await judged('過去には令和8年と説明しましたが、期限は令和9年3月31日です。', correct, '期限', correct), '裏付けあり');
    assert.equal(await judged(correct, correct, '期限', wrong), '資料なし');
  });
  await test('G3', '漢数字は単位・元号・第の文脈でだけ読む', () => {
    assert.deepEqual(F.normalizedNumbers('一般の一定の要件、第三項、昭和六十年、平成元年、三人、二件、六ヶ月、二割五分'), ['3', '60', '1', '3', '2', '6', '2', '5']);
    assert.deepEqual(F.normalizedNumbers('110万円 百十万円'), ['1100000', '1100000']);
  });

  for (const [refresh, status] of [[false, 'revise'], [false, 'not_run'], [true, 'revise'], [true, 'not_run']]) await test('G4', `承認停止を一度通知: 更新案=${refresh} 状態=${status}`, async () => {
    const calls = []; let writes = 0;
    const content = raw(correct, { fact_check_status: status, fact_check_blocking: true });
    const response = await require('../../../netlify/functions/review-approve-background')._handler({ httpMethod: 'POST',
      body: JSON.stringify({ filename: 'test.md', ...(refresh ? { ref: 'draft/refresh-test' } : {}) }) }, {
      getFile: async () => ({ content }), putFile: async () => { writes++; },
      sendNotification: async (...args) => calls.push(args),
    });
    assert.equal(response.statusCode, 400); assert.equal(writes, 0); assert.equal(calls.length, 1);
    assert.equal(calls[0][0], refresh ? 'refresh_approve_failed' : 'quality_blocked');
    assert.match(refresh ? calls[0][1].comment : calls[0][1].reasons[0], /事実の照合で承認できない状態です/);
  });
  await test('G4', '更新マーカーでも更新案通知、通知失敗でも承認停止', async () => {
    const calls = [];
    const response = await require('../../../netlify/functions/review-approve-background')._handler({ httpMethod: 'POST', body: JSON.stringify({ filename: 'test.md' }) }, {
      getFile: async () => ({ content: raw(correct, { refresh_of: 'published', fact_check_status: 'revise' }) }),
      sendNotification: async (...args) => { calls.push(args); throw new Error('偽の通知失敗'); },
      putFile: async () => assert.fail('承認停止時は書き込まない'),
    });
    assert.equal(response.statusCode, 400); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'refresh_approve_failed');
  });

  for (const [status, extraWarning, expected] of [
    ['', '', 'publish'], ['ok', '', 'publish'], ['revise', '', 'revise'], ['ok', '別の品質警告', 'revise'],
  ]) await test('G5', `実際のmainの再生成順で仮置き題名解除: ${status || '旧下書き'} ${extraWarning}`, async () => {
    const factWarning = '【事実の照合】捨てた主張 0 / 注意: 根拠の基準日が古い【/事実の照合】';
    const original = raw(correct, { title: '[要レビュー] review-fixes-test', recommendation: 'revise',
      review_warning: [N.PLACEHOLDER_TITLE_WARNING, status ? factWarning : '', extraWarning].filter(Boolean).join(' / '),
      ...(status ? { fact_check_version: 1, fact_check_status: status, fact_check_blocking: status === 'revise', fact_check_prev_recommendation: 'revise' } : {}) });
    const filename = '__fact-review-fixes-2__.md', target = path.join(ROOT, 'content/posts', filename);
    const oldRead = fs.readFileSync, oldWrite = fs.writeFileSync, oldExists = fs.existsSync;
    const oldArgv = process.argv, oldOutput = process.env.GITHUB_OUTPUT, oldKey = process.env.OPENAI_API_KEY;
    let written = '', inheritance = 0;
    const oldInherit = F.inheritFactMetadata;
    try {
      delete process.env.GITHUB_OUTPUT;
      process.env.OPENAI_API_KEY = 'テスト専用の偽認証';
      process.argv = [process.execPath, 'generate-draft.js', '--regenerate', '--filename', filename, '--comment', 'タイトルを「制度の期限を確認する方法」に変更して。'];
      fs.existsSync = file => path.resolve(String(file)) === target || oldExists(file);
      fs.readFileSync = (file, ...args) => path.resolve(String(file)) === target ? original : oldRead(file, ...args);
      fs.writeFileSync = (file, content, ...args) => path.resolve(String(file)) === target ? (written = content) : oldWrite(file, content, ...args);
      F.inheritFactMetadata = (...args) => { inheritance++; return oldInherit(...args); };
      await G.main();
      const meta = matter(written).data;
      assert.equal(inheritance, 1); assert.equal(meta.title, '制度の期限を確認する方法');
      assert.equal(meta.recommendation, expected); assert.ok(!meta.review_warning.includes(N.PLACEHOLDER_TITLE_WARNING));
      if (status) assert.ok(meta.review_warning.includes(factWarning));
      if (status === 'ok' && !extraWarning) assert.equal(meta.fact_check_prev_recommendation, 'publish');
      if (status === 'revise') assert.equal(meta.fact_check_blocking, true);
    } finally {
      fs.readFileSync = oldRead; fs.writeFileSync = oldWrite; fs.existsSync = oldExists;
      F.inheritFactMetadata = oldInherit; process.argv = oldArgv;
      if (oldOutput === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = oldOutput;
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    }
  });
  await test('G5', '照合not_runで停止中とrejectは解除しない', () => {
    for (const recommendation of ['revise', 'reject']) {
      const result = N.clearPlaceholderTitleWarning(raw(correct, { recommendation, fact_check_status: 'not_run', fact_check_blocking: true,
        review_warning: N.PLACEHOLDER_TITLE_WARNING + ' / 【事実の照合】未実施 / 注意【/事実の照合】' }));
      assert.equal(matter(result).data.recommendation, recommendation);
    }
  });

  for (const context of ['差し戻し', '更新案']) for (const source of [primary, generic]) await test('G6', `${context}で主出典固定、汎用ページだけ補強`, async () => {
    const meta = { slug: 'review-fixes-test', title: '贈与税の非課税', tax_terms: '贈与税', tax_domain: 'inheritance_gift', source_url: source,
      source_title: '元の主出典', source_provenance: 'auto', source_confidence: 0.8 };
    const before = { ...meta }; let supplements = 0, passedPrimary;
    const oldBundle = M.buildMaterialsBundle;
    try {
      M.buildMaterialsBundle = (topic, ...args) => { passedPrimary = topic.source_url; return oldBundle(topic, ...args); };
      const blocks = await G.buildRegenSourceBlocks(meta, correct, {
        enrichTaxTerms: async topic => { topic.tax_terms = '贈与税'; },
        ensureSource: () => assert.fail('主出典を選び直さない'), enrichSource: async () => assert.fail('主出典を選び直さない'),
        resolveSupplement: async () => { supplements++; return { url: supplement, title: '結婚・子育て', confidence: 1 }; },
      });
      for (const key of ['source_url', 'source_title', 'source_provenance', 'source_confidence']) assert.equal(meta[key], before[key]);
      assert.equal(passedPrimary, source); assert.ok(blocks.sourceBody.includes(source));
      assert.equal(supplements > 0, source === generic);
      if (source === generic) assert.ok(meta.source_bundle.includes(supplement));
      assert.equal(matter(G.recordMaterialMetadata(raw(), meta)).data.source_url, source);
    } finally { M.buildMaterialsBundle = oldBundle; }
  });
  await test('G6', '再生成後の既存LLM選定は初期選定を省き、その後に補強', async () => {
    const order = [], topic = { source_url: generic, source_provenance: 'domain-fallback', title: '贈与税' };
    await G.prepareSources([topic], { ensureInitial: false,
      ensureSource: () => assert.fail('初期選定・探し直しをしない'),
      enrichSource: async () => { order.push('select'); },
      enrichTaxTerms: async t => { order.push('terms'); t.tax_terms = '贈与税'; },
      resolveSupplement: async () => { order.push('supplement'); return null; },
    });
    assert.deepEqual(order, ['select', 'terms', 'supplement']);
  });

  const T = require('../nta-tsutatsu');
  for (const text of ['所基通36-40（1）', '所基通36-40(1)']) await test('G7', '末尾括弧を番号に含めず原文を添付: ' + text, () => {
    const result = T.checkCitations(text);
    assert.equal(result.unknown.length, 0); assert.equal(result.citations[0].no, '36-40');
    assert.ok(T.buildProvisionBlock(result.citations).includes('36-40'));
  });
  await test('G7', '措通61の4(1)-1の条の括弧は保持', () => {
    const catalog = T.loadCatalog(), saved = catalog.sochi_hojin;
    try {
      catalog.sochi_hojin = { label: '措置法通達', short: '措通', provisions: { '61の4(1)-1': { no: '61の4(1)-1', body: '確認済みの原文。' } } };
      for (const text of ['措通61の4(1)-1', '措通６１の４（１）－１（2）']) {
        const result = T.checkCitations(text);
        assert.equal(result.unknown.length, 0); assert.equal(result.citations[0].no, '61の4(1)-1');
        assert.ok(T.buildProvisionBlock(result.citations).includes('確認済みの原文'));
      }
    } finally { if (saved === undefined) delete catalog.sochi_hojin; else catalog.sochi_hojin = saved; }
  });
  await test('G7', '実在しない番号は括弧を外しても止める', () => assert.equal(T.checkCitations('所基通999-999（1）').unknown.length, 1));

  await test('G8', '見本の本文ページを0件に壊すと既存カタログを保持', () => temporary(async dir => {
    const crawler = require('../../crawl-nta-tsutatsu'), parser = require('../tsutatsu-parser');
    const fixtureDir = path.join(ROOT, 'docs/codex-tasks/fact-grounding/fixtures');
    const fixture = require(path.join(fixtureDir, 'tsutatsu-pages.json')).circulars.find(c => c.key === 'hyoka');
    const bodyPages = fixture.files.filter(f => f.kind === 'body');
    const urls = bodyPages.map(p => p.url);
    const originalHtml = new TextDecoder('shift_jis').decode(fs.readFileSync(path.join(fixtureDir, bodyPages[1].file)));
    const broken = originalHtml.replace(/<strong[^>]*>[\s\S]*?<\/strong>/gi, '');
    assert.ok(parser.parseTsutatsuPage(originalHtml, { circular: 'hyoka' }).provisions.length > 0);
    assert.equal(parser.parseTsutatsuPage(broken, { circular: 'hyoka' }).provisions.length, 0);
    const entries = ['hyoka.json', 'hyoka.index.json', 'index.json'];
    const initial = { 'hyoka.json': '{"既存":"本文"}\n', 'hyoka.index.json': '{"entries":[]}\n',
      'index.json': JSON.stringify([{ circular: 'hyoka', provision_count: 1, errors: 0 }]) + '\n' };
    for (const file of entries) fs.writeFileSync(path.join(dir, file), initial[file]);
    const oldFetch = global.fetch, oldArgv = process.argv, oldCode = process.exitCode, oldWarn = console.warn;
    const logs = [], requests = [];
    try {
      process.argv = [process.execPath, 'crawl-nta-tsutatsu.js', '--only', 'hyoka'];
      console.warn = (...args) => logs.push(args.join(' '));
      global.fetch = async url => {
        requests.push(url);
        const html = url === fixture.index_url ? `<meta charset=utf-8>${urls.map(u => `<a href="${u}">本文</a>`).join('')}`
          : url === urls[1] ? '<meta charset=utf-8>' + broken
            : '<meta charset=utf-8>' + new TextDecoder('shift_jis').decode(fs.readFileSync(path.join(fixtureDir, bodyPages[0].file)));
        assert.ok([fixture.index_url, ...urls].includes(url));
        return { ok: true, arrayBuffer: async () => Buffer.from(html) };
      };
      await crawler.main({ outDir: dir });
      assert.equal(process.exitCode, 1); assert.equal(requests.length, 3);
      assert.ok(logs.some(log => log.includes(urls[1]) && log.includes('0件')));
      for (const file of entries) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, file))), JSON.parse(initial[file]));
    } finally { global.fetch = oldFetch; process.argv = oldArgv; process.exitCode = oldCode; console.warn = oldWarn; }
  }));

  for (const [reviewed_at, expected] of [['2026-10-11', 0], ['2026-10-09', 1], ['2026-10-10T00:00:00.000Z', 1], ['不正な日付', 1]]) await test('G9', '確認日と監査日の比較: ' + reviewed_at, () => {
    const post = { slug: 'review-fixes-test', title: '制度の確認', body: correct, review_status: 'published', reviewed_at };
    const candidates = C.buildCandidates({ posts: [post], factAudits: { 'review-fixes-test': audit() } });
    assert.equal(candidates.length, expected);
  });

  await test('G10', '照合記録だけ強制404、既存の規則を維持', () => {
    const text = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
    const blocks = text.split('[[redirects]]').slice(1);
    const target = blocks.filter(block => /from\s*=\s*"\/data\/fact-check\/\*"/.test(block));
    assert.equal(target.length, 1); assert.match(target[0], /to\s*=\s*"\/404\.html"/);
    assert.match(target[0], /status\s*=\s*404/); assert.match(target[0], /force\s*=\s*true/);
    assert.ok(!blocks.some(block => /from\s*=\s*"\/data\/\*"/.test(block)));
    assert.ok(blocks.findIndex(block => block === target[0]) < blocks.findIndex(block => /from\s*=\s*"\/\*"/.test(block)));
  });

  for (const timeoutMs of [600000, 123456]) await test('G11', '照合の接続待ち設定をtimeoutMsに合わせて閉じる: ' + timeoutMs, async () => {
    const undici = require('undici'), SavedAgent = undici.Agent, oldFetch = global.fetch, oldKey = process.env.ANTHROPIC_API_KEY;
    let options, closed = 0, passedDispatcher;
    try {
      process.env.ANTHROPIC_API_KEY = 'テスト専用の偽認証';
      undici.Agent = class extends SavedAgent {
        constructor(opts) { super(opts); options = opts; }
        close(...args) { if (!args.length) closed++; return super.close(...args); }
      };
      global.fetch = async (_, opts) => { passedDispatcher = opts.dispatcher; return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[]' }] }) }; };
      await model.generateContent({ staticSystem: '照合', user: '本文' }, { provider: 'anthropic', model: 'claude-opus-5-5', fallback: false, timeoutMs });
      assert.deepEqual(options, { headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
      assert.ok(passedDispatcher instanceof SavedAgent); assert.equal(closed, 1);
    } finally { undici.Agent = SavedAgent; global.fetch = oldFetch; if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey; }
  });
  await test('G11', '書き手の呼び出しの接続設定は変更しない', async () => {
    const oldFetch = global.fetch; let dispatcher;
    try {
      global.fetch = async (_, opts) => { dispatcher = opts.dispatcher; return { ok: true, json: async () => ({ content: [{ type: 'text', text: '本文' }] }) }; };
      await model.generateContent({ staticSystem: '生成', user: '本文' }, { provider: 'anthropic', timeoutMs: 600000 });
      assert.equal(dispatcher, undefined);
    } finally { global.fetch = oldFetch; }
  });
  await test('G11', '応答失敗も接続を閉じ、照合は未実施として止める', async () => {
    const undici = require('undici'), SavedAgent = undici.Agent, oldFetch = global.fetch, oldKey = process.env.ANTHROPIC_API_KEY;
    let closed = 0;
    try {
      process.env.ANTHROPIC_API_KEY = 'テスト専用の偽認証';
      undici.Agent = class extends SavedAgent { close(...args) { if (!args.length) closed++; return super.close(...args); } };
      global.fetch = async () => { throw new Error('偽の接続失敗'); };
      const result = await F.checkArticle(raw(), { persist: false });
      assert.equal(result.record.status, 'not_run'); assert.equal(matter(result.content).data.fact_check_blocking, true);
      assert.equal(closed, 1);
    } finally { undici.Agent = SavedAgent; global.fetch = oldFetch; if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey; }
  });
  console.log(`レビュー修正2: PASS ${pass} / FAIL ${fail}\n${JSON.stringify(groups)}`);
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
