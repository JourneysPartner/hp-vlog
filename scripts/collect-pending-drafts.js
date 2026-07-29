'use strict';

/**
 * 未マージの下書きPR（draft/* ブランチ）の記事メタデータを集めて
 * リポジトリ直下 .pending-drafts.json に書き出す。
 *
 * 背景 / 目的:
 *   日次生成の重複検知（selectDailyTopics のコーパス = site-corpus）は
 *   main の content/posts しか見ない。承認前（未マージ）の下書きは対象外なので、
 *   前日の下書きが承認されずに溜まると、選定は「前日と同じ状態」を見て
 *   同じトピックを再生成してしまう（2026-07-28 と 07-29 の準確定申告ペアが完全重複）。
 *
 *   本スクリプトを daily-draft ワークフローの「生成前」に実行し、オープンの draft/*
 *   ブランチにあって main に無い記事のメタデータを収集する。generate-draft.js が
 *   これを extraCorpus として selectDailyTopics に渡すことで、承認前の下書きも
 *   既存slug除外 / cooldown / 類似度 / 意味的ゲートの対象に含める。
 *
 * 出力: .pending-drafts.json（.gitignore 済み・commit されない）
 * 失敗しても生成を止めない（空配列を書いて exit 0）。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const OUT = path.join(__dirname, '..', '.pending-drafts.json');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function collect() {
  // draft/* のブランチ先端を取得（shallow clone でも depth=1 で取得できる）
  try {
    sh("git fetch origin '+refs/heads/draft/*:refs/remotes/origin/draft/*' --depth=1");
  } catch (_) { /* リモートに draft が無い等は無視 */ }

  let branches = [];
  try {
    branches = sh("git for-each-ref --format='%(refname:short)' refs/remotes/origin/draft/")
      .split('\n').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  } catch (_) { branches = []; }

  // main に既にある記事は通常コーパスに入るので、ここでは除外対象
  let mainFiles = new Set();
  try {
    mainFiles = new Set(
      sh('git ls-tree -r --name-only origin/main content/posts')
        .split('\n').filter(f => f.endsWith('.md'))
    );
  } catch (_) { /* origin/main 未取得時は空のまま */ }

  const posts = [];
  const seenSlug = new Set();
  for (const br of branches) {
    let files = [];
    try {
      files = sh(`git ls-tree -r --name-only ${br} content/posts`)
        .split('\n').filter(f => f.endsWith('.md'));
    } catch (_) { continue; }
    for (const f of files) {
      if (mainFiles.has(f)) continue; // main にある＝既にコーパス
      let raw;
      try { raw = sh(`git show ${br}:${f}`); } catch (_) { continue; }
      let fm;
      try { fm = matter(raw).data || {}; } catch (_) { continue; }
      if (!fm.slug || seenSlug.has(fm.slug)) continue;
      seenSlug.add(fm.slug);
      // site-corpus.readAllPostsSorted() の post 形状に合わせる
      posts.push({
        file: path.basename(f),
        slug: fm.slug,
        title: fm.title || '',
        category: fm.category || '',
        primary_persona: fm.primary_persona || '',
        review_status: fm.review_status || 'draft',
        search_intent: fm.search_intent || '',
        reader_problem: fm.reader_problem || '',
        success_outcome: fm.success_outcome || '',
        primary_question: fm.primary_question || '',
        summary: fm.summary || '',
        publish_at: fm.publish_at || '',
        published_at: fm.published_at || '',
        created_at: fm.created_at || '',
        updated_at: fm.updated_at || '',
        business_stage: fm.business_stage || '',
        life_stage: fm.life_stage || '',
        pain_point: fm.pain_point || '',
        procedure_stage: fm.procedure_stage || '',
        macro: fm.macro || '',
        cluster: fm.cluster || '',
        subcluster: fm.subcluster || '',
        tax_domain: fm.tax_domain || '',
        customer_segment: fm.customer_segment || '',
        _pending: true,
      });
    }
  }
  return posts;
}

function main() {
  let posts = [];
  try { posts = collect(); }
  catch (e) { console.error('[pending-drafts] 収集に失敗（生成は継続）:', e.message); posts = []; }
  try { fs.writeFileSync(OUT, JSON.stringify(posts)); } catch (_) { /* 書けなくても継続 */ }
  console.log(`[pending-drafts] 未マージ下書き ${posts.length} 件を収集 → ${path.basename(OUT)}`);
  for (const p of posts) console.log(`  - ${p.slug} [${p.review_status}] segment=${p.customer_segment || '-'} pain=${p.pain_point || '-'} sub=${p.subcluster || '-'}`);
}

if (require.main === module) main();
module.exports = { collect };
