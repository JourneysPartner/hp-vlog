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
const crawler = require(path.join(ROOT, 'scripts/lib/nta-crawler'));

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

// ── 全件 crawl（C-2 以降で実装） ────────────────────────────────
async function crawlAll(args) {
  console.log('[crawl] Phase C-1 骨子では全件 crawl は未実装です。');
  console.log('[crawl] C-2（タックスアンサーパーサ）と C-3（質疑応答事例パーサ）で実装予定。');
  console.log('[crawl] 動作確認には --probe <url> を使用してください。');
  console.log('');
  console.log('例:');
  console.log('  node scripts/crawl-nta-sources.js --probe https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm');
  console.log('  node scripts/crawl-nta-sources.js --probe https://www.nta.go.jp/law/shitsugi/shohi/02/01.htm --verbose');
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
