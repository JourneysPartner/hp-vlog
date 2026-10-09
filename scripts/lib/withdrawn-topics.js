'use strict';

const fs = require('fs');
const path = require('path');
const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'withdrawn-topics.json');
const COMMENT = '日次生成で取り下げた題材。通常の選定では二度と選ばない。項目を消せば選定に戻る。';

// 追記時は既存記録を失わないよう、存在しない場合だけ空として扱う。
function readWithdrawnTopics(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, comment: COMMENT, entries: [] };
    throw error;
  }
  const data = JSON.parse(source);
  if (!data || !Array.isArray(data.entries)) throw new Error('entries が配列ではありません');
  return data;
}

function loadWithdrawnTopics(file = DEFAULT_PATH, warn = console.warn) {
  try {
    return readWithdrawnTopics(file);
  } catch (_) {
    // JSON の中身や環境変数は警告に含めない。
    warn(process.env.GITHUB_ACTIONS === 'true'
      ? '::warning::取り下げ記録が読めないため、記録による除外をせずに選定します'
      : '[withdrawn] 記録を読み込めないため空として扱います');
    return { version: 1, comment: COMMENT, entries: [] };
  }
}

const entriesOf = data => Array.isArray(data) ? data : (data && data.entries) || [];
const entryKey = entry => JSON.stringify([entry.topic_id, entry.stage, entry.date]);
function appendEntries(existing, additions) {
  const result = existing.slice();
  const seen = new Set(existing.map(entryKey));
  for (const entry of additions) {
    const key = entryKey(entry);
    if (!seen.has(key)) { result.push(entry); seen.add(key); }
  }
  return result;
}

function appendWithdrawnTopics(additions, file = DEFAULT_PATH) {
  const data = readWithdrawnTopics(file);
  const entries = appendEntries(data.entries, additions);
  if (entries.length !== data.entries.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...data, entries }, null, 2) + '\n', 'utf8');
  }
  return entries;
}

function findWithdrawnTopic(topic, data) {
  return entriesOf(data).find(entry => entry.topic_id === topic.slug) || null;
}
const normalizeQuery = query => String(query || '').replace(/[\s\u3000]+/g, ' ').trim().toLowerCase();
function findWithdrawnQuery(query, data) {
  const key = normalizeQuery(query);
  return key ? entriesOf(data).find(entry => normalizeQuery(entry.target_query) === key) || null : null;
}

// 取り下げるたびに保存し、途中で生成が失敗してもそこまでの記録を残す。
function createWithdrawalRecorder(options = {}) {
  const env = options.env || process.env;
  const file = options.file || DEFAULT_PATH;
  const initial = options.force ? [] : (options.withdrawn === undefined ? loadWithdrawnTopics(file) : options.withdrawn);
  let additions = [];
  if (env.WITHDRAWN_OUT && !options.force) {
    fs.mkdirSync(path.dirname(env.WITHDRAWN_OUT), { recursive: true });
    fs.writeFileSync(env.WITHDRAWN_OUT, '[]\n', 'utf8');
  }
  return {
    get entries() { return appendEntries(entriesOf(initial), additions); },
    get additions() { return additions.slice(); },
    record(topic, stage, detail = {}) {
      if (options.force) return null;
      const now = options.now || new Date();
      const entry = {
        topic_id: topic.slug, stage,
        similar_to: detail.similar_to || '',
        reason: [...String(detail.reason || '')].slice(0, 200).join(''),
        url_slug: detail.url_slug || topic.url_slug || '',
        target_query: topic.target_query || '',
        date: now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }),
        run_url: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
          ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '',
      };
      if (this.entries.some(item => entryKey(item) === entryKey(entry))) return entry;
      additions = appendEntries(additions, [entry]);
      if (env.WITHDRAWN_OUT) {
        fs.mkdirSync(path.dirname(env.WITHDRAWN_OUT), { recursive: true });
        fs.writeFileSync(env.WITHDRAWN_OUT, JSON.stringify(additions, null, 2) + '\n', 'utf8');
      } else {
        appendWithdrawnTopics([entry], file);
      }
      return entry;
    },
  };
}

module.exports = { loadWithdrawnTopics, appendEntries, appendWithdrawnTopics,
  findWithdrawnTopic, findWithdrawnQuery, createWithdrawalRecorder };
