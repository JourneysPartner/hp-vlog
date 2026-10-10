'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const matter = require('gray-matter');
const F = require('../fact-check');
const G = require('../../generate-draft');
const M = require('../materials-bundle');
const model = require('../content-model');
const crawler = require('../../crawl-nta-tsutatsu');
const ROOT = path.join(__dirname, '../../..');
const correct = '制度の期限は令和9年3月31日です。';
const wrong = correct.replace('9年', '8年');
const primary = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm';
const bundle = 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4511.htm';
const groups = {};
let pass = 0, fail = 0;

async function test(group, name, fn) {
  groups[group] ||= { pass: 0, fail: 0 };
  try { await fn(); pass++; groups[group].pass++; console.log(`PASS ${group}: ${name}`); }
  catch (e) { fail++; groups[group].fail++; console.error(`FAIL ${group}: ${name}\n${e.stack}`); }
}

async function judged(sentence, summary, quote, type = '期限', status = '裏付けあり', corrected = '') {
  const claim = { id: 'c1', sentence, claim: summary, type, subject: '制度' };
  const results = await F.judgeClaims([claim], { c1: [{ id: 'e1', text: quote }] }, sentence,
    async () => [{ id: 'c1', status, quote, correct: corrected, evidence_id: 'e1' }]);
  return results[0].status;
}

async function temporary(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-review-fixes-3-'));
  try { return await fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function regenerate(provenance, updates = {}) {
  const original = `---\nslug: review-fixes-3-test\ntitle: "制度の確認"\nrecommendation: "publish"\nreview_status: "draft"\nsource_url: "${primary}"\nsource_title: "贈与税の非課税"\nsource_provenance: "${provenance}"\nsource_confidence: 0.2\ntax_terms: "贈与税 非課税"\nsource_bundle: "${bundle}"\n---\n${correct}\n`;
  const filename = '__fact-review-fixes-3__.md', target = path.join(ROOT, 'content/posts', filename);
  const saved = { read: fs.readFileSync, write: fs.writeFileSync, exists: fs.existsSync,
    argv: process.argv, generate: model.generateContent, supplement: M.supplementGenericSource };
  const env = { OPENAI_API_KEY: 'テスト専用の偽認証', ENABLE_LLM_SOURCE_SELECT: 'false',
    ENABLE_PARTIAL_REVISE: 'true', GITHUB_OUTPUT: undefined };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let written = '', supplements = 0;
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    process.argv = [process.execPath, 'generate-draft.js', '--regenerate', '--filename', filename,
      '--comment', 'タイトルを「制度の期限を確認する方法」に変更して。'];
    // 仮想の記事をメモリで読み書きし、既存の記事と取り込み結果には書き込まない。
    fs.existsSync = file => path.resolve(String(file)) === target || saved.exists(file);
    fs.readFileSync = (file, ...args) => path.resolve(String(file)) === target ? original : saved.read(file, ...args);
    fs.writeFileSync = (file, content) => {
      assert.equal(path.resolve(String(file)), target, '仮想の記事以外には書き込まない');
      written = content;
    };
    model.generateContent = async () => assert.fail('題名の直接変更ではLLMを呼ばない');
    M.supplementGenericSource = async (...args) => {
      assert.equal(M.isGenericSource(args[0]), false, '主出典は汎用ページではない');
      supplements++;
      const result = await saved.supplement(...args);
      Object.assign(args[0], updates);
      return result;
    };
    await G.main();
    assert.equal(supplements, 1);
    assert.ok(written);
    assert.equal(matter(written).content.trim(), correct);
    return matter(written).data;
  } finally {
    fs.readFileSync = saved.read; fs.writeFileSync = saved.write; fs.existsSync = saved.exists;
    process.argv = saved.argv; model.generateContent = saved.generate; M.supplementGenericSource = saved.supplement;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function main() {
  for (const [name, sentence, summary, quote, expected] of [
    ['本文が令和8年、要約と引用が令和9年', wrong, correct, correct, '資料なし'],
    ['過去の令和8年を含む文の現在の期限', '過去には令和8年と説明しましたが、期限は令和9年3月31日です。', correct, correct, '裏付けあり'],
    ['数字のない要約は本文と引用の一致を確認', correct, '制度の期限が定められています。', correct, '裏付けあり'],
    ['数字のない要約でも本文と引用の不一致を止める', wrong, '制度の期限が定められています。', correct, '資料なし'],
    ['本文にも要約にも数字がなければ通さない', '制度の期限が定められています。', '制度の期限が定められています。', correct, '資料なし'],
    ['一定を数字と読まず本文の数字へ戻る', '一定の要件を満たせば、令和9年3月31日までの贈与が対象です。', '一定の要件で期限が定められています。', correct, '裏付けあり'],
  ]) await test('H1', name, async () => assert.equal(await judged(sentence, summary, quote), expected));

  for (const [type, sentence, summary, quote] of [
    ['金額', '控除額は100万円です。', '控除額は110万円です。', '控除額は百十万円です。'],
    ['割合', '税率は10%です。', '税率は20%です。', '税率は百分の二十です。'],
    ['適用年', '制度は令和8年に適用されます。', '制度は令和9年に適用されます。', '制度は令和九年に適用されます。'],
  ]) await test('H1', `${type}の要約だけを正しても通さない`, async () => {
    assert.equal(await judged(sentence, summary, quote, type), '資料なし');
  });
  for (const status of ['食い違い', '期限の書き漏れ']) await test('H1', `${status}は原文に基づく正しい数字を照合する`, async () => {
    assert.equal(await judged(wrong, wrong, correct, '期限', status, correct), status);
  });

  for (const [sentence, quote, expected] of [
    ['税率は20%です。', '税率は百分の二十です。', '裏付けあり'],
    ['割合は2分の1です。', '割合は二分の一です。', '裏付けあり'],
    ['割合は50%です。', '割合は二分の一です。', '裏付けあり'],
    ['割合は4分の3です。', '割合は四分の一です。', '資料なし'],
    ['税率は10%です。', '税率は百分の二十です。', '資料なし'],
    ['税率は百分の二十です。', '税率は20%です。', '裏付けあり'],
    ['割合は二分の一です。', '割合は50%です。', '裏付けあり'],
    ['割合は4分の3です。', '割合は75%です。', '裏付けあり'],
    ['割合は8分の1です。', '割合は12.5％です。', '裏付けあり'],
    ['割合は4分の3です。', '割合は3分の4です。', '資料なし'],
    ['割合は20分の1です。', '割合は20%です。', '資料なし'],
    ['割合は0%です。', '割合は百分の零です。', '裏付けあり'],
    ['割合は0分の1です。', '割合は零分の一です。', '資料なし'],
    ['割合は12.5000000000000001%です。', '割合は12.5%です。', '資料なし'],
    ['割合は10000000000000001分の1です。', '割合は10000000000000000分の1です。', '資料なし'],
    ['割合は2分の1%です。', '割合は50%です。', '資料なし'],
    ['割合は2分の1%です。', '割合は0.5%です。', '裏付けあり'],
    ['割合は-20%です。', '割合は20%です。', '資料なし'],
    ['割合は-20%です。', '割合は-百分の二十です。', '裏付けあり'],
    ['割合は.5%です。', '割合は5%です。', '資料なし'],
  ]) await test('H2', `${sentence} / ${quote} → ${expected}`, async () => {
    assert.equal(await judged(sentence, sentence, quote, '割合'), expected);
  });
  await test('H2', '割合の表記差は本文と要約の照合にも使う', async () => {
    assert.equal(await judged('割合は二分の一です。', '割合は50%です。', '割合は2分の1です。', '割合'), '裏付けあり');
  });
  await test('H2', '無効な分数を数字なしの要約として通さない', async () => {
    for (const summary of ['割合は0分の1です。', '割合は二分の一般です。']) {
      assert.equal(await judged('割合は50%です。', summary, '割合は50%です。', '割合'), '資料なし');
    }
    assert.equal(await judged('税率は20%です。', '税率は20%です。', '税率は20%で、別の割合は0分の1です。', '割合'), '資料なし');
  });
  await test('H2', '一般・一定と万・億の既存の読み取りを保つ', () => {
    assert.deepEqual(F.normalizedNumbers('一般の一定の要件'), []);
    assert.deepEqual(F.normalizedNumbers('110万円 百十万円 1億2,500万円 一億二千五百万円'), ['1100000', '1100000', '125000000', '125000000']);
  });

  for (const provenance of ['domain-fallback', 'ultimate', 'unknown']) await test('H3', `${provenance}の差し戻しで資料情報を保つ`, async () => {
    const meta = await regenerate(provenance);
    assert.equal(meta.tax_terms, '贈与税 非課税'); assert.equal(meta.source_bundle, bundle);
    assert.equal(meta.source_url, primary); assert.equal(meta.source_provenance, provenance);
  });
  await test('H3', '新しい論点語だけ決まったら資料一覧を保つ', async () => {
    const meta = await regenerate('unknown', { tax_terms: '住宅取得等資金' });
    assert.equal(meta.tax_terms, '住宅取得等資金'); assert.equal(meta.source_bundle, bundle);
  });
  await test('H3', '新しい資料一覧だけ決まったら論点語を保つ', async () => {
    const meta = await regenerate('ultimate', { source_bundle: primary });
    assert.equal(meta.tax_terms, '贈与税 非課税'); assert.equal(meta.source_bundle, primary);
  });

  await test('H4', '項目0件の7ページをすべてログに出し、既存カタログを保つ', () => temporary(async dir => {
    const indexUrl = crawler.CIRCULARS.hyoka.index;
    const base = new URL('.', indexUrl).href;
    const failedUrls = Array.from({ length: 6 }, (_, i) => `${base}review-http-${i + 1}.htm`);
    const emptyUrls = Array.from({ length: 7 }, (_, i) => `${base}review-empty-${i + 1}.htm`);
    const validUrl = `${base}review-valid.htm`;
    const urls = [...failedUrls, ...emptyUrls, validUrl];
    const initial = { 'hyoka.json': '{"既存":"本文"}\n', 'hyoka.index.json': '{"entries":[]}\n',
      'index.json': JSON.stringify([{ circular: 'hyoka', provision_count: 1, errors: 0 }], null, 2) + '\n' };
    for (const [file, content] of Object.entries(initial)) fs.writeFileSync(path.join(dir, file), content);
    const fixtureDir = path.join(ROOT, 'docs/codex-tasks/fact-grounding/fixtures');
    const fixture = require(path.join(fixtureDir, 'tsutatsu-pages.json')).circulars.find(c => c.key === 'hyoka');
    const html = new TextDecoder('shift_jis').decode(fs.readFileSync(path.join(fixtureDir, fixture.files.find(f => f.kind === 'body').file)));
    const saved = { fetch: global.fetch, argv: process.argv, code: process.exitCode, warn: console.warn, output: process.env.GITHUB_OUTPUT };
    const logs = [], requests = [];
    try {
      delete process.env.GITHUB_OUTPUT;
      process.argv = [process.execPath, 'crawl-nta-tsutatsu.js', '--only', 'hyoka'];
      console.warn = (...args) => logs.push(args.join(' '));
      global.fetch = async url => {
        requests.push(url); assert.ok([indexUrl, ...urls].includes(url));
        if (failedUrls.includes(url)) return { ok: false, status: 503 };
        const body = url === indexUrl ? urls.map(u => `<a href="${u}">本文</a>`).join('')
          : url === validUrl ? html : '<p>前文だけで項目はありません。</p>';
        return { ok: true, arrayBuffer: async () => Buffer.from('<meta charset=utf-8>' + body) };
      };
      await crawler.main({ outDir: dir });
      assert.equal(process.exitCode, 1); assert.equal(requests.length, urls.length + 1);
      for (const url of emptyUrls) assert.equal(logs.filter(log => log.includes(url) && log.includes('本文ページの項目が0件です')).length, 1);
      assert.equal(logs.filter(log => log.includes('HTTP 503')).length, 5);
      assert.ok(!logs.some(log => log.includes(failedUrls[5])));
      for (const [file, content] of Object.entries(initial)) assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), content);
    } finally {
      global.fetch = saved.fetch; process.argv = saved.argv; process.exitCode = saved.code; console.warn = saved.warn;
      if (saved.output === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = saved.output;
    }
  }));
  console.log(`レビュー修正3: PASS ${pass} / FAIL ${fail}\n${JSON.stringify(groups)}`);
  process.exitCode = fail ? 1 : 0;
}

// 外部への通信は、個別テストの偽のfetch以外すべて失敗させる。
const savedFetch = global.fetch;
global.fetch = async () => assert.fail('テストでネットワークを使わない');
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { global.fetch = savedFetch; });
