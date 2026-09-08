'use strict';

/**
 * e-Gov 法令API v2 から法令の条文を取り込み、data/law-sources/ に保存する。
 *
 *   node scripts/crawl-law-sources.js            # LAWS 全件
 *   node scripts/crawl-law-sources.js --only minpo,koseki
 *   node scripts/crawl-law-sources.js --dry-run  # 取得だけして保存しない
 *
 * 保存形式（data/law-sources/<key>.json）:
 *   { key, law_id, title, law_num, law_revision_id, amendment_enforcement_date, updated,
 *     fetched_at, elms, article_count, articles: [{ num, caption, title, text, path }] }
 *   path は「第五編 相続 > 第一章 総則」のような見出しの連なり。
 *
 * 応答の構造: law_full_text が { tag, attr, children } の木。Article の attr.Num が
 * 条番号（'909_2' = 第909条の2）。段落は Paragraph、号は Item。
 */

const fs = require('fs');
const path = require('path');
const { LAWS, LAW_DIR, EGOV_API } = require('./lib/law-sources');

const HEADING_TAGS = new Set(['PartTitle', 'ChapterTitle', 'SectionTitle', 'SubsectionTitle', 'DivisionTitle']);
const CONTAINER_TAGS = new Set(['Part', 'Chapter', 'Section', 'Subsection', 'Division']);
const BREAK_AFTER = new Set(['Paragraph', 'Item', 'Subitem1', 'Subitem2', 'Subitem3']);
const SPACE_AFTER = new Set(['ParagraphNum', 'ItemTitle', 'Subitem1Title', 'Subitem2Title', 'Subitem3Title']);
const SKIP_TAGS = new Set(['Rt', 'ArticleCaption', 'ArticleTitle']);   // ルビの読み・見出しは本文に含めない

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (SKIP_TAGS.has(node.tag)) return '';
  let s = (node.children || []).map(textOf).join('');
  if (SPACE_AFTER.has(node.tag) && s) s += '　';
  if (BREAK_AFTER.has(node.tag)) s += '\n';
  return s;
}

function childText(node, tag) {
  const c = (node.children || []).find(x => x && typeof x === 'object' && x.tag === tag);
  return c ? textOf({ ...c, tag: '_' }).trim() : '';
}

/** 木を歩いて条を集める。見出し（編・章・節）の連なりを path に持たせる */
function collectArticles(root) {
  const out = [];
  const walk = (node, headings) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, headings); return; }
    if (node.tag === 'Article') {
      out.push({
        num: String((node.attr || {}).Num || ''),
        caption: childText(node, 'ArticleCaption').replace(/^（|）$/g, ''),
        title: childText(node, 'ArticleTitle'),
        text: textOf(node).replace(/\n{2,}/g, '\n').trim(),
        path: headings.join(' > '),
      });
      return;
    }
    let next = headings;
    if (CONTAINER_TAGS.has(node.tag)) {
      const titleTag = node.tag + 'Title';
      const t = childText(node, titleTag);
      if (t) next = headings.concat([t]);
    }
    for (const c of node.children || []) walk(c, next);
  };
  walk(root, []);
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'hp-vlog-law-crawler (+https://mori-zeirishi.net)', accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function crawlLaw(key, def, opts) {
  const articles = [];
  let info = null;
  for (const elm of def.elms || ['MainProvision']) {
    const url = `${EGOV_API}${def.law_id}?elm=${encodeURIComponent(elm)}`;
    const data = await fetchJson(url);
    if (!info) {
      const ri = data.revision_info || {};
      const li = data.law_info || {};
      info = {
        law_id: def.law_id,
        title: ri.law_title || def.title,
        law_num: li.law_num || '',
        law_revision_id: ri.law_revision_id || '',
        amendment_enforcement_date: ri.amendment_enforcement_date || '',
        amendment_law_id: ri.amendment_law_id || '',
        updated: ri.updated || '',
      };
      if (info.title !== def.title) {
        throw new Error(`法令名が想定と違います: ${def.law_id} → ${info.title}（想定 ${def.title}）`);
      }
    }
    const got = collectArticles(data.law_full_text);
    articles.push(...got);
    if (opts.verbose) console.log(`  ${key} ${elm}: ${got.length} 条`);
    await sleep(1000);
  }
  // 重複（同じ条が複数 elm に現れることは無いが念のため）と絞り込み
  const seen = new Set();
  let kept = articles.filter(a => a.num && !seen.has(a.num) && seen.add(a.num));
  if (Array.isArray(def.articles) && def.articles.length) {
    const allow = new Set(def.articles);
    kept = kept.filter(a => allow.has(a.num));
  }
  return { key, ...info, fetched_at: new Date().toISOString(), elms: def.elms || ['MainProvision'], article_count: kept.length, articles: kept };
}

function parseArgs(argv) {
  const args = { only: null, dryRun: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') args.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const keys = Object.keys(LAWS).filter(k => !args.only || args.only.includes(k));
  console.log(`[law] ${keys.length} 法令を取得します（e-Gov 法令API v2、1 req/sec）`);
  const index = [];
  for (const key of keys) {
    const def = LAWS[key];
    try {
      const law = await crawlLaw(key, def, args);
      console.log(`[law] ${law.title}（${law.law_num}）: ${law.article_count} 条 / 最終改正施行 ${law.amendment_enforcement_date}`);
      if (!args.dryRun) {
        fs.mkdirSync(LAW_DIR, { recursive: true });
        fs.writeFileSync(path.join(LAW_DIR, `${key}.json`), JSON.stringify(law, null, 1) + '\n');
      }
      index.push({ key, law_id: law.law_id, title: law.title, law_num: law.law_num, article_count: law.article_count,
        amendment_enforcement_date: law.amendment_enforcement_date, law_revision_id: law.law_revision_id, fetched_at: law.fetched_at });
    } catch (e) {
      console.error(`[law] ✗ ${key}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (!args.dryRun && index.length) {
    fs.writeFileSync(path.join(LAW_DIR, 'index.json'), JSON.stringify({ generated_at: new Date().toISOString(), laws: index }, null, 1) + '\n');
    console.log(`[law] index.json を更新（${index.length} 法令）`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[law] fatal:', e.message); process.exit(1); });
}

module.exports = { collectArticles, textOf, crawlLaw };
