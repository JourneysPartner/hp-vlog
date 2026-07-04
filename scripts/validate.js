'use strict';

/**
 * 記事品質チェックスクリプト
 * 使い方: node scripts/validate.js [ファイルパス ...]
 *         ファイル省略時は content/posts/*.md を全件チェック
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { checkSourceAlignment } = require('./lib/source-alignment');

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
  'general_individual_proprietor', 'general_corporation',
  // Phase 4 で追加した新カテゴリのペルソナ
  'youtuber', 'content_seller', 'construction_solo', 'retail_store', 'wholesale',
];

// ── article_type の許容値 ──────────────────────────────────────
const VALID_ARTICLE_TYPES = [
  'basic_explainer', 'comparison_decision', 'edge_case',
  'industry_example', 'filing_practice', 'misconception_fix', 'case_study',
];

// ── publish_slot の許容値 ──────────────────────────────────────
const VALID_PUBLISH_SLOTS = ['morning', 'evening'];

// ── source_type の許容値 ───────────────────────────────────────
// 通常記事は未設定 or 空文字。nta_shitsugi（質疑応答事例ベース）は条件付き必須項目あり。
// 将来 nta_taxanswer 等の追加を想定し配列で管理する。
const VALID_SOURCE_TYPES = ['', 'nta_taxanswer', 'nta_shitsugi'];

// ── nta_shitsugi 記事の条件付き必須フィールド ─────────────────
// `source_type === "nta_shitsugi"` の記事のみに適用される
const NTA_SHITSUGI_REQUIRED_FIELDS = [
  'source_url', 'source_title',
  'case_based', 'case_transformed',
  'case_transform_note', 'source_tax_category',
];

// ── nta_shitsugi 記事の本文必須キーワード（いずれか1つ以上）─────
const NTA_SHITSUGI_BODY_KEYWORDS = ['想定事例', '一般化した事例'];

// ── nta_shitsugi 記事の見出しに使ってはいけないラベル ──────────
// 国税庁原文の構造をなぞる印象を避ける
const NTA_SHITSUGI_FORBIDDEN_HEADINGS = ['照会要旨', '回答要旨'];

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

  // 4b. 出典一致（主論点と主出典の税目カテゴリが違う場合は警告）
  // 例: リバースチャージ記事に相続税ページ、相続税申告要否記事に贈与税ページ 等。
  // 既存記事をブロックしないよう、強い不一致（カテゴリ違い）のみ警告に留める。
  if (fm.source_url && (fm.pain_point || fm.tax_domain)) {
    const sa = checkSourceAlignment({ pain_point: fm.pain_point, tax_domain: fm.tax_domain, source_url: fm.source_url });
    if (sa.severity === 'hard') {
      warnings.push(`出典一致: ${sa.reason}。期待出典の例:「${sa.expectedTitle}」`);
    }
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

  // 11. source_type の許容値チェック
  // 通常記事は source_type 未設定 or 空文字。設定する場合は VALID_SOURCE_TYPES のいずれかであること。
  if (fm.source_type !== undefined && fm.source_type !== null) {
    if (!VALID_SOURCE_TYPES.includes(fm.source_type)) {
      warnings.push(`source_type が未定義の値: "${fm.source_type}"（許容値: ${VALID_SOURCE_TYPES.filter(Boolean).join(', ')}）`);
    }
  }

  // 12. nta_shitsugi 記事の条件付き必須フィールドチェック
  // source_type === "nta_shitsugi" のときに、定型 metadata と本文構造を検証する。
  // 通常記事には影響しない（後方互換性確保）。
  if (fm.source_type === 'nta_shitsugi') {
    // 12a. 必須フィールドの存在
    for (const field of NTA_SHITSUGI_REQUIRED_FIELDS) {
      const val = fm[field];
      // boolean フィールド（case_based / case_transformed）は true でないと NG
      if (field === 'case_based' || field === 'case_transformed') {
        if (val !== true) {
          errors.push(`nta_shitsugi 記事では ${field}: true が必須`);
        }
      } else {
        // 文字列フィールドは空文字 / undefined を NG
        if (!val || (typeof val === 'string' && val.trim() === '')) {
          errors.push(`nta_shitsugi 記事では ${field} が必須`);
        }
      }
    }

    // 12b. 本文に「想定事例」または「一般化した事例」のキーワードがあること
    const hasKeyword = NTA_SHITSUGI_BODY_KEYWORDS.some(k => body.includes(k));
    if (!hasKeyword) {
      errors.push(`nta_shitsugi 記事の本文に「想定事例」または「一般化した事例」の明示がありません`);
    }

    // 12c. 国税庁原文の構造をなぞる印象を避けるため、特定の見出しラベルを禁止
    for (const forbidden of NTA_SHITSUGI_FORBIDDEN_HEADINGS) {
      // h2/h3 見出しに含まれている場合のみ NG
      const headingRegex = new RegExp(`^#{2,3}\\s.*${forbidden}`, 'm');
      if (headingRegex.test(body)) {
        errors.push(`nta_shitsugi 記事の見出しに「${forbidden}」が使われています（国税庁原文の構造をなぞらないこと）`);
      }
    }

    // 12d. supporting_source_urls は設定されている場合 array であること
    if (fm.supporting_source_urls !== undefined && fm.supporting_source_urls !== null) {
      if (!Array.isArray(fm.supporting_source_urls)) {
        errors.push(`supporting_source_urls は配列である必要があります`);
      } else {
        // 各要素が URL として valid か
        for (const url of fm.supporting_source_urls) {
          try { new URL(url); }
          catch { errors.push(`supporting_source_urls に URL として不正な値: "${url}"`); }
        }
      }
    }

    // 12e. n-gram 転載検知（Phase D）
    // 国税庁原文と本文の連続 3 文一致を検出。FAIL 判定。
    // data/nta-sources/index.json が存在しない場合は警告に留める（DB 未構築環境への配慮）。
    try {
      const ngramCheck = require('./lib/nta-ngram-check');
      const ngramResult = ngramCheck.checkNgramOverlapForArticle(fm, body);
      if (!ngramResult.sourceFound) {
        warnings.push(`n-gram 転載検知: 国税庁ソース DB に対応する原文が見つかりませんでした（data/nta-sources/ 未構築の可能性）`);
      } else {
        for (const r of ngramResult.results) {
          if (r.matched) {
            for (const ov of r.overlaps) {
              const preview = ov.sentences.join(' ').slice(0, 80);
              errors.push(
                `n-gram 転載検知: ${r.url} と連続 ${ov.length} 文一致 ` +
                `（記事の文 ${ov.indexInArticle + 1} 以降）: "${preview}${preview.length >= 80 ? '...' : ''}"`
              );
            }
          }
        }
      }
    } catch (e) {
      warnings.push(`n-gram 転載検知でエラー: ${e.message}`);
    }
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
