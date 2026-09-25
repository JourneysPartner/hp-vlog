#!/usr/bin/env node
'use strict';

/**
 * サーチコンソールの検索語を取り込む（2026-09-03 並行A R1〜R2）
 *
 *   node scripts/fetch-search-console.js
 *
 * 直近28日（終了日は3日前。データ反映の遅れを吸収）の
 *   query（検索語）／page（URL）／query×page
 * を上位1,000行まで取り、data/search-console/YYYYMMDD/ に保存する。
 * 保持は直近12週分。それより古い日付ディレクトリは削除する。
 *
 * 認証: サービスアカウント。鍵の JSON を環境変数 GSC_SERVICE_ACCOUNT_JSON に入れる。
 *       未設定なら「未設定」と出して正常終了する（失敗にしない）。
 * プロパティ: sc-domain:mori-zeirishi.net を第一候補、無ければ https://mori-zeirishi.net/。
 *
 * 取り込んだデータを記事生成の候補選定に自動で接続しない（貯めて見られるようにするまで）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'data', 'search-console');
const PROPERTIES = ['sc-domain:mori-zeirishi.net', 'https://mori-zeirishi.net/'];
const API = 'https://www.googleapis.com/webmasters/v3/sites';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const ROW_LIMIT = 1000;
const DAYS = 28;
const LAG_DAYS = 3;
const KEEP_WEEKS = 12;

function ymd(d) { return d.toISOString().slice(0, 10); }
function stamp(d) { return ymd(d).replace(/-/g, ''); }

function dateRange(now) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - LAG_DAYS));
  const start = new Date(end.getTime() - (DAYS - 1) * 86400000);
  return { start: ymd(start), end: ymd(end) };
}

/**
 * 鍵 JSON の読み取り。GitHub の Secret に貼るときに崩れやすい形（前後の空白や BOM、
 * 前後に混ざった余計な文字、base64 で登録した場合、秘密鍵の改行が実際の改行になった場合）を
 * 補正して読む。読めないときは、秘密を出さずに原因の見当がつく日本語で失敗させる。
 */
function parseServiceAccountJson(raw) {
  if (raw && typeof raw === 'object') return validateServiceAccount(raw);
  const text = String(raw == null ? '' : raw).replace(/^﻿/, '').trim();
  const candidates = [text];
  const first = text.indexOf('{');
  if (first >= 0) {
    // 前後に余計な文字が付いている場合: 「{」から、終わり側の「}」までを順に試す
    let close = text.lastIndexOf('}');
    for (let i = 0; i < 5 && close > first; i++) {
      candidates.push(text.slice(first, close + 1));
      close = text.lastIndexOf('}', close - 1);
    }
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(text)) {
    // base64 で登録された場合
    try { candidates.push(Buffer.from(text, 'base64').toString('utf8').trim()); } catch (_) { /* 次へ */ }
  }
  for (const c of candidates.slice()) {
    const fixed = escapeNewlinesInPrivateKey(c);
    if (fixed) candidates.push(fixed);
  }
  let firstError = null;
  for (const c of candidates) {
    let parsed;
    try { parsed = JSON.parse(c); } catch (e) { if (!firstError) firstError = e; continue; }
    return validateServiceAccount(parsed);
  }
  throw new Error(describeUnreadableKey(text, firstError));
}

// 秘密鍵の中の改行が「\n」の2文字ではなく実際の改行になっている貼り付けを補正する
function escapeNewlinesInPrivateKey(text) {
  const begin = text.indexOf('-----BEGIN');
  if (begin < 0) return null;
  const end = text.indexOf('-----END', begin);
  const quote = end >= 0 ? text.indexOf('"', end) : -1;
  if (quote < 0) return null;
  const body = text.slice(begin, quote);
  if (!/[\r\n]/.test(body)) return null;
  return text.slice(0, begin) + body.replace(/\r?\n/g, '\\n') + text.slice(quote);
}

function validateServiceAccount(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('鍵 JSON の中身がオブジェクトではありません。サービスアカウントの鍵ファイル（JSON）の中身をそのまま貼ってください');
  }
  if (obj.installed || obj.web) {
    throw new Error('貼られているのは OAuth クライアントの JSON です。Google Cloud の「サービスアカウント」→「キー」で作った JSON 鍵を貼ってください');
  }
  const missing = ['client_email', 'private_key'].filter(k => typeof obj[k] !== 'string' || !obj[k]);
  if (missing.length) {
    throw new Error(`鍵 JSON に ${missing.join(' と ')} がありません。サービスアカウントの鍵ファイル（type が service_account の JSON）を貼ってください`);
  }
  return obj;
}

// 秘密の中身は出さず、長さ・形だけで原因の見当がつく説明を作る
function describeUnreadableKey(text, error) {
  const kind = (ch) => {
    if (ch === undefined) return '末尾（文字が足りない）';
    if (ch === '\n' || ch === '\r') return '改行';
    if (/\s/.test(ch)) return '空白';
    if (ch === '"') return '引用符';
    if (ch === '{' || ch === '}') return '波かっこ';
    if (/[A-Za-z0-9]/.test(ch)) return '英数字';
    if (/[　-鿿＀-￯]/.test(ch)) return '全角文字';
    return '記号';
  };
  const opens = (text.match(/{/g) || []).length;
  const closes = (text.match(/}/g) || []).length;
  const lines = [
    '鍵 JSON を読み取れません。GitHub の Secret に貼った中身が壊れています。',
    `  文字数 ${text.length}、先頭は${kind(text[0])}、末尾は${kind(text[text.length - 1])}、{ が ${opens} 個、} が ${closes} 個`,
    `  "client_email" ${text.includes('"client_email"') ? 'あり' : '無し'} / "private_key" ${text.includes('"private_key"') ? 'あり' : '無し'}`,
  ];
  const m = error && /position (\d+)/.exec(error.message);
  if (m) lines.push(`  ${m[1]} 文字目付近で崩れています（その文字は${kind(text[Number(m[1])])}）。JSON の判定: ${error.message}`);
  else if (error) lines.push(`  JSON の判定: ${error.message}`);
  lines.push('  直し方: 鍵ファイルをメモ帳で開き Ctrl+A → Ctrl+C で全体をコピーし、Secret の Update で中身を全部消してから貼り直してください（docs/search-console-setup.md「うまくいかないとき」）');
  return lines.join('\n');
}

async function accessTokenFromServiceAccount(json) {
  const creds = parseServiceAccountJson(json);
  const { JWT } = require('google-auth-library');
  const client = new JWT({ email: creds.client_email, key: creds.private_key, scopes: [SCOPE] });
  const res = await client.getAccessToken();
  const token = typeof res === 'string' ? res : (res && res.token);
  if (!token) throw new Error('アクセストークンを取得できませんでした');
  return token;
}

async function query({ fetchImpl, token, property, body }) {
  const url = `${API}/${encodeURIComponent(property)}/searchAnalytics/query`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data.rows) ? data.rows : [];
}

function normalizeRows(rows, dims) {
  return rows.map(r => {
    const out = { clicks: r.clicks || 0, impressions: r.impressions || 0, ctr: r.ctr || 0, position: r.position || 0 };
    dims.forEach((d, i) => { out[d] = (r.keys || [])[i] || ''; });
    return out;
  });
}

/** 12週分より古い日付ディレクトリを消す */
function prune(outRoot, keep = KEEP_WEEKS) {
  if (!fs.existsSync(outRoot)) return [];
  const dirs = fs.readdirSync(outRoot).filter(d => /^\d{8}$/.test(d)).sort();
  const removed = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const d of removed) fs.rmSync(path.join(outRoot, d), { recursive: true, force: true });
  return removed;
}

/**
 * @param {object} options
 *   env, now, fetchImpl, outRoot, getToken（テストで差し替える）
 * @returns {{status: 'skipped'|'fetched', property?: string, dir?: string, counts?: object}}
 */
async function run(options = {}) {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const outRoot = options.outRoot || OUT_ROOT;
  const log = options.log || console.log;

  const keyJson = env.GSC_SERVICE_ACCOUNT_JSON;
  if (!keyJson) {
    log('[gsc] GSC_SERVICE_ACCOUNT_JSON が未設定のためスキップします（サイト側の設定は不要。鍵を登録すると取り込みが始まります）');
    return { status: 'skipped', reason: 'no-credentials' };
  }

  const token = options.getToken ? await options.getToken(keyJson) : await accessTokenFromServiceAccount(keyJson);
  const range = dateRange(now);

  // プロパティは取れたほうを使う（ドメインプロパティ → URLプレフィックス）
  let property = null;
  let firstError = null;
  const results = {};
  const dims = { queries: ['query'], pages: ['page'], 'query-page': ['query', 'page'] };
  for (const candidate of PROPERTIES) {
    try {
      results.queries = normalizeRows(await query({ fetchImpl, token, property: candidate,
        body: { startDate: range.start, endDate: range.end, dimensions: dims.queries, rowLimit: ROW_LIMIT } }), dims.queries);
      property = candidate;
      break;
    } catch (e) {
      firstError = firstError || e;
      log(`[gsc] ${candidate}: ${e.message}（次の候補を試します）`);
    }
  }
  if (!property) throw new Error(`どのプロパティからも取得できませんでした: ${firstError && firstError.message}`);
  log(`[gsc] プロパティ: ${property}（${range.start}〜${range.end}）`);

  for (const key of ['pages', 'query-page']) {
    results[key] = normalizeRows(await query({ fetchImpl, token, property,
      body: { startDate: range.start, endDate: range.end, dimensions: dims[key], rowLimit: ROW_LIMIT } }), dims[key]);
  }

  const dirName = stamp(now);
  const dir = path.join(outRoot, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const key of Object.keys(results)) {
    const rel = `${dirName}/${key}.json`;
    fs.writeFileSync(path.join(outRoot, rel), `${JSON.stringify({ property, range, dimensions: dims[key], rows: results[key] }, null, 2)}\n`);
    files[key] = rel;
  }
  fs.writeFileSync(path.join(outRoot, 'latest.json'), `${JSON.stringify({
    fetched_at: now.toISOString(), range, property, files,
  }, null, 2)}\n`);

  const removed = prune(outRoot);
  const counts = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length]));
  log(`[gsc] 保存: ${dirName}（検索語 ${counts.queries} 行 / ページ ${counts.pages} 行 / 組合せ ${counts['query-page']} 行）${removed.length ? ` 削除: ${removed.join(', ')}` : ''}`);
  return { status: 'fetched', property, dir: dirName, counts, removed };
}

if (require.main === module) {
  run().then(r => {
    if (r.status === 'skipped') console.log('::notice::サーチコンソールの鍵が未設定のため取り込みをスキップしました');
  }).catch(e => {
    console.error(`[gsc] エラー: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { run, dateRange, prune, normalizeRows, parseServiceAccountJson, OUT_ROOT, PROPERTIES };
