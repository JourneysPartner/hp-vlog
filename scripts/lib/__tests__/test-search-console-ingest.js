'use strict';
/**
 * サーチコンソールの週次取り込み（2026-09-03 並行A）
 *
 * 実際の API は呼ばない（鍵が無い）。取得部分は差し替えて、
 * ファイルの形・保持期間・レポートの節・鍵が無いときの挙動を確認する。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..', '..');
const fetcher = require(path.join(ROOT, 'scripts/fetch-search-console'));
const reporter = require(path.join(ROOT, 'scripts/report-search-console'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-test-'));
const quiet = () => {};

// API 応答のモック。dimensions に応じて keys を返す
function fakeFetch({ failDomainProperty = false } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (failDomainProperty && url.includes('sc-domain')) {
        return { ok: false, status: 403, text: async () => 'forbidden' };
      }
      const dims = body.dimensions;
      const rows = [];
      for (let i = 0; i < 5; i++) {
        const keys = dims.map(d => d === 'query' ? `検索語${i}` : `https://mori-zeirishi.net/${i === 0 ? '' : i === 1 ? 'services/bookkeeping/' : i === 2 ? 'blog/macro/salon/' : `blog/post-${i}/`}`);
        rows.push({ keys, clicks: 10 - i, impressions: 100 * (i + 1), ctr: 0.1, position: i === 1 ? 15.2 : 3 + i });
      }
      return { ok: true, status: 200, json: async () => ({ rows }), text: async () => '' };
    },
  };
}

(async () => {
  console.log('=== 1. 鍵が無ければ正常終了（例外を出さない）===');
  {
    let r = null, threw = false;
    try { r = await fetcher.run({ env: {}, outRoot: tmp, log: quiet }); } catch (_) { threw = true; }
    assert(!threw && r && r.status === 'skipped', '未設定は skipped');
    assert(!fs.existsSync(path.join(tmp, 'latest.json')), '何も書かない');
  }

  console.log('');
  console.log('=== 2. 期間は直近28日・終了日は3日前 ===');
  {
    const r = fetcher.dateRange(new Date('2026-09-07T04:00:00Z'));
    assert(r.end === '2026-09-04' && r.start === '2026-08-08', `期間 ${r.start}〜${r.end}`);
  }

  console.log('');
  console.log('=== 3. 3種のファイルと latest.json ===');
  {
    const f = fakeFetch();
    const r = await fetcher.run({
      env: { GSC_SERVICE_ACCOUNT_JSON: '{"client_email":"x@y","private_key":"k"}' },
      now: new Date('2026-09-07T04:00:00Z'), fetchImpl: f.fetchImpl, outRoot: tmp, log: quiet,
      getToken: async () => 'dummy-token',
    });
    assert(r.status === 'fetched' && r.dir === '20260907', '取り込みに成功する');
    assert(r.property === 'sc-domain:mori-zeirishi.net', 'ドメインプロパティを第一候補にする');
    for (const name of ['queries', 'pages', 'query-page']) {
      const p = path.join(tmp, '20260907', `${name}.json`);
      const ok = fs.existsSync(p) && Array.isArray(JSON.parse(fs.readFileSync(p, 'utf8')).rows);
      assert(ok, `${name}.json が正しい形で出る`);
    }
    const latest = JSON.parse(fs.readFileSync(path.join(tmp, 'latest.json'), 'utf8'));
    assert(latest.files.queries === '20260907/queries.json' && latest.range.end === '2026-09-04' && latest.property, 'latest.json に所在・期間・プロパティ');
    const q = JSON.parse(fs.readFileSync(path.join(tmp, '20260907', 'queries.json'), 'utf8')).rows[0];
    assert(q.query === '検索語0' && q.clicks === 10 && q.impressions === 100, '行の項目名が query / clicks / impressions');
    const qp = JSON.parse(fs.readFileSync(path.join(tmp, '20260907', 'query-page.json'), 'utf8')).rows[0];
    assert(qp.query && qp.page, 'query×page は両方の項目を持つ');
    assert(f.calls.every(c => c.body.rowLimit === 1000), '上位1,000行まで');
    assert(f.calls.every(c => c.url.includes('/searchAnalytics/query')), '検索アナリティクスの API を呼ぶ');
  }

  console.log('');
  console.log('=== 4. ドメインプロパティが使えなければ URL プレフィックスにする ===');
  {
    const f = fakeFetch({ failDomainProperty: true });
    const r = await fetcher.run({
      env: { GSC_SERVICE_ACCOUNT_JSON: '{}' }, now: new Date('2026-09-14T04:00:00Z'),
      fetchImpl: f.fetchImpl, outRoot: tmp, log: quiet, getToken: async () => 't',
    });
    assert(r.property === 'https://mori-zeirishi.net/', '2番目の候補で取れる');
  }

  console.log('');
  console.log('=== 5. 12週より古いディレクトリを消す ===');
  {
    for (let i = 0; i < 14; i++) fs.mkdirSync(path.join(tmp, `202601${String(i + 1).padStart(2, '0')}`), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'not-a-date'), { recursive: true });
    const removed = fetcher.prune(tmp, 12);
    const remain = fs.readdirSync(tmp).filter(d => /^\d{8}$/.test(d));
    assert(remain.length === 12, `12件だけ残る（残り ${remain.length}、削除 ${removed.length}）`);
    assert(remain.includes('20260914') && remain.includes('20260907'), '新しい2件は残る');
    assert(fs.existsSync(path.join(tmp, 'not-a-date')), '日付でないディレクトリは触らない');
  }

  console.log('');
  console.log('=== 6. レポート ===');
  {
    const r = reporter.run({ outRoot: tmp, log: quiet });
    assert(r.status === 'written', 'report.md を書く');
    const md = fs.readFileSync(path.join(tmp, 'report.md'), 'utf8');
    assert(md.includes('## 伸ばしやすい語'), '「伸ばしやすい語」の節がある');
    const growable = md.split('## 伸ばしやすい語')[1].split('## ページ別')[0];
    assert(growable.includes('検索語1') && !growable.includes('検索語0') && !growable.includes('検索語2'), '順位11〜30位の語だけが入る');
    assert(md.includes('## ページ種別ごとの合計') && md.includes('業種ハブ') && md.includes('サービス'), 'ページ種別の集計がある');
    assert(md.includes('## 前回との差分'), '前回との差分の節がある');
    assert(r.prevDir === '20260907', '前回（1つ前の日付）と比べる');
    assert(reporter.pageKind('https://mori-zeirishi.net/blog/macro/salon/') === '業種ハブ'
      && reporter.pageKind('https://mori-zeirishi.net/services/bookkeeping/') === 'サービス'
      && reporter.pageKind('https://mori-zeirishi.net/blog/some-post/') === '記事'
      && reporter.pageKind('https://mori-zeirishi.net/') === 'トップ', 'URL の種別分け');
  }

  console.log('');
  console.log('=== 7. 伸ばしやすい語の所在・推奨と狙った語の順位 ===');
  {
    const latest = { fetched_at: '2026-09-27', range: { start: '2026-08-28', end: '2026-09-24' }, property: 'x' };
    const queries = [
      { query: '題名語', impressions: 50, clicks: 1, ctr: 0.02, position: 12 },
      { query: '見出し語', impressions: 40, clicks: 0, ctr: 0, position: 13 },
      { query: '本文語', impressions: 30, clicks: 0, ctr: 0, position: 14 },
      { query: '未配置上位', impressions: 20, clicks: 0, ctr: 0, position: 19 },
      { query: '未配置下位', impressions: 15, clicks: 0, ctr: 0, position: 25 },
      { query: 'サービス語', impressions: 10, clicks: 0, ctr: 0, position: 18 },
      { query: '塗料 勘定科目', impressions: 9, clicks: 2, ctr: 0.2, position: 8.5 },
    ];
    const queryPages = queries.slice(0, 6).map((query, index) => ({
      query: query.query,
      page: index === 5
        ? 'https://mori-zeirishi.net/services/bookkeeping/'
        : `https://mori-zeirishi.net/blog/grow-${index + 1}/`,
      impressions: query.impressions,
      clicks: query.clicks,
      ctr: query.ctr,
      position: query.position,
    }));
    const postContents = new Map([
      ['grow-1', { title: '題名語の解説', headings: [], body: '' }],
      ['grow-2', { title: '別の題名', headings: ['見出し語の解説'], body: '' }],
      ['grow-3', { title: '別の題名', headings: [], body: '本文語の解説です。' }],
      ['grow-4', { title: '別の題名', headings: [], body: '該当語はありません。' }],
      ['grow-5', { title: '別の題名', headings: [], body: '該当語はありません。' }],
    ]);
    const posts = [
      { slug: 'target-hit', title: '塗料の記事', target_query: '勘定科目 塗料', review_status: 'published' },
      { slug: 'target-miss', title: '未表示の記事', target_query: '人工代 仕訳', review_status: 'published' },
      { slug: 'target-draft', title: '下書き', target_query: '題名語', review_status: 'draft' },
    ];
    const md = reporter.buildReport({ latest, queries, pages: [], queryPages, posts, postContents });
    const growable = md.split('## 伸ばしやすい語')[1].split('## 狙った語の順位')[0];
    assert(growable.includes('該当ページ') && growable.includes('語の所在') && growable.includes('推奨'), '伸ばしやすい語に3列を追加する');
    assert(growable.includes('grow-1') && growable.includes('title') && growable.includes('見出しと本文の充実'), 'title なら見出しと本文の充実');
    assert(growable.includes('grow-2') && growable.includes('h2') && growable.includes('題名の見直し'), 'h2 なら題名の見直し');
    assert(growable.includes('grow-3') && growable.includes('本文'), '本文の所在を表示する');
    assert(growable.includes('grow-4') && growable.includes('h2 の追加'), '無し・20位以内なら h2 の追加');
    assert(growable.includes('grow-5') && growable.includes('新記事の候補'), '無し・20位超なら新記事の候補');
    assert(growable.includes('サービス') && growable.includes('該当ページの文面'), '記事以外なら該当ページの文面');

    const target = md.split('## 狙った語の順位')[1].split('## ページ別')[0];
    assert(target.includes('target-hit') && target.includes('8.5') && target.includes('9') && target.includes('2'),
      'normalizeQuery 一致で順位・表示・クリックを出す');
    assert(target.includes('target-miss') && target.includes('表示なし'), '一致が無い狙った語は表示なし');

    const unknown = reporter.buildReport({ latest, queries: queries.slice(0, 1), pages: [], queryPages: null, posts: [], postContents: new Map() });
    const unknownGrowable = unknown.split('## 伸ばしやすい語')[1].split('## 狙った語の順位')[0];
    assert((unknownGrowable.match(/（不明）/g) || []).length === 3, 'query-page が無い週は追加3列を（不明）にする');
    assert(unknown.includes('## 狙った語の順位\n\n（対象の記事はまだありません）'), '対象記事0本の文言');
  }

  console.log('');
  console.log('=== 8. 管理画面の表示 ===');
  {
    const page = require(path.join(ROOT, 'netlify/functions/admin-analytics-page'));
    const html = page.renderSearchConsoleSection();
    assert(/検索語（サーチコンソール）/.test(html), '節の見出しがある');
    assert(/まだ取り込まれていません|<pre class="gsc">/.test(html), 'レポートか未取り込みの案内を出す');
    const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
    assert(/\[functions\][\s\S]*included_files = \["data\/search-console\/\*\*"\]/.test(toml), 'netlify.toml で関数に同梱する設定がある');
  }

  console.log('');
  console.log('=== 9. GSC 候補は検収用データを介して接続する ===');
  {
    // 生の GSC 行を日次選定へ直結せず、週次 PR で検収する
    // data/gsc-topics.json を介してプールに合流させる。
    const files = ['scripts/topic-pool.js', 'scripts/lib/topic-selector.js']
      .filter(f => fs.existsSync(path.join(ROOT, f)));
    const linked = files.filter(f => /search-console/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    assert(linked.length === 0, '候補選定側から生の search-console データを直接参照しない');
    const poolSrc = fs.readFileSync(path.join(ROOT, 'scripts/topic-pool.js'), 'utf8');
    assert(poolSrc.includes('expandGscTopics') && poolSrc.includes('...GSC_TOPICS'), '検収後の GSC 候補をプールに合流する');
    const genSrc = fs.readFileSync(path.join(ROOT, 'scripts/generate-draft.js'), 'utf8');
    const gscReads = genSrc.match(/search-console/g) || [];
    const guarded = genSrc.includes('function loadTargetQueryInputs()')
      && genSrc.includes("path.join(ROOT, 'data', 'search-console', 'latest.json')")
      && genSrc.includes('readJsonOr(latestPath, {})');
    assert(gscReads.length === 0 || guarded, '生成側の search-console 参照は loadTargetQueryInputs の readJsonOr（無ければ空）経由だけ');
    assert(fs.existsSync(path.join(ROOT, '.github/workflows/fetch-search-console.yml')), 'ワークフローがある');
    assert(fs.existsSync(path.join(ROOT, 'docs/search-console-setup.md')), '設定手順がある');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('');
  console.log('=== 鍵 JSON の貼り付け崩れに耐える／読めないときは原因が分かる ===');
  {
    const parse = fetcher.parseServiceAccountJson;
    const key = { type: 'service_account', client_email: 'sa@example.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nMIIBSECRETLINE\n-----END PRIVATE KEY-----\n' };
    const good = JSON.stringify(key, null, 2);
    assert(parse(good).client_email === key.client_email, 'そのままの JSON を読める');
    assert(parse('﻿  \n' + good + '\n\n').private_key === key.private_key, 'BOM と前後の空白があっても読める');
    assert(parse('search-console-reader.json\n' + good + '\n}').client_email === key.client_email, '前後に余計な文字が混ざっても読める');
    assert(parse(Buffer.from(good).toString('base64')).client_email === key.client_email, 'base64 で登録されていても読める');
    const literal = good.replace(/\\n/g, '\n');
    assert(parse(literal).private_key === key.private_key, '秘密鍵の改行が実際の改行になっていても元に戻して読める');

    const fails = (raw) => { try { parse(raw); return null; } catch (e) { return e.message; } };
    const msg = fails(good.slice(0, -1) + ']');
    assert(msg && msg.includes('読み取れません') && msg.includes('文字数') && msg.includes('直し方'), '読めないときは長さと直し方を案内する');
    assert(msg && !msg.includes('MIIBSECRETLINE') && !msg.includes('sa@example'), '案内文に鍵の中身を出さない');
    assert(/OAuth/.test(fails('{"installed":{"client_id":"x"}}') || ''), 'OAuth クライアントの JSON を貼った場合はそれと分かる');
    assert(/client_email/.test(fails('{"type":"service_account"}') || ''), '必須項目が無ければ項目名を出す');

    let runError = null;
    try {
      await fetcher.run({ env: { GSC_SERVICE_ACCOUNT_JSON: '{"client_email": "x@y" ' }, fetchImpl: fakeFetch().fetchImpl, outRoot: tmp, log: quiet });
    } catch (e) { runError = e; }
    assert(runError && runError.message.includes('読み取れません'), 'run() でも API を呼ぶ前に同じ案内で止まる');
  }

  console.log('');
  console.log('=== 結果 ===');
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
