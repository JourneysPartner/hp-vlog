'use strict';

// 保存済みHTMLと偽の取得関数だけで確認する。出力先はすべてOSの一時領域。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../tsutatsu-parser');
const C = require('../../crawl-nta-tsutatsu');
const ROOT = path.resolve(__dirname, '../../..');
const FIXTURES = path.join(ROOT, 'docs/codex-tasks/tsutatsu-crawl/fixtures');
let passed = 0, failed = 0;

async function test(label, fn) {
  try { await fn(); passed++; console.log(`成功: ${label}`); }
  catch (error) { failed++; console.error(`失敗: ${label}\n${error.stack}`); }
}

const provision = '<h2>（試験項目）</h2><p><strong>11</strong>本文です。</p>';
const missing = '<title>指定されたページを表示できませんでした</title>';
const noProvision = '<h1>目次</h1><p>番号のない前文です。</p>';
const noPause = async () => {};

async function importCase({ total = 1, missingCount = 0, nonProvisionCount = 0, badPage, success = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsutatsu-import-'));
  const saved = { argv: process.argv, code: process.exitCode, output: process.env.GITHUB_OUTPUT,
    log: console.log, warn: console.warn, error: console.error };
  const initial = {
    'hyoka.json': '{"既存":"本文"}\n',
    'hyoka.index.json': '{"entries":[{"id":"既存"}]}\n',
    'index.json': JSON.stringify([{ circular: 'hyoka', provision_count: 1 },
      { circular: 'shotoku', provision_count: 123 }], null, 2) + '\n',
  };
  try {
    for (const [file, text] of Object.entries(initial)) fs.writeFileSync(path.join(dir, file), text);
    process.argv = [process.execPath, 'crawl-nta-tsutatsu.js', '--only', 'hyoka'];
    process.exitCode = 0;
    process.env.GITHUB_OUTPUT = path.join(dir, 'github-output');
    const logs = [];
    console.log = console.warn = console.error = (...args) => logs.push(args.join(' '));
    const base = new URL('.', C.CIRCULARS.hyoka.index).href;
    const pages = Array.from({ length: total }, (_, i) => ({
      url: `${base}${i === 0 && nonProvisionCount ? 'fusoku/' : ''}test-${i}.htm`,
      html: i < nonProvisionCount ? (i === 0 ? provision : noProvision)
        : i < nonProvisionCount + missingCount ? missing : provision,
    }));
    if (badPage !== undefined) pages[total - 1].html = badPage;
    const requests = [];
    const fetchPage = async url => {
      requests.push(url);
      if (url === C.CIRCULARS.hyoka.index) return pages.map(p => `<a href="${p.url}">節</a>`).join('');
      const page = pages.find(p => p.url === url);
      assert.ok(page, `予期しない取得: ${url}`);
      if (page.html instanceof Error) throw page.html;
      return page.html;
    };
    await C.main({ outDir: dir, fetchPage, pause: noPause });
    assert.equal(requests.length, total + 1, '目次と各節を1回ずつ取得する');
    assert.equal(process.exitCode, success ? 0 : 1, '取り込み可否が終了コードに反映される');
    const output = fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8');
    assert.match(output, success ? /errors=0\n/ : /errors=[1-9]\d*\n/);
    if (success) {
      const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'hyoka.json'), 'utf8'));
      assert.deepEqual(catalog.missing_pages, pages.filter(p => p.html === missing).map(p => ({ url: p.url })));
      assert.deepEqual(catalog.non_provision_pages.map(p => p.url), pages.slice(0, nonProvisionCount).map(p => p.url));
      assert.ok(catalog.non_provision_pages.every(p => p.reason));
      assert.deepEqual(Object.keys(catalog.provisions), ['11']);
      const entries = [].concat(catalog.provisions['11']);
      assert.equal(entries.length, total - nonProvisionCount - missingCount);
      assert.ok(entries.every(p => p.body === '本文です。'));
      const search = JSON.parse(fs.readFileSync(path.join(dir, 'hyoka.index.json'), 'utf8'));
      assert.equal(search.entries.length, entries.length);
      const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
      assert.deepEqual(index.find(p => p.circular === 'shotoku'), { circular: 'shotoku', provision_count: 123 });
      assert.equal(index.find(p => p.circular === 'hyoka').errors, 0);
    } else {
      for (const [file, text] of Object.entries(initial)) {
        assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), text, `${file}をバイト単位で保持する`);
      }
    }
    for (const page of pages.slice(0, nonProvisionCount + missingCount)) {
      assert.ok(logs.some(log => log.includes(page.url)), `記録したURLをログに出す: ${page.url}`);
    }
    if (nonProvisionCount || missingCount) {
      assert.ok(logs.some(log => log.includes(`項目の無いページ: ${nonProvisionCount} 件 / リンク切れ: ${missingCount} 件`)));
    }
  } finally {
    process.argv = saved.argv; process.exitCode = saved.code;
    if (saved.output === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = saved.output;
    console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const pages = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8')).pages;
  const counts = {}, belowMinimum = [];
  assert.equal(pages.length, 66);
  for (const page of pages) await test(`T1 ${page.url}`, () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'pages', page.file), 'utf8');
    const result = P.classifyTsutatsuPage(html, { url: page.url, circular: page.circular });
    counts[result.type] = (counts[result.type] || 0) + 1;
    if (result.provisions.length < page.min_items) belowMinimum.push(page.url);
    if (page.expected === 'provisions') {
      assert.equal(result.type, 'provisions');
      assert.ok(result.provisions.length >= page.min_items, `${result.provisions.length} < ${page.min_items}`);
      if (page.circular === 'hyoka' || page.circular.startsWith('sochi_')) {
        const basic = P.parseTsutatsuPage(html).provisions;
        assert.ok(basic.length >= page.basic_parser_items);
        const remaining = result.provisions.map(p => p.no);
        for (const item of basic) {
          const at = remaining.indexOf(item.no);
          assert.ok(at >= 0, `通常用で読める${item.no}を読み落とさない`);
          remaining.splice(at, 1);
        }
      }
    } else if (page.expected === 'missing') assert.equal(result.type, 'missing');
    else assert.ok(['provisions', 'non_provision'].includes(result.type), result.type);
  });
  console.log(`66ページの分類: ${JSON.stringify(counts)} / min_items未達: ${JSON.stringify(belowMinimum)}`);

  const numberCases = [
    ['<span class="bold">1－3の2－2</span>', '1-3の2-2'],
    ['<strong>31</strong><strong>の2-21　</strong>', '31の2-21'],
    ['<b>16-3の2-1&emsp;</b>', '16-3の2-1'],
    ['<strong>1</strong>&ensp;<span id="番号" class="extra bold">－3</span><b>－2&thinsp;</b>', '1-3-2'],
    ["<span class='bold extra'>６&#xff0d;４&#45;５&#x2003;&#8194;&#160;&nbsp;</span>", '6-4-5'],
    ['<b>6-4-5&#99999999;</b>', null],
    ['<span class="not-bold">6-4-5</span>', null],
    ['説明<strong>6-4-5</strong>', null],
  ];
  for (const circular of ['hojin', 'hyoka', 'sochi_hojin']) {
    for (const [markup, no] of numberCases) await test(`T2 ${circular}: ${markup}`, () => {
      const result = P.parseTsutatsuPage(`<h2>（番号）</h2><p>${markup}本文です。</p>`, { circular });
      assert.deepEqual(result.provisions.map(p => p.no), no ? [no] : []);
      if (no) assert.equal(result.provisions[0].body, '本文です。');
    });
  }
  await test('T2 番号のない本文は項目なし、有効な番号を読み落としたら停止する', () => {
    assert.equal(P.classifyTsutatsuPage(noProvision).type, 'non_provision');
    for (const markup of ['<strong>1-2</strong>', '<b>１－２</b>', '<span class="bold">1-2</span>']) {
      assert.equal(P.classifyTsutatsuPage(`<p>${markup}</p>`).type, 'unreadable');
    }
    for (const name of ['fusoku', 'bessi', 'zenbun']) {
      const result = P.classifyTsutatsuPage(provision, { circular: 'hyoka', url: `https://www.nta.go.jp/${name}/01.htm` });
      assert.equal(result.type, 'non_provision');
      assert.deepEqual(result.provisions, []);
      assert.equal(P.classifyTsutatsuPage(missing, { url: `https://www.nta.go.jp/${name}/01.htm` }).type, 'missing');
    }
    assert.throws(() => P.parseTsutatsuPage(missing), /国税庁のエラーページです/);
    assert.throws(() => P.parseIndexPage(missing, 'hyoka', C.CIRCULARS.hyoka.index));
    assert.equal(P.classifyTsutatsuPage('<h2>附則</h2><p><strong>1</strong>適用日です。</p>', { circular: 'shotoku' }).type, 'non_provision');
    assert.equal(P.classifyTsutatsuPage('<h2>共通事項</h2><p><strong>64～66(共)-1</strong>本文です。</p>', { circular: 'sochi_hojin' }).type, 'non_provision');
  });
  await test('T2 通常用で有効な範囲形を措置法用でも取りこぼさない', () => {
    const html = '<h2>共通事項</h2><p><strong>10の3～14共-1</strong>本文です。</p>';
    const basic = P.parseTsutatsuPage(html, { circular: 'shotoku' });
    const extended = P.parseTsutatsuPage(html, { circular: 'sochi_shotoku' });
    assert.deepEqual(extended.provisions.map(p => p.no), basic.provisions.map(p => p.no));
    assert.deepEqual(extended.provisions.map(p => p.no), ['10の3～14共-1']);
  });
  await test('T2 h1なしでも本文を読み、本文後のナビゲーションは含めない', () => {
    const html = '<!-- InstanceEndEditable --><!-- InstanceBeginEditable name="bodyArea" -->'
      + provision + '<!-- InstanceEndEditable --><p><strong>12</strong>ナビゲーション</p>';
    const result = P.parseTsutatsuPage(html, { circular: 'hyoka' });
    assert.deepEqual(result.provisions.map(p => p.no), ['11']);
    assert.equal(result.provisions[0].body, '本文です。');
    const fallback = P.parseTsutatsuPage('<!-- InstanceEndEditable -->' + provision
      + '<!-- InstanceEndEditable --><p><strong>12</strong>ナビゲーション</p>', { circular: 'hyoka' });
    assert.deepEqual(fallback.provisions, result.provisions);
  });

  await test('T3 項目なしと3%ちょうどのリンク切れは記録して取り込む', () =>
    importCase({ total: 100, missingCount: 3, nonProvisionCount: 2, success: true }));
  await test('T3 リンク切れが10件ちょうど、3%以内なら取り込む', () =>
    importCase({ total: 400, missingCount: 10, success: true }));
  await test('T3 リンク切れが3%を超えたら既存を保持する', () =>
    importCase({ total: 33, missingCount: 1 }));
  await test('T3 リンク切れが3%未満なら取り込む', () =>
    importCase({ total: 34, missingCount: 1, success: true }));
  await test('T3 リンク切れが3%以内でも11件あれば既存を保持する', () =>
    importCase({ total: 400, missingCount: 11 }));
  await test('T3 読み落としが1件でもあれば既存を保持する', () =>
    importCase({ total: 2, badPage: '<h2>（本文なし）</h2><p><b>11</b></p>' }));
  for (const message of ['HTTP 503', '時間切れ', '国税庁のエラーページです']) {
    await test(`T3 取得時の例外「${message}」は既存を保持する`, () =>
      importCase({ total: 2, badPage: new Error(message) }));
  }
  await test('T3 全ページが項目なしなら0項目なので既存を保持する', () =>
    importCase({ badPage: noProvision }));

  // 修正前のパーサーで取得した04の10本文ページの結果。番号・本文・重複を含めて固定する。
  const hashes = [
    '7f96f4ba3344829c263147a6528744ddac63fd5963441096eab16870681433d0',
    'ee66f3821d49e8e964d16dcd5be90b5134b59a3f95dcee0bb73612bede3bef0c',
    '02924f30a1be0924e600fa9c854437d15611272f12fd603e3caecdfd5d86a390',
    'cb5b49c855321870184aa694bddef23a3462f7da192e63566821d3565d9692c3',
    '26986ea8e8c64c8dab7a3c60a601b1df505f470a2b278904150e4d1a703bd2d4',
    '2a6e8d88cb1eb4c233f95a13377e61755275a17d26acbed135b9959491257ae9',
    'c1dd2bec26fc1d70ff776ad6aaa6b436ae43bc3bedb47bc1b358489a83ac589d',
    'ff8d6ea6c87f31285508f51be990d40398438dff89d30ca1cd22192053e59af1',
    '5937f09086171f783964be64f4d0d8f8592631360623ba6dc6dbe9fd8e6004d1',
    '048cb6ac1b7dbd12f77cb856b0194553be2561248d7d9c7d3c9177c67b085dfc',
  ];
  const oldDir = path.join(ROOT, 'docs/codex-tasks/fact-grounding/fixtures');
  const oldPages = JSON.parse(fs.readFileSync(path.join(oldDir, 'tsutatsu-pages.json'), 'utf8'));
  let hashIndex = 0;
  for (const circular of oldPages.circulars) {
    for (const page of circular.files.filter(p => p.kind === 'body')) await test(`T4 既存04: ${page.file}`, () => {
      const html = new TextDecoder(circular.encoding).decode(fs.readFileSync(path.join(oldDir, page.file)));
      const parsed = P.parseTsutatsuPage(html, { circular: circular.key, url: page.url });
      assert.equal(crypto.createHash('sha256').update(JSON.stringify(parsed)).digest('hex'), hashes[hashIndex++]);
    });
  }
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const dataDir = path.join(ROOT, 'data/nta-tsutatsu');
  const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
  for (const catalog of index.filter(c => ['shotoku', 'shohi', 'hojin', 'sozoku'].includes(c.circular))) {
    await test(`T4 既存カタログの全項目: ${catalog.circular}`, () => {
      const stored = JSON.parse(fs.readFileSync(path.join(dataDir, catalog.file), 'utf8')).provisions;
      for (const item of Object.values(stored)) {
        const html = `<h2>${escape(item.title)}</h2><p><strong>${escape(item.no)}</strong>${escape(item.body)}</p>`;
        const parsed = P.parseTsutatsuPage(html, { circular: catalog.circular, url: item.url });
        assert.deepEqual(parsed.provisions, [{ no: item.no, title: item.title, body: item.body,
          url: item.url, circular: catalog.circular }], item.no);
      }
    });
  }
  console.log(`結果: ${passed} 成功、${failed} 失敗`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
