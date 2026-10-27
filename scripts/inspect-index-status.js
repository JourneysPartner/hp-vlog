#!/usr/bin/env node
'use strict';

/**
 * sitemap.xml の URL を URL Inspection API で検査し、週次スナップショットを保存する。
 * 認証情報はログや出力ファイルに含めない。
 */

const fs = require('fs');
const path = require('path');
const {
  accessTokenFromServiceAccount,
  parseServiceAccountJson,
  PROPERTIES,
  OUT_ROOT,
} = require('./fetch-search-console');

const ROOT = path.join(__dirname, '..');
const SITEMAP_PATH = path.join(ROOT, 'sitemap.xml');
const API = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const MAX_URLS = 1800;
const CONCURRENCY = 4;
const REQUEST_INTERVAL_MS = 150;
const RETRY_WAIT_MS = 15000;
const TIMEOUT_MS = 60000;

function stamp(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function readSitemapUrls(sitemapPath = SITEMAP_PATH) {
  const xml = fs.readFileSync(sitemapPath, 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].trim()).filter(Boolean);
}

function pageKind(url) {
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch (_) { pathname = String(url || ''); }
  if (pathname === '/' || pathname === '/index.html') return 'トップ';
  if (pathname.startsWith('/services/') || pathname === '/services.html') return 'サービス';
  if (pathname.startsWith('/pricing')) return '料金';
  if (pathname.startsWith('/area')) return '対応地域';
  if (pathname === '/blog/macro/' || pathname.startsWith('/blog/macro/')) return '業種ハブ';
  if (/^\/blog\/[^/]+\/?$/.test(pathname) && !/^\/blog\/(?:category|page)\//.test(pathname)) return '記事';
  if (pathname.startsWith('/tools/')) return 'ツール';
  return 'その他';
}

function safeError(error) {
  if (!error) return '不明なエラー';
  if (error.name === 'AbortError' || error.code === 'ETIMEDOUT') return '60秒でタイムアウト';
  return String(error.message || error).slice(0, 300);
}

async function requestInspection({ fetchImpl, token, property, url, timeoutMs = TIMEOUT_MS }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('60秒でタイムアウト');
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
  });

  let response;
  try {
    response = await Promise.race([
      fetchImpl(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inspectionUrl: url, siteUrl: property, languageCode: 'ja' }),
        signal: controller.signal,
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(`HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return (data.inspectionResult && data.inspectionResult.indexStatusResult) || {};
}

async function inspectOne(options) {
  const { sleep } = options;
  let status;
  try {
    status = await requestInspection(options);
  } catch (error) {
    if (error.status !== 429) throw error;
    await sleep(RETRY_WAIT_MS);
    status = await requestInspection(options);
  }

  return {
    url: options.url,
    kind: pageKind(options.url),
    coverage: status.coverageState || '',
    verdict: status.verdict || '',
    indexing: status.indexingState || '',
    fetch: status.pageFetchState || '',
    lastCrawl: status.lastCrawlTime || '',
    googleCanonical: status.googleCanonical || '',
    referring: Array.isArray(status.referringUrls) ? status.referringUrls.length : 0,
    inSitemap: Array.isArray(status.sitemap) && status.sitemap.length > 0,
  };
}

async function inspectSafely(options) {
  try {
    return await inspectOne(options);
  } catch (error) {
    return { url: options.url, kind: pageKind(options.url), error: safeError(error) };
  }
}

async function inspectConcurrent(urls, options) {
  const rows = new Array(urls.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < urls.length) {
      const index = next++;
      if (index >= CONCURRENCY) await options.sleep(REQUEST_INTERVAL_MS);
      const row = await inspectSafely({ ...options, url: urls[index] });
      rows[index] = row;
      completed++;
      if (completed % 25 === 0) {
        options.log(`[gsc-index] ${completed}/${urls.length}: ${row.url} — ${row.error || row.coverage || row.verdict || '状態なし'}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()));
  return rows;
}

function writeLatestIndexStatus(outRoot, relPath) {
  const latestPath = path.join(outRoot, 'latest.json');
  const latest = fs.existsSync(latestPath)
    ? JSON.parse(fs.readFileSync(latestPath, 'utf8'))
    : {};
  latest.files = { ...(latest.files || {}), indexStatus: relPath };
  fs.writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
}

async function chooseProperty(firstUrl, options) {
  let lastRow = null;
  for (const property of PROPERTIES) {
    const row = await inspectSafely({ ...options, property, url: firstUrl });
    if (!row.error) return { property, row };
    lastRow = row;
    options.log(`[gsc-index] ${property}: ${firstUrl} — ${row.error}（次の候補を試します）`);
  }
  return { property: PROPERTIES[PROPERTIES.length - 1], row: lastRow };
}

/**
 * @returns {Promise<{status: 'skipped'|'fetched', property?: string, total?: number, dir?: string}>}
 */
async function run(options = {}) {
  const env = options.env || process.env;
  const log = options.log || console.log;
  const keyJson = env.GSC_SERVICE_ACCOUNT_JSON;
  if (!keyJson) {
    log('[gsc-index] GSC_SERVICE_ACCOUNT_JSON が未設定のためスキップします');
    return { status: 'skipped', reason: 'no-credentials' };
  }

  // API 呼び出し前に既存の安全なパーサで検証する。例外にも鍵の本文は含まれない。
  parseServiceAccountJson(keyJson);
  const token = options.getToken
    ? await options.getToken(keyJson)
    : await accessTokenFromServiceAccount(keyJson);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || new Date();
  const outRoot = options.outRoot || OUT_ROOT;
  const allUrls = readSitemapUrls(options.sitemapPath || SITEMAP_PATH);
  const urls = allUrls.slice(0, MAX_URLS);
  if (allUrls.length > MAX_URLS) {
    log(`[gsc-index] sitemap.xml は ${allUrls.length} 件のため先頭 ${MAX_URLS} 件だけ検査します（残り ${allUrls.length - MAX_URLS} 件）`);
  }

  const baseOptions = { fetchImpl, token, sleep, log, timeoutMs: options.timeoutMs || TIMEOUT_MS };
  let property = PROPERTIES[0];
  let rows = [];
  if (urls.length > 0) {
    const selected = await chooseProperty(urls[0], baseOptions);
    property = selected.property;
    const rest = await inspectConcurrent(urls.slice(1), { ...baseOptions, property });
    rows = [selected.row, ...rest];
  }

  const dirName = stamp(now);
  const dir = path.join(outRoot, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const relPath = `${dirName}/index-status.json`;
  fs.writeFileSync(path.join(outRoot, relPath), `${JSON.stringify({
    fetchedAt: now.toISOString(),
    property,
    total: rows.length,
    rows,
  }, null, 2)}\n`, 'utf8');
  writeLatestIndexStatus(outRoot, relPath);
  log(`[gsc-index] 保存: ${relPath}（${rows.length} 件）`);
  return { status: 'fetched', property, total: rows.length, dir: dirName, file: relPath };
}

if (require.main === module) {
  run().then(result => {
    if (result.status === 'skipped') console.log('::notice::サーチコンソールの鍵が未設定のため URL 検査をスキップしました');
  }).catch(error => {
    console.error(`[gsc-index] エラー: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  run,
  readSitemapUrls,
  pageKind,
  requestInspection,
  inspectOne,
  inspectConcurrent,
  writeLatestIndexStatus,
  API,
  MAX_URLS,
};
