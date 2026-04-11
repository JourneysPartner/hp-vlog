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

const ROOT      = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

function nowJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

// frontmatter の特定キーを書き換える（既存値があれば差替、無ければ追加）
function setFmField(raw, key, value) {
  const m = raw.match(/^(---\r?\n)([\s\S]+?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!m) throw new Error('frontmatter が見つかりません');
  let fm = m[2];
  const re = new RegExp(`^(${key}:\\s*)"?[^"\\n]*"?\\s*$`, 'm');
  if (re.test(fm)) {
    fm = fm.replace(re, `$1"${value}"`);
  } else {
    fm += `\n${key}: "${value}"`;
  }
  return m[1] + fm + m[3] + m[4];
}

function getFmField(raw, key) {
  const m = raw.match(new RegExp(`^${key}:\\s*"?([^"\\n\\r]+)"?`, 'm'));
  return m ? m[1].trim() : '';
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

  for (const file of files) {
    const filepath = path.join(POSTS_DIR, file);
    const raw = fs.readFileSync(filepath, 'utf8');

    const status   = getFmField(raw, 'review_status');
    const publishAt = getFmField(raw, 'publish_at');

    if (status !== 'approved') continue;
    if (!publishAt) continue;

    const due = new Date(publishAt);
    if (isNaN(due) || due > now) continue;

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

  // GitHub Actions 出力変数
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
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
