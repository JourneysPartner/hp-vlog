'use strict';

/**
 * 周辺処理（本文生成以外）の棚卸しと分類
 *
 * tier:
 *   A — 完全にルールベースでよい（API不要）
 *   B — ルールベース + 必要時だけ安価モデル
 *   C — 安価モデル向き
 *   D — 高品質モデルに残すべき（本文生成のみ）
 *
 * status:
 *   'rule_based_done' — 既にルールベースで実装済み
 *   'rule_based_todo' — ルールベース化可能だが未実装
 *   'needs_aux_model' — 安価モデルの採用を検討（API未決定）
 *   'content_model'   — 本文生成（Sonnet 4.6）
 *
 * impl: 実装場所（既存 or 想定）
 */

const AUX_TASKS = [
  {
    id: 'topic_primary_selection',
    label: 'テーマ候補の一次選定',
    tier: 'A',
    status: 'rule_based_done',
    impl: 'scripts/lib/topic-selector.js (selectDailyTopics)',
    note: 'scenario-expansion + cooldown + denylist + balance で決定論的に選定。API不要。',
  },
  {
    id: 'title_draft',
    label: 'title 案の作成',
    tier: 'B',
    status: 'rule_based_done',
    impl: 'scripts/lib/title-builder.js (buildTitle)',
    note: '軸からテンプレートで自然タイトル生成。仕上げの自然化を安価モデルに回す余地あり（B）。',
  },
  {
    id: 'title_lint',
    label: 'title lint',
    tier: 'A',
    status: 'rule_based_done',
    impl: 'scripts/lib/title-lint.js (lintTitle)',
    note: '禁止フレーズ・長さ・重複の検査。完全ルールベース。',
  },
  {
    id: 'frontmatter_fill',
    label: 'frontmatter 補完',
    tier: 'A',
    status: 'rule_based_done',
    impl: 'scripts/lib/scenario-expansion.js (buildTopic) / generate-draft.js',
    note: 'macro/cluster/subcluster/tax_domain/category を軸から決定論的に補完。',
  },
  {
    id: 'source_url_fill',
    label: 'source_url / source_title 補完',
    tier: 'A',
    status: 'rule_based_done',
    impl: 'scripts/lib/tax-authority-refs.js (getDefaultSourceForTopic)',
    note: 'tax_domain / pain_point → 国税庁URL のマッピング。完全ルールベース。',
  },
  {
    id: 'slug_generation',
    label: 'slug 生成',
    tier: 'A',
    status: 'rule_based_done',
    impl: 'scripts/lib/scenario-expansion.js (kebab + slugParts)',
    note: '軸から決定論的に kebab-case 生成。',
  },
  {
    id: 'category_persona_taxdomain_fill',
    label: 'category / persona / tax_domain 補完',
    tier: 'A',
    status: 'rule_based_done',
    impl: 'scripts/lib/cluster-taxonomy.js / scenario-expansion.js',
    note: 'TAX_DOMAIN_TO_CATEGORY 等のマッピングで補完。',
  },
  {
    id: 'main_support_pair_check',
    label: 'main/support ペアチェック',
    tier: 'A',
    status: 'rule_based_done',
    impl: 'scripts/lib/topic-selector.js (buildBestPair)',
    note: 'article_type から役割を決定し main+support を強制。',
  },
  {
    id: 'dup_similarity_cooldown_denylist',
    label: 'duplicate / similarity / cooldown / denylist 判定',
    tier: 'A',
    status: 'rule_based_done',
    impl: 'topic-similarity.js / cooldown.js / denylist.js / site-corpus.js',
    note: 'Jaccard 類似度・日数 cooldown・禁止リスト。完全ルールベース。',
  },
  {
    id: 'markdown_table_lint',
    label: 'Markdown 表の整形・検査',
    tier: 'A',
    status: 'rule_based_todo',
    impl: 'scripts/lib/markdown-table-lint.js（新規・本PRで追加）',
    note: 'GFM 表の区切り行・列数の整合を検査。整形まではルールベースで可能。',
  },
  {
    id: 'light_proofreading',
    label: '軽い校正（誤字・表記ゆれ）',
    tier: 'C',
    status: 'needs_aux_model',
    impl: '（API未決定）',
    note: '誤字・冗長表現の検出は安価モデルが向く。ルールベースは限界がある。',
  },
  {
    id: 'structure_check',
    label: '記事構造チェック（h2数・結論先出し等）',
    tier: 'A',
    status: 'rule_based_done',
    impl: 'scripts/generate-draft.js (selfCheckContent)',
    note: 'h2 数・テーブル有無・結論位置のヒューリスティック検査。',
  },
  {
    id: 'preflight_validate',
    label: 'validate 前の事前チェック（preflight）',
    tier: 'A',
    status: 'rule_based_todo',
    impl: 'scripts/lib/preflight-check.js（新規・本PRで追加）',
    note: 'frontmatter 必須項目・source_url・title lint・表 lint を生成直後に一括検査。',
  },
  {
    id: 'chatwork_message_format',
    label: 'Chatwork 通知文の整形',
    tier: 'A',
    status: 'rule_based_done',
    impl: 'netlify/functions/lib/notify/message.js',
    note: 'テンプレート文字列で整形。完全ルールベース。',
  },
  {
    id: 'article_body_generation',
    label: '本文生成',
    tier: 'D',
    status: 'content_model',
    impl: 'scripts/lib/content-model.js (generateContent / Sonnet 4.6)',
    note: '品質維持のため高品質モデル（Claude Sonnet 4.6）を使用。',
  },
];

function summary() {
  const byTier = { A: [], B: [], C: [], D: [] };
  for (const t of AUX_TASKS) (byTier[t.tier] = byTier[t.tier] || []).push(t.id);
  return byTier;
}

module.exports = { AUX_TASKS, summary };
