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

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const OUT = path.join(__dirname, '..', '.pending-drafts.json');

function runCommand(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function loadPullRequests(run, env) {
  if (!env.GH_TOKEN) {
    throw new Error('GH_TOKEN が未設定です');
  }
  const raw = run('gh', ['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'headRefName,state,closedAt']);
  const prs = JSON.parse(raw);
  if (!Array.isArray(prs)) throw new Error('PR 一覧の形式が不正です');

  const byBranch = new Map();
  for (const pr of prs) {
    if (!pr || !pr.headRefName) continue;
    const normalized = { ...pr, state: String(pr.state || '').toUpperCase() };
    const current = byBranch.get(pr.headRefName);
    // 同じ head の履歴が複数あっても、OPEN があれば必ず収集対象に残す。
    if (!current || (normalized.state === 'OPEN' && current.state !== 'OPEN')) {
      byBranch.set(pr.headRefName, normalized);
    }
  }
  return byBranch;
}

function collect({ run = runCommand, env = process.env, warn = console.warn, log = console.log } = {}) {
  // オブジェクトを fetch する前に、remote の枝名だけを軽量に取得する。
  let headBranches = [];
  try {
    headBranches = run('git', ['ls-remote', '--heads', 'origin', 'refs/heads/draft/*'])
      .split(/\r?\n/)
      .map(line => (line.match(/\srefs\/heads\/(draft\/.+)$/) || [])[1])
      .filter(Boolean);
  } catch (_) {
    // ls-remote が使えない環境では、従来の remote-tracking ref を利用する。
    try {
      run('git', ['fetch', '--depth=1', 'origin', '+refs/heads/draft/*:refs/remotes/origin/draft/*']);
      headBranches = run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/draft/'])
        .split(/\r?\n/).map(s => s.trim().replace(/^origin\//, '')).filter(Boolean);
    } catch (_) { headBranches = []; }
  }

  let prsByBranch = null;
  try {
    prsByBranch = loadPullRequests(run, env);
  } catch (_) {
    warn('[pending-drafts] 警告: PR 状態を取得できないため、従来どおり全 draft/* 枝を対象にします。');
  }

  const excluded = { merged: 0, closed: 0, skipped: 0 };
  const activeHeads = headBranches.filter((headRefName) => {
    const pr = prsByBranch && prsByBranch.get(headRefName);
    if (pr && pr.state === 'MERGED') {
      excluded.merged++;
      return false;
    }
    if (pr && pr.state === 'CLOSED') {
      excluded.closed++;
      return false;
    }
    return true;
  });

  // OPEN と PR なしだけを取得する。PR 一覧の取得失敗時は全枝になり、従来挙動を保つ。
  if (activeHeads.length > 0) {
    const refspecs = activeHeads.map(head => `+refs/heads/${head}:refs/remotes/origin/${head}`);
    try { run('git', ['fetch', '--depth=1', 'origin', ...refspecs]); }
    catch (_) { /* 取得できた remote-tracking ref だけで継続する */ }
  }

  // main に既にある記事は通常コーパスに入るので、ここでは除外対象
  let mainFiles = new Set();
  try {
    mainFiles = new Set(
      run('git', ['ls-tree', '-r', '--name-only', 'origin/main', 'content/posts'])
        .split('\n').filter(f => f.endsWith('.md'))
    );
  } catch (_) { /* origin/main 未取得時は空のまま */ }

  const posts = [];
  const seenSlug = new Set();
  for (const headRefName of activeHeads) {
    const br = `origin/${headRefName}`;
    let files = [];
    try {
      files = run('git', ['ls-tree', '-r', '--name-only', br, 'content/posts'])
        .split('\n').filter(f => f.endsWith('.md'));
    } catch (_) { continue; }
    for (const f of files) {
      if (mainFiles.has(f)) continue; // main にある＝既にコーパス
      let raw;
      try { raw = run('git', ['show', `${br}:${f}`]); } catch (_) { continue; }
      let fm;
      try { fm = matter(raw).data || {}; } catch (_) { continue; }
      if (['skipped', 'rejected', 'merged'].includes(String(fm.review_status || '').toLowerCase())) {
        excluded.skipped++;
        continue;
      }
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
  log(`[pending-drafts] 除外: merged ${excluded.merged} / closed ${excluded.closed} / skipped ${excluded.skipped}`);
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
module.exports = { collect, loadPullRequests };
