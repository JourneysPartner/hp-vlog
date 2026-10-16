'use strict';

// 01c: 保存済みHTML・偽の取得関数・OSの一時領域だけで検証する。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../tsutatsu-parser');
const C = require('../../crawl-nta-tsutatsu');
const { testCatalogQuality } = require('./test-tsutatsu');
const ROOT = path.resolve(__dirname, '../../..');
const FIXTURES = path.join(ROOT, 'docs/codex-tasks/tsutatsu-crawl/fixtures');
let passed = 0, failed = 0;

async function test(label, fn) {
  try { await fn(); passed++; console.log(`成功: ${label}`); }
  catch (error) { failed++; console.error(`失敗: ${label}\n${error.stack}`); }
}

const pages = [
  ['kihon__hojin__04__04_01_03.htm', 'hojin', 1],
  ['kihon__shohi__08__01.htm', 'shohi', 11],
  ['kihon__sisan__sozoku2__02__10.htm', 'sozoku', 17],
  ['kihon__sisan__sozoku2__04__01.htm', 'sozoku', 24],
  ['kobetsu__hojin__sochiho__750214__01__01_42_06.htm', 'sochi_hojin', 13],
  ['kobetsu__shotoku__sochiho__801226__sinkoku__57__11__01.htm', 'sochi_shotoku', 3],
  ['kobetsu__sozoku__sochiho__080708__70_3__02.htm', 'sochi_sozoku', 18],
  ['kobetsu__sozoku__sochiho__080708__70_3__05.htm', 'sochi_sozoku', 17],
  ['kobetsu__shotoku__sochiho__710826__sanrin__sanjyou__soti31__04.htm', 'sochi_joto', 10],
].map(([file, circular, count]) => ({ file, circular, count,
  url: 'https://www.nta.go.jp/law/tsutatsu/' + file.replace(/__/g, '/') }));

const fullPage = content => '<html><head><title>試験の通達｜国税庁</title></head><body>'
  + `<main class="imp-cnt-tsutatsu"><h1>試験の通達</h1>${content}</main></body></html>`;
const normalBody = '現行の条文の本文です。品質の検査に十分な長さを持つ本文です。';
const item = (no, body = normalBody) => ({ no, title: '（試験の条文）', body,
  url: `https://www.nta.go.jp/test-${no}.htm` });
const markup = entries => entries.map(p => `<h2>${p.title}</h2><p><strong>${p.no}</strong>${p.body}</p>`).join('');

async function importCase({ previous, next, accepted = {}, lost = [], success = true, html }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsutatsu-comments-import-'));
  const saved = { argv: process.argv, code: process.exitCode, output: process.env.GITHUB_OUTPUT,
    log: console.log, warn: console.warn, error: console.error };
  const initial = {
    'hyoka.json': JSON.stringify({ provisions: previous }) + '\n',
    'hyoka.index.json': '{"entries":[{"id":"既存"}]}\n',
    'index.json': JSON.stringify([{ circular: 'hyoka', provision_count: Object.keys(previous).length },
      { circular: 'shotoku', provision_count: 123 }]) + '\n',
  };
  try {
    for (const [file, text] of Object.entries(initial)) fs.writeFileSync(path.join(dir, file), text);
    process.argv = [process.execPath, 'crawl-nta-tsutatsu.js', '--only', 'hyoka'];
    process.exitCode = 0;
    process.env.GITHUB_OUTPUT = path.join(dir, 'github-output');
    const logs = [], requests = [];
    console.log = console.warn = console.error = (...args) => logs.push(args.join(' '));
    const url = new URL('test-comments.htm', C.CIRCULARS.hyoka.index).href;
    const fetchPage = async requested => {
      requests.push(requested);
      if (requested === C.CIRCULARS.hyoka.index) return `<a href="${url}">節</a>`;
      assert.equal(requested, url, '偽の取得関数以外で取得しない');
      return html ?? fullPage(markup(next));
    };
    await C.main({ outDir: dir, fetchPage, pause: async () => {} });
    assert.deepEqual(requests, [C.CIRCULARS.hyoka.index, url]);
    assert.equal(process.exitCode, success ? 0 : 1);
    const output = fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8');
    assert.match(output, success ? /errors=0\n/ : /errors=[1-9]\d*\n/);
    const removed = Object.values(accepted).reduce((sum, n) => sum + n, 0);
    assert.match(output, new RegExp(`(?:^|\\n)comment_removed=${success ? removed : 0}\\n`));
    assert.equal(logs.filter(log => log.includes('コメントの中だった番号:')).length,
      success ? Object.keys(accepted).length : 0);
    if (success) {
      for (const [no, count] of Object.entries(accepted)) {
        assert.ok(logs.some(log => log.includes(`コメントの中だった番号: ${no}（${count} 件）`)));
      }
      const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'hyoka.json'), 'utf8'));
      assert.deepEqual(Object.keys(catalog.provisions).sort(), [...new Set(next.map(p => p.no))].sort());
      assert.equal(Object.values(catalog.provisions).flat().length, next.length);
      const search = JSON.parse(fs.readFileSync(path.join(dir, 'hyoka.index.json'), 'utf8'));
      assert.equal(search.entries.length, next.length);
      const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
      assert.deepEqual(index.find(p => p.circular === 'shotoku'), { circular: 'shotoku', provision_count: 123 });
    } else {
      for (const [file, text] of Object.entries(initial)) {
        assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), text, `${file}をバイト単位で保持する`);
      }
      for (const no of lost) assert.ok(logs.some(log => log.includes(`消えた番号: ${no}`)));
    }
  } finally {
    process.argv = saved.argv; process.exitCode = saved.code;
    if (saved.output === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = saved.output;
    console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const parsedPages = new Map();
  for (const page of pages) await test(`試験1 コメントの印なし: ${page.file}`, () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'pages', page.file), 'utf8');
    const parsed = P.classifyTsutatsuPage(html, page);
    parsedPages.set(page.file, parsed);
    assert.equal(parsed.type, 'provisions');
    assert.equal(parsed.provisions.length, page.count);
    assert.equal(new Set(parsed.provisions.map(p => p.no)).size, page.count, 'ページ内に番号の重複がない');
    for (const p of parsed.provisions) assert.doesNotMatch(p.title + p.body, /<!--|-->/);
  });
  const parsed = file => parsedPages.get(file).provisions;
  await test('試験2 コメントの中の28-1と21の2-1の古い注記を除く', () => {
    assert.ok(!parsed(pages[3].file).some(p => p.no === '28-1'));
    const current = parsed(pages[2].file).find(p => p.no === '21の2-1');
    assert.ok(current);
    assert.doesNotMatch(current.body, /法第1条の4第1項第2号ロに該当していた者/);
  });
  await test('試験3 措置法法人の同じ番号は1件で現行の見出し', () => {
    const current = parsed(pages[4].file).filter(p => p.no === '42の6-1の3');
    assert.equal(current.length, 1);
    assert.equal(current[0].title, '（従業員数基準の適用等）');
  });
  await test('試験4 措置法相続70の3の3-1は05のURLだけ', () => {
    const current = [...parsed(pages[6].file), ...parsed(pages[7].file)].filter(p => p.no === '70の3の3-1');
    assert.equal(current.length, 1);
    assert.equal(current[0].url, pages[7].url);
  });
  await test('試験5 66ページの分類・min_itemsと本文の型の印を維持する', () => {
    const counts = {};
    for (const page of JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8')).pages) {
      const result = P.classifyTsutatsuPage(fs.readFileSync(path.join(FIXTURES, 'pages', page.file), 'utf8'), page);
      counts[result.type] = (counts[result.type] || 0) + 1;
      assert.ok(result.provisions.length >= page.min_items, page.file);
    }
    assert.deepEqual(counts, { provisions: 41, non_provision: 17, missing: 8 });
    const html = '<!-- InstanceEndEditable --><!-- InstanceBeginEditable name="bodyArea" -->'
      + markup([item('11')]) + '<!-- InstanceEndEditable -->' + markup([item('12')]);
    assert.deepEqual(P.parseTsutatsuPage(html, { circular: 'hyoka' }).provisions.map(p => p.no), ['11']);
  });
  await test('試験6 閉じていないコメント以後を基本・拡張の両方で除く', () => {
    for (const circular of ['hojin', 'hyoka', 'sochi_hojin']) {
      for (const comment of ['<!--', '<!-- InstanceBeginEditable']) {
        const result = P.parseTsutatsuPage(markup([item('1-1')]) + comment + markup([item('1-2')]), { circular });
        assert.deepEqual(result.provisions.map(p => p.no), ['1-1']);
      }
      const html = fullPage('<p>番号のない前文です。</p>'.repeat(8) + '<!--' + markup([item('1-2')]) + '-->');
      assert.equal(P.classifyTsutatsuPage(html, { circular }).type, 'non_provision', 'コメントの番号は読み落としの候補にも数えない');
    }
  });

  const a = item('11', '<!--古い条文-->'), b = item('12'), stable = item('13');
  await test('試験7 Aだけ消えたら受け入れて番号と1件を出力', () =>
    importCase({ previous: { 11: a, 12: b }, next: [b], accepted: { 11: 1 } }));
  await test('試験7 Bだけ消えたら保持する', () =>
    importCase({ previous: { 11: a, 12: b }, next: [item('11')], success: false, lost: ['12'] }));
  await test('試験7 AとBが両方消えたら保持する', () =>
    importCase({ previous: { 11: a, 12: b, 13: stable }, next: [stable], success: false, lost: ['11', '12'] }));
  await test('試験7 配列のコメント付き1件だけが減ったら受け入れる', () =>
    importCase({ previous: { 11: [item('11'), a], 12: b }, next: [item('11'), b], accepted: { 11: 1 } }));
  await test('試験7 閉じ印だけでも前の本文の印として認め、配列の減少数を数える', () =>
    importCase({ previous: { 11: [item('11', '古い条文-->'), a, item('11')] },
      next: [item('11')], accepted: { 11: 2 } }));
  await test('試験7 配列の番号全体が消えたら消えた全件を数える', () =>
    importCase({ previous: { 11: [a, item('11')], 12: b }, next: [b], accepted: { 11: 2 } }));
  await test('試験7 コメント付きの減少に別番号の配列減少を紛れ込ませない', () =>
    importCase({ previous: { 11: [a, item('11')], 12: [b, item('12', '別の現行本文')] },
      next: [item('11'), b], success: false }));
  await test('試験7 新しい本文のコメントの印では減少を認めない', () =>
    importCase({ previous: { 11: item('11'), 12: b }, next: [item('11', normalBody + '<!--注記-->')],
      success: false, lost: ['12'] }));
  await test('試験7 他の番号が増えてもコメントの印のない番号の消失は保持する', () =>
    importCase({ previous: { 11: a, 12: b }, next: [item('11'), stable, item('14')], success: false, lost: ['12'] }));
  await test('試験7 全項目がコメントでも新しい取り込み0件なら保持する', () =>
    importCase({ previous: { 11: a }, next: [], success: false,
      html: fullPage('<p>番号のない前文です。</p>'.repeat(8)) }));

  await test('試験8 完全に同じ重複だけ除き、最初のURLを残す', async () => {
    const first = item('11'), second = { ...first, title: '別の見出し', url: first.url + '?2' };
    const third = { ...first, body: first.body + ' ', url: first.url + '?3' };
    for (const circular of ['hyoka', 'sochi_hojin', 'sochi_sozoku', 'sochi_shotoku', 'sochi_joto']) {
      const result = C.provisionsByNumber([first, { ...first, url: '別のURL' }, second, third, { ...second, url: '後のURL' }], circular);
      assert.equal(result['11'].length, 3);
      assert.deepEqual(result['11'].map(p => p.url), [first.url, second.url, third.url]);
      assert.ok(!Array.isArray(C.provisionsByNumber([first, { ...first }], circular)['11']));
    }
    const basic = C.provisionsByNumber([first, { ...first, body: normalBody + normalBody }], 'hojin');
    assert.equal(basic['11'].body, normalBody + normalBody, '基本通達の重複の扱いは維持する');
    const base = new URL('.', C.CIRCULARS.hyoka.index).href;
    const urls = [base + 'test-a.htm', base + 'test-b.htm'];
    const result = await C.crawlCircular('hyoka', C.CIRCULARS.hyoka, 0, {
      fetchPage: async url => url === C.CIRCULARS.hyoka.index
        ? urls.map(u => `<a href="${u}">節</a>`).join('') : fullPage(markup([first])),
      pause: async () => {},
    });
    assert.deepEqual(result.duplicates, ['11'], '取り込んだ条の重複の記録は残す');
    assert.equal(C.provisionsByNumber(result.provisions, 'hyoka')['11'].url, urls[0]);
  });

  await test('試験9 一時カタログで配列・拡張番号・削除の跡を検査し、不正は落とす', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsutatsu-comments-quality-'));
    const previousEnv = process.env.TSUTATSU_DIR, oldLog = console.log;
    try {
      process.env.TSUTATSU_DIR = dir;
      const index = ['hyoka', 'sochi_hojin', 'hojin'].map(circular => ({ circular, label: circular, file: circular + '.json' }));
      const hyoka = { 11: [item('11'), { ...item('11'), title: '（別の条文）' }],
        12: { ...item('12', '削除（平11課評2－12外）'), title: '' },
        13: { ...item('13', '（平11課評2－12外により削除）'), title: '' } };
      const sochi = { '70の3の3-1': item('70の3の3-1'), '42の6～47共-1': item('42の6～47共-1') };
      const basic = { '1-1': item('1-1') };
      fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
      const write = () => {
        for (const [circular, provisions] of [['hyoka', hyoka], ['sochi_hojin', sochi], ['hojin', basic]]) {
          fs.writeFileSync(path.join(dir, circular + '.json'), JSON.stringify({ provisions }));
        }
      };
      const logs = [];
      console.log = message => logs.push(message);
      const errors = () => {
        write();
        const failed = [];
        testCatalogQuality((ok, label) => { if (!ok) failed.push(label); });
        return failed;
      };
      assert.deepEqual(errors(), []);
      assert.ok(logs.includes('  hyoka: 削除の跡 2 件'));
      assert.ok(logs.some(log => log.includes('削除の跡 0 件')));
      hyoka[12].body = '削除(' + '改正の沿革、'.repeat(30) + ')';
      assert.deepEqual(errors(), [], '長い沿革付きの削除表示も除外する');
      for (const marker of ['<!--', '-->']) {
        hyoka[11][1].body = normalBody + marker;
        assert.deepEqual(errors().map(x => x.split(':')[0]), ['hyoka']);
        assert.match(errors()[0], /コメントの印が無い（1 件）/);
      }
      hyoka[11][1].body = normalBody;
      hyoka[11][1].title = '';
      assert.match(errors()[0], /見出しが空/);
      hyoka[11][1].title = '（別の条文）';
      hyoka[11][1].url = '';
      assert.match(errors()[0], /URL/);
      hyoka[11][1].url = item('11').url;
      hyoka[12].url = '';
      assert.match(errors()[0], /URL/, '削除の跡もURLは検査する');
      hyoka[12].url = item('12').url;
      hyoka[11][0].body = hyoka[11][1].body = '短い本文';
      assert.match(errors()[0], /短い条文が2%以下（2\/2）/, '削除の跡を割合の分母に含めない');
      hyoka[11][0].body = normalBody + '（旧注記により削除）';
      hyoka[11][1].body = normalBody;
      hyoka[11][0].title = '';
      assert.match(errors()[0], /見出しが空/, '長い現行本文の中の削除という語では除外しない');
      hyoka[11][0] = item('11');
      basic['1-1'].no = '11';
      assert.match(errors()[0], /全条番号/, '基本通達では数字だけの番号を許可しない');
      basic['1-1'].no = '1-1';
      assert.deepEqual(errors(), []);
      fs.writeFileSync(path.join(dir, 'index.json'), '[]');
      const empty = [];
      testCatalogQuality((ok, label) => { if (!ok) empty.push(label); });
      assert.equal(empty.length, 1, '一時カタログでも0件は失敗する');
    } finally {
      if (previousEnv === undefined) delete process.env.TSUTATSU_DIR; else process.env.TSUTATSU_DIR = previousEnv;
      console.log = oldLog;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  console.log(`結果: ${passed} 成功、${failed} 失敗`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
