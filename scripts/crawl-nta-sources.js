#!/usr/bin/env node
'use strict';

/**
 * 国税庁ソース DB 構築 CLI
 *
 * 使い方:
 *   node scripts/crawl-nta-sources.js [options]
 *
 * Options:
 *   --type <type>       crawl 対象種別 (taxanswer | shitsugi | all、デフォルト all)
 *   --category <cat>    特定カテゴリのみ (shohi | sozoku | shotoku | hojin | gensen | joto | hyoka)
 *   --incremental       差分 crawl（既存 html_hash と比較し未変更は skip）
 *   --dry-run           実 fetch せず、対象 URL のリストアップのみ
 *   --verbose           詳細ログ
 *   --max-pages <N>     最大 N ページで停止（テスト用）
 *   --probe <url>       1 ページだけ fetch して表示（動作確認用）
 *
 * Phase C-1: スクリプト骨子（fetch + 表示まで）
 *   - パーサ実装は C-2 (taxanswer) / C-3 (shitsugi)
 *   - 差分 crawl ロジックは C-4
 *   - index.json / meta.json 生成は C-5
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const crawler          = require(path.join(ROOT, 'scripts/lib/nta-crawler'));
const taxanswerParser  = require(path.join(ROOT, 'scripts/lib/nta-parsers/taxanswer'));
const taxanswerIndex   = require(path.join(ROOT, 'scripts/lib/nta-index/taxanswer-index'));
const shitsugiParser   = require(path.join(ROOT, 'scripts/lib/nta-parsers/shitsugi'));
const shitsugiIndex    = require(path.join(ROOT, 'scripts/lib/nta-index/shitsugi-index'));
const store            = require(path.join(ROOT, 'scripts/lib/nta-store'));

// ── 引数パーサ ─────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    type: 'all',
    category: null,
    incremental: false,
    dryRun: false,
    verbose: false,
    maxPages: Infinity,
    probe: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--type':         args.type = argv[++i]; break;
      case '--category':     args.category = argv[++i]; break;
      case '--incremental':  args.incremental = true; break;
      case '--dry-run':      args.dryRun = true; break;
      case '--verbose':      args.verbose = true; break;
      case '--max-pages':    args.maxPages = parseInt(argv[++i], 10); break;
      case '--probe':        args.probe = argv[++i]; break;
      case '-h':
      case '--help':         printHelp(); process.exit(0);
      default:
        console.error(`不明な引数: ${a}`);
        printHelp();
        process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
使い方: node scripts/crawl-nta-sources.js [options]

Options:
  --type <type>       crawl 対象種別 (taxanswer | shitsugi | all)
  --category <cat>    特定カテゴリのみ
  --incremental       差分 crawl（未変更は skip）
  --dry-run           実 fetch せず対象 URL リストアップ
  --verbose           詳細ログ
  --max-pages <N>     最大 N ページで停止（テスト用）
  --probe <url>       1 ページだけ fetch して表示
  -h, --help          このヘルプ

Phase C-1（骨子）では --probe での動作確認のみ可能。
タックスアンサー全件 crawl は C-2、質疑応答事例は C-3 で実装。
`);
}

// ── probe: 1 ページだけ fetch して表示 ──────────────────────────
async function probe(url, verbose) {
  console.log(`[probe] fetching: ${url}`);
  const result = await crawler.fetchPage(url);
  if (!result.ok) {
    console.error(`[probe] FAIL: ${result.reason} (status=${result.status})`);
    process.exit(1);
  }
  console.log(`[probe] OK`);
  console.log(`  encoding:   ${result.encoding}`);
  console.log(`  byte size:  ${result.byteSize}`);
  console.log(`  html_hash:  ${result.htmlHash.slice(0, 16)}...`);
  console.log(`  fetched_at: ${result.fetchedAt}`);

  // タイトル抽出（最低限の sanity check）
  const titleMatch = result.html.match(/<title>([^<]+)<\/title>/);
  console.log(`  title:      ${titleMatch ? titleMatch[1] : '(no title)'}`);

  if (verbose) {
    console.log(`\n--- first 500 chars of body ---`);
    // bodyArea 抽出（簡易）
    const bodyMatch = result.html.match(/id="bodyArea"[\s\S]{0,2000}/);
    if (bodyMatch) {
      const cleaned = bodyMatch[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(cleaned.slice(0, 500));
    }
  }
}

// ── タックスアンサーの全件 crawl ────────────────────────────────
async function crawlTaxAnswer(args) {
  const verbose = args.verbose;
  const maxPages = args.maxPages;
  const categoryFilter = args.category ? [args.category] : null;

  console.log('[taxanswer] index ページを取得中…');
  const entries = await taxanswerIndex.fetchTaxAnswerIndex({ categories: categoryFilter });
  console.log(`[taxanswer] index から ${entries.length} 件の URL を取得`);

  // カテゴリ別件数の表示
  const byCategory = {};
  for (const e of entries) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  }
  for (const [cat, n] of Object.entries(byCategory).sort()) {
    console.log(`  ${cat.padEnd(10)} : ${n}`);
  }

  if (args.dryRun) {
    console.log('[taxanswer] --dry-run のため crawl は実行しません。');
    return { fetched: 0, skipped: 0, errors: [] };
  }

  const target = Number.isFinite(maxPages) ? Math.min(entries.length, maxPages) : entries.length;
  console.log(`[taxanswer] ${target} 件を crawl 開始（rate limit 1 req/sec）…`);

  const rl = new crawler.RateLimiter(1000);
  const results = { fetched: 0, skipped: 0, errors: [] };
  let i = 0;

  for (const entry of entries) {
    if (i >= target) break;
    i++;

    if (args.incremental) {
      const existing = store.loadTaxAnswerEntry(entry.category, entry.id);
      if (existing && existing.html_hash) {
        // C-4 で HEAD リクエストでの判定を実装予定。
        // ここでは「既存があれば skip」の単純判定に留める。
        if (verbose) console.log(`  [skip] ${entry.id} (existing)`);
        results.skipped++;
        continue;
      }
    }

    await rl.wait();

    const fetchResult = await crawler.fetchPage(entry.url);
    if (!fetchResult.ok) {
      results.errors.push({ url: entry.url, reason: fetchResult.reason, status: fetchResult.status });
      if (verbose) console.warn(`  [error] ${entry.url}: ${fetchResult.reason}`);
      continue;
    }

    try {
      const parsed = taxanswerParser.parseTaxAnswerHtml(fetchResult.html, entry.url);
      const stored = {
        ...parsed,
        fetched_at: fetchResult.fetchedAt,
        html_hash: fetchResult.htmlHash,
        byte_size: fetchResult.byteSize,
        encoding: fetchResult.encoding,
      };
      store.saveTaxAnswerEntry(stored);
      results.fetched++;
      if (verbose || i % 20 === 0) {
        console.log(`  [${i}/${target}] ${entry.category}/${entry.id} ${parsed.title.slice(0, 30)}`);
      }
    } catch (e) {
      results.errors.push({ url: entry.url, reason: 'parse_failed', error: e.message });
      console.warn(`  [parse error] ${entry.url}: ${e.message}`);
    }
  }

  console.log(`\n[taxanswer] 完了: fetched=${results.fetched}, skipped=${results.skipped}, errors=${results.errors.length}`);
  if (results.errors.length > 0) {
    console.log('[taxanswer] エラー詳細（最大 10 件）:');
    for (const e of results.errors.slice(0, 10)) {
      console.log(`  - ${e.url}: ${e.reason}${e.error ? ' / ' + e.error : ''}`);
    }
  }
  return results;
}

// ── 質疑応答事例の全件 crawl ────────────────────────────────────
async function crawlShitsugi(args) {
  const verbose = args.verbose;
  const maxPages = args.maxPages;
  const categoryFilter = args.category ? [args.category] : null;

  console.log('[shitsugi] index ページを取得中…（カテゴリ別 index は順次 fetch）');
  const entries = await shitsugiIndex.fetchShitsugiIndex({ categories: categoryFilter });
  console.log(`[shitsugi] index から ${entries.length} 件の URL を取得`);

  // カテゴリ別件数の表示
  const byCategory = {};
  for (const e of entries) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  }
  for (const [cat, n] of Object.entries(byCategory).sort()) {
    console.log(`  ${cat.padEnd(10)} : ${n}`);
  }

  if (args.dryRun) {
    console.log('[shitsugi] --dry-run のため crawl は実行しません。');
    return { fetched: 0, skipped: 0, errors: [] };
  }

  const target = Number.isFinite(maxPages) ? Math.min(entries.length, maxPages) : entries.length;
  console.log(`[shitsugi] ${target} 件を crawl 開始（rate limit 1 req/sec）…`);

  const rl = new crawler.RateLimiter(1000);
  const results = { fetched: 0, skipped: 0, errors: [] };
  let i = 0;

  for (const entry of entries) {
    if (i >= target) break;
    i++;

    if (args.incremental) {
      const existing = store.readJson(
        store.shitsugiPath(entry.category, entry.section, entry.id)
      );
      if (existing && existing.html_hash) {
        if (verbose) console.log(`  [skip] ${entry.category}/${entry.section}/${entry.id}`);
        results.skipped++;
        continue;
      }
    }

    await rl.wait();

    const fetchResult = await crawler.fetchPage(entry.url);
    if (!fetchResult.ok) {
      results.errors.push({ url: entry.url, reason: fetchResult.reason, status: fetchResult.status });
      if (verbose) console.warn(`  [error] ${entry.url}: ${fetchResult.reason}`);
      continue;
    }

    try {
      const parsed = shitsugiParser.parseShitsugiHtml(fetchResult.html, entry.url);
      const stored = {
        ...parsed,
        fetched_at: fetchResult.fetchedAt,
        html_hash: fetchResult.htmlHash,
        byte_size: fetchResult.byteSize,
        encoding: fetchResult.encoding,
      };
      store.saveShitsugiEntry(stored);
      results.fetched++;
      if (verbose || i % 20 === 0) {
        console.log(`  [${i}/${target}] ${entry.category}/${entry.section}/${entry.id} ${parsed.title.slice(0, 30)}`);
      }
    } catch (e) {
      results.errors.push({ url: entry.url, reason: 'parse_failed', error: e.message });
      console.warn(`  [parse error] ${entry.url}: ${e.message}`);
    }
  }

  console.log(`\n[shitsugi] 完了: fetched=${results.fetched}, skipped=${results.skipped}, errors=${results.errors.length}`);
  if (results.errors.length > 0) {
    console.log('[shitsugi] エラー詳細（最大 10 件）:');
    for (const e of results.errors.slice(0, 10)) {
      console.log(`  - ${e.url}: ${e.reason}${e.error ? ' / ' + e.error : ''}`);
    }
  }
  return results;
}

// ── 全件 crawl の振分け ────────────────────────────────────────
async function crawlAll(args) {
  if (args.type === 'taxanswer' || args.type === 'all') {
    await crawlTaxAnswer(args);
  }
  if (args.type === 'shitsugi' || args.type === 'all') {
    await crawlShitsugi(args);
  }
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  if (args.probe) {
    await probe(args.probe, args.verbose);
    return;
  }

  await crawlAll(args);
}

main().catch(e => {
  console.error('[fatal]', e.message);
  process.exit(1);
});
