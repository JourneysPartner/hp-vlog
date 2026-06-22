#!/usr/bin/env node
'use strict';

/**
 * 質疑応答事例から topic 候補を自動抽出する (Phase E)
 *
 * 使い方:
 *   node scripts/extract-shitsugi-candidates.js
 *   node scripts/extract-shitsugi-candidates.js --min-score 70
 *   node scripts/extract-shitsugi-candidates.js --output data/nta-shitsugi-topics-candidate.json
 *   node scripts/extract-shitsugi-candidates.js --preserve-adopted   # 既存ファイルの adopted フラグを保持
 *
 * 出力:
 *   data/nta-shitsugi-topics-candidate.json
 *
 * 使い分け:
 *   - 初回実行 → 全候補を新規生成
 *   - 月次 crawl 後 → --preserve-adopted で adopted=true のエントリを保持
 *
 * 採用フラグ運用:
 *   - 自動抽出は score >= 70 を候補化、adopted=false で出力
 *   - user が JSON を編集して adopted=true に立てる
 *   - 後続 Phase F で adopted=true のもののみ daily-draft で使用
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const scorer = require(path.join(ROOT, 'scripts/lib/nta-shitsugi-scorer'));
const store  = require(path.join(ROOT, 'scripts/lib/nta-store'));

const NTA_SOURCES_DIR = store.NTA_SOURCES_DIR;
const INDEX_FILE      = path.join(NTA_SOURCES_DIR, 'index.json');
const DEFAULT_OUTPUT  = path.join(ROOT, 'data', 'nta-shitsugi-topics-candidate.json');

// ── 引数パーサ ─────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    minScore: 70,
    output: DEFAULT_OUTPUT,
    preserveAdopted: false,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--min-score':         args.minScore = parseInt(argv[++i], 10); break;
      case '--output':            args.output = argv[++i]; break;
      case '--preserve-adopted':  args.preserveAdopted = true; break;
      case '--verbose':           args.verbose = true; break;
      case '-h':
      case '--help':              printHelp(); process.exit(0);
      default:
        console.error(`不明な引数: ${a}`);
        printHelp(); process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
使い方: node scripts/extract-shitsugi-candidates.js [options]

Options:
  --min-score <N>        候補化する最低スコア（デフォルト: 70）
  --output <path>        出力先パス
  --preserve-adopted     既存ファイルの adopted=true フラグを保持
                         （月次 crawl 後の再抽出時に推奨）
  --verbose              詳細ログ
  -h, --help             このヘルプ
`);
}

// ── 既存ファイルから adopted=true のエントリ一覧を読込 ────────
function loadAdoptedUrls(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const adopted = new Set();
    for (const c of data.candidates || []) {
      if (c.adopted === true && c.shitsugi_url) {
        adopted.add(c.shitsugi_url);
      }
    }
    return adopted;
  } catch (e) {
    console.warn(`[extract] 既存ファイル読込失敗: ${e.message}`);
    return new Set();
  }
}

// ── 既存ファイルから adopted エントリのメタも保持 ──────────────
function loadExistingAdoptedEntries(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const map = new Map();
    for (const c of data.candidates || []) {
      if (c.adopted === true && c.shitsugi_url) {
        map.set(c.shitsugi_url, c);
      }
    }
    return map;
  } catch (e) {
    return new Map();
  }
}

// ── メインフロー ───────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);

  // 1. index.json を読込
  if (!fs.existsSync(INDEX_FILE)) {
    console.error(`✗ ${INDEX_FILE} が存在しません。先に crawl-nta-sources.js を実行してください。`);
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const shitsugiEntries = (index.entries || []).filter(e => e.type === 'shitsugi' && !e.deleted);
  console.log(`[extract] index から shitsugi エントリ ${shitsugiEntries.length} 件を読込`);

  // 2. 既存 adopted の保持
  const existingAdopted = args.preserveAdopted
    ? loadExistingAdoptedEntries(args.output)
    : new Map();
  if (existingAdopted.size > 0) {
    console.log(`[extract] 既存 adopted=true: ${existingAdopted.size} 件を保持`);
  }

  // 3. 各エントリを採点
  const candidates = [];
  const allScored = [];
  let read = 0, errors = 0;

  for (const idxEntry of shitsugiEntries) {
    const filePath = path.join(NTA_SOURCES_DIR, idxEntry.file_path);
    if (!fs.existsSync(filePath)) {
      errors++;
      continue;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      errors++;
      continue;
    }
    read++;

    const result = scorer.scoreEntry(data);
    const candidate = {
      shitsugi_url: data.url,
      shitsugi_title: data.title,
      tax_category: data.tax_category,
      tax_category_code: data.tax_category_code,
      section: data.section,
      id: data.id,
      file_path: idxEntry.file_path,
      score: result.score,
      score_breakdown: result.breakdown,
      proposed: result.proposed,
      kankei_hourei: data.kankei_hourei || null,
      law_version: data.law_version || null,
      adopted: false,
    };

    allScored.push(candidate);

    if (result.score >= args.minScore) {
      // 既存 adopted エントリと merge（adopted=true を保持）
      if (existingAdopted.has(data.url)) {
        const existing = existingAdopted.get(data.url);
        candidate.adopted = true;
        // adoption_note や proposed の手動編集を保持
        if (existing.adoption_note) candidate.adoption_note = existing.adoption_note;
        if (existing.proposed && existing.proposed.persona) {
          candidate.proposed = existing.proposed;
        }
      }
      candidates.push(candidate);
    }
  }

  // 4. 既存 adopted で min-score 未満のものも保持
  for (const [url, existing] of existingAdopted) {
    if (!candidates.some(c => c.shitsugi_url === url)) {
      candidates.push({ ...existing, adopted: true });
    }
  }

  // スコア降順でソート
  candidates.sort((a, b) => b.score - a.score);

  // 集計
  const byScore = { '90+': 0, '80-89': 0, '70-79': 0 };
  const byCategory = {};
  const byPersona = {};
  let adoptedCount = 0;
  for (const c of candidates) {
    if (c.adopted) adoptedCount++;
    if (c.score >= 90) byScore['90+']++;
    else if (c.score >= 80) byScore['80-89']++;
    else byScore['70-79']++;
    byCategory[c.tax_category_code] = (byCategory[c.tax_category_code] || 0) + 1;
    if (c.proposed && c.proposed.persona) {
      byPersona[c.proposed.persona] = (byPersona[c.proposed.persona] || 0) + 1;
    }
  }

  // 5. 出力
  const output = {
    version: 1,
    generated_at: new Date().toISOString(),
    scoring_criteria: {
      persona_match_max:     30,
      search_need_max:       20,
      freshness_max:         10,
      judgment_ambiguity_max: 15,
      taxanswer_support_max: 25,
      total_max:             100,
      candidate_threshold:   args.minScore,
    },
    stats: {
      total_shitsugi_scanned: read,
      read_errors: errors,
      candidates_count: candidates.length,
      adopted_count: adoptedCount,
      by_score: byScore,
      by_category: byCategory,
      by_persona: byPersona,
    },
    candidates,
  };

  store.writeJsonAtomic(args.output, output);
  console.log(`[extract] 候補 ${candidates.length} 件を ${path.relative(ROOT, args.output)} に書き出し`);
  console.log(`           by_score:    ${JSON.stringify(byScore)}`);
  console.log(`           by_category: ${JSON.stringify(byCategory)}`);
  console.log(`           by_persona:  ${JSON.stringify(byPersona)}`);
  console.log(`           adopted:     ${adoptedCount} 件（手動レビュー後）`);

  if (args.verbose) {
    console.log(`\n[verbose] 上位 5 件:`);
    for (const c of candidates.slice(0, 5)) {
      console.log(`  [${c.score}] ${c.tax_category_code}/${c.section}/${c.id} ${c.shitsugi_title.slice(0, 50)}`);
      console.log(`        breakdown: ${JSON.stringify(c.score_breakdown)}`);
    }
  }
}

main();
