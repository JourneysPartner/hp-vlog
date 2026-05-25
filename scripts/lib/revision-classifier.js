'use strict';

/**
 * 差し戻しコメント分類器
 *
 * 差し戻しコメントを解析し、再生成の範囲（修正タイプ）を判定する。
 * 目的: 軽微な修正で全文再生成（コスト大）を避け、部分修正に振り分ける。
 *
 * 修正タイプ:
 *   title_only            — タイトル/サマリーの言い回しだけ（本文は変えない）
 *   table_fix             — 表 / Markdown表 / 比較表の追加・修正
 *   add_section           — 新しい見出し（章）の追加
 *   section_only          — 特定の見出し/段落だけの修正
 *   intro_conclusion_fix  — 導入文・まとめだけの修正
 *   factual_correction    — 一部の事実関係・税務表現の修正
 *   full_regenerate       — 全体構成変更・テーマ変更・suppression
 *
 * scope（再生成範囲）:
 *   frontmatter — frontmatter のみ（title_only）
 *   section     — 本文の一部セクションのみ（table_fix / section_only / add_section / intro_conclusion_fix）
 *   targeted    — 本文全体を渡すが「指摘箇所のみ最小修正」（factual_correction）
 *   full        — 全文再生成（full_regenerate）
 *
 * detectDenyIntent（denylist 由来）で禁止意図があれば必ず full_regenerate にする。
 */

const { detectDenyIntent } = require('./denylist');

// パターン定義（上から優先度順に評価）
const RULES = [
  {
    type: 'full_regenerate',
    scope: 'full',
    // 全面的な書き直し / テーマ変更 / 構成変更
    patterns: [
      /全体的に(?:書き直|作り直|見直)/,
      /全部(?:書き直|作り直)/,
      /一から(?:書き直|作り直)/,
      /構成(?:を|から)(?:変え|見直|練り直)/,
      /記事の(?:方向性|趣旨|テーマ)(?:を|が)(?:変え|違)/,
      /別のテーマ/,
      /テーマ(?:を|が)(?:変え|違)/,
      /根本的に/,
    ],
  },
  {
    type: 'title_only',
    scope: 'frontmatter',
    patterns: [
      /タイトル(?:だけ|のみ)/,
      /タイトル.{0,12}(?:硬い|不自然|自然に|変え|直し|つけ直|見直)/,
      /(?:見出し|タイトル)が(?:硬い|長い|分かりにくい|わかりにくい)/,
      /サマリー(?:だけ|のみ|を直)/,
      /(?:メタ|meta).{0,8}(?:説明|description)(?:だけ|を直)/,
    ],
  },
  {
    type: 'table_fix',
    scope: 'section',
    patterns: [
      /表(?:に|で|を|が|の)/,
      /テーブル/,
      /比較表/,
      /一覧(?:表|に)/,
      /表形式/,
      /マークダウン.{0,4}表/i,
      /markdown.{0,4}(?:table|表)/i,
    ],
  },
  {
    type: 'add_section',
    scope: 'section',
    patterns: [
      /(?:章|見出し|セクション|項目|パート)(?:を)?(?:追加|足し|増やし|加え)/,
      /(?:も|を)(?:追加|入れて|加えて|盛り込)/,
      /(?:よくある誤解|具体例|事例|注意点|まとめ|手順).{0,8}(?:も|を)?(?:追加|入れて|加えて)/,
    ],
  },
  {
    type: 'intro_conclusion_fix',
    scope: 'section',
    patterns: [
      /(?:導入|リード|冒頭|書き出し)(?:文)?(?:だけ|を|が)/,
      /(?:まとめ|結論|結び|おわりに)(?:だけ|を|が)/,
      /最初の(?:段落|部分)/,
      /最後の(?:段落|部分)/,
    ],
  },
  {
    type: 'factual_correction',
    scope: 'targeted',
    patterns: [
      /(?:誤り|間違い|まちがい|誤字|事実誤認)/,
      /(?:正確|訂正|修正)(?:に|して)/,
      /(?:税率|金額|数字|年度|期限|要件)(?:が|を|の).{0,10}(?:違|誤|間違|正)/,
      /(?:法令|条文|通達|タックスアンサー).{0,10}(?:違|誤|正)/,
      /(?:事実|内容)(?:が|に).{0,6}(?:誤|違|正確でない)/,
    ],
  },
  {
    type: 'section_only',
    scope: 'section',
    patterns: [
      /この(?:章|見出し|部分|段落|セクション|表現|箇所)(?:だけ|のみ|を)/,
      /ここ(?:だけ|のみ|を)/,
      /(?:○○|特定)の(?:章|見出し|部分)/,
      /(?:この|その)(?:説明|記述)(?:だけ|を|が)/,
    ],
  },
];

/**
 * コメントから「対象セクションのヒント（見出し語）」を抽出する。
 * 「〜の章」「〜について」「〜の表」などからキーワードを拾う。
 */
function extractSectionHint(comment) {
  if (!comment) return '';
  const c = comment.replace(/\s+/g, ' ');
  // 「『...』の章」「「...」の見出し」「...について」など
  const quoted = c.match(/[「『]([^」』]{2,30})[」』]/);
  if (quoted) return quoted[1];
  const about = c.match(/([一-鿿ぁ-んァ-ヶA-Za-z0-9・]{2,20})(?:について|の章|の見出し|の部分|のセクション|の説明|の表)/);
  if (about) return about[1];
  return '';
}

/**
 * 差し戻しコメントを分類する。
 * @returns {Object} { type, scope, sectionHint, reason, denySuppression }
 */
function classifyRevision(comment) {
  const text = (comment || '').replace(/\s+/g, ' ').trim();

  // 0. 禁止意図（denylist）→ 必ず full_regenerate（suppression）
  if (detectDenyIntent(text)) {
    return {
      type: 'full_regenerate',
      scope: 'full',
      sectionHint: '',
      reason: '禁止意図を検出（topic suppression のため全文再生成扱い）',
      denySuppression: true,
    };
  }

  // 1. ルール順にマッチ判定
  for (const rule of RULES) {
    for (const re of rule.patterns) {
      if (re.test(text)) {
        return {
          type: rule.type,
          scope: rule.scope,
          sectionHint: rule.scope === 'section' || rule.scope === 'targeted'
            ? extractSectionHint(text)
            : '',
          reason: `パターン一致: ${re}`,
          denySuppression: false,
        };
      }
    }
  }

  // 2. どれにも当てはまらない軽微なコメント → targeted（最小修正）
  //    （全文再生成はコストが高いので、デフォルトは「指摘箇所のみ最小修正」に倒す）
  //    コメントが非常に長い/抽象的な場合は full に倒す
  if (text.length >= 120) {
    return {
      type: 'full_regenerate',
      scope: 'full',
      sectionHint: '',
      reason: 'コメントが長く広範囲の修正と判断（120文字以上）',
      denySuppression: false,
    };
  }

  return {
    type: 'factual_correction',
    scope: 'targeted',
    sectionHint: extractSectionHint(text),
    reason: 'デフォルト: 指摘箇所のみ最小修正（部分修正優先）',
    denySuppression: false,
  };
}

module.exports = {
  classifyRevision,
  extractSectionHint,
  RULES,
};
