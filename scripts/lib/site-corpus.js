'use strict';

/**
 * サイト全体の記事コーパスを読み込む。
 *
 * 重複回避・cooldown・カテゴリ偏り判定で使うため、以下を全て対象に含める:
 *   - 公開済み（review_status: published）
 *   - 公開予定（approved / scheduled）
 *   - レビュー中（needs_review）
 *   - ドラフト（draft）
 *   - 差し戻し（needs_revision）
 *   - スキップ済み（skipped）も "近すぎテーマは避けたい" 判定には含める
 *
 * frontmatter のうち、判定に使う項目だけ抽出する。
 */

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..', '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const { resolveCluster, resolveTaxDomain } = require('./cluster-taxonomy');

// ── 簡易 frontmatter パーサ（gray-matter 非依存にして起動コスト軽減）
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]+?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_]+):\s*"?(.*?)"?\s*$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].replace(/^"(.*)"$/, '$1');
    out[key] = val;
  }
  return out;
}

function readAllPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];

  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const posts = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const fm = parseFrontmatter(raw);
    if (!fm.slug) continue;

    const cluster = resolveCluster({
      slug: fm.slug,
      persona: fm.primary_persona,
      cluster: fm.cluster,
      subcluster: fm.subcluster,
      macro: fm.macro,
    });

    posts.push({
      file,
      filepath: path.join(POSTS_DIR, file),
      slug:             fm.slug,
      title:            fm.title || '',
      category:         fm.category || '',
      primary_persona:  fm.primary_persona || '',
      article_type:     fm.article_type || '',
      article_role:     fm.article_role || '',
      review_status:    fm.review_status || '',
      summary:          fm.summary || '',
      search_intent:    fm.search_intent || '',
      reader_problem:   fm.reader_problem || '',
      success_outcome:  fm.success_outcome || '',
      primary_question: fm.primary_question || '',
      publish_at:       fm.publish_at || '',
      published_at:     fm.published_at || '',
      created_at:       fm.created_at || '',
      updated_at:       fm.updated_at || '',
      // シナリオ軸（scenario-expansion 由来。既存記事は無くても OK）
      business_stage:   fm.business_stage || '',
      life_stage:       fm.life_stage || '',
      pain_point:       fm.pain_point || '',
      procedure_stage:  fm.procedure_stage || '',
      transaction_pattern: fm.transaction_pattern || '',
      asset_type:       fm.asset_type || '',
      macro:            cluster.macro,
      cluster:          cluster.cluster,
      subcluster:       cluster.subcluster,
      tax_domain:       resolveTaxDomain({ category: fm.category, tax_domain: fm.tax_domain }),
    });
  }

  return posts;
}

/**
 * 記事を「日付」でソートして返す（新しい順）。
 * 日付の優先順位: published_at > publish_at > updated_at > created_at > ファイル名先頭の日付
 */
function postReferenceDate(post) {
  const candidates = [post.published_at, post.publish_at, post.updated_at, post.created_at];
  for (const c of candidates) {
    if (c && !isNaN(new Date(c))) return new Date(c);
  }
  // ファイル名先頭が YYYY-MM-DD の場合
  const m = post.file.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return new Date(m[1] + 'T00:00:00+09:00');
  return new Date(0);
}

function readAllPostsSorted() {
  return readAllPosts().sort((a, b) => postReferenceDate(b) - postReferenceDate(a));
}

/**
 * 直近 N 日以内の記事だけ返す（status は問わない、ドラフトも対象）。
 */
function readPostsWithinDays(days, now = new Date()) {
  const threshold = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return readAllPostsSorted().filter(p => postReferenceDate(p) >= threshold);
}

function getAllSlugs() {
  return new Set(readAllPosts().map(p => p.slug));
}

module.exports = {
  readAllPosts,
  readAllPostsSorted,
  readPostsWithinDays,
  getAllSlugs,
  postReferenceDate,
  parseFrontmatter,
};
