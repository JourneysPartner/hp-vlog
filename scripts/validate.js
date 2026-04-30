'use strict';

/**
 * 記事品質チェックスクリプト
 * 使い方: node scripts/validate.js [ファイルパス ...]
 *         ファイル省略時は content/posts/*.md を全件チェック
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const ROOT      = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

// ── 必須フロントマター項目 ──────────────────────────────────────
const REQUIRED_FIELDS = [
  'title', 'slug', 'category', 'primary_persona',
  'summary', 'review_status',
];

// source_url は公開前に必須だが、draft / needs_review では警告に留める
const REQUIRED_FOR_PUBLISH = ['source_url'];
const DRAFT_STATUSES = ['draft', 'needs_review'];

// ── 禁止表現（誇大広告チェック）────────────────────────────────
const BANNED_PHRASES = [
  '必ず節税', '絶対安心', '確実に節税', '100%節税',
  '受賞歴', '最優秀', 'No.1税理士',
];

// ── review_status の許容値 ──────────────────────────────────────
const VALID_STATUSES = [
  'draft', 'needs_review', 'needs_revision',
  'approved', 'scheduled', 'published', 'skipped',
];

// ── primary_persona の許容値 ────────────────────────────────────
const VALID_PERSONAS = [
  'ebay_export_seller', 'domestic_ec_seller', 'reseller_marketplace_seller',
  'influencer_creator', 'beauty_salon_owner', 'inheritance_client',
];

// ── article_type の許容値 ──────────────────────────────────────
const VALID_ARTICLE_TYPES = [
  'basic_explainer', 'comparison_decision', 'edge_case',
  'industry_example', 'filing_practice', 'misconception_fix', 'case_study',
];

// ── publish_slot の許容値 ──────────────────────────────────────
const VALID_PUBLISH_SLOTS = ['morning', 'evening'];

function validateFile(filePath) {
  const rel = path.relative(ROOT, filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  const { data: fm, content: body } = matter(raw);
  const errors = [];
  const warnings = [];

  // 1. 必須フィールド
  for (const field of REQUIRED_FIELDS) {
    if (!fm[field]) errors.push(`必須項目が未設定: ${field}`);
  }

  // 1b. 公開前必須フィールド（draft/needs_review では警告、それ以外はエラー）
  const isDraft = DRAFT_STATUSES.includes(fm.review_status);
  for (const field of REQUIRED_FOR_PUBLISH) {
    if (!fm[field]) {
      if (isDraft) {
        warnings.push(`${field} が未設定です（公開前に設定が必要）`);
      } else {
        errors.push(`必須項目が未設定: ${field}`);
      }
    }
  }

  // 2. review_status の値
  if (fm.review_status && !VALID_STATUSES.includes(fm.review_status)) {
    errors.push(`review_status の値が不正: "${fm.review_status}"`);
  }

  // 3. primary_persona の値
  if (fm.primary_persona && !VALID_PERSONAS.includes(fm.primary_persona)) {
    warnings.push(`primary_persona が未定義の値: "${fm.primary_persona}"`);
  }

  // 3b. article_type の値
  if (fm.article_type && !VALID_ARTICLE_TYPES.includes(fm.article_type)) {
    warnings.push(`article_type が未定義の値: "${fm.article_type}"`);
  }

  // 3c. publish_slot の値
  if (fm.publish_slot && !VALID_PUBLISH_SLOTS.includes(fm.publish_slot)) {
    warnings.push(`publish_slot が未定義の値: "${fm.publish_slot}"`);
  }

  // 3d. 企画メタ情報の存在チェック
  // 運用方針: 2026-04-30 以前の既存記事 → WARN（後方互換）
  //          2026-05-01 以降の新規記事 → ERROR（生成時に必ず付与される前提）
  const META_FIELDS = ['search_intent', 'reader_problem', 'success_outcome', 'primary_question'];
  const META_CUTOFF = new Date('2026-05-01T00:00:00+09:00');
  const createdAt = fm.created_at ? new Date(fm.created_at) : null;
  const isLegacy = !createdAt || createdAt < META_CUTOFF;
  for (const field of META_FIELDS) {
    if (!fm[field] && !isDraft) {
      if (isLegacy) {
        warnings.push(`${field} が未設定です（既存記事のため警告に留めます）`);
      } else {
        errors.push(`${field} が未設定です（2026-05-01以降の記事では必須）`);
      }
    }
  }

  // 4. source_url の形式
  if (fm.source_url) {
    try { new URL(fm.source_url); }
    catch { errors.push(`source_url が URL として不正: "${fm.source_url}"`); }
  }

  // 5. 見出し構造（h2 が最低1つ）
  if (!/^## /m.test(body)) {
    warnings.push('h2（## ）見出しがありません');
  }

  // 6. 免責事項の有無
  const hasDisclaimer =
    /本記事は.{0,30}情報提供/.test(body) ||
    /免責/.test(body) ||
    /個別事情/.test(body);
  if (!hasDisclaimer) {
    errors.push('免責事項が本文に含まれていません');
  }

  // 7. 誇大表現チェック
  const fullText = raw;
  for (const phrase of BANNED_PHRASES) {
    if (fullText.includes(phrase)) {
      errors.push(`禁止表現が含まれています: "${phrase}"`);
    }
  }

  // 8. 想定事例の明示（想定事例という文言があるのに明示がない場合は警告）
  if (/想定事例/.test(body) === false && /事例/.test(body)) {
    warnings.push('事例が含まれていますが「想定事例」と明示されているか確認してください');
  }

  // 9. title 長さ
  if (fm.title && fm.title.length > 80) {
    warnings.push(`title が長すぎます（${fm.title.length}文字）: 80文字以内推奨`);
  }

  // 10. summary 長さ
  if (fm.summary && fm.summary.length > 160) {
    warnings.push(`summary（meta description）が長すぎます（${fm.summary.length}文字）: 160文字以内推奨`);
  }

  return { file: rel, errors, warnings };
}

function main() {
  let files = process.argv.slice(2);
  if (files.length === 0) {
    if (!fs.existsSync(POSTS_DIR)) {
      console.log('content/posts/ ディレクトリがありません。');
      process.exit(0);
    }
    files = fs.readdirSync(POSTS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(POSTS_DIR, f));
  }

  let hasError = false;
  for (const file of files) {
    const result = validateFile(file);
    const hasIssue = result.errors.length > 0 || result.warnings.length > 0;
    if (!hasIssue) {
      console.log(`✓ ${result.file}`);
      continue;
    }
    console.log(`\n${result.file}`);
    for (const e of result.errors) {
      console.error(`  [ERROR] ${e}`);
      hasError = true;
    }
    for (const w of result.warnings) {
      console.warn(`  [WARN]  ${w}`);
    }
  }

  if (hasError) {
    console.error('\n品質チェック: エラーがあります。');
    process.exit(1);
  } else {
    console.log('\n品質チェック: OK');
  }
}

main();
