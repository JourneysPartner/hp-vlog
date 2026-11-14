#!/usr/bin/env node
'use strict';

/**
 * Bing Webmaster Tools の数字を取り込む（2026-11-13 bing-weekly R1〜R8）
 *
 *   node scripts/fetch-bing-webmaster.js
 *
 * 鍵は環境変数 BING_WEBMASTER_API_KEY から読む。未設定なら「未設定」と出して正常終了する（失敗にしない）。
 * 呼ぶのは読み取りの 5 つの窓口（traffic / queries / pages / crawl / feeds）だけ。書き込みの窓口は呼ばない。
 * 取得した数字は data/bing-webmaster/YYYYMMDD/ に保存し、latest.json に所在を書く。保持は直近 12 回分。
 *
 * 鍵・鍵の入った URL・応答の本文・例外の文は、ログにも保存するファイルにも出さない（このリポジトリは公開）。
 * 日ごとの数字（traffic・crawl）は GetRankAndTrafficStats と GetCrawlStats から、検索語・ページは週ごとの
 * 上位だけを返す GetQueryStats と GetPageStats から取る（表の合計は全体の数にはならない）。
 *
 * 記事生成の候補選びには接続しない（GSC と同じく「貯めて見る」まで）。
 */

const fs = require('fs');
const path = require('path');
const { prune } = require('./fetch-search-console');

const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'data', 'bing-webmaster');

/** サイトの候補。最初の窓口で取れたほうを以後の窓口にも使う。 */
const SITE_URLS = Object.freeze(['https://mori-zeirishi.net/', 'https://mori-zeirishi.net']);

const API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

/** 呼んでよい窓口はこの 5 つだけ（読み取りのみ）。 */
const ENDPOINTS = Object.freeze({
  traffic: 'GetRankAndTrafficStats',
  queries: 'GetQueryStats',
  pages: 'GetPageStats',
  crawl: 'GetCrawlStats',
  feeds: 'GetFeeds',
});
const ENDPOINT_ORDER = Object.freeze(['traffic', 'queries', 'pages', 'crawl', 'feeds']);
const REQUIRED_ENDPOINT = 'traffic';

const WINDOW_DAYS = 28;
const ROW_LIMIT = 1000;
const DAYS_AT_CAP = 100;
const KEEP_RUNS = 12;
const TIMEOUT_MS = 30000;
const RETRY_DELAYS = Object.freeze([5000, 15000]);

/**
 * 順位の倍率。Bing の AvgImpressionPosition は 3.25 のような普通の値で返る（倍率なし）。
 * 受け入れで画面と比べて確かめる。
 */
const POSITION_SCALE = 1;

const CRAWL_FIELDS = Object.freeze([
  'CrawledPages', 'InIndex', 'CrawlErrors', 'Code2xx', 'Code301', 'Code302', 'Code4xx', 'Code5xx',
  'BlockedByRobotsTxt', 'AllOtherCodes', 'ConnectionTimeout', 'DnsFailures', 'ContainsMalware', 'InLinks',
]);

const BLOCKED_MESSAGE = '[bing] 鍵が含まれるため書き込みを止めました';
const DATE_PATTERN = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;
/** 形の記録に並べてよい項目名（改行などが入った鍵を Actions の記録に出さないため）。 */
const SHAPE_KEY_PATTERN = /^[A-Za-z0-9_]{1,40}$/;

function ymd(date) { return date.toISOString().slice(0, 10); }
function stamp(date) { return ymd(date).replace(/-/g, ''); }
function n(value) { return Number(value || 0).toLocaleString('ja-JP'); }

function dayNumber(date) { return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000); }
function dateFromDay(day) { return new Date(day * 86400000).toISOString().slice(0, 10); }

/**
 * 鍵を外に出さないための最後の守り。ログに出す文は、出す直前に確かめる。
 * 鍵そのもの・encodeURIComponent(鍵)・apikey のどれかを含んでいたら出さずに止める。
 */
function guardText(text, apiKey) {
  const value = String(text == null ? '' : text);
  const needles = ['apikey'];
  if (apiKey) needles.push(String(apiKey), encodeURIComponent(String(apiKey)));
  for (const needle of needles) {
    if (needle && value.includes(needle)) throw new Error(BLOCKED_MESSAGE);
  }
  return value;
}

function emit(log, text, apiKey) {
  log(guardText(text, apiKey));
}

/**
 * 保存する JSON の確かめ（2026-11-13 bing-weekly R13）。
 * 見るのは鍵そのものと encodeURIComponent(鍵) だけ。検索語・ページの URL に偶然「apikey」の
 * 文字が入っても、その週の取り込みを止めないため「apikey」では止めない。
 * （「apikey」はログの側（guardText）で止める。失敗の理由の文もログに出るのでそこで止まる。）
 */
function guardJson(text, apiKey) {
  const value = String(text == null ? '' : text);
  if (!apiKey) return value;
  for (const needle of [String(apiKey), encodeURIComponent(String(apiKey))]) {
    if (needle && value.includes(needle)) throw new Error(BLOCKED_MESSAGE);
  }
  return value;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 保存するファイルを全部先に作って確かめ、全部が通ってから書き始める（途中まで書いて止まらない）。
 * 日付フォルダも、確かめが通ったあとに作る。
 */
function writeJsonFiles(entries, apiKey) {
  const prepared = entries.map(([filePath, value]) => [filePath, guardJson(jsonText(value), apiKey)]);
  for (const [filePath, text] of prepared) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
  }
}

/**
 * 窓口の URL。一覧に無い名前は例外にする（書き込みの窓口を呼べない作りにする）。
 */
function endpointUrl(name, siteUrl, apiKey) {
  if (!Object.prototype.hasOwnProperty.call(ENDPOINTS, name)) {
    throw new Error(`知らない窓口です: ${name}`);
  }
  return `${API_BASE}/${ENDPOINTS[name]}?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(apiKey)}`;
}

/** 例外の名前だけを使う（message には URL 全体が入ることがあるため使わない）。 */
function safeErrorName(error) {
  const name = String((error && error.name) || '').replace(/[^A-Za-z]/g, '');
  return name || 'Error';
}

/** 応答の本文は捨て、決まった形の理由だけを作る。 */
async function httpReason(name, response) {
  const status = Number(response && response.status);
  let reason = `${name}: HTTP ${Number.isFinite(status) ? status : 0}`;
  let payload = null;
  try {
    if (response && typeof response.json === 'function') payload = await response.json();
    else if (response && typeof response.text === 'function') payload = JSON.parse(String(await response.text()));
  } catch (_) {
    payload = null;
  }
  if (payload && typeof payload === 'object'
    && Number.isInteger(payload.ErrorCode)
    && typeof payload.Message === 'string'
    && /^[A-Za-z0-9 _.-]{1,80}$/.test(payload.Message)) {
    reason += ` ErrorCode ${payload.ErrorCode} ${payload.Message}`;
  }
  return reason;
}

function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/**
 * 窓口を 1 つ呼ぶ。429・5xx・接続の失敗・時間切れのときだけ、5 秒・15 秒あけて最大 2 回やり直す。
 * それ以外の 4xx はすぐ失敗する。失敗は決まった形の理由（R2）を持つ Error で返す。
 */
async function callEndpoint({ name, siteUrl, apiKey, fetchImpl, log, retryDelays, timeoutMs }) {
  const delays = Array.isArray(retryDelays) ? retryDelays : RETRY_DELAYS;
  const label = ENDPOINTS[name];
  for (let attempt = 0; ; attempt++) {
    let response = null;
    let retryable = false;
    let reason = '';
    try {
      response = await fetchImpl(endpointUrl(name, siteUrl, apiKey), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs || TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      retryable = true;
      reason = timedOut ? `${label}: 時間切れ` : `${label}: 接続できませんでした（${safeErrorName(error)}）`;
    }

    if (response) {
      if (response.ok) {
        let payload = null;
        let timedOut = false;
        try {
          payload = await response.json();
        } catch (error) {
          // 本文を読む途中の時間切れも、時間切れとしてやり直す（R17）。
          if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) timedOut = true;
        }
        if (timedOut) {
          retryable = true;
          reason = `${label}: 時間切れ`;
        } else if (payload && Array.isArray(payload.d)) {
          return payload.d;
        } else {
          throw new Error(`${label}: 応答の形が違います`);
        }
      } else if (response.status === 429 || response.status >= 500) {
        retryable = true;
        reason = await httpReason(label, response);
      } else {
        throw new Error(await httpReason(label, response));
      }
    }

    if (!retryable || attempt >= delays.length) throw new Error(reason);
    const wait = Number(delays[attempt]) || 0;
    if (log) emit(log, `[bing] ${label}: 再試行します（${n(wait / 1000)} 秒後）`, apiKey);
    if (wait > 0) await sleep(wait);
  }
}

/** `/Date(ミリ秒±hhmm)/` はミリ秒を UTC の暦日へ。`2026-11-07T…` は先頭 10 文字。他は捨てる。 */
function parseDate(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const matched = DATE_PATTERN.exec(text);
  if (matched) {
    const ms = Number(matched[1]);
    if (!Number.isFinite(ms)) return null;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (iso) {
    const date = new Date(`${iso[1]}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : iso[1];
  }
  return null;
}

/** 0 以上の整数だけを使う。それ以外は null（呼び側で行を捨てる）。 */
function parseCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** 順位は 0 より大きい数のときだけ使う。-1・0・数でないものは「順位なし」（null）。 */
function parsePosition(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * POSITION_SCALE : null;
}

function normalizeTraffic(rawRows) {
  const rows = [];
  let dropped = 0;
  for (const row of rawRows) {
    const date = row && typeof row === 'object' ? parseDate(row.Date) : null;
    const impressions = row && typeof row === 'object' ? parseCount(row.Impressions) : null;
    const clicks = row && typeof row === 'object' ? parseCount(row.Clicks) : null;
    if (!date || impressions === null || clicks === null) { dropped++; continue; }
    rows.push({ date, impressions, clicks });
  }
  return { rows, dropped };
}

/** 検索語（pages は URL）ごとにまとめるための正規化。 */
function normalizeTerms(rawRows, keyName) {
  const rows = [];
  let dropped = 0;
  for (const row of rawRows) {
    if (!row || typeof row !== 'object') { dropped++; continue; }
    const date = parseDate(row.Date);
    const impressions = parseCount(row.Impressions);
    const clicks = parseCount(row.Clicks);
    const label = typeof row.Query === 'string' ? row.Query.trim() : '';
    if (!date || impressions === null || clicks === null || !label) { dropped++; continue; }
    rows.push({
      date,
      [keyName]: label,
      impressions,
      clicks,
      position: parsePosition(row.AvgImpressionPosition),
      click_position: parsePosition(row.AvgClickPosition),
    });
  }
  return { rows, dropped };
}

function normalizeCrawl(rawRows) {
  const rows = [];
  let dropped = 0;
  for (const row of rawRows) {
    if (!row || typeof row !== 'object') { dropped++; continue; }
    const date = parseDate(row.Date);
    let valid = Boolean(date);
    const out = { date };
    for (const field of CRAWL_FIELDS) {
      if (row[field] === undefined || row[field] === null) continue;
      const count = parseCount(row[field]);
      if (count === null) { valid = false; break; }
      out[field] = count;
    }
    if (!valid) { dropped++; continue; }
    rows.push(out);
  }
  return { rows, dropped };
}

function normalizeFeeds(rawRows) {
  const rows = [];
  let dropped = 0;
  for (const row of rawRows) {
    if (!row || typeof row !== 'object' || typeof row.Url !== 'string' || !row.Url) { dropped++; continue; }
    const out = { Url: row.Url };
    for (const key of ['Type', 'Status', 'UrlCount', 'FileSize', 'Compressed']) {
      if (row[key] !== undefined) out[key] = row[key];
    }
    for (const key of ['Submitted', 'LastCrawled']) {
      if (row[key] !== undefined) out[key] = parseDate(row[key]);
    }
    rows.push(out);
  }
  return { rows, dropped };
}

/**
 * 同じ日付の行を 1 行にまとめる。取り出した値が全部同じなら 1 行として数え、
 * 違えばその日を除いて conflicting に記録する。
 */
function dedupeByDate(rows, signature) {
  const groups = new Map();
  for (const row of rows) {
    const list = groups.get(row.date);
    if (list) list.push(row);
    else groups.set(row.date, [row]);
  }
  const kept = [];
  const conflicts = [];
  let duplicates = 0;
  for (const date of [...groups.keys()].sort()) {
    const list = groups.get(date);
    if (list.length > 1) duplicates += list.length - 1;
    const first = signature(list[0]);
    if (list.every(row => signature(row) === first)) kept.push(list[0]);
    else conflicts.push(date);
  }
  return { rows: kept, conflicts, duplicates };
}

function dateBounds(rows) {
  if (!rows.length) return { min: null, max: null };
  const dates = rows.map(row => row.date).sort();
  return { min: dates[0], max: dates[dates.length - 1] };
}

function perDateStats(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.date, (counts.get(row.date) || 0) + 1);
  let atCap = 0;
  for (const count of counts.values()) if (count >= DAYS_AT_CAP) atCap++;
  return { dates: counts.size, atCap };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** 検索語（ページ）ごとに足し、順位は表示回数（クリック数）で重みを付けた平均にする。 */
function aggregateTerms(rows, keyName) {
  const groups = new Map();
  for (const row of rows) {
    const label = row[keyName];
    const entry = groups.get(label) || {
      impressions: 0, clicks: 0,
      positionSum: 0, positionWeight: 0,
      clickPositionSum: 0, clickPositionWeight: 0,
      dates: new Set(),
    };
    entry.impressions += row.impressions;
    entry.clicks += row.clicks;
    if (row.position !== null && row.impressions > 0) {
      entry.positionSum += row.position * row.impressions;
      entry.positionWeight += row.impressions;
    }
    if (row.click_position !== null && row.clicks > 0) {
      entry.clickPositionSum += row.click_position * row.clicks;
      entry.clickPositionWeight += row.clicks;
    }
    entry.dates.add(row.date);
    groups.set(label, entry);
  }
  const out = [];
  for (const [label, entry] of groups) {
    out.push({
      [keyName]: label,
      impressions: entry.impressions,
      clicks: entry.clicks,
      position: entry.positionWeight ? round2(entry.positionSum / entry.positionWeight) : null,
      click_position: entry.clickPositionWeight ? round2(entry.clickPositionSum / entry.clickPositionWeight) : null,
      weeks: entry.dates.size,
    });
  }
  out.sort((a, b) => b.impressions - a.impressions
    || b.clicks - a.clicks
    || String(a[keyName]).localeCompare(String(b[keyName]), 'ja'));
  return out.slice(0, ROW_LIMIT);
}

/**
 * 形の記録（R6）。応答の生の行から作る。検索語・URL の中身や数の値は出さない。
 */
function shapeLine(name, rawRows, { dropped = 0, duplicates = 0, conflicts = 0 } = {}) {
  const parts = [`[bing] ${ENDPOINTS[name]}: ${n(rawRows.length)} 行`];
  const dates = rawRows.map(row => (row && typeof row === 'object' ? parseDate(row.Date) : null)).filter(Boolean);
  if (dates.length) {
    const sorted = [...dates].sort();
    const counts = new Map();
    for (const date of dates) counts.set(date, (counts.get(date) || 0) + 1);
    parts.push(`（日付 ${sorted[0]}〜${sorted[sorted.length - 1]}、日付 ${n(counts.size)} 種類、`
      + `1 日付あたり最大 ${n(Math.max(...counts.values()))} 行）`);
  } else if (name !== 'feeds') {
    parts.push('（日付 なし）');
  }
  const first = rawRows.find(row => row && typeof row === 'object');
  const keys = first ? Object.keys(first).filter(key => key !== '__type') : [];
  const shown = keys.filter(key => SHAPE_KEY_PATTERN.test(key)).sort();
  parts.push(`項目 ${shown.length ? shown.join(',') : 'なし'}`);
  const hidden = keys.length - shown.length;
  if (hidden > 0) parts.push(`他 ${n(hidden)} 個`);
  if (name === 'queries' || name === 'pages') {
    const positions = rawRows
      .map(row => (row && typeof row === 'object' ? row.AvgImpressionPosition : null))
      .filter(value => typeof value === 'number' && value > 0);
    parts.push(positions.length
      ? `順位 ${Math.min(...positions).toFixed(1)}〜${Math.max(...positions).toFixed(1)}`
      : '順位 なし');
  }
  if (name === 'traffic' || name === 'crawl') {
    parts.push(`同じ日付の重複 ${n(duplicates)}`, `食い違い ${n(conflicts)}`);
  }
  parts.push(`捨てた行 ${n(dropped)}`);
  return parts.join('、');
}

/**
 * @param {object} options
 *   env, now, fetchImpl, outRoot, log, retryDelays, timeoutMs（試験で差し替える）
 * @returns {{status: 'skipped'|'fetched'}}
 */
async function run(options = {}) {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const outRoot = options.outRoot || OUT_ROOT;
  const log = options.log || console.log;
  const apiKey = env.BING_WEBMASTER_API_KEY;

  if (!apiKey) {
    emit(log, '[bing] BING_WEBMASTER_API_KEY が未設定のためスキップします', '');
    return { status: 'skipped' };
  }

  const retryDelays = Array.isArray(options.retryDelays) ? options.retryDelays : RETRY_DELAYS;
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;

  // 最初の窓口で取れたサイトを以後の窓口にも使う（GSC のプロパティの選び方と同じ）。
  const raw = {};
  let siteUrl = null;
  let lastError = null;
  for (const candidate of SITE_URLS) {
    try {
      raw[REQUIRED_ENDPOINT] = await callEndpoint({
        name: REQUIRED_ENDPOINT, siteUrl: candidate, apiKey, fetchImpl, log, retryDelays, timeoutMs,
      });
      siteUrl = candidate;
      break;
    } catch (error) {
      lastError = error;
      emit(log, `[bing] ${candidate}: ${error.message}（次の候補を試します）`, apiKey);
    }
  }
  if (!siteUrl) throw lastError || new Error(`${ENDPOINTS[REQUIRED_ENDPOINT]}: 接続できませんでした（Error）`);
  emit(log, `[bing] サイト: ${siteUrl}`, apiKey);

  const failures = {};
  for (const name of ENDPOINT_ORDER) {
    if (name === REQUIRED_ENDPOINT) continue;
    try {
      raw[name] = await callEndpoint({ name, siteUrl, apiKey, fetchImpl, log, retryDelays, timeoutMs });
    } catch (error) {
      failures[name] = error.message;
      emit(log, `::warning::Bing の ${name} を取得できませんでした（${error.message}）`, apiKey);
    }
  }

  const normalized = { traffic: normalizeTraffic(raw.traffic) };
  if (raw.queries) normalized.queries = normalizeTerms(raw.queries, 'query');
  if (raw.pages) normalized.pages = normalizeTerms(raw.pages, 'page');
  if (raw.crawl) normalized.crawl = normalizeCrawl(raw.crawl);
  if (raw.feeds) normalized.feeds = normalizeFeeds(raw.feeds);

  const trafficDedupe = dedupeByDate(normalized.traffic.rows, row => JSON.stringify([row.impressions, row.clicks]));
  const crawlDedupe = normalized.crawl
    ? dedupeByDate(normalized.crawl.rows, row => JSON.stringify(row))
    : { rows: [], conflicts: [], duplicates: 0 };

  for (const name of ENDPOINT_ORDER) {
    if (!raw[name]) continue;
    const duplicates = name === 'traffic' ? trafficDedupe.duplicates : name === 'crawl' ? crawlDedupe.duplicates : 0;
    const conflicts = name === 'traffic' ? trafficDedupe.conflicts.length : name === 'crawl' ? crawlDedupe.conflicts.length : 0;
    emit(log, shapeLine(name, raw[name], { dropped: normalized[name].dropped, duplicates, conflicts }), apiKey);
  }

  // 期間: traffic の全部の行（食い違いの日も含む）の最新の日付から 28 日。
  // traffic が 0 行なら他の窓口の最新の日付（R12）。
  const fallbackDates = [];
  for (const name of ['queries', 'pages', 'crawl']) {
    if (!normalized[name]) continue;
    for (const row of normalized[name].rows) fallbackDates.push(row.date);
  }
  const trafficBounds = dateBounds(normalized.traffic.rows);
  const end = trafficBounds.max
    ? trafficBounds.max
    : (fallbackDates.length ? fallbackDates.sort()[fallbackDates.length - 1] : null);
  const start = end ? dateFromDay(dayNumber(end) - (WINDOW_DAYS - 1)) : null;
  const inRange = (date) => Boolean(start) && date >= start && date <= end;
  const window = end
    ? {
      start,
      end,
      days_reported: 0,
      // 期間の中の traffic の食い違いだけを「除いた日」として出す（期間の外の日は出さない）。
      conflicting_dates: trafficDedupe.conflicts.filter(inRange),
    }
    : null;
  const inWindow = (rows) => (window ? rows.filter(row => row.date >= window.start && row.date <= window.end) : []);

  const trafficRows = inWindow(trafficDedupe.rows);
  const totals = trafficRows.reduce((sum, row) => ({
    impressions: sum.impressions + row.impressions,
    clicks: sum.clicks + row.clicks,
  }), { impressions: 0, clicks: 0 });
  if (window) window.days_reported = trafficRows.length;

  const queriesInWindow = normalized.queries ? inWindow(normalized.queries.rows) : [];
  const pagesInWindow = normalized.pages ? inWindow(normalized.pages.rows) : [];
  const crawlInWindow = inWindow(crawlDedupe.rows);
  const queriesOut = normalized.queries ? aggregateTerms(queriesInWindow, 'query') : [];
  const pagesOut = normalized.pages ? aggregateTerms(pagesInWindow, 'page') : [];

  const sections = {};
  const trafficPerDate = perDateStats(trafficRows);
  sections.traffic = {
    status: 'ok',
    raw_rows: raw.traffic.length,
    dropped_rows: normalized.traffic.dropped,
    date_min: trafficBounds.min,
    date_max: trafficBounds.max,
    weeks: trafficPerDate.dates,
    weeks_at_cap: trafficPerDate.atCap,
    // 期間の外も含む全部の食い違い（latest.json での記録用。レポートには window の分だけ出す）。
    conflicting_dates: [...trafficDedupe.conflicts],
  };
  for (const name of ['queries', 'pages']) {
    if (!normalized[name]) { sections[name] = { status: 'failed', reason: failures[name] }; continue; }
    const rows = normalized[name].rows;
    const bounds = dateBounds(rows);
    const used = name === 'queries' ? queriesInWindow : pagesInWindow;
    const perDate = perDateStats(used);
    sections[name] = {
      status: 'ok',
      raw_rows: raw[name].length,
      dropped_rows: normalized[name].dropped,
      used_rows: used.length,
      weeks: perDate.dates,
      weeks_at_cap: perDate.atCap,
      date_min: bounds.min,
      date_max: bounds.max,
    };
  }
  if (!normalized.crawl) {
    sections.crawl = { status: 'failed', reason: failures.crawl };
  } else {
    const bounds = dateBounds(normalized.crawl.rows);
    const perDate = perDateStats(crawlInWindow);
    sections.crawl = {
      status: 'ok',
      raw_rows: raw.crawl.length,
      dropped_rows: normalized.crawl.dropped,
      date_min: bounds.min,
      date_max: bounds.max,
      weeks: perDate.dates,
      weeks_at_cap: perDate.atCap,
      // 期間の中の食い違いだけ（レポートの「巡回とサイトマップ」に出す）。
      conflicting_dates: crawlDedupe.conflicts.filter(inRange),
    };
  }
  if (!normalized.feeds) {
    sections.feeds = { status: 'failed', reason: failures.feeds };
  } else {
    sections.feeds = {
      status: 'ok',
      raw_rows: raw.feeds.length,
      dropped_rows: normalized.feeds.dropped,
    };
  }

  const dirName = stamp(now);
  const entries = [];
  const files = {};
  const add = (name, content) => {
    const rel = `${dirName}/${name}.json`;
    files[name] = rel;
    entries.push([path.join(outRoot, rel), content]);
  };
  add('traffic', { site_url: siteUrl, window, rows: trafficRows });
  if (normalized.queries) add('queries', { site_url: siteUrl, window, rows: queriesOut });
  if (normalized.pages) add('pages', { site_url: siteUrl, window, rows: pagesOut });
  if (normalized.crawl) add('crawl', { site_url: siteUrl, window, rows: crawlInWindow });
  if (normalized.feeds) add('feeds', { site_url: siteUrl, rows: normalized.feeds.rows });
  entries.push([path.join(outRoot, 'latest.json'), {
    fetched_at: now.toISOString(),
    site_url: siteUrl,
    window,
    totals,
    files,
    sections,
  }]);

  // 全部の JSON を先に作って確かめてから、日付フォルダを作って書き始める（R13）。
  writeJsonFiles(entries, apiKey);

  const removed = prune(outRoot, KEEP_RUNS);
  emit(log, `[bing] 保存: ${dirName}（期間 ${window ? `${window.start}〜${window.end}` : 'なし'}、`
    + `表示 ${n(totals.impressions)} ／ クリック ${n(totals.clicks)}、`
    + `検索語 ${n(queriesOut.length)} 行 ／ ページ ${n(pagesOut.length)} 行）`, apiKey);

  return {
    status: 'fetched', siteUrl, dir: dirName, window, totals, files, sections, removed,
  };
}

if (require.main === module) {
  run().catch(error => {
    const key = process.env.BING_WEBMASTER_API_KEY || '';
    let message = error && error.message === BLOCKED_MESSAGE
      ? BLOCKED_MESSAGE
      : `[bing] エラー: ${error && error.message}`;
    try { message = guardText(message, key); } catch (_) { message = BLOCKED_MESSAGE; }
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  run,
  endpointUrl,
  parseDate,
  parseCount,
  parsePosition,
  aggregateTerms,
  dedupeByDate,
  ENDPOINTS,
  ENDPOINT_ORDER,
  SITE_URLS,
  OUT_ROOT,
  POSITION_SCALE,
  WINDOW_DAYS,
};
