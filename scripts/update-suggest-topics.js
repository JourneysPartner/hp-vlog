#!/usr/bin/env node
'use strict';
/**
 * 検索サジェストの取得と候補づくり（段階3改）
 *
 * 1. 取得: data/search-suggest-seeds.json の種語ごとに Google サジェスト
 *    （検索窓の補完＝実際に打ち込まれている語）を取得し、
 *    data/search-suggest/raw-latest.json にキャッシュする。
 *    非公式な入口のため、週1回・種語1件につき1クエリ・1.5秒以上の間隔を厳守。
 * 2. 選別: 取得した語句を LLM で選別し、記事候補（読者想定・企画メタつき）に
 *    構造化して data/search-suggest-topics.json に書く（slug 単位で追記マージ。
 *    既存の候補は上書きしない）。
 *
 * 実行:
 *   node scripts/update-suggest-topics.js               # 取得 → 選別
 *   node scripts/update-suggest-topics.js --skip-fetch  # キャッシュを使って選別だけ
 *
 * OPENAI_API_KEY が必要（選別のみ）。モデルは LLM_SUGGEST_MODEL（既定 gpt-5.6-luna）。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { validateTopic } = require('./lib/suggest-topics');
const {
  SELECT_SYSTEM, buildSelectPrompt, selectTopicProposals,
} = require('./lib/search-topic-selector');

const ROOT = path.join(__dirname, '..');
const SEEDS_FILE = path.join(ROOT, 'data', 'search-suggest-seeds.json');
const RAW_FILE = path.join(ROOT, 'data', 'search-suggest', 'raw-latest.json');
const TOPICS_FILE = path.join(ROOT, 'data', 'search-suggest-topics.json');
const FETCH_DELAY_MS = 1600;   // 1.5秒以上の間隔（指示書の厳守事項）

// ── 1. 取得 ─────────────────────────────────────────────────────
function defaultFetcher(term) {
  return new Promise((resolve) => {
    const url = 'https://www.google.com/complete/search?client=firefox&hl=ja&q=' + encodeURIComponent(term);
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ja' },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(Array.isArray(parsed) && Array.isArray(parsed[1]) ? parsed[1] : null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function fetchSuggests(options = {}) {
  const seedsFile = options.seedsFile || SEEDS_FILE;
  const rawFile = options.rawFile || RAW_FILE;
  const fetcher = options.fetcher || defaultFetcher;
  const delayMs = options.delayMs === undefined ? FETCH_DELAY_MS : options.delayMs;
  const logger = options.logger === undefined ? console : options.logger;
  const log = (m) => { if (logger && logger.log) logger.log(m); };

  const seeds = JSON.parse(fs.readFileSync(seedsFile, 'utf8')).seeds || [];
  const results = [];
  let failed = 0;
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    const suggestions = await fetcher(seed.term);
    if (Array.isArray(suggestions)) {
      // 種語そのものと同一の候補は情報が無いので除く
      const phrases = suggestions.map(s => String(s).trim())
        .filter(s => s && s !== seed.term).slice(0, 10);
      results.push({ id: seed.id, term: seed.term, persona_hint: seed.persona_hint, phrases });
    } else {
      failed++;
      results.push({ id: seed.id, term: seed.term, persona_hint: seed.persona_hint, phrases: [], failed: true });
    }
    if (i < seeds.length - 1 && delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    if ((i + 1) % 10 === 0) log(`[suggest] 取得 ${i + 1}/${seeds.length}`);
  }
  fs.mkdirSync(path.dirname(rawFile), { recursive: true });
  fs.writeFileSync(rawFile, JSON.stringify({
    fetched_at: (options.nowFn || (() => new Date().toISOString()))(),
    seeds: results,
  }, null, 2) + '\n', 'utf8');
  log(`[suggest] 取得完了: 種語 ${seeds.length} 件（失敗 ${failed} 件） → ${path.relative(ROOT, rawFile)}`);
  return { seedCount: seeds.length, failed };
}

// ── 2. 選別（LLM）────────────────────────────────────────────────
function slugFor(seedId, primaryPhrase) {
  const hash = crypto.createHash('sha1').update(String(primaryPhrase)).digest('hex').slice(0, 6);
  return `suggest-${seedId}-${hash}`;
}

async function selectTopics(options = {}) {
  const callLLM = options.callLLM;
  if (typeof callLLM !== 'function') throw new Error('callLLM が必要です');
  const rawFile = options.rawFile || RAW_FILE;
  const topicsFile = options.topicsFile || TOPICS_FILE;
  const logger = options.logger === undefined ? console : options.logger;
  const nowFn = options.nowFn || (() => new Date().toISOString());
  const log = (m) => { if (logger && logger.log) logger.log(m); };
  const warn = (m) => { if (logger && logger.warn) logger.warn(m); };

  const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  const seeds = (raw.seeds || []).filter(s => Array.isArray(s.phrases) && s.phrases.length > 0);

  // 既存候補は上書きしない（slug 単位の追記マージ）
  let existing = { version: 1, topics: [] };
  try { existing = JSON.parse(fs.readFileSync(topicsFile, 'utf8')); } catch (_) { /* 初回 */ }
  const known = new Set((existing.topics || []).map(t => t.slug));

  const stats = { proposed: 0, accepted: 0, invalid: 0, duplicate: 0, skippedBatches: 0 };
  const accepted = [];

  const selected = await selectTopicProposals(seeds, { callLLM, logger, prefix: 'suggest' });
  stats.skippedBatches = selected.skippedBatches;
  for (const p of selected.proposals) {
    stats.proposed++;
    const phrases = Array.isArray(p.phrases)
      ? p.phrases.map(s => String(s).trim()).filter(Boolean).slice(0, 10) : [];
    const candidate = {
      slug: slugFor(String(p.seed_id || 'x'), phrases[0] || ''),
      seed_id: p.seed_id,
      phrases,
      persona: p.persona,
      tax_domain: p.tax_domain,
      category: p.category,
      article_type: p.article_type,
      primary_question: String(p.primary_question || '').trim(),
      reader_problem: String(p.reader_problem || '').trim(),
      selected_at: nowFn(),
    };
    const problem = validateTopic(candidate);
    if (problem) { stats.invalid++; warn(`[suggest] 提案を却下 (${problem}): ${phrases[0] || '?'}`); continue; }
    if (known.has(candidate.slug)) { stats.duplicate++; continue; }
    known.add(candidate.slug);
    accepted.push(candidate);
    stats.accepted++;
  }

  if (accepted.length > 0) {
    existing.topics = (existing.topics || []).concat(accepted);
    existing.version = existing.version || 1;
    existing.updated_at = nowFn();
    fs.writeFileSync(topicsFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  }
  log(`[suggest] 選別完了: 提案 ${stats.proposed} → 採用 ${stats.accepted} ` +
    `(形式不正 ${stats.invalid} / 既出 ${stats.duplicate} / スキップしたバッチ ${stats.skippedBatches})`);
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--skip-fetch')) {
    await fetchSuggests({});
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('[suggest] OPENAI_API_KEY が未設定です（取得のみ実施）');
    process.exit(1);
  }
  const { makeOpenAILuna } = require('./lib/llm-source-selector');
  process.env.LLM_SOURCE_SELECT_MODEL = process.env.LLM_SUGGEST_MODEL || 'gpt-5.6-luna';
  const stats = await selectTopics({ callLLM: makeOpenAILuna() });
  if (stats.proposed === 0 && stats.skippedBatches > 0) {
    console.error('[suggest] 1件も選別できませんでした');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[suggest] 失敗:', e.message); process.exit(1); });
}

module.exports = {
  fetchSuggests, selectTopics, slugFor, buildSelectPrompt,
  SELECT_SYSTEM, FETCH_DELAY_MS, SEEDS_FILE, RAW_FILE, TOPICS_FILE,
};
