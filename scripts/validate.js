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
  'source_url', 'summary', 'review_status',
];

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

  // 2. review_status の値
  if (fm.review_status && !VALID_STATUSES.includes(fm.review_status)) {
    errors.push(`review_status の値が不正: "${fm.review_status}"`);
  }

  // 3. primary_persona の値
  if (fm.primary_persona && !VALID_PERSONAS.includes(fm.primary_persona)) {
    warnings.push(`primary_persona が未定義の値: "${fm.primary_persona}"`);
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
