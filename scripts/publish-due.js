'use strict';

/**
 * publish-due.js — 公開予定時刻を過ぎた approved 記事を published に昇格する
 *
 * 使い方:
 *   node scripts/publish-due.js
 *
 * 動作:
 *   1. content/posts/*.md を走査
 *   2. review_status === 'approved' かつ publish_at <= now の記事を抽出
 *   3. 該当記事の frontmatter を以下のように更新
 *        review_status: published
 *        published_at:  現在時刻 (JST)
 *        updated_at:    現在時刻 (JST)
 *   4. 結果を GitHub Actions の出力変数 / stdout に書き出す
 *
 * 出力 (GITHUB_OUTPUT):
 *   published_count=N
 *   published_files=file1.md,file2.md
 *   published_titles=title1|title2
 *   published_slugs=slug1,slug2
 *   published_categories=cat1|cat2
 *   published_personas=p1,p2
 */

const fs = require('fs');
const path = require('path');
const { publishGateReasons } = require('./lib/customer-relevance');

const ROOT      = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

function nowJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

// 単/双引用符を剥がす（YAML スカラ値が "...", '...', または素のいずれでも受ける）
function unquote(s) {
  if (!s) return '';
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// frontmatter の特定キーを書き換える（既存値があれば差替、無ければ追加）
// 既存値の引用符スタイル（', "）を問わずマッチする。書き戻しは double quote に統一する。
function setFmField(raw, key, value) {
  const m = raw.match(/^(---\r?\n)([\s\S]+?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!m) throw new Error('frontmatter が見つかりません');
  let fm = m[2];
  // 行全体（quote 種類を問わず）: key: <something>
  const re = new RegExp(`^(${key}:\\s*).*$`, 'm');
  if (re.test(fm)) {
    fm = fm.replace(re, `$1"${value}"`);
  } else {
    fm += `\n${key}: "${value}"`;
  }
  return m[1] + fm + m[3] + m[4];
}

function getFmField(raw, key) {
  // single / double quote のいずれにもマッチする
  const m = raw.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return m ? unquote(m[1]) : '';
}

function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.log('[publish-due] content/posts/ がありません');
    return;
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const now = new Date();
  const nowStr = nowJST();
  const published = [];
  const skipped = [];

  for (const file of files) {
    const filepath = path.join(POSTS_DIR, file);
    const raw = fs.readFileSync(filepath, 'utf8');

    const status   = getFmField(raw, 'review_status');
    const publishAt = getFmField(raw, 'publish_at');

    if (status !== 'approved') continue;
    if (!publishAt) continue;

    const due = new Date(publishAt);
    if (isNaN(due) || due > now) continue;

    // ── 品質ゲート（最終チェック）────────────────────────────
    // スコアが設定されている記事（Phase 3b 以降）のみ対象。スコア未設定の
    // レガシー記事は従来どおり昇格させる（既存記事を止めない）。
    const gateReasons = publishGateReasons({
      recommendation:         getFmField(raw, 'recommendation'),
      customer_fit_score:     getFmField(raw, 'customer_fit_score'),
      search_intent_score:    getFmField(raw, 'search_intent_score'),
      source_alignment_score: getFmField(raw, 'source_alignment_score'),
    });
    if (gateReasons.length > 0) {
      skipped.push({ file, reasons: gateReasons });
      console.warn(`[publish-due] SKIP(品質ゲート): ${file} — ${gateReasons.join(', ')} → published に昇格しません`);
      continue;
    }

    // 公開時刻に到達 → published に昇格
    let updated = raw;
    updated = setFmField(updated, 'review_status', 'published');
    updated = setFmField(updated, 'published_at', nowStr);
    updated = setFmField(updated, 'updated_at',   nowStr);

    fs.writeFileSync(filepath, updated, 'utf8');

    const title    = getFmField(raw, 'title');
    const slug     = getFmField(raw, 'slug');
    const category = getFmField(raw, 'category');
    const persona  = getFmField(raw, 'primary_persona');

    published.push({ file, title, slug, category, persona });
    console.log(`[publish-due] published: ${file} (${title})`);
  }

  console.log(`[publish-due] 公開対象: ${published.length} 件`);
  if (skipped.length > 0) {
    console.warn(`[publish-due] 品質ゲートで公開見送り: ${skipped.length} 件`);
    for (const s of skipped) console.warn(`  - ${s.file}: ${s.reasons.join(', ')}`);
  }

  // GitHub Actions 出力変数
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    fs.appendFileSync(ghOutput, `skipped_count=${skipped.length}\n`);
    fs.appendFileSync(ghOutput, `skipped_files=${skipped.map(s => s.file).join(',')}\n`);
    const filesCsv      = published.map(p => p.file).join(',');
    const titlesPipe    = published.map(p => p.title).join('|');
    const slugsCsv      = published.map(p => p.slug).join(',');
    const categoriesPipe = published.map(p => p.category).join('|');
    const personasCsv   = published.map(p => p.persona).join(',');

    fs.appendFileSync(ghOutput, `published_count=${published.length}\n`);
    fs.appendFileSync(ghOutput, `published_files=${filesCsv}\n`);
    fs.appendFileSync(ghOutput, `published_titles=${titlesPipe}\n`);
    fs.appendFileSync(ghOutput, `published_slugs=${slugsCsv}\n`);
    fs.appendFileSync(ghOutput, `published_categories=${categoriesPipe}\n`);
    fs.appendFileSync(ghOutput, `published_personas=${personasCsv}\n`);
  }
}

main();
