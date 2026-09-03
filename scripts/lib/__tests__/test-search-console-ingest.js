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
  console.log('=== 7. 管理画面の表示 ===');
  {
    const page = require(path.join(ROOT, 'netlify/functions/admin-analytics-page'));
    const html = page.renderSearchConsoleSection();
    assert(/検索語（サーチコンソール）/.test(html), '節の見出しがある');
    assert(/まだ取り込まれていません|<pre class="gsc">/.test(html), 'レポートか未取り込みの案内を出す');
    const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
    assert(/\[functions\][\s\S]*included_files = \["data\/search-console\/\*\*"\]/.test(toml), 'netlify.toml で関数に同梱する設定がある');
  }

  console.log('');
  console.log('=== 8. 候補選定に接続していない ===');
  {
    const files = ['scripts/topic-pool.js', 'scripts/lib/topic-selector.js', 'scripts/generate-draft.js']
      .filter(f => fs.existsSync(path.join(ROOT, f)));
    const linked = files.filter(f => /search-console/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    assert(linked.length === 0, '記事生成側から search-console を参照していない');
    assert(fs.existsSync(path.join(ROOT, '.github/workflows/fetch-search-console.yml')), 'ワークフローがある');
    assert(fs.existsSync(path.join(ROOT, 'docs/search-console-setup.md')), '設定手順がある');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('');
  console.log('=== 結果 ===');
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
