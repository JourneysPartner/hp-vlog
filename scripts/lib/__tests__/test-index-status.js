'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const inspector = require('../../inspect-index-status');
const reporter = require('../../report-search-console');

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function result({ coverage, verdict = 'NEUTRAL', sitemap = [] }) {
  return {
    inspectionResult: {
      indexStatusResult: {
        verdict,
        coverageState: coverage,
        indexingState: 'INDEXING_ALLOWED',
        pageFetchState: 'SUCCESSFUL',
        lastCrawlTime: '2026-09-27T00:00:00Z',
        googleCanonical: 'https://mori-zeirishi.net/',
        referringUrls: ['https://mori-zeirishi.net/'],
        sitemap,
      },
    },
  };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-index-test-'));
  const sitemapPath = path.join(tmp, 'sitemap.xml');
  const urls = [
    'https://mori-zeirishi.net/',
    'https://mori-zeirishi.net/services/ebay-export/',
    'https://mori-zeirishi.net/pricing/',
    'https://mori-zeirishi.net/blog/macro/retail/',
    'https://mori-zeirishi.net/blog/ebay-shouhizei-kanpu-kihon/',
  ];
  fs.writeFileSync(sitemapPath, `<urlset>${urls.map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`, 'utf8');

  console.log('=== 1. 鍵が無い場合 ===');
  const skippedRoot = path.join(tmp, 'skipped');
  const skipped = await inspector.run({ env: {}, outRoot: skippedRoot, sitemapPath, log: () => {} });
  assert(skipped.status === 'skipped', '鍵が無ければ status=skipped');
  assert(!fs.existsSync(path.join(skippedRoot, 'latest.json')), 'スキップ時はファイルを書かない');

  console.log('\n=== 2. 5 URL の検査・再試行・保存 ===');
  const currentDir = path.join(tmp, '20260928');
  fs.mkdirSync(currentDir, { recursive: true });
  fs.writeFileSync(path.join(currentDir, 'queries.json'), JSON.stringify({ rows: [] }), 'utf8');
  fs.writeFileSync(path.join(currentDir, 'pages.json'), JSON.stringify({ rows: [] }), 'utf8');
  const originalLatest = {
    fetched_at: '2026-09-28T04:00:00.000Z',
    range: { start: '2026-08-29', end: '2026-09-25' },
    property: 'sc-domain:mori-zeirishi.net',
    files: { queries: '20260928/queries.json', pages: '20260928/pages.json' },
  };
  fs.writeFileSync(path.join(tmp, 'latest.json'), `${JSON.stringify(originalLatest, null, 2)}\n`, 'utf8');

  const calls = [];
  const attempts = new Map();
  const waits = [];
  const logs = [];
  const privateKey = 'PRIVATE_KEY_MUST_NOT_APPEAR';
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (body.siteUrl.startsWith('sc-domain:')) return response(403, 'forbidden');
    const attempt = (attempts.get(body.inspectionUrl) || 0) + 1;
    attempts.set(body.inspectionUrl, attempt);
    if (body.inspectionUrl.includes('/services/')) return response(429, 'quota');
    if (body.inspectionUrl.includes('/pricing/') && attempt === 1) return response(429, 'quota');
    if (body.inspectionUrl.includes('/pricing/')) return response(200, result({ coverage: 'URL が Google に認識されていません' }));
    if (body.inspectionUrl.includes('/blog/macro/')) return response(200, result({ coverage: '検出 - インデックス未登録' }));
    return response(200, result({
      coverage: '送信して登録されました',
      verdict: 'PASS',
      sitemap: ['https://mori-zeirishi.net/sitemap.xml'],
    }));
  };

  const fetched = await inspector.run({
    env: { GSC_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'test@example.com', private_key: privateKey }) },
    now: new Date('2026-09-28T04:00:00Z'),
    outRoot: tmp,
    sitemapPath,
    fetchImpl,
    getToken: async () => 'dummy-token',
    sleep: async ms => { waits.push(ms); },
    log: message => { logs.push(String(message)); },
  });
  assert(fetched.status === 'fetched' && fetched.total === 5, '5 URL を失敗で中断せず検査する');
  assert(fetched.property === 'https://mori-zeirishi.net/', '403 のドメインプロパティから URL プレフィックスへ切り替える');
  assert(waits.includes(15000), '429 の後に差し替え可能な 15 秒待機を呼ぶ');
  assert(attempts.get(urls[1]) === 2 && attempts.get(urls[2]) === 2, '429 は 1 回だけ再試行する');
  assert(calls.every(call => call.url === inspector.API && call.body.languageCode === 'ja'), 'URL Inspection API を日本語指定で呼ぶ');

  const saved = JSON.parse(fs.readFileSync(path.join(currentDir, 'index-status.json'), 'utf8'));
  assert(saved.total === 5 && saved.property === 'https://mori-zeirishi.net/' && Array.isArray(saved.rows), 'index-status.json が指定の外形を持つ');
  const top = saved.rows.find(row => row.kind === 'トップ');
  const service = saved.rows.find(row => row.kind === 'サービス');
  assert(top && top.coverage && top.referring === 1 && top.inSitemap === true, '検査結果の項目を正規化する');
  assert(service && service.error && saved.rows.filter(row => !row.error).length === 4, '2 回目も失敗した URL に error を入れて続行する');
  assert(
    inspector.pageKind('https://mori-zeirishi.net/') === 'トップ' &&
    inspector.pageKind('https://mori-zeirishi.net/services/a/') === 'サービス' &&
    inspector.pageKind('https://mori-zeirishi.net/pricing/') === '料金' &&
    inspector.pageKind('https://mori-zeirishi.net/area/') === '対応地域' &&
    inspector.pageKind('https://mori-zeirishi.net/blog/macro/retail/') === '業種ハブ' &&
    inspector.pageKind('https://mori-zeirishi.net/blog/a/') === '記事' &&
    inspector.pageKind('https://mori-zeirishi.net/blog/category/shouhi/') === 'その他' &&
    inspector.pageKind('https://mori-zeirishi.net/tools/a/') === 'ツール' &&
    inspector.pageKind('https://mori-zeirishi.net/privacy.html') === 'その他',
    'URL を 8 種に判定する'
  );

  const latest = JSON.parse(fs.readFileSync(path.join(tmp, 'latest.json'), 'utf8'));
  assert(latest.files.indexStatus === '20260928/index-status.json', 'latest.json に files.indexStatus を追加する');
  assert(
    latest.fetched_at === originalLatest.fetched_at &&
    latest.range.end === originalLatest.range.end &&
    latest.files.queries === originalLatest.files.queries,
    'latest.json の既存項目を変えない'
  );
  assert(!logs.join('\n').includes(privateKey), 'ログに秘密鍵を出さない');

  console.log('\n=== 3. レポート ===');
  const previousDir = path.join(tmp, '20260921');
  fs.mkdirSync(previousDir, { recursive: true });
  const previousRows = saved.rows.map(row => ({ ...row }));
  const previousArticle = previousRows.find(row => row.url.includes('/blog/ebay-shouhizei-kanpu-kihon/'));
  previousArticle.coverage = '検出 - インデックス未登録';
  previousArticle.verdict = 'NEUTRAL';
  delete previousArticle.error;
  fs.writeFileSync(path.join(previousDir, 'index-status.json'), `${JSON.stringify({
    fetchedAt: '2026-09-21T04:00:00.000Z',
    property: saved.property,
    total: previousRows.length,
    rows: previousRows,
  }, null, 2)}\n`, 'utf8');

  const reportResult = reporter.run({ outRoot: tmp, log: () => {} });
  const markdown = fs.readFileSync(path.join(tmp, 'report.md'), 'utf8');
  assert(reportResult.status === 'written' && markdown.includes('## 索引の状態'), 'report.md の末尾に索引状態の節が出る');
  assert(markdown.includes('索引済み: 2（前回比 +1）'), '合計に前回差分が出る');
  assert(markdown.includes('### 種別ごと') && markdown.includes('| 料金 |'), '種別ごとの件数と索引率が出る');
  assert(markdown.includes('### 記事の公開月ごと') && markdown.includes('2026-04'), '記事を frontmatter の公開月で集計する');
  assert(markdown.includes('### 今週 新しく索引に入った URL') && markdown.includes(urls[4]), '未索引から索引済みになった URL が出る');
  assert(markdown.includes('### 未索引の重要ページ') && markdown.includes(urls[2]) && markdown.includes(urls[3]), '未索引の重要ページが出る');

  const paceHistory = Array.from({ length: 5 }, (_, snapshotIndex) => ({
    rows: Array.from({ length: 5 }, (_, rowIndex) => ({
      url: `https://mori-zeirishi.net/blog/pace-${rowIndex}/`,
      kind: '記事',
      coverage: rowIndex < snapshotIndex ? '送信して登録されました' : '検出 - インデックス未登録',
      verdict: rowIndex < snapshotIndex ? 'PASS' : 'NEUTRAL',
    })),
  }));
  const paceSection = reporter.buildIndexStatusSection({
    current: paceHistory[4],
    history: paceHistory,
  }).join('\n');
  assert(paceSection.includes('直近 4 回の平均は週 1.0 件') && paceSection.includes('約 1 週'), '直近 4 回から待ち行列の目安を出す');

  const unavailable = reporter.buildReport({
    latest: originalLatest,
    queries: [],
    pages: [],
  });
  assert(unavailable.includes('## 索引の状態\n\n（索引状態は未取得です）'), '未取得の週は 1 行で示す');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
