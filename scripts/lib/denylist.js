'use strict';

/**
 * トピック denylist（グローバル禁止リスト）
 *
 * 目的:
 *   - 過去の単年限定論点（例: 定額減税）を通常生成候補から永久に外す
 *   - 「今後このテーマは生成しないでください」という明示指示を全体ルールとして登録する
 *   - daily-draft / regenerate-draft 両方が同じデータを参照する
 *
 * データ: data/topic-denylist.json （main にコミットされる）
 *
 * entry の type:
 *   slug              — 完全一致するスラグを禁止
 *   subcluster        — その subcluster を持つ topic を全て禁止
 *   cluster           — その cluster を持つ topic を全て禁止
 *   primary_question  — primary_question 文字列の完全一致（または近似）で禁止
 *   keyword           — title / search_intent / primary_question にこのキーワードを含むものを禁止
 *   topic_id          — topic-pool 内の任意の id を禁止（将来用）
 *
 * expires_at: 空文字なら無期限、ISO 8601 が入っていればその時刻まで有効。
 * active=false で一時的に無効化できる。
 *
 * 例:
 *   { "type": "subcluster", "value": "fixed-amount-tax-reduction", ... }
 *   { "type": "keyword",    "value": "定額減税", ... }
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DENYLIST_PATH = path.join(ROOT, 'data', 'topic-denylist.json');

// ── 禁止意図検出パターン ────────────────────────────────────────────
// 「今後...書かない/出さない/生成しない/扱わない/作らない」系を強く検出する。
// 普通の改善要望（例: "もう少し具体例を増やしてください"）には反応しないように、
// 「今後 / もう / 今度 / 二度と」などの未来限定マーカーがある場合のみ true。
const DENY_PATTERNS = [
  /(?:今後|今度|これから|もう|二度と|以降).{0,30}(?:書か|執筆し|出さ|出し|生成し|生成は|作成し|作ら|つくら|扱わ|取り上げ|採用し)(?:ない|ません|ないで|ないでください)/,
  /(?:このテーマ|この論点|この内容|この記事).{0,30}(?:禁止|除外|書かない|出さない|生成しない|やめて|やめてください)/,
  /(?:同じ|同様|類似).{0,15}(?:テーマ|論点|内容).{0,30}(?:書かない|出さない|生成しない)/,
  /(?:^|[\s、。])(禁止|除外)してください/,
];

function detectDenyIntent(comment) {
  if (!comment || typeof comment !== 'string') return false;
  const normalized = comment.replace(/\s+/g, ' ').trim();
  return DENY_PATTERNS.some(re => re.test(normalized));
}

// ── ファイル I/O ────────────────────────────────────────────────────
function loadDenylist() {
  if (!fs.existsSync(DENYLIST_PATH)) {
    return { version: 1, entries: [] };
  }
  try {
    const raw = fs.readFileSync(DENYLIST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || 1,
      comment: parsed.comment || '',
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch (e) {
    console.warn(`[denylist] 読込失敗（空として扱う）: ${e.message}`);
    return { version: 1, entries: [] };
  }
}

function saveDenylist(denylist) {
  const out = JSON.stringify(denylist, null, 2) + '\n';
  fs.mkdirSync(path.dirname(DENYLIST_PATH), { recursive: true });
  fs.writeFileSync(DENYLIST_PATH, out, 'utf8');
}

function isEntryActive(entry, now = new Date()) {
  if (entry.active === false) return false;
  if (entry.expires_at) {
    const exp = new Date(entry.expires_at);
    if (!isNaN(exp) && exp <= now) return false;
  }
  return true;
}

// ── マッチング ──────────────────────────────────────────────────────
function entryMatchesTopic(entry, topic) {
  if (!entry || !topic) return false;
  const val = String(entry.value || '');
  if (!val) return false;

  switch (entry.type) {
    case 'slug':
      return String(topic.slug || '') === val;
    case 'subcluster':
      return String(topic.subcluster || '') === val;
    case 'cluster':
      return String(topic.cluster || '') === val;
    case 'primary_question':
      return String(topic.primary_question || '').trim() === val.trim();
    case 'topic_id':
      return String(topic.id || '') === val;
    case 'keyword': {
      const hay = [
        topic.title, topic.slug, topic.search_intent,
        topic.reader_problem, topic.primary_question, topic.success_outcome,
      ].filter(Boolean).join(' ');
      // 部分一致（日本語想定で大文字小文字は区別しない）
      return hay.toLowerCase().includes(val.toLowerCase());
    }
    default:
      return false;
  }
}

/**
 * トピックが denylist にヒットするか判定。
 * @returns {Object|null} ヒットしたエントリ、なければ null
 */
function findMatchingEntry(topic, denylist, now = new Date()) {
  const list = denylist || loadDenylist();
  for (const entry of list.entries || []) {
    if (!isEntryActive(entry, now)) continue;
    if (entryMatchesTopic(entry, topic)) return entry;
  }
  return null;
}

function isTopicDenied(topic, denylist, now = new Date()) {
  return findMatchingEntry(topic, denylist, now) != null;
}

// ── 単年限定 / 期限切れ判定 ─────────────────────────────────────────
function isTimeLimitedExpired(topic, now = new Date()) {
  if (topic.historical_only === true) return { expired: true, reason: 'historical_only=true' };
  if (topic.disabled === true)        return { expired: true, reason: 'disabled=true' };
  if (topic.valid_to) {
    const vt = new Date(topic.valid_to);
    if (!isNaN(vt) && vt < now) return { expired: true, reason: `valid_to=${topic.valid_to}` };
  }
  if (topic.obsolete_after) {
    const oa = new Date(topic.obsolete_after);
    if (!isNaN(oa) && oa < now) return { expired: true, reason: `obsolete_after=${topic.obsolete_after}` };
  }
  return { expired: false };
}

// ── デフォルト entry ID 生成（manual / review-revise / review-skip 共通）
function generateEntryId(prefix, value) {
  const stamp = new Date().toISOString().replace(/[^\dT]/g, '').slice(0, 14);
  const safeValue = String(value).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
  return `${prefix}-${safeValue}-${stamp}`;
}

// ── コメントから推測した entry を作る（review-revise 用）─────────
/**
 * comment + 当該 frontmatter からの自動 entry 構築。
 * 「subcluster と keyword の 2 件」を推奨（広めに止める + 検索意図ベースでも止める）。
 * 既に同値の active entry がある場合は重複しない。
 */
function buildEntriesFromContext(meta, comment, source = 'review_revise') {
  const now = new Date().toISOString();
  const reason = (comment || '').trim().slice(0, 200) || '（コメントなし）';

  const out = [];
  if (meta.subcluster) {
    out.push({
      id: generateEntryId(`auto-${source}-sub`, meta.subcluster),
      type: 'subcluster',
      value: meta.subcluster,
      reason: `${source}: ${reason}`,
      created_at: now,
      expires_at: '',
      source,
      active: true,
    });
  }
  if (meta.primary_question) {
    out.push({
      id: generateEntryId(`auto-${source}-q`, meta.primary_question),
      type: 'primary_question',
      value: meta.primary_question,
      reason: `${source}: ${reason}`,
      created_at: now,
      expires_at: '',
      source,
      active: true,
    });
  }
  // フォールバック: subcluster も primary_question もなければ slug を入れる
  if (out.length === 0 && meta.slug) {
    out.push({
      id: generateEntryId(`auto-${source}-slug`, meta.slug),
      type: 'slug',
      value: meta.slug,
      reason: `${source}: ${reason}`,
      created_at: now,
      expires_at: '',
      source,
      active: true,
    });
  }
  return out;
}

function mergeEntries(denylist, newEntries) {
  const list = denylist || loadDenylist();
  const existing = list.entries || [];
  const seen = new Set(existing.map(e => `${e.type}::${(e.value || '').toLowerCase()}`));
  let added = 0;
  for (const e of newEntries) {
    const key = `${e.type}::${(e.value || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    existing.push(e);
    added++;
  }
  return { denylist: { ...list, entries: existing }, added };
}

module.exports = {
  DENYLIST_PATH,
  loadDenylist,
  saveDenylist,
  isTopicDenied,
  findMatchingEntry,
  isEntryActive,
  entryMatchesTopic,
  isTimeLimitedExpired,
  detectDenyIntent,
  buildEntriesFromContext,
  mergeEntries,
  generateEntryId,
};
