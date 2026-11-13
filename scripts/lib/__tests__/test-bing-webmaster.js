'use strict';
/**
 * Bing Webmaster Tools の週次取り込みとレポートの節（2026-11-13 bing-weekly R1〜R11）
 *
 * 本物の API は呼ばない（偽の fetch に差し替える）。一時フォルダに書き、終わったら消す。
 * 偽の鍵は鍵らしい形にしない（英数字32文字などは Netlify の秘密情報の検出で公開が止まる）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..', '..');
const fetcher = require(path.join(ROOT, 'scripts/fetch-bing-webmaster'));
const reporter = require(path.join(ROOT, 'scripts/report-search-console'));

const KEY = 'fake-bing-key-for-tests';

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function endpointOf(url) {
  const match = /\/json\/([A-Za-z]+)\?/.exec(String(url));
  return match ? match[1] : '';
}

function day(base, offset) {
  return new Date(Date.parse(`${base}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}

function bingDate(date) {
  return `/Date(${Date.parse(`${date}T00:00:00Z`)})/`;
}

function trafficRows() {
  const rows = [];
  for (let index = 0; index < 28; index++) {
    rows.push({ Date: bingDate(day('2026-10-14', index)), Impressions: 10, Clicks: 1, __type: 'RankAndTrafficStats' });
  }
  rows.push({ Date: bingDate('2026-05-15'), Impressions: 3, Clicks: 0 });
  return rows;
}

function queryRows() {
  return [
    { Date: '2026-11-06T00:00:00', Query: '確定申告', Impressions: 100, Clicks: 5, AvgImpressionPosition: 5.5, AvgClickPosition: 4.5, __type: 'QueryStats', Unknown: 'x' },
    { Date: '2026-10-30T00:00:00', Query: '確定申告', Impressions: 300, Clicks: 15, AvgImpressionPosition: 3.5, AvgClickPosition: 3 },
    { Date: '2026-11-06T00:00:00', Query: '経費', Impressions: 50, Clicks: 0, AvgImpressionPosition: -1, AvgClickPosition: -1 },
  ];
}

function pageRows() {
  return [
    { Date: '2026-11-06T00:00:00', Query: 'https://mori-zeirishi.net/', Impressions: 80, Clicks: 8, AvgImpressionPosition: 2, AvgClickPosition: 2 },
    { Date: '2026-11-06T00:00:00', Query: 'https://mori-zeirishi.net/services/bookkeeping/', Impressions: 20, Clicks: 2, AvgImpressionPosition: 12.25, AvgClickPosition: 11 },
  ];
}

function crawlRow(date, values) {
  return {
    Date: bingDate(date),
    CrawledPages: values.CrawledPages,
    InIndex: values.InIndex,
    CrawlErrors: values.CrawlErrors,
    Code2xx: values.Code2xx,
    Code301: values.Code301,
    Code302: 0,
    Code4xx: values.Code4xx,
    Code5xx: values.Code5xx,
    BlockedByRobotsTxt: values.BlockedByRobotsTxt,
    AllOtherCodes: 0,
    ConnectionTimeout: 0,
    DnsFailures: 0,
    ContainsMalware: 0,
    InLinks: values.InLinks,
  };
}

function crawlRows() {
  return [
    crawlRow('2026-10-14', { CrawledPages: 10, InIndex: 100, CrawlErrors: 1, Code2xx: 8, Code301: 1, Code4xx: 1, Code5xx: 0, BlockedByRobotsTxt: 0, InLinks: 5 }),
    crawlRow('2026-11-10', { CrawledPages: 12, InIndex: 105, CrawlErrors: 2, Code2xx: 9, Code301: 1, Code4xx: 2, Code5xx: 1, BlockedByRobotsTxt: 1, InLinks: 7 }),
  ];
}

function feedRows() {
  return [{
    Url: 'https://mori-zeirishi.net/sitemap.xml',
    Type: 'Sitemap',
    Status: 'Success',
    UrlCount: 315,
    FileSize: 12345,
    Compressed: false,
    Submitted: bingDate('2026-01-01'),
    LastCrawled: bingDate('2026-11-10'),
    __type: 'Feed',
  }];
}

const DEFAULT = {
  GetRankAndTrafficStats: trafficRows,
  GetQueryStats: queryRows,
  GetPageStats: pageRows,
  GetCrawlStats: crawlRows,
  GetFeeds: feedRows,
};

/** 窓口の名前で応答を差し替えられる偽の fetch。 */
function fakeFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const name = endpointOf(url);
    const attempt = calls.filter(call => call.name === name).length + 1;
    calls.push({ url, init, name, attempt });
    const handler = overrides[name];
    if (typeof handler === 'function') return handler({ url, init, attempt, calls });
    if (handler !== undefined) return handler;
    return response(200, { d: DEFAULT[name]() });
  };
  return { calls, fetchImpl };
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function allText(dir) {
  const texts = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else texts.push(fs.readFileSync(full, 'utf8'));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return texts.join('\n');
}

async function runFetcher(fake, options = {}) {
  const logs = options.logs || [];
  return fetcher.run({
    env: { BING_WEBMASTER_API_KEY: KEY },
    now: new Date('2026-11-15T19:00:00Z'),
    fetchImpl: fake.fetchImpl,
    retryDelays: [0, 0],
    timeoutMs: 1000,
    log: message => logs.push(String(message)),
    ...options,
    logs: undefined,
  });
}

(async () => {
  // ---------------------------------------------------------------- 01 R1
  console.log('=== 1. 鍵が無ければスキップする ===');
  {
    const tmp = tempDir('bing-skip');
    let calls = 0;
    const result = await fetcher.run({
      env: {},
      outRoot: tmp,
      log: () => {},
      fetchImpl: async () => { calls++; return response(200, { d: [] }); },
    });
    assert(result.status === 'skipped', 'status は skipped');
    assert(calls === 0, 'fetch を 1 回も呼ばない');
    assert(fs.readdirSync(tmp).length === 0, '何も書かない');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('');
  console.log('=== 2. 呼ぶ窓口と URL ===');
  {
    const tmp = tempDir('bing-url');
    const fake = fakeFetch();
    const result = await runFetcher(fake, { outRoot: tmp });
    assert(result.status === 'fetched', '取り込める');
    const names = [...new Set(fake.calls.map(call => call.name))].sort();
    assert(names.join(',') === 'GetCrawlStats,GetFeeds,GetPageStats,GetQueryStats,GetRankAndTrafficStats',
      `呼んだのは 5 つの窓口だけ（${names.join(',')}）`);
    assert(fake.calls.every(call => (call.init.method || 'GET') === 'GET'), '方法は GET（または未指定）');
    assert(fake.calls.every(call => String(call.url).startsWith('https://ssl.bing.com/webmaster/api.svc/json/')),
      '窓口の URL で始まる');
    assert(fake.calls.every(call => {
      const url = new URL(call.url);
      return url.searchParams.get('siteUrl') === 'https://mori-zeirishi.net/'
        && url.searchParams.get('apikey') === KEY;
    }), 'siteUrl と apikey が付く');
    assert(fake.calls.every(call => call.init.headers && call.init.headers.Accept === 'application/json'),
      'Accept: application/json を送る');
    assert(fake.calls.every(call => call.init.signal && typeof call.init.signal.aborted === 'boolean'),
      '時間切れの signal を渡す');
    assert(Object.isFrozen(fetcher.ENDPOINTS), '窓口の一覧は Object.freeze してある');

    let threw = false;
    try { fetcher.endpointUrl('SubmitUrl', 'https://mori-zeirishi.net/', KEY); } catch (_) { threw = true; }
    assert(threw, '一覧に無い窓口名（SubmitUrl）で URL を作ろうとすると例外');
    threw = false;
    try { fetcher.endpointUrl('toString', 'https://mori-zeirishi.net/', KEY); } catch (_) { threw = true; }
    assert(threw, '一覧の元の項目名（toString）でも例外');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('');
  console.log('=== 3. 1 つ目のサイトで失敗したら 2 つ目を使う ===');
  {
    const tmp = tempDir('bing-site');
    const fake = fakeFetch({
      GetRankAndTrafficStats: ({ url }) => {
        const site = new URL(url).searchParams.get('siteUrl');
        return site === 'https://mori-zeirishi.net/'
          ? response(400, { ErrorCode: 3, Message: 'InvalidApiKey' })
          : response(200, { d: trafficRows() });
      },
    });
    const result = await runFetcher(fake, { outRoot: tmp });
    assert(result.siteUrl === 'https://mori-zeirishi.net', '2 つ目のサイトを選ぶ');
    const trafficCalls = fake.calls.filter(call => call.name === 'GetRankAndTrafficStats');
    assert(trafficCalls.length === 2, '1 つ目の失敗は再試行せず 2 つ目へ進む');
    const others = fake.calls.filter(call => call.name !== 'GetRankAndTrafficStats');
    assert(others.length === 4 && others.every(call => new URL(call.url).searchParams.get('siteUrl') === 'https://mori-zeirishi.net'),
      '以後の窓口も 2 つ目のサイトを使う');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- 01 R3
  console.log('');
  console.log('=== 4. 日付・数・順位の読み方 ===');
  {
    assert(fetcher.parseDate('/Date(1316156400000-0700)/') === '2011-09-16', '/Date(ミリ秒±時差)/ は UTC の暦日');
    assert(fetcher.parseDate('/Date(1772755200000)/') === '2026-03-06', '/Date(ミリ秒)/ も UTC の暦日');
    assert(fetcher.parseDate('2026-11-07T00:00:00') === '2026-11-07', 'ISO の文字列は先頭 10 文字');
    assert(fetcher.parseDate('2026-11-07') === '2026-11-07', '日付だけの文字列も読む');
    assert(fetcher.parseDate('きのう') === null && fetcher.parseDate(1316156400000) === null, '読めない日付は null');
    assert(fetcher.parseCount(0) === 0 && fetcher.parseCount(12) === 12, '0 以上の整数は使う');
    assert(fetcher.parseCount(-1) === null && fetcher.parseCount(1.5) === null && fetcher.parseCount('12') === null,
      '負・小数・文字列は捨てる');
    assert(fetcher.parsePosition(3.25) === 3.25 && fetcher.parsePosition(-1) === null && fetcher.parsePosition(0) === null,
      '順位は 0 より大きい数だけ（-1・0 は順位なし）');
    assert(fetcher.POSITION_SCALE === 1, '順位の倍率は 1');

    const tmp = tempDir('bing-dates');
    const result = await runFetcher(fakeFetch({
      GetRankAndTrafficStats: () => response(200, { d: [
        { Date: bingDate('2026-11-10'), Impressions: 5, Clicks: 1 },
        { Date: 'きのう', Impressions: 5, Clicks: 1 },
        { Date: bingDate('2026-11-09'), Impressions: '5', Clicks: 1 },
      ] }),
    }), { outRoot: tmp });
    assert(result.sections.traffic.dropped_rows === 2, '読めない日付・数の行は捨てて数える');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- 01 R4
  console.log('');
  console.log('=== 5. 期間（28 日） ===');
  {
    const tmp = tempDir('bing-window');
    const result = await runFetcher(fakeFetch(), { outRoot: tmp });
    assert(result.window.start === '2026-10-14' && result.window.end === '2026-11-10'
      && result.window.days_reported === 28, `traffic の最新日から 28 日（${result.window.start}〜${result.window.end}）`);
    const traffic = readJson(path.join(tmp, '20261115', 'traffic.json'));
    assert(traffic.rows.length === 28 && !traffic.rows.some(row => row.date === '2026-05-15'),
      '期間外の行は使わない');
    assert(traffic.rows[0].date === '2026-10-14' && traffic.rows[27].date === '2026-11-10', '日付順に並ぶ');
    assert(result.totals.impressions === 280 && result.totals.clicks === 28, '表示・クリックの合計');
    fs.rmSync(tmp, { recursive: true, force: true });

    const tmp2 = tempDir('bing-window-fallback');
    const fallback = await runFetcher(fakeFetch({ GetRankAndTrafficStats: () => response(200, { d: [] }) }), { outRoot: tmp2 });
    assert(fallback.window && fallback.window.end === '2026-11-10', 'traffic が 0 行なら他の窓口の最新日');
    fs.rmSync(tmp2, { recursive: true, force: true });

    const tmp3 = tempDir('bing-window-none');
    const none = await runFetcher(fakeFetch({
      GetRankAndTrafficStats: () => response(200, { d: [] }),
      GetQueryStats: () => response(200, { d: [] }),
      GetPageStats: () => response(200, { d: [] }),
      GetCrawlStats: () => response(200, { d: [] }),
    }), { outRoot: tmp3 });
    assert(none.window === null, 'どれも 0 行なら window は null');
    for (const name of ['traffic', 'queries', 'pages', 'crawl']) {
      const saved = readJson(path.join(tmp3, '20261115', `${name}.json`));
      assert(Array.isArray(saved.rows) && saved.rows.length === 0, `${name}.json の rows は空`);
    }
    fs.rmSync(tmp3, { recursive: true, force: true });
  }

  console.log('');
  console.log('=== 6. 同じ日付の行 ===');
  {
    const tmp = tempDir('bing-dup');
    const same = await runFetcher(fakeFetch({
      GetRankAndTrafficStats: () => response(200, { d: [
        { Date: bingDate('2026-11-10'), Impressions: 5, Clicks: 1 },
        { Date: bingDate('2026-11-10'), Impressions: 5, Clicks: 1 },
      ] }),
    }), { outRoot: tmp });
    assert(same.window.days_reported === 1 && same.totals.impressions === 5, '同じ値なら 1 行として数える');
    assert(same.window.conflicting_dates.length === 0, '食い違いはない');
    fs.rmSync(tmp, { recursive: true, force: true });

    const tmp2 = tempDir('bing-conflict');
    const conflict = await runFetcher(fakeFetch({
      GetRankAndTrafficStats: () => response(200, { d: [
        { Date: bingDate('2026-11-10'), Impressions: 5, Clicks: 1 },
        { Date: bingDate('2026-11-10'), Impressions: 6, Clicks: 1 },
        { Date: bingDate('2026-11-09'), Impressions: 5, Clicks: 1 },
      ] }),
    }), { outRoot: tmp2 });
    assert(conflict.window.conflicting_dates.join(',') === '2026-11-10', '食い違う日は conflicting_dates に記録');
    const traffic = readJson(path.join(tmp2, '20261115', 'traffic.json'));
    assert(traffic.rows.length === 1 && traffic.rows[0].date === '2026-11-09', '食い違う日は使わない');
    fs.rmSync(tmp2, { recursive: true, force: true });

    const tmp3 = tempDir('bing-conflict-crawl');
    const crawl = await runFetcher(fakeFetch({
      GetCrawlStats: () => response(200, { d: [
        crawlRow('2026-11-10', { CrawledPages: 1, InIndex: 1, CrawlErrors: 0, Code2xx: 1, Code301: 0, Code4xx: 0, Code5xx: 0, BlockedByRobotsTxt: 0, InLinks: 0 }),
        crawlRow('2026-11-10', { CrawledPages: 2, InIndex: 1, CrawlErrors: 0, Code2xx: 1, Code301: 0, Code4xx: 0, Code5xx: 0, BlockedByRobotsTxt: 0, InLinks: 0 }),
      ] }),
    }), { outRoot: tmp3 });
    assert(crawl.window.conflicting_dates.join(',') === '2026-11-10', 'crawl の食い違いも記録する');
    fs.rmSync(tmp3, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- 01 R4 queries/pages
  console.log('');
  console.log('=== 7. 検索語・ページのまとめ方 ===');
  {
    const tmp = tempDir('bing-aggregate');
    const result = await runFetcher(fakeFetch(), { outRoot: tmp });
    const queries = readJson(path.join(tmp, '20261115', 'queries.json'));
    const konnichi = queries.rows.find(row => row.query === '確定申告');
    assert(konnichi.impressions === 400 && konnichi.clicks === 20, '2 週分の同じ語を足す');
    assert(konnichi.position === 4 && konnichi.click_position === 3.38,
      '順位は表示回数・クリック数で重みを付けた平均（小数第 2 位）');
    assert(konnichi.weeks === 2, '出た日付の数を weeks に出す');
    const keihi = queries.rows.find(row => row.query === '経費');
    assert(keihi.position === null && keihi.click_position === null, '-1 の順位は「順位なし」（null）');
    assert(result.sections.queries.weeks === 2 && result.sections.queries.weeks_at_cap === 0,
      '期間内の日付の数と上限に達した日');
    const pages = readJson(path.join(tmp, '20261115', 'pages.json'));
    assert(pages.rows.every(row => row.page) && pages.rows.some(row => row.page === 'https://mori-zeirishi.net/'),
      'ページは Query 列の URL でまとめる');
    fs.rmSync(tmp, { recursive: true, force: true });

    const weighted = fetcher.aggregateTerms([
      { date: '2026-11-01', query: 'q', impressions: 0, clicks: 0, position: 1, click_position: 1 },
      { date: '2026-11-08', query: 'q', impressions: 100, clicks: 10, position: 10, click_position: 8 },
    ], 'query');
    assert(weighted[0].position === 10 && weighted[0].click_position === 8,
      '表示 0・クリック 0 の行は平均に入らない');

    const many = Array.from({ length: 1200 }, (_, index) => ({
      date: '2026-11-01', query: `q${String(index).padStart(4, '0')}`,
      impressions: 1200 - index, clicks: 0, position: 1, click_position: null,
    }));
    const cut = fetcher.aggregateTerms(many, 'query');
    assert(cut.length === 1000, '1,000 行で切る');
    assert(cut[0].query === 'q0000' && cut[999].query === 'q0999', '表示の多い順に残す');

    const tied = fetcher.aggregateTerms([
      { date: '2026-11-01', query: 'b', impressions: 10, clicks: 1, position: null, click_position: null },
      { date: '2026-11-01', query: 'a', impressions: 10, clicks: 1, position: null, click_position: null },
      { date: '2026-11-01', query: 'c', impressions: 10, clicks: 2, position: null, click_position: null },
    ], 'query').map(row => row.query);
    assert(tied.join(',') === 'c,a,b', '並びは表示→クリック→文字列の順');
  }

  // ---------------------------------------------------------------- 01 R2/R5
  console.log('');
  console.log('=== 8. 失敗の扱い ===');
  {
    const tmp = tempDir('bing-traffic-fail');
    const latestPath = path.join(tmp, 'latest.json');
    fs.writeFileSync(latestPath, '{"keep":true}', 'utf8');
    let error = null;
    try {
      await runFetcher(fakeFetch({
        GetRankAndTrafficStats: () => response(500, 'boom'),
      }), { outRoot: tmp });
    } catch (caught) { error = caught; }
    assert(error && error.message === 'GetRankAndTrafficStats: HTTP 500', `traffic の失敗は例外（${error && error.message}）`);
    assert(fs.readFileSync(latestPath, 'utf8') === '{"keep":true}', '前からある latest.json は変えない');
    assert(!fs.existsSync(path.join(tmp, '20261115')), '日付フォルダも作らない');
    fs.rmSync(tmp, { recursive: true, force: true });

    const tmp2 = tempDir('bing-queries-fail');
    const logs = [];
    const partial = await runFetcher(fakeFetch({
      GetQueryStats: () => response(400, { ErrorCode: 3, Message: 'InvalidApiKey' }),
    }), { outRoot: tmp2, logs });
    assert(partial.sections.queries.status === 'failed', '失敗した窓口は failed');
    assert(partial.sections.queries.reason === 'GetQueryStats: HTTP 400 ErrorCode 3 InvalidApiKey',
      `理由は決まった形（${partial.sections.queries.reason}）`);
    assert(!partial.files.queries && !fs.existsSync(path.join(tmp2, '20261115', 'queries.json')),
      '失敗した窓口のファイルは書かない');
    assert(partial.files.traffic && partial.files.pages && partial.files.crawl && partial.files.feeds, '残りは保存する');
    const latest = readJson(path.join(tmp2, 'latest.json'));
    assert(!latest.files.queries && latest.sections.queries.status === 'failed', 'latest.json からも外す');
    assert(logs.some(line => line === '::warning::Bing の queries を取得できませんでした（GetQueryStats: HTTP 400 ErrorCode 3 InvalidApiKey）'),
      '失敗した窓口ごとに警告を出す');
    fs.rmSync(tmp2, { recursive: true, force: true });

    const tmp3 = tempDir('bing-429');
    let attempts = 0;
    const retried = await runFetcher(fakeFetch({
      GetPageStats: () => {
        attempts++;
        return attempts === 1 ? response(429, 'slow down') : response(200, { d: pageRows() });
      },
    }), { outRoot: tmp3 });
    assert(attempts === 2 && retried.sections.pages.status === 'ok', '429 は再試行して成功する');
    fs.rmSync(tmp3, { recursive: true, force: true });

    const tmp4 = tempDir('bing-400');
    let badAttempts = 0;
    const notRetried = await runFetcher(fakeFetch({
      GetPageStats: () => { badAttempts++; return response(400, 'bad'); },
    }), { outRoot: tmp4 });
    assert(badAttempts === 1, '400 は再試行しない');
    assert(notRetried.sections.pages.reason === 'GetPageStats: HTTP 400', '理由は HTTP の番号だけ');
    fs.rmSync(tmp4, { recursive: true, force: true });

    const tmp5 = tempDir('bing-timeout');
    const timedOut = await runFetcher(fakeFetch({
      GetFeeds: () => {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      },
    }), { outRoot: tmp5 });
    assert(timedOut.sections.feeds.reason === 'GetFeeds: 時間切れ', '時間切れの理由');
    fs.rmSync(tmp5, { recursive: true, force: true });
  }

  console.log('');
  console.log('=== 9. 鍵が漏れない ===');
  {
    // (a) 400 の本文に URL 全体（鍵入り）が入る
    const tmp = tempDir('bing-leak-body');
    const logs = [];
    const result = await runFetcher(fakeFetch({
      GetQueryStats: ({ url }) => response(400, `{"message":"bad request ${url}"}`),
    }), { outRoot: tmp, logs });
    assert(result.sections.queries.reason === 'GetQueryStats: HTTP 400', '本文を使わず決まった形にする');
    const written = allText(tmp);
    assert(!written.includes(KEY) && !logs.join('\n').includes(KEY), '偽の鍵がファイルにもログにも出ない');
    assert(!written.includes('apikey') && !logs.join('\n').includes('apikey'), 'apikey も出ない');
    fs.rmSync(tmp, { recursive: true, force: true });

    // (b) fetch が URL 全体を含む message の例外を投げる
    const tmp2 = tempDir('bing-leak-error');
    const logs2 = [];
    const thrown = await runFetcher(fakeFetch({
      GetFeeds: ({ url }) => {
        const error = new Error(`failed to fetch ${url}`);
        error.name = 'TypeError';
        throw error;
      },
    }), { outRoot: tmp2, logs: logs2 });
    assert(thrown.sections.feeds.reason === 'GetFeeds: 接続できませんでした（TypeError）', '例外の文ではなく名前だけを使う');
    assert(!allText(tmp2).includes(KEY) && !logs2.join('\n').includes(KEY), '例外の経路でも鍵が出ない');
    fs.rmSync(tmp2, { recursive: true, force: true });

    // (c) 成功したとき
    const tmp3 = tempDir('bing-leak-ok');
    const logs3 = [];
    await runFetcher(fakeFetch(), { outRoot: tmp3, logs: logs3 });
    assert(!allText(tmp3).includes(KEY) && !logs3.join('\n').includes(KEY) && !logs3.join('\n').includes('apikey'),
      '成功の経路でも鍵が出ない');
    fs.rmSync(tmp3, { recursive: true, force: true });

    // (d) 最後の守り: 保存する値に apikey が混ざったら書かずに止める
    const tmp4 = tempDir('bing-leak-guard');
    let guardError = null;
    try {
      await runFetcher(fakeFetch({
        GetFeeds: () => response(200, { d: [{ Url: 'https://example.test/?apikey=x', Type: 'Sitemap' }] }),
      }), { outRoot: tmp4 });
    } catch (caught) { guardError = caught; }
    assert(guardError && guardError.message === '[bing] 鍵が含まれるため書き込みを止めました', '鍵らしい文字列は書く直前に止める');
    fs.rmSync(tmp4, { recursive: true, force: true });
  }

  console.log('');
  console.log('=== 10. 決めた項目だけを保存する ===');
  {
    const tmp = tempDir('bing-fields');
    await runFetcher(fakeFetch(), { outRoot: tmp });
    const traffic = readJson(path.join(tmp, '20261115', 'traffic.json'));
    assert(Object.keys(traffic.rows[0]).sort().join(',') === 'clicks,date,impressions', 'traffic は date・impressions・clicks');
    const queries = readJson(path.join(tmp, '20261115', 'queries.json'));
    assert(Object.keys(queries.rows[0]).sort().join(',') === 'click_position,clicks,impressions,position,query,weeks',
      'queries は決めた 6 項目');
    const crawl = readJson(path.join(tmp, '20261115', 'crawl.json'));
    assert(Object.keys(crawl.rows[0]).sort().join(',') === 'AllOtherCodes,BlockedByRobotsTxt,Code2xx,Code301,Code302,Code4xx,Code5xx,'
      + 'ConnectionTimeout,ContainsMalware,CrawlErrors,CrawledPages,DnsFailures,InIndex,InLinks,date',
    'crawl は Bing の名前のまま');
    const feeds = readJson(path.join(tmp, '20261115', 'feeds.json'));
    assert(feeds.rows[0].Submitted === '2026-01-01' && feeds.rows[0].LastCrawled === '2026-11-10',
      'feeds の日付は YYYY-MM-DD');
    assert(!allText(tmp).includes('__type') && !allText(tmp).includes('"Unknown"'), '余計な項目は保存しない');
    const latest = readJson(path.join(tmp, 'latest.json'));
    assert(latest.files.traffic === '20261115/traffic.json' && latest.fetched_at === '2026-11-15T19:00:00.000Z',
      'latest.json に所在と取得日時');
    assert(latest.sections.queries.raw_rows === 3 && latest.sections.queries.used_rows === 3,
      '窓口ごとの行数を記録する');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- 01 R5
  console.log('');
  console.log('=== 11. 古い日付フォルダを消す（12 回分） ===');
  {
    const tmp = tempDir('bing-prune');
    for (let index = 1; index <= 14; index++) {
      fs.mkdirSync(path.join(tmp, `2025${String(index).padStart(2, '0')}01`), { recursive: true });
    }
    const result = await runFetcher(fakeFetch(), { outRoot: tmp });
    const remain = fs.readdirSync(tmp).filter(name => /^\d{8}$/.test(name));
    assert(remain.length === 12, `12 個だけ残る（残り ${remain.length}）`);
    assert(remain.includes('20261115'), '今回のフォルダは残る');
    assert(result.removed.length === 3, '古い 3 個を消す');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- 01 R7
  console.log('');
  console.log('=== 12. ワークフロー ===');
  {
    const source = fs.readFileSync(path.join(ROOT, '.github/workflows/fetch-search-console.yml'), 'utf8').replace(/\r\n/g, '\n');
    const document = yaml.load(source);
    const steps = document.jobs.fetch.steps;
    const names = steps.map(step => step.name);
    const bingIndex = names.indexOf('Fetch from Bing Webmaster Tools');
    assert(bingIndex > names.indexOf('Fetch from Search Console'), 'Bing の手順は「Fetch from Search Console」の後');
    assert(bingIndex < names.indexOf('Build freshness candidates and report'), '「Build freshness candidates and report」の前');

    const bingStep = steps[bingIndex];
    assert(bingStep.env && bingStep.env.BING_WEBMASTER_API_KEY === '${{ secrets.BING_WEBMASTER_API_KEY }}',
      '鍵は env で渡す');
    assert(!/secrets\./.test(bingStep.run), 'run の中に secrets を書かない');
    assert(bingStep.run.includes('|| echo "::warning::'), '失敗しても止まらない');
    assert(/if \[ -z "\$BING_WEBMASTER_API_KEY" \]/.test(bingStep.run), '未設定なら何もしない');

    const gitAdd = source.slice(source.indexOf('git add data/search-console'));
    assert(gitAdd.startsWith('git add data/search-console data/freshness data/bing-webmaster'),
      'git add に data/bing-webmaster を足す');
    assert(source.includes('git status --porcelain -- data/search-console data/freshness data/gsc-topics.json data/bing-webmaster'),
      'git status にも data/bing-webmaster を足す');
    assert(source.includes('Bing の数字はレポートの「Bing の数字」の節にあります。'), 'PR 本文に案内を足す');

    const byName = name => steps.find(step => step.name === name);
    assert(byName('Update GSC topics').if === '${{ inputs.dry_run != true }}', 'dry_run では GSC 候補を更新しない');
    assert(byName('Create PR if changed').if === '${{ inputs.dry_run != true }}', 'dry_run では PR を作らない');
    assert(byName('Upload dry-run result').if === '${{ inputs.dry_run == true }}', 'dry_run のとき成果物を置く');
    assert(names[names.length - 1] === 'Upload dry-run result', 'dry-run の手順は最後');
    assert(!byName('Notify freshness candidates').if.includes('dry_run'), '通知の条件は今のまま');
    assert(document.on.schedule[0].cron === '0 19 * * 0', '予定の実行は今のまま');
  }

  console.log('');
  console.log('=== 13. 記事生成の側は Bing を読まない ===');
  {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('bing-webmaster')) {
          hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(path.join(ROOT, 'scripts'));
    assert(hits.sort().join(',') === 'scripts/fetch-bing-webmaster.js,scripts/report-search-console.js',
      `bing-webmaster を含むのは 2 つだけ（${hits.join(',')}）`);
  }

  // ---------------------------------------------------------------- 02 R10/R11
  console.log('');
  console.log('=== 14. レポートの「Bing の数字」の節 ===');
  const bingFixture = () => ({
    latest: {
      fetched_at: '2026-11-15T19:00:00.000Z',
      site_url: 'https://mori-zeirishi.net/',
      window: { start: '2026-10-14', end: '2026-11-10', days_reported: 28, conflicting_dates: [] },
      totals: { impressions: 1234, clicks: 56 },
      files: {},
      sections: {
        traffic: { status: 'ok' },
        queries: { status: 'ok', weeks: 4, weeks_at_cap: 4 },
        pages: { status: 'ok' },
        crawl: { status: 'ok' },
        feeds: { status: 'ok' },
      },
    },
    traffic: { rows: [] },
    queries: {
      rows: Array.from({ length: 25 }, (_, index) => ({
        query: `語${String(index + 1).padStart(2, '0')}`,
        impressions: 100 - index,
        clicks: 1,
        position: index === 0 ? null : 3 + index,
        click_position: null,
        weeks: 1,
      })),
    },
    pages: {
      rows: [
        { page: 'https://mori-zeirishi.net/blog/a/', clicks: 3, impressions: 30, position: 5 },
        { page: 'https://mori-zeirishi.net/services/bookkeeping/', clicks: 9, impressions: 90, position: 2.25 },
      ],
    },
    crawl: { rows: crawlRows().map(row => ({
      date: row.Date === bingDate('2026-10-14') ? '2026-10-14' : '2026-11-10',
      CrawledPages: row.CrawledPages,
      InIndex: row.InIndex,
      CrawlErrors: row.CrawlErrors,
      Code2xx: row.Code2xx,
      Code301: row.Code301,
      Code302: row.Code302,
      Code4xx: row.Code4xx,
      Code5xx: row.Code5xx,
      BlockedByRobotsTxt: row.BlockedByRobotsTxt,
      AllOtherCodes: row.AllOtherCodes,
      ConnectionTimeout: row.ConnectionTimeout,
      DnsFailures: row.DnsFailures,
      ContainsMalware: row.ContainsMalware,
      InLinks: row.InLinks,
    })) },
    feeds: {
      rows: [{
        Url: 'https://mori-zeirishi.net/sitemap.xml', Type: 'サイトマップ', Status: '成功',
        LastCrawled: '2026-11-10', UrlCount: 315,
      }],
    },
  });
  const gscLatest = { fetched_at: '2026-11-15T19:00:00.000Z', range: { start: '2026-10-02', end: '2026-10-29' } };
  const gscPages = [{ impressions: 100, clicks: 5 }, { impressions: 50, clicks: 1 }];
  const buildSection = (options = {}) => reporter.buildBingSection({
    bing: bingFixture(), gscLatest, gscPages, ...options,
  }).join('\n');

  console.log('');
  console.log('=== 14-1. 未取り込み ===');
  {
    const text = reporter.buildBingSection({ bing: null }).join('\n');
    assert(text.startsWith('## Bing の数字（Bing Webmaster Tools）'), '見出しは出る');
    const body = text.split('\n').filter(line => line.trim() !== '').slice(1);
    assert(body.length === 1 && body[0].includes('Bing はまだ取り込まれていません')
      && body[0].includes('docs/search-console-setup.md'), '案内の 1 行だけ');
  }

  console.log('');
  console.log('=== 14-2. 普通のデータ ===');
  {
    const text = buildSection();
    assert(text.includes('- 取得日時: 2026-11-15T19:00:00.000Z'), '取得日時');
    assert(text.includes('- 期間: 2026-10-14 〜 2026-11-10（Bing が返した日数 28/28）'), '期間と日数');
    assert(text.includes('- 表示 1,234 ／ クリック 56（ウェブのほか、チャット・ニュース・画像・動画・ナレッジパネルの表示も含みます）'),
      '表示・クリックの合計');
    assert(text.includes('- 参考: Google（ページ別の合計、2026-10-02〜2026-10-29）表示 150 ／ クリック 6'), 'Google の参考');
    assert(text.includes('### 検索語の上位 20（表示回数順）'), '検索語の見出し');
    assert(text.includes('期間内の週 4、うち上限に達した週 4'), '週の数と上限の注記');
    assert(text.includes('| 語20 |') && !text.includes('| 語21 |'), '検索語は上位 20 で切る');
    assert(text.includes('| 語01 | 100 | 1 | — |'), '順位なしは「—」');
    assert(text.includes('| 語02 | 99 | 1 | 4.0 |'), '平均順位は小数第 1 位');
    const pages = text.split('### ページの上位 20（クリック順）')[1].split('### 巡回とサイトマップ')[0];
    assert(pages.indexOf('services/bookkeeping') < pages.indexOf('blog/a/'), 'ページはクリックの多い順');
    assert(pages.includes('| サービス |') && pages.includes('| 記事 |'), 'ページの種別を出す');
    assert(pages.includes('| 2.3 |'), 'ページの平均順位');
    assert(text.includes('- 索引にあるページ（InIndex）: 105（期間の初日 100、差 +5）'), 'InIndex の差');
    assert(text.includes('- 期間の合計: 巡回したページ 22 ／ 巡回の誤り 3 ／ 4xx 3 ／ 5xx 1 ／ robots.txt で止めた 1'), '巡回の合計');
    assert(text.includes('- 被リンク（InLinks、最新の日）: 7'), '被リンク');
    assert(text.includes('| https://mori-zeirishi.net/sitemap.xml | サイトマップ | 成功 | 2026-11-10 | 315 |'), 'サイトマップの表');
    assert(text.includes('- AI の回答での引用（AI Performance）は API で取れないため、月 1 回 Bing の画面で確かめます。'), 'AI の注記');
  }

  console.log('');
  console.log('=== 14-3. 古いデータの注意 ===');
  {
    const older = buildSection({ gscLatest: { ...gscLatest, fetched_at: '2026-11-19T19:00:00.000Z' } });
    assert(older.includes('**今週の Bing の取り込みは失敗したか未設定です。以下は 2026-11-15 の取り込みの数字です。**'),
      '4 日古ければ注意を出す');
    const near = buildSection({ gscLatest: { ...gscLatest, fetched_at: '2026-11-17T19:00:00.000Z' } });
    assert(!near.includes('今週の Bing の取り込みは失敗したか未設定です'), '2 日なら出さない');
  }

  console.log('');
  console.log('=== 14-4. 失敗した窓口 ===');
  {
    const bing = bingFixture();
    bing.latest.sections.queries = { status: 'failed', reason: 'GetQueryStats: HTTP 500' };
    const text = buildSection({ bing });
    assert(text.includes('（取得に失敗しました: GetQueryStats: HTTP 500）'), '検索語の表の代わりに理由');
    assert(!text.includes('| 検索語 | 表示 | クリック | 平均順位 |'), '失敗した表は出さない');
    const bing2 = bingFixture();
    bing2.feeds.rows = [];
    assert(buildSection({ bing: bing2 }).includes('（サイトマップの記録はありません）'), 'サイトマップが空のとき');
    const bing3 = bingFixture();
    bing3.crawl.rows = [];
    assert(buildSection({ bing: bing3 }).includes('（まだデータがありません）'), '巡回が空のとき');
  }

  console.log('');
  console.log('=== 14-5. 表の文字の | を逃がす ===');
  {
    const bing = bingFixture();
    bing.queries.rows[0].query = 'a|b';
    bing.pages.rows[0].page = 'https://mori-zeirishi.net/blog/a|b/';
    const text = buildSection({ bing });
    assert(text.includes('| a\\|b |'), '検索語の | を \\| にする');
    assert(text.includes('a\\|b/'), 'ページの | を \\| にする');
  }

  console.log('');
  console.log('=== 14-6. 節の位置 ===');
  {
    const markdown = reporter.buildReport({
      latest: { fetched_at: '2026-11-15', range: { start: 'a', end: 'b' }, property: 'x' },
      queries: [],
      pages: [],
      bing: bingFixture(),
    });
    const index = markdown.indexOf('## 索引の状態');
    const bingIndex = markdown.indexOf('## Bing の数字（Bing Webmaster Tools）');
    assert(index >= 0 && bingIndex > index, '「索引の状態」より後');
    assert(bingIndex < markdown.indexOf('## 更新候補（上位 10）'), '「更新候補（上位 10）」より前');
  }

  console.log('');
  console.log('=== 14-7. run() は Bing が無くても壊れていても止まらない ===');
  {
    const tmp = tempDir('bing-report-run');
    fs.mkdirSync(path.join(tmp, '20261101'));
    fs.writeFileSync(path.join(tmp, 'latest.json'), JSON.stringify({
      fetched_at: '2026-11-01T04:00:00.000Z',
      range: { start: '2026-10-02', end: '2026-10-29' },
      property: 'test',
      files: { queries: '20261101/queries.json', pages: '20261101/pages.json' },
    }), 'utf8');
    for (const name of ['queries', 'pages']) fs.writeFileSync(path.join(tmp, '20261101', `${name}.json`), '{"rows":[]}', 'utf8');

    const missing = reporter.run({ outRoot: tmp, bingRoot: path.join(tmp, 'no-bing'), log: () => {} });
    assert(missing.status === 'written', 'Bing が無くてもレポートを書く');
    assert(fs.readFileSync(path.join(tmp, 'report.md'), 'utf8').includes('Bing はまだ取り込まれていません'), '未取り込みの案内');

    const brokenRoot = path.join(tmp, 'broken-bing');
    fs.mkdirSync(brokenRoot, { recursive: true });
    fs.writeFileSync(path.join(brokenRoot, 'latest.json'), '{broken', 'utf8');
    assert(reporter.run({ outRoot: tmp, bingRoot: brokenRoot, log: () => {} }).status === 'written',
      'latest.json が壊れていても止まらない');

    const bingRoot = path.join(tmp, 'bing');
    const fixture = bingFixture();
    fs.mkdirSync(path.join(bingRoot, '20261115'), { recursive: true });
    fixture.latest.files = {
      traffic: '20261115/traffic.json', queries: '20261115/queries.json', pages: '20261115/pages.json',
      crawl: '20261115/crawl.json', feeds: '20261115/feeds.json',
    };
    fs.writeFileSync(path.join(bingRoot, 'latest.json'), JSON.stringify(fixture.latest), 'utf8');
    for (const name of ['traffic', 'queries', 'pages', 'crawl', 'feeds']) {
      fs.writeFileSync(path.join(bingRoot, '20261115', `${name}.json`), JSON.stringify(fixture[name]), 'utf8');
    }
    assert(reporter.run({ outRoot: tmp, bingRoot, log: () => {} }).status === 'written', 'Bing があれば読んで書く');
    const report = fs.readFileSync(path.join(tmp, 'report.md'), 'utf8');
    assert(report.includes('- 取得日時: 2026-11-15T19:00:00.000Z') && report.includes('| 語01 |'), 'Bing の数字を載せる');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('');
  console.log('=== 結果 ===');
  console.log(`PASS: ${passed} / FAIL: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
