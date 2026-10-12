'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');
const F = require('../fact-check');
const E = require('../fact-evidence');
const page = require('../../../netlify/functions/review-page');
const audit = require('../../audit-published-facts');
const groups = {};
let pass = 0, fail = 0;

async function test(group, name, fn) {
  groups[group] ||= { pass: 0, fail: 0 };
  try { await fn(); pass++; groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (error) { fail++; groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${error.stack}`); }
}

const now = new Date('2026-10-12T00:00:00Z');
const claim = (sentence, type = '判定', subject = '制度') => ({ id: '同じID', sentence, type, subject, heading: '制度の確認', claim: sentence });
const ref = (text = 'この制度は個別の事実に応じて判断します。') => ({ id: '資料1', title: '制度の原文', url: 'https://example.jp/source', text });
const raw = body => `---\nslug: real-run-test\nrecommendation: publish\n---\n${body}`;
const primary = 'https://www.nta.go.jp/law/shitsugi/sozoku/10/05.htm';
const primaryTitle = '小規模宅地等の特例の対象となる「被相続人等の居住の用に供されていた宅地等」の判定';
const supplement = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4124.htm';
// #643 と同じ主出典・制度のメタデータ。CIでは下書きのリモートブランチに依存しない。
const draft = (body, extra = '') => `---\ntitle: "小規模宅地の特例、親の家は「居住用」と認められる？判定の考え方と注意すべきケース"\nslug: shitsugi-sozoku-10-05\nsource_url: "${primary}"\nsource_title: "${primaryTitle}"\nsource_provenance: explicit\nsource_confidence: 1\nsource_guard_version: 1\ntax_domain: inheritance_tax\nrecommendation: publish\n${extra}---\n${body}`;
const housing = '二世帯住宅の場合は、構造や出入口の状況、各世帯の独立性などによって判断が変わります。';
const rebuilding = '建て替えのために一時的に居住の用に供されなくなった場合の扱いは、租税特別措置法の条文でも「居住の用に供されなくなる直前の居住の用」が一定の範囲で含まれる旨が規定されています。';

const supported = request => JSON.parse(request.user).claims.map(c => ({ id: c.id, status: '裏付けあり', quote: c.sentence, evidence_id: '資料1' }));
const missing = request => JSON.parse(request.user).claims.map(c => ({ id: c.id, status: '資料なし' }));
const options = extra => ({ enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', now, persist: false, ...extra });
const meta = result => matter(result.content).data;

async function main() {
  await test('E1', '判定の資料なし10件と金額の裏付け2件は本文を保持し承認可能', async () => {
    const judgments = Array.from({ length: 10 }, (_, i) => claim(`確認項目${i + 1}は状況により判断します。`));
    const amounts = [claim('制度甲の控除額は100万円です。', '金額'), claim('制度乙の控除額は200万円です。', '金額')];
    const items = [...judgments, ...amounts], body = items.map(c => c.sentence).join('\n');
    const calls = [];
    const result = await F.checkArticle(raw(body), options({ searchEvidence: () => [ref(amounts.map(c => c.sentence).join('\n'))], callLLM: async request => {
      calls.push(request.task);
      if (request.task === 'extract') return items;
      if (request.task === 'judge') return JSON.parse(request.user).claims.map(c => ({ id: c.id,
        status: c.type === '金額' ? '裏付けあり' : '資料なし', quote: c.type === '金額' ? c.sentence : '', evidence_id: '資料1' }));
      assert.fail('資料なしの判定を修正に送ってはいけません');
    } }));
    assert.equal(result.record.status, 'ok'); assert.equal(result.body, body);
    assert.equal(result.record.review_items.length, 10); assert.equal(result.record.remaining.length, 0);
    assert.equal(result.record.corrections.length, 0); assert.equal(calls.includes('repair'), false);
    assert.equal(meta(result).fact_check_blocking, false); assert.equal(meta(result).recommendation, 'publish');
    assert.match(meta(result).fact_check_summary, /人が確かめる箇所 10 件/);
    for (const c of result.record.review_items) {
      assert.equal(c.heading, '制度の確認'); assert.equal(c.subject, '制度'); assert.equal(c.type, '判定');
      assert.deepEqual(c.evidence, [{ id: '資料1', title: '制度の原文', url: 'https://example.jp/source' }]);
    }
  });

  for (const type of ['要件', '手続']) await test('E1', `${type}の資料なしは修正せず一覧に残す`, async () => {
    const sentence = 'この制度の取扱いは個別の事情によって決まります。';
    const result = await F.checkArticle(raw(sentence), options({ searchEvidence: () => [ref()], callLLM: async request => {
      if (request.task === 'extract') return [claim(sentence, type)];
      assert.equal(request.task, 'judge'); return missing(request);
    } }));
    assert.equal(result.body, sentence); assert.equal(result.record.status, 'ok');
    assert.equal(result.record.review_items[0].type, type); assert.equal(meta(result).fact_check_blocking, false);
  });

  await test('E1', '資料なしの期限だけを案内に変え、判定の原文と再照合の一覧を保持', async () => {
    const deadline = '制度の申請期限は令和9年3月31日です。';
    const judgment = '個別の事情を確認したうえで制度の対象か判定します。';
    const guidance = '詳しくは国税庁の制度の案内で確認してください。';
    const before = `## 制度\n${deadline}\n${judgment}\nその他の説明はそのまま残します。`;
    const after = before.replace(deadline, guidance);
    const result = await F.checkArticle(raw(before), options({ searchEvidence: () => [ref()], callLLM: async request => {
      if (request.task === 'extract') return request.user.includes(deadline)
        ? [claim(deadline, '期限'), claim(judgment)] : [claim(guidance, '手続')];
      if (request.task === 'judge') return missing(request);
      assert.equal(request.task, 'repair');
      const corrections = JSON.parse(request.user).corrections;
      assert.equal(corrections.length, 1); assert.equal(corrections[0].type, '期限');
      return after;
    } }));
    assert.equal(result.body, after); assert.equal(result.record.status, 'ok');
    assert.equal(result.record.corrections[0].resolved, true); assert.equal(result.record.corrections[0].generalized, true);
    assert.equal(result.record.review_items.length, 2); assert.equal(meta(result).fact_check_blocking, false);
  });

  await test('E1', '資料なしの期限が修正後も残れば差し止める', async () => {
    const sentence = '制度の期限は令和9年3月31日です。';
    let repairs = 0;
    const result = await F.checkArticle(raw(sentence), options({ searchEvidence: () => [ref()], callLLM: async request => {
      if (request.task === 'extract') return [claim(sentence, '期限')];
      if (request.task === 'judge') return missing(request);
      repairs++; return sentence;
    } }));
    assert.equal(repairs, 1); assert.equal(result.record.status, 'revise'); assert.equal(result.body, sentence);
    assert.equal(meta(result).fact_check_blocking, true); assert.equal(result.record.review_items.length, 0);
  });

  for (const status of ['食い違い', '期限の書き漏れ']) await test('E1', `判定の${status}が残れば差し止める`, async () => {
    const sentence = 'この制度は条件を満たせばいつでも適用できます。';
    const correct = 'この制度の適用には令和9年3月31日までの申請が必要です。';
    const result = await F.checkArticle(raw(sentence), options({ searchEvidence: () => [ref(correct)], callLLM: async request => {
      if (request.task === 'extract') return [claim(sentence)];
      if (request.task === 'judge') return JSON.parse(request.user).claims.map(c => ({ id: c.id, status, quote: correct, correct, evidence_id: '資料1' }));
      return sentence;
    } }));
    assert.equal(result.record.status, 'revise'); assert.equal(result.record.remaining[0].status, status);
    assert.equal(meta(result).fact_check_blocking, true); assert.equal(result.record.review_items.length, 0);
  });

  await test('E1', '判定の食い違いは該当文だけ修正し、裏付けが得られれば承認可能', async () => {
    const wrong = '届出がなければ売れ残り在庫を低く評価できません。';
    const correct = '季節商品の売れ残りは届出がなくても評価損を計上できます。';
    const untouched = '個別の事情について資料を整理してください。';
    const body = `## 制度\n${wrong}\n${untouched}`;
    const result = await F.checkArticle(raw(body), options({ searchEvidence: () => [ref(correct)], callLLM: async request => {
      if (request.task === 'extract') return [claim(request.user.includes(wrong) ? wrong : correct)];
      if (request.task === 'judge') return JSON.parse(request.user).claims.map(c => ({ id: c.id,
        status: c.sentence === wrong ? '食い違い' : '裏付けあり', quote: correct, correct, evidence_id: '資料1' }));
      return body.replace(wrong, correct);
    } }));
    assert.equal(result.body, body.replace(wrong, correct)); assert.equal(result.record.status, 'ok');
    assert.equal(result.record.corrections[0].resolved, true); assert.equal(meta(result).fact_check_blocking, false);
  });

  for (const type of ['金額', '割合', '期限', '適用年', '番号']) await test('E1', `${type}の資料なし・上限超過・捨てた主張は差し止める`, async () => {
    const one = claim('制度甲の値は100です。', type), two = claim('制度乙の値は200です。', type);
    for (const mode of ['資料なし', '上限超過', '捨てた主張']) {
      const body = mode === '捨てた主張' ? one.sentence : one.sentence + two.sentence;
      const result = await F.checkArticle(raw(body), options({ repair: false, maxNumericClaims: mode === '上限超過' ? 1 : 120,
        searchEvidence: () => [ref(body)], callLLM: async request => {
          if (request.task === 'extract') return [one, two];
          return mode === '資料なし' ? missing(request) : supported(request);
        } }));
      assert.equal(result.record.status, 'revise', mode); assert.equal(meta(result).fact_check_blocking, true, mode);
      if (mode === '上限超過') assert.equal(result.record.dropped, 1);
      if (mode === '捨てた主張') assert.equal(result.record.discarded, 1);
    }
  });

  await test('E1', '上限で判定だけが落ちた場合は承認でき、候補を一覧に保持', async () => {
    const amount = claim('この制度の控除額は100万円です。', '金額'), judgment = claim('個別の事実に応じて判定します。');
    const firstJudgment = claim('もう一つの制度を個別に判定します。');
    const body = firstJudgment.sentence + judgment.sentence + amount.sentence;
    const result = await F.checkArticle(raw(body), options({ maxClaims: 1, repair: false, searchEvidence: () => [ref(body)],
      callLLM: async request => request.task === 'extract' ? [firstJudgment, judgment, amount] : supported(request) }));
    assert.equal(result.record.status, 'ok'); assert.equal(result.record.dropped, 1); assert.equal(result.body, body);
    assert.equal(result.record.review_items[0].sentence, judgment.sentence);
    assert.equal(result.record.review_items[0].status, '上限で未照合'); assert.equal(result.record.review_items[0].evidence[0].id, '資料1');
    assert.equal(meta(result).fact_check_blocking, false);
  });

  for (const type of ['要件', '判定', '手続']) await test('E1', `本文にない${type}だけを捨てた場合は一覧に残し承認可能`, async () => {
    const absent = claim('本文にない記述です。', type);
    // 長い本文でも、抽出された非数値の主張を捨てたことを未実施と取り違えない。
    const body = 'この文章は制度の背景を説明するものです。'.repeat(20);
    const result = await F.checkArticle(raw(body), options({ repair: false, searchEvidence: () => [ref()],
      callLLM: async request => { assert.equal(request.task, 'extract'); return [absent]; } }));
    assert.equal(result.record.status, 'ok'); assert.equal(result.record.discarded, 1); assert.equal(result.body, body);
    assert.equal(result.record.review_items[0].sentence, absent.sentence);
    assert.equal(result.record.review_items[0].status, '本文に見つからない'); assert.equal(meta(result).fact_check_blocking, false);
  });

  await test('E1', '未知の種類を捨てた場合は資料なしの緩和対象にしない', async () => {
    const body = '個別の事情を確認します。';
    const result = await F.checkArticle(raw(body), options({ repair: false, searchEvidence: () => [],
      callLLM: async () => [claim(body, '未知の種類')] }));
    assert.equal(result.record.status, 'revise'); assert.equal(meta(result).fact_check_blocking, true);
    assert.equal(result.record.review_items.length, 0);
  });

  await test('E1', '上限では金額・期限・割合・適用年・番号を先に残す', async () => {
    const types = ['手続', '判定', '要件', '番号', '適用年', '割合', '期限', '金額'];
    const items = types.map(type => claim(`${type}の値は100です。`, type)), body = items.map(c => c.sentence).join('');
    const extracted = await F.extractClaims(body, async () => items, { maxNumericClaims: 5, maxClaims: 2 });
    assert.deepEqual(extracted.claims.map(c => c.type), ['金額', '期限', '割合', '適用年', '番号', '要件', '判定']);
    assert.deepEqual(extracted.droppedClaims.map(c => c.type), ['手続']);
  });

  await test('E2', '#643の主出典が資料束のない記事でも各主張の候補に入る', async () => {
    const candidates = [], body = `${housing}\n${rebuilding}`;
    const result = await F.checkArticle(draft(body), options({ repair: false, callLLM: async request => {
      if (request.task === 'extract') return [claim(housing, '判定', '小規模宅地等の特例'), claim(rebuilding, '要件', '小規模宅地等の特例')];
      const payload = JSON.parse(request.user), rows = payload.claims;
      for (const c of rows) {
        const refs = c.evidence_ids.map(id => payload.evidence.find(e => e.id === id));
        assert.equal(refs[0].id, primary); assert.equal(E.evidenceCatalog().entries.find(e => e.id === refs[0].id).kind, 'shitsugi');
        assert.equal(refs[0].title, primaryTitle); assert.ok(refs[0].text.includes('生活の拠点'));
        assert.ok(refs.every(e => e.text.length <= 4000));
        candidates.push({ sentence: c.sentence, evidence: refs.map(({ id, title }) => ({ id, title })) });
      }
      return missing(request);
    } }));
    assert.equal(result.record.status, 'ok'); assert.equal(candidates.length, 2);
    console.log('#643 根拠の候補:', JSON.stringify(candidates));
  });

  await test('E2', '資料束の法令と通達・補助出典を優先し、7件以内で重複を除く', async () => {
    const refs = E.searchEvidence(claim(housing, '判定', '小規模宅地等の特例'), {
      source_url: primary, source_supplements: [{ url: primary }, { url: supplement }],
      source_bundle: `${primary};${supplement};措法69条の4;law:sozokuzei:21_6;所基通47-22`,
    });
    assert.equal(refs[0].id, primary); assert.equal(refs[1].url, supplement);
    for (const id of ['law:sozeki_hou:69_4', 'law:sozokuzei:21_6', 'tsutatsu:shotoku:47-22']) assert.ok(refs.some(e => e.id === id), id);
    assert.ok(refs.length <= 7); assert.equal(new Set(refs.map(e => e.id)).size, refs.length);
    assert.ok(refs.every(e => e.text.length <= 2000));
  });

  for (const frontmatter of [`source_2_url: "${supplement}"\n`, `source_supplements:\n  - url: "${supplement}"\n`]) {
    await test('E2', 'frontmatterの補助出典と資料束の法令を判定へ渡す', async () => {
      let judged = false;
      await F.checkArticle(draft(housing, frontmatter + 'source_bundle: "措法69条の4"\n'), options({ repair: false, callLLM: async request => {
        if (request.task === 'extract') return [claim(housing, '判定', '小規模宅地等の特例')];
        judged = true;
        const payload = JSON.parse(request.user);
        const refs = payload.claims[0].evidence_ids.map(id => payload.evidence.find(e => e.id === id));
        assert.equal(refs[0].id, primary); assert.equal(refs[1].url, supplement);
        assert.ok(refs.some(e => e.id === 'law:sozeki_hou:69_4')); return missing(request);
      } }));
      assert.equal(judged, true);
    });
  }

  await test('E2', '記事資料が7件あっても主出典を落とさず、検索の上位3件も押し出さない。未収録資料は候補に入れない', () => {
    const urls = ['3306', '3307', '4452', '4511', '4508', '4124'].map(no => E.evidenceCatalog().entries.find(e => e.kind === 'taxanswer' && e.no === no).url);
    const searchOnly = E.searchEvidence(claim(housing), {});
    const refs = E.searchEvidence(claim(housing), { source_url: primary, source_supplements: urls.map(url => ({ url })),
      source_bundle: 'https://example.invalid/not-in-catalog;law:unknown:999' });
    assert.equal(refs.length, 7); assert.equal(refs[0].id, primary); assert.equal(new Set(refs.map(e => e.id)).size, 7);
    for (const top of searchOnly.slice(0, 3)) assert.ok(refs.some(e => e.id === top.id), `検索の上位 ${top.id}`);
    assert.ok(refs.every(e => e.url !== 'https://example.invalid/not-in-catalog' && e.id !== 'law:unknown:999'));
  });

  await test('E2', '補助出典の配列とsource_2_urlが共存しても両方を候補に入れる', () => {
    const other = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4511.htm';
    const refs = E.searchEvidence(claim(housing), F.articleEvidenceOptions({ source_url: primary,
      source_supplements: [{ url: supplement }], source_2_url: other }));
    assert.equal(refs[0].id, primary); assert.ok(refs.some(e => e.url === supplement)); assert.ok(refs.some(e => e.url === other));
  });

  await test('E2', '公開済み記事の照合でも主出典・補助出典・資料束を渡す', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-real-run-audit-'));
    try {
      const post = { ...matter(draft(housing, `source_2_url: "${supplement}"\nsource_bundle: "措法69条の4"\n`)).data,
        review_status: 'published', published_at: '2026-10-01', file: 'test.md', body: housing };
      let judged = false;
      const result = await audit.run([], options({ posts: [post], auditDir: dir, log: () => {}, callLLM: async request => {
        if (request.task === 'extract') return [claim(housing)];
        assert.equal(request.task, 'judge'); judged = true;
        const payload = JSON.parse(request.user);
        const refs = payload.claims[0].evidence_ids.map(id => payload.evidence.find(e => e.id === id));
        assert.equal(refs[0].id, primary); assert.ok(refs.some(e => e.url === supplement));
        assert.ok(refs.some(e => e.id === 'law:sozeki_hou:69_4')); return missing(request);
      } }));
      assert.equal(judged, true); assert.equal(result.records[0].status, 'ok');
      assert.equal(result.records[0].review_items.length, 1); assert.equal(result.records[0].body_sha256, F.bodyHash(housing));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('E2', '長い記事資料も主張の語で連続した2000文字以内の原文を渡す', () => {
    const body = '冒頭の別の話題。'.repeat(400) + '対象となる制度の確認事項です。' + '末尾の説明。'.repeat(400);
    const title = '対象となる制度';
    const entry = { id: 'local-long', kind: 'shitsugi', title, url: primary, text: body, tokens: new Set(), titleTokens: new Set() };
    const refs = E.searchEvidence(claim('対象となる制度の確認事項です。', '要件', title), { source_url: primary, catalog: { entries: [entry], df: new Map() } });
    assert.equal(refs.length, 1); assert.ok(refs[0].text.length <= 2000); assert.ok(body.includes(refs[0].text));
    assert.ok(refs[0].text.includes('対象となる制度の確認事項です。'));
  });

  for (const wrap of [json => `前置きです。\n${json}\n後書きです。`, json => `前置きです。\n\`\`\`json\n${json}\n\`\`\`\n後書きです。[参考]`]) {
    await test('E3', '前置き・後書き・フェンスと文字列内の括弧や引用符を読める', async () => {
      const sentence = '制度の「[条件]」と引用符"、記号\\を確認します。';
      let calls = 0;
      const result = await F.extractClaims(sentence, async request => {
        calls++; assert.match(request.system, /claim は60文字以内/);
        return { text: wrap(JSON.stringify([claim(sentence)])) };
      });
      assert.equal(calls, 1); assert.equal(result.claims[0].sentence, sentence); assert.equal(result.discarded, 0);
    });
  }

  await test('E3', '切れた応答は見出し境界で2分割し、全体で重複除去・上限・IDを振り直す', async () => {
    const one = claim('制度甲は事実により判定します。'), two = claim('制度乙の控除額は100万円です。', '金額');
    const body = `## 制度甲\n${one.sentence}\n\n## 制度乙\n${two.sentence}`;
    const calls = [];
    const extracted = await F.extractClaims(body, async request => {
      calls.push(request.user);
      if (calls.length === 1) return '[{"id":"切れた';
      return JSON.stringify(request.user.includes(one.sentence) ? [one, one] : [two]);
    }, { maxClaims: 1 });
    assert.equal(calls.length, 3); assert.equal(calls[1] + calls[2], body); assert.ok(calls[2].startsWith('## 制度乙'));
    assert.equal(extracted.claims[0].type, '判定'); assert.equal(extracted.claims[0].id, 'c1');
    assert.deepEqual(extracted.claims.map(c => c.id), ['c1', 'c2']);
    assert.equal(extracted.dropped, 0); assert.equal(extracted.discarded, 0);
  });

  await test('E3', '2分割の成功後も全ての主張を照合し、同じIDを振り直す', async () => {
    const one = claim('制度甲の控除額は100万円です。', '金額'), two = claim('制度乙の控除額は200万円です。', '金額');
    const body = `導入です。\n## 制度甲\n${one.sentence}\n## 制度乙\n${two.sentence}`;
    let extracts = 0;
    const result = await F.checkArticle(raw(body), options({ repair: false, searchEvidence: () => [ref(body)], callLLM: async request => {
      if (request.task === 'extract') {
        extracts++;
        if (extracts === 1) return '[{"sentence":';
        return request.user.includes(one.sentence) ? [one] : [two];
      }
      return supported(request);
    } }));
    assert.equal(extracts, 3); assert.equal(result.record.status, 'ok'); assert.equal(result.body, body);
    assert.deepEqual(result.record.claims.map(c => c.id), ['c1', 'c2']);
  });

  await test('E3', '片方でも再抽出が読めなければ部分結果を通さずnot_runとSyntaxErrorだけ残す', async () => {
    const body = '## 制度甲\n制度甲の説明です。\n## 制度乙\n制度乙の説明です。';
    let calls = 0;
    const result = await F.checkArticle(raw(body), options({ callLLM: async request => {
      assert.equal(request.task, 'extract'); calls++;
      return calls === 2 ? [claim('制度甲の説明です。')] : '[{"鍵のような文字列":"秘匿すべき内容';
    } }));
    assert.equal(calls, 3); assert.equal(result.record.status, 'not_run'); assert.equal(result.record.error, 'SyntaxError');
    assert.equal(result.body, body); assert.equal(meta(result).fact_check_blocking, true);
    assert.ok(!JSON.stringify(result.record).includes('秘匿すべき内容'));
  });

  await test('E3', '見出しの境界がない壊れた応答はnot_runで止め、fail-openの既定を保持', async () => {
    const body = '制度の説明です。';
    for (const failOpen of [false, true]) {
      let calls = 0;
      const result = await F.checkArticle(raw(body), options({ failOpen, callLLM: async () => { calls++; return '['; } }));
      assert.equal(calls, 1); assert.equal(result.record.status, 'not_run'); assert.equal(result.record.error, 'SyntaxError');
      assert.equal(meta(result).fact_check_blocking, !failOpen);
    }
  });

  await test('E3', 'JSON解析以外の呼び出し障害は再試行せずnot_run', async () => {
    let calls = 0;
    const result = await F.checkArticle(raw('## 制度甲\n説明です。\n## 制度乙\n説明です。'), options({ callLLM: async () => {
      calls++; throw new Error('任意の障害の文面');
    } }));
    assert.equal(calls, 1); assert.equal(result.record.status, 'not_run'); assert.equal(result.record.error, 'Error');
    assert.equal(meta(result).fact_check_blocking, true);
  });

  await test('E4', '一覧の文・種類・見出し・制度名・候補のリンクをエスケープし、既存の並びを保持', () => {
    const item = { sentence: '<script>記述</script>', type: '<判定>', heading: '見出し&"', subject: '<制度>', status: '資料なし',
      evidence: [{ id: 'x', title: '<候補>', url: 'https://example.jp/?a="&b=1' }, { id: 'unsafe', title: '安全な文字列', url: 'javascript:alert(1)' }] };
    const record = { status: 'ok', body_sha256: F.bodyHash('本文'), review_items: [item], corrections: [], remaining: [] };
    for (const data of [record, F.compactRecord(record)]) {
      const html = page.renderFactCheck({ fact_check_status: 'ok' }, data, '本文');
      assert.ok(html.includes('人が確かめる箇所（資料が見つからなかった記述）'));
      assert.ok(html.includes('この一覧は承認を止める理由ではなく'));
      for (const escaped of ['&lt;script&gt;記述&lt;/script&gt;', '&lt;判定&gt;', '見出し&amp;&quot;', '&lt;制度&gt;', '&lt;候補&gt;']) assert.ok(html.includes(escaped), escaped);
      assert.ok(html.includes('href="https://example.jp/?a=&quot;&amp;b=1"')); assert.ok(!html.includes('javascript:'));
      assert.ok(html.indexOf('直した箇所') < html.indexOf('資料が無く案内に変えた箇所'));
      assert.ok(html.indexOf('資料が無く案内に変えた箇所') < html.indexOf('残った食い違い'));
      assert.ok(html.indexOf('残った食い違い') < html.indexOf('人が確かめる箇所'));
      assert.ok(!page.renderFactCheck({}, data, '変更した本文').includes('&lt;script&gt;記述'));
    }
  });

  await test('E4', '保存・再読込した資料なしの一覧をレビュー画面に表示し、承認ボタンを有効にする', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-real-run-fixes-'));
    try {
      const sentence = 'この制度の対象は事情によって判断します。';
      const result = await F.checkArticle(raw(sentence), options({ persist: true, recordDir: dir, searchEvidence: () => [ref()],
        callLLM: async request => request.task === 'extract' ? [claim(sentence)] : missing(request) }));
      const record = JSON.parse(fs.readFileSync(result.recordFile, 'utf8'));
      assert.equal(record.review_items.length, 1); assert.ok(record.review_items[0].evidence_ids.length);
      assert.equal(F.evidenceRefs(record, record.review_items[0])[0].title, '制度の原文');
      const html = page.renderReviewPage('test.md', meta(result), sentence, 'draft/test', null, record);
      assert.ok(html.includes(sentence)); assert.ok(html.includes('人が確かめる箇所'));
      assert.match(html, /id="btnApprove"[^>]*>/); assert.ok(!/id="btnApprove"[^>]* disabled/.test(html));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  console.log(`\n実AI確認後の修正: PASS ${pass} / FAIL ${fail}`);
  console.log('E別集計:', JSON.stringify(groups));
  process.exitCode = fail ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
