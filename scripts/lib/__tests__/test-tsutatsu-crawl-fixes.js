'use strict';

// 保存済みHTMLと偽の取得関数だけで確認する。出力先はすべてOSの一時領域。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../tsutatsu-parser');
const C = require('../../crawl-nta-tsutatsu');
const N = require('../nta-tsutatsu');
const ROOT = path.resolve(__dirname, '../../..');
const FIXTURES = path.join(ROOT, 'docs/codex-tasks/tsutatsu-crawl/fixtures');
let passed = 0, failed = 0;

async function test(label, fn) {
  try { await fn(); passed++; console.log(`成功: ${label}`); }
  catch (error) { failed++; console.error(`失敗: ${label}\n${error.stack}`); }
}

const provision = '<h2>（試験項目）</h2><p><strong>11</strong>本文です。</p>';
const missing = '<title>指定されたページを表示できませんでした</title>';
const ntaPage = content => '<html><head><title>試験の通達｜国税庁</title></head><body>'
  + `<div class="imp-cnt-tsutatsu"><h1>試験の通達</h1>${content}</div></body></html>`;
const noProvision = ntaPage('<p>番号のない前文です。</p>'.repeat(6));
const noPause = async () => {};

async function importCase({ total = 1, missingCount = 0, nonProvisionCount = 0, badPage, badPages = [],
  previous = { '11': { no: '11', body: '既存の本文' } }, previousJson, lost = [], success = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsutatsu-import-'));
  const saved = { argv: process.argv, code: process.exitCode, output: process.env.GITHUB_OUTPUT,
    log: console.log, warn: console.warn, error: console.error };
  const initial = {
    ...(previous === null ? {} : { 'hyoka.json': previousJson ?? JSON.stringify({ provisions: previous }) + '\n' }),
    'hyoka.index.json': '{"entries":[{"id":"既存"}]}\n',
    'index.json': JSON.stringify([{ circular: 'shotoku', provision_count: 123 },
      { circular: 'hyoka', provision_count: 1 }], null, 2) + '\n',
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
      html: i < nonProvisionCount ? noProvision
        : i < nonProvisionCount + missingCount ? missing : provision,
    }));
    if (badPage !== undefined) pages[total - 1].html = badPage;
    badPages.forEach((html, i) => { pages[i].html = html; });
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
    for (const no of lost) assert.ok(logs.some(log => log.includes(`消えた番号: ${no}`)));
    for (const [i, html] of badPages.entries()) {
      const kind = html === missing ? 'リンク切れ:' : html instanceof Error ? '取得の失敗:' : '読み落とし:';
      assert.equal(logs.filter(log => log.includes(kind) && log.includes(pages[i].url)).length, 1);
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
  await test('T2 裏付けのある本文は項目なし、有効な番号を読み落としたら停止する', () => {
    assert.equal(P.classifyTsutatsuPage(noProvision).type, 'non_provision');
    for (const markup of ['<strong>1-2</strong>', '<b>１－２</b>', '<span class="bold">1-2</span>']) {
      assert.equal(P.classifyTsutatsuPage(`<p>${markup}</p>`).type, 'unreadable');
    }
    for (const name of ['fusoku', 'bessi', 'zenbun']) {
      const result = P.classifyTsutatsuPage(provision, { circular: 'hyoka', url: `https://www.nta.go.jp/${name}/01.htm` });
      assert.equal(result.type, 'provisions');
      assert.deepEqual(result.provisions.map(p => p.no), ['11']);
      assert.equal(P.classifyTsutatsuPage(missing, { url: `https://www.nta.go.jp/${name}/01.htm` }).type, 'missing');
    }
    assert.throws(() => P.parseTsutatsuPage(missing), /国税庁のエラーページです/);
    assert.throws(() => P.parseIndexPage(missing, 'hyoka', C.CIRCULARS.hyoka.index));
    assert.equal(P.classifyTsutatsuPage(ntaPage('<h2>附則</h2><p><strong>1</strong>適用日です。</p>' + '<p>適用に関する説明です。</p>'.repeat(6)), { circular: 'shotoku' }).type, 'non_provision');
    assert.equal(P.classifyTsutatsuPage('<h2>共通事項</h2><p><strong>64～66(共)-1</strong>本文です。</p>', { circular: 'sochi_hojin' }).type, 'provisions');
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

  const unreadablePages = [
    ['空の応答', ''],
    ['前文だけ', '<p>前文だけで項目はありません。</p>'],
    ['メンテナンス中', '<html><head><title>メンテナンス中</title></head><body><h1>メンテナンス中</h1>' + '確認中です。'.repeat(20) + '</body></html>'],
    ['途中で切れたHTML', noProvision.slice(0, -20)],
    ['本文の枠がない', '<html><head><title>通達｜国税庁</title></head><body><p>' + '本文です。'.repeat(20) + '</p></body></html>'],
    ['短い本文', ntaPage('<p>短い本文。</p>')],
    ['fw-boldの番号だけ', ntaPage('<p><span class="fw-bold">1－3－2</span></p>')],
    ['emの番号だけ', ntaPage('<p><em>1－3－2</em></p>')],
    ['divの番号だけ', ntaPage('<div>1－3－2</div>')],
  ];
  for (const [label, html] of unreadablePages) await test(`B1 ${label}は読み落としとして保持する`, async () => {
    assert.equal(P.classifyTsutatsuPage(html, { circular: 'hyoka' }).type, 'unreadable');
    await importCase({ total: 2, badPage: html });
  });
  await test('B1 本文の裏付けは附則URLでも省略しない', () => {
    for (const [, html] of unreadablePages) {
      assert.equal(P.classifyTsutatsuPage(html, { circular: 'hyoka', url: 'https://www.nta.go.jp/fusoku/01.htm' }).type, 'unreadable');
    }
  });
  await test('B1 本文は50字以上を必要とし、コメントやスクリプトは数えない', () => {
    const html = text => `<html><head><title>通達｜国税庁</title></head><body><main id="bodyArea">${text}</main></body></html>`;
    assert.equal(P.classifyTsutatsuPage(html('文'.repeat(49))).type, 'unreadable');
    assert.equal(P.classifyTsutatsuPage(html('文'.repeat(50))).type, 'non_provision');
    assert.equal(P.classifyTsutatsuPage(html('文'.repeat(49) + '<!--長い注記--><script>長いスクリプト</script>')).type, 'unreadable');
    assert.equal(P.classifyTsutatsuPage(html('文'.repeat(49)).replace('</main>', '</main><p>' + '枠外です。'.repeat(20) + '</p>')).type, 'unreadable');
    assert.equal(P.classifyTsutatsuPage(html('文'.repeat(50)).replace('</main>', '')).type, 'unreadable');
    assert.equal(P.classifyTsutatsuPage(html('文'.repeat(50)).replace('<html>', '')).type, 'unreadable');
    assert.equal(P.classifyTsutatsuPage(noProvision.replace('｜国税庁', '別サイト')).type, 'unreadable');
    assert.equal(P.classifyTsutatsuPage(noProvision.replace('<div class="imp-cnt-tsutatsu"><h1>試験の通達</h1>', '<h1>試験の通達</h1>')).type, 'non_provision');
    assert.equal(P.classifyTsutatsuPage(noProvision.replace('<h1>試験の通達</h1>', '<div class="page-header">試験の通達</div>').replace('imp-cnt-tsutatsu', 'content')).type, 'non_provision');
  });
  await test('B1 重複番号を含む項目数が減ったら保持する', () =>
    importCase({ previous: { '11': [{ no: '11', body: '旧本文1' }, { no: '11', body: '旧本文2' }] } }));
  await test('B1 項目数が増えても既存番号が消えたら保持して番号を記録する', () =>
    importCase({ total: 3, previous: { '12': { no: '12', body: '旧本文' } }, lost: ['12'] }));
  await test('B1 既存カタログが読めないときも保持する', () => importCase({ previous: false }));
  await test('B1 既存カタログのJSONが壊れていても保持する', () => importCase({ previousJson: '{' }));
  await test('B1 初回は既存との比較なしで取り込む', () => importCase({ previous: null, success: true }));

  for (const circular of ['hojin', 'sochi_shotoku']) {
    for (const no of ['12の5の2-1-1', '37-13の2の2']) await test(`B2 ${circular}で番号${no}だけのページは読み落とし`, () => {
      for (const tag of ['strong', 'b', 'span class="bold"']) {
        const html = ntaPage('<p>前文の説明です。</p>'.repeat(12) + `<h2>番号のみ</h2><p><${tag}>${no}</${tag.split(' ')[0]}></p>`);
        assert.equal(P.classifyTsutatsuPage(html, { circular }).type, 'unreadable');
        if (circular === 'hojin') {
          assert.equal(P.classifyTsutatsuPage(html.replace('</p></div>', '本文です。</p></div>'), { circular }).type, 'unreadable');
        }
      }
    });
  }
  await test('B2 数字だけは財産評価で番号候補とし、旧番号は候補にしない', () => {
    const html = ntaPage('<p>適用の説明です。</p>'.repeat(8) + '<p><strong>１</strong></p>');
    assert.equal(P.classifyTsutatsuPage(html, { circular: 'shotoku' }).type, 'non_provision');
    assert.equal(P.classifyTsutatsuPage(html, { circular: 'hyoka' }).type, 'unreadable');
    const old = html.replace('１', '旧70の3の3・70の3の4-1');
    const result = P.classifyTsutatsuPage(old, { circular: 'sochi_sozoku' });
    assert.equal(result.type, 'non_provision');
    assert.match(result.reason, /旧70の3の3・70の3の4-1/);
  });
  await test('B2 共通番号を引用側も同じ番号で引く', () => {
    const catalog = N.loadCatalog(), saved = catalog.sochi_hojin;
    const no = '42の6～47共-1';
    try {
      catalog.sochi_hojin = { label: '試験の措置法', provisions: { [no]: { no, body: '共通事項の本文' } } };
      for (const raw of ['42の6～47(共)-1', '４２の６～４７（共）－１']) {
        assert.equal(P.normalizeProvisionNo(raw), no);
        assert.equal(N.findProvision(raw, 'sochi').no, no);
        const result = N.checkCitations(`措通${raw}、55～57の8(共)-2`);
        assert.equal(result.citations[0].no, no);
        assert.equal(result.citations[0].found, true);
        assert.equal(result.citations[1].no, '55～57の8共-2');
      }
    } finally {
      if (saved === undefined) delete catalog.sochi_hojin; else catalog.sochi_hojin = saved;
    }
  });
  for (const circular of ['shohi', 'hyoka', 'sochi_hojin']) await test(`B4 ${circular}は最長の有効な太字までを番号にする`, () => {
    for (const [markup, no] of [
      ['<strong>6－4－5　</strong><b>（注）</b>', '6-4-5'],
      ['<strong>6</strong><span class="bold">－4</span><b>－5</b><strong>（注）</strong>', '6-4-5'],
      ['<strong>6</strong><b>（注）</b>', circular === 'hyoka' ? '6' : null],
    ]) {
      const parsed = P.parseTsutatsuPage(`<h2>試験項目</h2><p>${markup}本文です。</p>`, { circular });
      assert.deepEqual(parsed.provisions.map(p => p.no), no ? [no] : []);
      if (no) assert.equal(parsed.provisions[0].body, '（注）本文です。');
    }
  });
  await test('B5 パス区切りだけで附則扱いし、有効な項目は解析する', () => {
    const html = ntaPage('<p><strong>1-2</strong></p>' + '<p>附則の説明です。</p>'.repeat(8));
    for (const name of ['fusoku', 'bessi', 'zenbun']) {
      for (const suffix of ['/' + name + '/01.htm', '/' + name + '.htm']) {
        const opts = { circular: 'shotoku', url: 'https://www.nta.go.jp' + suffix };
        assert.equal(P.classifyTsutatsuPage(html, opts).type, 'non_provision');
        assert.equal(P.classifyTsutatsuPage('<h2>項目</h2><p><b>1-2</b>本文です。</p>', opts).type, 'provisions');
      }
      for (const url of [`https://${name}.example/01.htm`, `https://www.nta.go.jp/not-${name}/01.htm`, `https://www.nta.go.jp/01.htm?name=${name}`]) {
        assert.equal(P.classifyTsutatsuPage(html, { circular: 'shotoku', url }).type, 'unreadable');
      }
    }
  });
  await test('B6 項目なしの理由に未読番号の例を最大3件記録する', () => {
    const html = ntaPage('<p><b>廃止された項目</b></p>' + [1, 2, 3, 4].map(n => `<p><b>旧70-3-${n}</b>廃止されました。</p>`).join('') + '<p>廃止の説明です。</p>'.repeat(8));
    const result = P.classifyTsutatsuPage(html, { circular: 'sochi_sozoku' });
    assert.equal(result.type, 'non_provision');
    for (const n of [1, 2, 3]) assert.ok(result.reason.includes(`旧70-3-${n}`));
    assert.ok(!result.reason.includes('旧70-3-4'));
    assert.ok(!result.reason.includes('廃止された項目'));
  });
  await test('B7 読み落とし・取得失敗・リンク切れを6件以上でも全URL記録する', () =>
    importCase({ total: 25, missingCount: 7, badPages: [
      ...Array.from({ length: 6 }, () => new Error('HTTP 503')),
      ...Array.from({ length: 6 }, () => ''), ...Array.from({ length: 7 }, () => missing),
    ] }));

  await test('B3 項目なしと15%ちょうどのリンク切れは記録して取り込む', () =>
    importCase({ total: 20, missingCount: 3, nonProvisionCount: 2, success: true }));
  await test('B3 リンク切れが10件ちょうど、15%以内なら取り込む', () =>
    importCase({ total: 100, missingCount: 10, success: true }));
  await test('B3 リンク切れが10/58なら既存を保持する', () =>
    importCase({ total: 58, missingCount: 10 }));
  for (const [total, missingCount] of [[58, 6], [136, 8]]) await test(`B3 リンク切れ${missingCount}/${total}を取り込む`, () =>
    importCase({ total, missingCount, success: true }));
  await test('B3 リンク切れが15%以内でも11件あれば既存を保持する', () =>
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
