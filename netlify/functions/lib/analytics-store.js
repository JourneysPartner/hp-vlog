'use strict';

/**
 * 自前アクセス解析の保存・検証ロジック。
 * Function 本体から切り離し、Blobs を模した store でも単体テストできるようにする。
 */

const crypto = require('crypto');

const COOKIE_NAME = 'mz_vid';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const MAX_BODY_BYTES = 1024;
const MAX_PATH_LENGTH = 128;
const DEFAULT_PRODUCTION_HOST = 'mori-zeirishi.net';
const BOT_RE = /bot|crawl|spider|slurp|preview|lighthouse|headless|monitor/i;

const FIXED_PATHS = new Set([
  '/', '/about.html', '/contact.html', '/services.html', '/voice.html', '/privacy.html',
  '/404.html', '/blog/', '/contact-thanks.html', '/area/', '/pricing/',
]);

const PRETTY_PATHS = new Map([
  ['/about', '/about.html'], ['/contact', '/contact.html'],
  ['/contact-thanks', '/contact-thanks.html'], ['/services', '/services.html'],
  ['/voice', '/voice.html'], ['/privacy', '/privacy.html'], ['/404', '/404.html'],
]);

function jstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function jstMinute(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', '-');
}

function dateOffset(date, offset) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function hash(value, length = 16) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function signId(id, secret) {
  return base64url(crypto.createHmac('sha256', secret).update(`v1.${id}`).digest());
}

function issueVisitorCookie(secret) {
  if (!secret) throw new Error('ANALYTICS_COOKIE_SECRET is required');
  const id = base64url(crypto.randomBytes(16));
  return `v1.${id}.${signId(id, secret)}`;
}

function verifyVisitorCookie(value, secret) {
  if (!value || !secret) return null;
  const parts = String(value).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, id, signature] = parts;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id) || !/^[A-Za-z0-9_-]{20,}$/.test(signature)) return null;
  const expected = Buffer.from(signId(id, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return { id, value: String(value) };
}

function cookieHeader(value) {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

function getHeader(headers = {}, name) {
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function hostFromUrl(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function isProductionRequest(event, productionHost = DEFAULT_PRODUCTION_HOST) {
  const headers = event.headers || {};
  const host = String(getHeader(headers, 'host')).toLowerCase().replace(/:\d+$/, '');
  if (host !== productionHost) return false;
  const origin = getHeader(headers, 'origin');
  const referer = getHeader(headers, 'referer');
  // POST Beacon は Origin を送る。Referrer-Policy で Referer が消える場合もあるためどちらかでよい。
  if (origin && hostFromUrl(origin) !== productionHost) return false;
  if (!origin && (!referer || hostFromUrl(referer) !== productionHost)) return false;
  const fetchSite = String(getHeader(headers, 'sec-fetch-site')).toLowerCase();
  return fetchSite === 'same-origin' || fetchSite === 'same-site';
}

function isBot(userAgent) {
  return !userAgent || BOT_RE.test(userAgent);
}

function normalizePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_PATH_LENGTH) return null;
  let path = value.split(/[?#]/, 1)[0];
  if (!path || path.includes('\\') || path.includes('..') || /[\u0000-\u001f]/.test(path)) return null;
  if (path !== '/' && path.endsWith('/')) path = path.replace(/\/+$/, '') + '/';
  return PRETTY_PATHS.get(path.replace(/\/$/, '')) || path;
}

function isAllowedPath(path) {
  if (FIXED_PATHS.has(path)) return true;
  if (/^\/services\/[a-z0-9-]+\/?$/.test(path)) return true;
  if (/^\/blog\/[a-z0-9-]+\/?$/.test(path)) return true;
  if (/^\/blog\/page\/\d+\/?$/.test(path)) return true;
  if (/^\/blog\/(?:category|macro)\/[a-z0-9-]+(?:\/page\/\d+)?\/?$/.test(path)) return true;
  return false;
}

// 問い合わせ・送信完了ページで、直前に見ていた内部ページを記録する。
const CONTACT_PATH = '/contact.html';
const THANKS_PATH = '/contact-thanks.html';

/**
 * ビーコンの本文を {path, ref, event} に分解する。
 * ref（遷移元）は、現在ページが問い合わせ・送信完了ページで、遷移元がサイト内の
 * 許可されたパス（問い合わせ・送信完了ページを除く）の場合だけ有効。それ以外は null。
 */
function parseBeaconPayload(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return null;
  let body;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some(k => k !== 'p' && k !== 'r' && k !== 'e')) return null;
  if (Object.hasOwn(body, 'e') && body.e !== 'line') return null;
  const path = normalizePath(body.p);
  if (!path || !isAllowedPath(path)) return null;
  let ref = null;
  if ((path === CONTACT_PATH || path === THANKS_PATH) && typeof body.r === 'string') {
    const candidate = normalizePath(body.r);
    if (candidate && candidate !== CONTACT_PATH && candidate !== THANKS_PATH && isAllowedPath(candidate)) ref = candidate;
  }
  return { path, ref, event: body.e || null };
}

function parseBeaconBody(raw) {
  const payload = parseBeaconPayload(raw);
  return payload ? payload.path : null;
}

function dailyKey(date) { return `daily/${date}`; }
function uniqueKey(date, vidHash) { return `uniq/${date}/${vidHash}`; }
function rateKey(minute, vidHash, path) { return `rate/${minute}/${vidHash}/${hash(path, 8)}`; }

async function markUnique(store, date, vidHash) {
  return store.set(uniqueKey(date, vidHash), '1', { onlyIfNew: true });
}

async function markRate(store, minute, vidHash, path) {
  return store.set(rateKey(minute, vidHash, path), '1', { onlyIfNew: true });
}

async function incrementPageview(store, date, path, { maxAttempts = 8, sleep = defaultSleep } = {}) {
  const key = dailyKey(date);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Lambda 互換Functionに渡されるBlobs接続情報にはuncachedEdgeURLがないため、
    // 標準のeventual consistencyで読み取る。ETag条件付き書き込みは引き続き使用する。
    const current = await store.getWithMetadata(key, { type: 'json' });
    const previous = current && current.data && typeof current.data === 'object' ? current.data : {};
    const next = {
      date,
      pageviews: Number.isSafeInteger(previous.pageviews) ? previous.pageviews + 1 : 1,
      byPath: { ...(previous.byPath && typeof previous.byPath === 'object' ? previous.byPath : {}) },
    };
    next.byPath[path] = (Number.isSafeInteger(next.byPath[path]) ? next.byPath[path] : 0) + 1;
    const result = current
      ? await store.setJSON(key, next, { onlyIfMatch: current.etag })
      : await store.setJSON(key, next, { onlyIfNew: true });
    if (result && result.modified) return true;
    if (attempt < maxAttempts - 1) await sleep(Math.min(5 * (2 ** attempt), 160));
  }
  return false;
}

function transitionKey(date) { return `transitions/${date}`; }
function submissionKey(date) { return `submissions/${date}`; }
function lineKey(date) { return `line/${date}`; }

/**
 * 問い合わせページへの遷移を記録する（日別・遷移元パス別の回数）。
 * どの記事が問い合わせを生んだかの実測になり、記事候補の選定に還元する。
 */
async function incrementTransition(store, date, fromPath, options = {}) {
  return incrementFrom(store, transitionKey(date), date, fromPath, options);
}

async function incrementSubmission(store, date, fromPath, options = {}) {
  return incrementFrom(store, submissionKey(date), date, fromPath, options);
}

async function incrementLine(store, date, fromPath, options = {}) {
  return incrementFrom(store, lineKey(date), date, fromPath, options);
}

async function incrementFrom(store, key, date, fromPath, { maxAttempts = 8, sleep = defaultSleep } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await store.getWithMetadata(key, { type: 'json' });
    const previous = current && current.data && typeof current.data === 'object' ? current.data : {};
    const next = {
      date,
      total: Number.isSafeInteger(previous.total) ? previous.total + 1 : 1,
      byFrom: { ...(previous.byFrom && typeof previous.byFrom === 'object' ? previous.byFrom : {}) },
    };
    next.byFrom[fromPath] = (Number.isSafeInteger(next.byFrom[fromPath]) ? next.byFrom[fromPath] : 0) + 1;
    const result = current
      ? await store.setJSON(key, next, { onlyIfMatch: current.etag })
      : await store.setJSON(key, next, { onlyIfNew: true });
    if (result && result.modified) return true;
    if (attempt < maxAttempts - 1) await sleep(Math.min(5 * (2 ** attempt), 160));
  }
  return false;
}

function defaultSleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function countPrefix(store, prefix) {
  let count = 0;
  for await (const page of store.list({ prefix, paginate: true })) count += (page.blobs || []).length;
  return count;
}

async function listPrefixKeys(store, prefix) {
  const keys = [];
  for await (const page of store.list({ prefix, paginate: true })) {
    for (const blob of page.blobs || []) keys.push(blob.key);
  }
  return keys;
}

async function deleteKeys(store, keys, batchSize = 25) {
  for (let i = 0; i < keys.length; i += batchSize) await Promise.all(keys.slice(i, i + batchSize).map(key => store.delete(key)));
}

module.exports = {
  COOKIE_NAME, COOKIE_MAX_AGE, DEFAULT_PRODUCTION_HOST,
  jstDate, jstMinute, dateOffset, hash, parseCookies, issueVisitorCookie, verifyVisitorCookie, cookieHeader,
  isProductionRequest, isBot, normalizePath, isAllowedPath, parseBeaconBody, parseBeaconPayload,
  CONTACT_PATH, THANKS_PATH, incrementTransition, transitionKey, incrementSubmission, submissionKey,
  incrementLine, lineKey,
  dailyKey, uniqueKey, rateKey, markUnique, markRate, incrementPageview, countPrefix, listPrefixKeys, deleteKeys,
};
