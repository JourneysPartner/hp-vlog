'use strict';

/**
 * 国税庁 Web ページの fetch 基盤
 *
 * Phase C-1: crawl スクリプト骨子
 *   - rate limit (1 req/sec)
 *   - エンコーディング自動判別（UTF-8 / Shift_JIS）
 *   - リトライ（指数バックオフ）
 *   - User-Agent 明示
 *   - SHA-256 hash 計算（差分検知用）
 *
 * 後続 Phase で使う:
 *   - C-2 タックスアンサーパーサ
 *   - C-3 質疑応答事例パーサ
 *   - C-4 差分 crawl
 */

const crypto = require('crypto');

const USER_AGENT = 'MoriZeirishi-Bot/1.0 (https://mori-zeirishi.net/contact)';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RATE_LIMIT_MS = 1000;        // 1 req/sec
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;          // 1s → 2s → 4s

// ── Rate Limiter ───────────────────────────────────────────────
// 連続する fetch の間隔を最低 N ms に保つ。複数並列を許容しないシリアル設計。
class RateLimiter {
  constructor(minIntervalMs = DEFAULT_RATE_LIMIT_MS) {
    this.minIntervalMs = minIntervalMs;
    this.lastRequestAt = 0;
  }

  async wait() {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }
}

// ── エンコーディング検知 ───────────────────────────────────────
// HTTP ヘッダー → HTML meta tag の順に判別する。
//   1. Content-Type ヘッダーに charset=xxx
//   2. HTML 内の <meta charset> または <meta http-equiv="Content-Type">
//   3. デフォルトは UTF-8
function detectEncoding(buffer, contentTypeHeader) {
  // ① HTTP ヘッダー
  if (contentTypeHeader) {
    const m = contentTypeHeader.match(/charset=([\w-]+)/i);
    if (m) return normalizeEncoding(m[1]);
  }
  // ② HTML meta tag — 先頭 1024 バイトを ASCII として走査
  const head = buffer.subarray(0, Math.min(1024, buffer.length)).toString('ascii');
  const metaCharset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (metaCharset) return normalizeEncoding(metaCharset[1]);
  const metaHttpEquiv = head.match(/<meta[^>]+http-equiv=["']?Content-Type["']?[^>]+charset=([\w-]+)/i);
  if (metaHttpEquiv) return normalizeEncoding(metaHttpEquiv[1]);
  // ③ デフォルト
  return 'utf-8';
}

function normalizeEncoding(enc) {
  const e = enc.toLowerCase();
  if (e === 'shift_jis' || e === 'shift-jis' || e === 'sjis' || e === 'x-sjis') return 'shift_jis';
  if (e === 'utf-8' || e === 'utf8') return 'utf-8';
  if (e === 'euc-jp' || e === 'euc_jp' || e === 'eucjp') return 'euc-jp';
  return e;
}

// ── デコード ───────────────────────────────────────────────────
function decodeBuffer(buffer, encoding) {
  // TextDecoder は Node 18+ で標準。shift_jis / euc-jp も対応。
  try {
    const td = new TextDecoder(encoding, { fatal: false });
    return td.decode(buffer);
  } catch (e) {
    // 不明エンコーディング → UTF-8 fallback
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

// ── 文字化け検知 ───────────────────────────────────────────────
// U+FFFD (replacement character) の出現率が閾値超過なら文字化けと判定。
function detectMojibake(text, thresholdRatio = 0.01) {
  if (!text) return false;
  const fffdCount = (text.match(/�/g) || []).length;
  return fffdCount / text.length > thresholdRatio;
}

// ── ハッシュ計算 ───────────────────────────────────────────────
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ── fetch with retry ───────────────────────────────────────────
// 指数バックオフでリトライ。
//   1 回目失敗 → 1s 待機 → 2 回目
//   2 回目失敗 → 2s 待機 → 3 回目
//   3 回目失敗 → 4s 待機 → 4 回目（リトライ最大数で停止）
async function fetchWithRetry(url, options = {}) {
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });
        clearTimeout(timer);

        // 404 や 410 は再試行しても無駄なので即返す
        if (res.status === 404 || res.status === 410) {
          return { ok: false, status: res.status, reason: 'not_found' };
        }
        // 5xx はリトライ対象
        if (res.status >= 500 && res.status < 600) {
          lastError = new Error(`HTTP ${res.status}`);
          continue;
        }
        // それ以外の 4xx は即終了
        if (!res.ok) {
          return { ok: false, status: res.status, reason: 'http_error' };
        }
        return { ok: true, status: res.status, response: res };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastError = e;
      // AbortError（タイムアウト）と NetworkError はリトライ
    }
  }
  return { ok: false, status: 0, reason: 'retry_exhausted', error: lastError };
}

// ── ページ取得（核心関数）──────────────────────────────────────
// URL を fetch し、エンコーディング判別 + デコード + hash 計算した結果を返す。
//
// 戻り値:
//   { ok: true, url, html, encoding, htmlHash, byteSize, fetchedAt, status }
//   { ok: false, url, reason, status }
async function fetchPage(url, options = {}) {
  const fetchedAt = new Date().toISOString();
  const result = await fetchWithRetry(url, options);

  if (!result.ok) {
    return { ok: false, url, reason: result.reason, status: result.status, fetchedAt };
  }

  const res = result.response;
  const contentType = res.headers.get('content-type') || '';
  // GET レスポンスからも Last-Modified / ETag を拾っておくと、初回 crawl 後の
  // incremental で HEAD 比較が即 hit する。
  const lastModified = res.headers.get('last-modified') || null;
  const etag = res.headers.get('etag') || null;
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const encoding = detectEncoding(buffer, contentType);
  const html = decodeBuffer(buffer, encoding);

  // 文字化け検知
  if (detectMojibake(html)) {
    return {
      ok: false,
      url,
      reason: 'mojibake_detected',
      status: result.status,
      fetchedAt,
      encoding,
    };
  }

  const htmlHash = sha256Hex(html);

  return {
    ok: true,
    url,
    html,
    encoding,
    htmlHash,
    byteSize: buffer.length,
    fetchedAt,
    status: result.status,
    lastModified,
    etag,
  };
}

// ── HEAD リクエスト（差分 crawl 用） ────────────────────────────
// 本文を取得せず Last-Modified / ETag だけ確認する。
// ボディが空のため、リトライは GET と同じロジックを使う。
//
// 戻り値:
//   { ok: true, url, status, lastModified, etag, contentLength, contentType, checkedAt }
//   { ok: false, url, reason, status, checkedAt }
async function fetchPageHead(url, options = {}) {
  const checkedAt = new Date().toISOString();
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, {
          method: 'HEAD',
          headers: { 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.status === 404 || res.status === 410) {
          return { ok: false, url, reason: 'not_found', status: res.status, checkedAt };
        }
        if (res.status >= 500 && res.status < 600) {
          lastError = new Error(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) {
          return { ok: false, url, reason: 'http_error', status: res.status, checkedAt };
        }
        return {
          ok: true,
          url,
          status: res.status,
          lastModified: res.headers.get('last-modified') || null,
          etag: res.headers.get('etag') || null,
          contentLength: parseInt(res.headers.get('content-length') || '0', 10) || null,
          contentType: res.headers.get('content-type') || null,
          checkedAt,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastError = e;
    }
  }
  return { ok: false, url, reason: 'retry_exhausted', status: 0, checkedAt, error: lastError };
}

// ── 差分判定 ───────────────────────────────────────────────────
// 既存エントリの metadata（last_modified / etag）と HEAD レスポンスを比較し、
// 更新の要否を判定する。
//
// 戻り値:
//   { decision: 'skip' | 'fetch' | 'mark_deleted' | 'first_time', reason }
//
// 判定ロジック:
//   1. 既存エントリなし → 'first_time'（全文 GET）
//   2. HEAD が 404/410 → 'mark_deleted'（削除フラグ付与、JSON は保持）
//   3. HEAD 取得失敗 → 'fetch'（安全側に倒す）
//   4. ETag が同じ → 'skip'
//   5. Last-Modified が同じ → 'skip'
//   6. それ以外 → 'fetch'（変更あり）
function decideIncrementalAction(existingEntry, headResult) {
  if (!existingEntry || !existingEntry.html_hash) {
    return { decision: 'first_time', reason: 'no_existing_entry' };
  }
  if (!headResult.ok) {
    if (headResult.reason === 'not_found') {
      return { decision: 'mark_deleted', reason: 'head_404' };
    }
    return { decision: 'fetch', reason: `head_error:${headResult.reason}` };
  }
  const { etag, lastModified } = headResult;
  if (etag && existingEntry.etag && etag === existingEntry.etag) {
    return { decision: 'skip', reason: 'etag_match' };
  }
  if (lastModified && existingEntry.last_modified && lastModified === existingEntry.last_modified) {
    return { decision: 'skip', reason: 'last_modified_match' };
  }
  return { decision: 'fetch', reason: 'metadata_changed' };
}

// ── 公開 API ───────────────────────────────────────────────────
module.exports = {
  RateLimiter,
  USER_AGENT,
  detectEncoding,
  decodeBuffer,
  detectMojibake,
  sha256Hex,
  fetchPage,
  fetchPageHead,
  fetchWithRetry,
  decideIncrementalAction,
};
