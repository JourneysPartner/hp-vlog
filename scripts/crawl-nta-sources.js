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
const indexBuilder     = require(path.join(ROOT, 'scripts/lib/nta-index-builder'));
const figures          = require(path.join(ROOT, 'scripts/lib/nta-figures'));

// ── 引数パーサ ─────────────────────────────────────────────────
// ページに図（画像）があれば取得して entry.images に載せる。
// 図は「そのページの HTML に実在する img」だけを対象にし、URL を規則から
// 組み立てない（同じ img ディレクトリに別事例の図が同居しているため）。
// 取得に失敗しても本文の取り込みは止めない。
async function attachFigures(stored, html, url, rl, verbose) {
  try {
    const refs = figures.extractFigureRefs(html, url);
    if (refs.length === 0) return stored;
    const images = await figures.fetchAndStoreFigures(refs, stored, stored.html_hash, { rateLimiter: rl });
    if (images.length === 0) return stored;
    if (verbose) console.log(`  [figures] ${url} の図 ${images.length} 枚を保存`);
    return { ...stored, images };
  } catch (e) {
    console.warn(`[figures] 取り込みに失敗（本文は保存します）: ${url} — ${e.message}`);
    return stored;
  }
}

function parseArgs(argv) {
  const args = {
    type: 'all',
    category: null,
    incremental: false,
    dryRun: false,
    verbose: false,
    maxPages: Infinity,
    probe: null,
    rebuildIndex: false,
    skipIndex: false,
    backfillFigures: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--backfill-figures': args.backfillFigures = true; break;
      case '--type':         args.type = argv[++i]; break;
      case '--category':     args.category = argv[++i]; break;
      case '--incremental':  args.incremental = true; break;
      case '--dry-run':      args.dryRun = true; break;
      case '--verbose':      args.verbose = true; break;
      case '--max-pages':    args.maxPages = parseInt(argv[++i], 10); break;
      case '--probe':        args.probe = argv[++i]; break;
      case '--rebuild-index': args.rebuildIndex = true; break;
      case '--skip-index':   args.skipIndex = true; break;
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
  --rebuild-index     crawl をスキップして index.json / meta.json だけ再生成
  --skip-index        crawl 後の index/meta 自動生成をスキップ
  --backfill-figures    既存レコードに図（画像）を後追いで取り込む（images 未取得のものだけ）
  -h, --help          このヘルプ
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

// ── 共通：差分 crawl の判定 + GET フェッチ ───────────────────────
// HEAD を先に投げ、Last-Modified/ETag を既存と比較。
// 戻り値: { action: 'skipped'|'fetched'|'deleted'|'error', stored?, error? }
//
// action 'fetched' なら呼び出し側で parser に渡して save する。
// 'skipped' は last_checked_at だけ更新したものを返す。
// 'deleted' は { ...existing, deleted: true, last_checked_at } を返す。
async function performIncrementalFetch(entry, existing, rl, args) {
  // 既存なしなら incremental の対象外 → 全文 GET
  if (!args.incremental || !existing || !existing.html_hash) {
    await rl.wait();
    const fetchResult = await crawler.fetchPage(entry.url);
    return { action: fetchResult.ok ? 'fetched' : 'error', fetchResult };
  }

  // HEAD で差分判定
  await rl.wait();
  const head = await crawler.fetchPageHead(entry.url);
  const { decision, reason } = crawler.decideIncrementalAction(existing, head);

  if (decision === 'skip') {
    return {
      action: 'skipped',
      reason,
      updatedEntry: { ...existing, last_checked_at: head.checkedAt },
    };
  }

  if (decision === 'mark_deleted') {
    return {
      action: 'deleted',
      reason,
      updatedEntry: { ...existing, deleted: true, last_checked_at: head.checkedAt },
    };
  }

  // 'fetch' または 'first_time' → 本文 GET
  await rl.wait();
  const fetchResult = await crawler.fetchPage(entry.url);
  if (!fetchResult.ok) {
    return { action: 'error', fetchResult, headMeta: head };
  }

  // hash が一致するなら、HEAD は変わったが実体は変わらず → skipped 扱い
  if (existing.html_hash && fetchResult.htmlHash === existing.html_hash) {
    return {
      action: 'skipped',
      reason: 'hash_match_after_get',
      updatedEntry: {
        ...existing,
        last_checked_at: head.checkedAt,
        // 新しい HEAD メタは反映しておく
        last_modified: head.lastModified || existing.last_modified,
        etag: head.etag || existing.etag,
      },
    };
  }

  return { action: 'fetched', fetchResult, headMeta: head };
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
  const results = { fetched: 0, skipped: 0, deleted: 0, errors: [] };
  let i = 0;

  for (const entry of entries) {
    if (i >= target) break;
    i++;

    const existing = args.incremental
      ? store.loadTaxAnswerEntry(entry.category, entry.id)
      : null;

    const r = await performIncrementalFetch(entry, existing, rl, args);

    if (r.action === 'skipped') {
      store.saveTaxAnswerEntry(r.updatedEntry);
      results.skipped++;
      if (verbose) console.log(`  [skip] ${entry.category}/${entry.id} (${r.reason})`);
      continue;
    }

    if (r.action === 'deleted') {
      store.saveTaxAnswerEntry(r.updatedEntry);
      results.deleted++;
      console.warn(`  [deleted] ${entry.category}/${entry.id} (HEAD 404)`);
      continue;
    }

    if (r.action === 'error') {
      results.errors.push({
        url: entry.url,
        reason: r.fetchResult.reason,
        status: r.fetchResult.status,
      });
      if (verbose) console.warn(`  [error] ${entry.url}: ${r.fetchResult.reason}`);
      continue;
    }

    // action === 'fetched'
    try {
      const parsed = taxanswerParser.parseTaxAnswerHtml(r.fetchResult.html, entry.url);
      const stored = {
        ...parsed,
        fetched_at: r.fetchResult.fetchedAt,
        last_checked_at: r.headMeta ? r.headMeta.checkedAt : r.fetchResult.fetchedAt,
        html_hash: r.fetchResult.htmlHash,
        byte_size: r.fetchResult.byteSize,
        encoding: r.fetchResult.encoding,
        // HEAD で取れていればそれ、無ければ GET レスポンスから
        last_modified: (r.headMeta && r.headMeta.lastModified) || r.fetchResult.lastModified || null,
        etag:          (r.headMeta && r.headMeta.etag)          || r.fetchResult.etag          || null,
      };
      const withFigures = await attachFigures(stored, r.fetchResult.html, entry.url, rl, verbose);
      store.saveTaxAnswerEntry(withFigures);
      results.fetched++;
      if (verbose || i % 20 === 0) {
        console.log(`  [${i}/${target}] ${entry.category}/${entry.id} ${parsed.title.slice(0, 30)}`);
      }
    } catch (e) {
      results.errors.push({ url: entry.url, reason: 'parse_failed', error: e.message });
      console.warn(`  [parse error] ${entry.url}: ${e.message}`);
    }
  }

  console.log(`\n[taxanswer] 完了: fetched=${results.fetched}, skipped=${results.skipped}, deleted=${results.deleted}, errors=${results.errors.length}`);
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
  const results = { fetched: 0, skipped: 0, deleted: 0, errors: [] };
  let i = 0;

  for (const entry of entries) {
    if (i >= target) break;
    i++;

    const existing = args.incremental
      ? store.readJson(store.shitsugiPath(entry.category, entry.section, entry.id))
      : null;

    const r = await performIncrementalFetch(entry, existing, rl, args);

    if (r.action === 'skipped') {
      store.saveShitsugiEntry(r.updatedEntry);
      results.skipped++;
      if (verbose) console.log(`  [skip] ${entry.category}/${entry.section}/${entry.id} (${r.reason})`);
      continue;
    }

    if (r.action === 'deleted') {
      store.saveShitsugiEntry(r.updatedEntry);
      results.deleted++;
      console.warn(`  [deleted] ${entry.category}/${entry.section}/${entry.id} (HEAD 404)`);
      continue;
    }

    if (r.action === 'error') {
      results.errors.push({
        url: entry.url,
        reason: r.fetchResult.reason,
        status: r.fetchResult.status,
      });
      if (verbose) console.warn(`  [error] ${entry.url}: ${r.fetchResult.reason}`);
      continue;
    }

    // action === 'fetched'
    try {
      const parsed = shitsugiParser.parseShitsugiHtml(r.fetchResult.html, entry.url);
      const stored = {
        ...parsed,
        fetched_at: r.fetchResult.fetchedAt,
        last_checked_at: r.headMeta ? r.headMeta.checkedAt : r.fetchResult.fetchedAt,
        html_hash: r.fetchResult.htmlHash,
        byte_size: r.fetchResult.byteSize,
        encoding: r.fetchResult.encoding,
        last_modified: (r.headMeta && r.headMeta.lastModified) || r.fetchResult.lastModified || null,
        etag:          (r.headMeta && r.headMeta.etag)          || r.fetchResult.etag          || null,
      };
      const withFigures = await attachFigures(stored, r.fetchResult.html, entry.url, rl, verbose);
      store.saveShitsugiEntry(withFigures);
      results.fetched++;
      if (verbose || i % 20 === 0) {
        console.log(`  [${i}/${target}] ${entry.category}/${entry.section}/${entry.id} ${parsed.title.slice(0, 30)}`);
      }
    } catch (e) {
      results.errors.push({ url: entry.url, reason: 'parse_failed', error: e.message });
      console.warn(`  [parse error] ${entry.url}: ${e.message}`);
    }
  }

  console.log(`\n[shitsugi] 完了: fetched=${results.fetched}, skipped=${results.skipped}, deleted=${results.deleted}, errors=${results.errors.length}`);
  if (results.errors.length > 0) {
    console.log('[shitsugi] エラー詳細（最大 10 件）:');
    for (const e of results.errors.slice(0, 10)) {
      console.log(`  - ${e.url}: ${e.reason}${e.error ? ' / ' + e.error : ''}`);
    }
  }
  return results;
}

// ── index.json + meta.json の生成 ────────────────────────────
function buildAndSaveIndex(startedAt, results) {
  console.log('\n[index] index.json と meta.json を生成中…');
  const indexData = indexBuilder.buildIndex();
  indexBuilder.saveIndex(indexData);
  console.log(`[index] index.json: ${indexData.total_count} エントリ`);
  console.log(`        by_type: ${JSON.stringify(indexData.by_type)}`);

  // meta.json は crawl 実行時のみ保存（rebuild-index 単独時は results が null）
  if (results) {
    indexBuilder.saveMeta({
      startedAt,
      finishedAt: new Date().toISOString(),
      results,
      byType: indexData.by_type,
    });
    console.log(`[meta] meta.json: fetched=${results.fetched} skipped=${results.skipped} deleted=${results.deleted} errors=${results.errors.length}`);
  }
}

// ── 全件 crawl の振分け ────────────────────────────────────────
async function crawlAll(args) {
  const startedAt = new Date().toISOString();
  // 全 type の集計
  const aggregated = { fetched: 0, skipped: 0, deleted: 0, errors: [] };

  if (args.type === 'taxanswer' || args.type === 'all') {
    const r = await crawlTaxAnswer(args);
    if (r) {
      aggregated.fetched += r.fetched;
      aggregated.skipped += r.skipped;
      aggregated.deleted += r.deleted;
      aggregated.errors.push(...r.errors);
    }
  }
  if (args.type === 'shitsugi' || args.type === 'all') {
    const r = await crawlShitsugi(args);
    if (r) {
      aggregated.fetched += r.fetched;
      aggregated.skipped += r.skipped;
      aggregated.deleted += r.deleted;
      aggregated.errors.push(...r.errors);
    }
  }

  if (!args.dryRun && !args.skipIndex) {
    buildAndSaveIndex(startedAt, aggregated);
  }
}

// ── 既存レコードへの図のバックフィル ────────────────────────────
//
// 通常の incremental crawl は html_hash が変わらないページを HEAD だけで
// スキップするため、図の取り込みを後から入れても既存レコードには一生付かない。
// このモードは images も figures_checked_at も持たないレコードだけを対象に、
// ページを取り直して図を保存する。図が無いページには figures_checked_at を
// 記録し、次回以降は再取得しない（1,550件を何度も舐めないため）。
async function backfillFigures(args) {
  // data/nta-sources 配下の出典レコードを走査する（images 配下は対象外）
  const fsMod = require('fs');
  const walk = (dir, acc) => {
    for (const name of fsMod.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fsMod.statSync(full);
      if (st.isDirectory()) {
        if (name === 'images') continue;
        walk(full, acc);
      } else if (name.endsWith('.json') && name !== 'index.json' && name !== 'meta.json' && name !== 'token-df.json') {
        acc.push(full);
      }
    }
    return acc;
  };
  const targets = [];
  for (const file of walk(store.NTA_SOURCES_DIR, [])) {
    const entry = store.readJson(file);
    if (!entry || entry.deleted === true || !entry.url) continue;
    if (Array.isArray(entry.images) || entry.figures_checked_at) continue;
    targets.push({ file, entry });
  }
  const limit = Number.isFinite(args.maxPages) ? Math.min(targets.length, args.maxPages) : targets.length;
  console.log(`[backfill] 図が未確認のレコード ${targets.length} 件のうち ${limit} 件を処理します（1 req/sec）`);
  if (args.dryRun) return;

  const rl = new crawler.RateLimiter(1000);
  let withFig = 0, without = 0, errors = 0;
  for (let i = 0; i < limit; i++) {
    const { file, entry } = targets[i];
    await rl.wait();
    const r = await crawler.fetchPage(entry.url);
    if (!r.ok) {
      errors++;
      if (args.verbose) console.warn(`  [error] ${entry.url}: ${r.reason}`);
      continue;
    }
    // ページが変わっていれば html_hash も更新しておく（図との整合のため）
    const base = { ...entry, html_hash: r.htmlHash, figures_checked_at: r.fetchedAt };
    const updated = await attachFigures(base, r.html, entry.url, rl, args.verbose);
    store.writeJsonAtomic(file, updated);
    if (Array.isArray(updated.images) && updated.images.length > 0) withFig++;
    else without++;
    if (args.verbose || (i + 1) % 50 === 0) {
      console.log(`  [${i + 1}/${limit}] 図あり ${withFig} / 図なし ${without} / エラー ${errors}`);
    }
  }
  console.log(`[backfill] 完了: 図あり ${withFig} 件 / 図なし ${without} 件 / エラー ${errors} 件`);
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  if (args.probe) {
    await probe(args.probe, args.verbose);
    return;
  }

  if (args.rebuildIndex) {
    console.log('[rebuild] index.json を再生成中（crawl はスキップ）…');
    const indexData = indexBuilder.buildIndex();
    indexBuilder.saveIndex(indexData);
    console.log(`[rebuild] 完了: ${indexData.total_count} エントリ`);
    console.log(`          by_type: ${JSON.stringify(indexData.by_type)}`);
    return;
  }

  if (args.backfillFigures) {
    await backfillFigures(args);
    return;
  }

  await crawlAll(args);
}

main().catch(e => {
  console.error('[fatal]', e.message);
  process.exit(1);
});
