'use strict';

/**
 * 部分再生成ユーティリティ
 *
 * 差し戻し時に「全文再生成」を避け、修正タイプに応じて最小範囲だけ作り直す。
 *   - title_only           → frontmatter の title/summary だけ（本文は触らない）
 *   - section スコープ      → 対象 h2 セクションだけ抽出して差し替え／追加
 *   - targeted スコープ     → 本文全体を渡し「指摘箇所のみ最小修正」
 *   - full                 → 全文再生成（呼び出し側で既存ロジック）
 *
 * 本モジュールは「本文の分解・再合成」と「部分修正プロンプトの組み立て」だけを担い、
 * 実際の LLM 呼び出しは呼び出し側（generate-draft.js / content-model）に任せる。
 */

// ── 本文を h2（## ）単位のセクションに分割 ──────────────────────
// 戻り値: { intro, sections: [{ heading, body, raw }] }
//   intro: 最初の ## より前の導入部
function splitSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let intro = [];
  let cur = null;

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (cur) sections.push(cur);
      cur = { heading: m[1], headingLine: line, lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  if (cur) sections.push(cur);

  return {
    intro: intro.join('\n'),
    sections: sections.map(s => ({
      heading: s.heading,
      body: s.lines.join('\n'),
      raw: `${s.headingLine}\n${s.lines.join('\n')}`,
    })),
  };
}

// ── セクション配列を本文に再合成 ────────────────────────────────
function joinSections(intro, sections) {
  const parts = [];
  if (intro && intro.trim()) parts.push(intro.replace(/\s+$/, ''));
  for (const s of sections) {
    parts.push(`## ${s.heading}\n${s.body.replace(/^\s+/, '')}`.replace(/\s+$/, ''));
  }
  return parts.join('\n\n') + '\n';
}

// ── コメントのヒントから対象セクションの index を推定 ───────────
// sectionHint（見出しキーワード）に最も近い見出しを探す。なければ -1。
function findTargetSectionIndex(sections, sectionHint, type) {
  if (sectionHint) {
    // 見出しに hint を含むものを優先
    const idx = sections.findIndex(s => s.heading.includes(sectionHint));
    if (idx >= 0) return idx;
  }
  // intro_conclusion_fix の「まとめ/結論」系
  if (type === 'intro_conclusion_fix') {
    const idx = sections.findIndex(s => /まとめ|結論|おわり|最後に/.test(s.heading));
    if (idx >= 0) return idx;
  }
  // table_fix: 表が含まれている（または含むべき）セクションを優先
  if (type === 'table_fix') {
    const idx = sections.findIndex(s => /\|.+\|/.test(s.body));
    if (idx >= 0) return idx;
  }
  return -1;
}

// ── frontmatter の title/summary 等だけ差し替える（title_only）──
// LLM 出力（新 title / 新 summary）を受け取り、本文を保ったまま frontmatter を更新する。
function applyTitleOnly(originalRaw, { title, summary }, nowJST) {
  let out = originalRaw;
  if (title) {
    out = replaceFmField(out, 'title', title);
  }
  if (summary) {
    out = replaceFmField(out, 'summary', summary);
  }
  out = replaceFmField(out, 'updated_at', nowJST);
  out = replaceFmField(out, 'review_status', 'draft');
  out = replaceFmField(out, 'review_comment', '');
  return out;
}

// frontmatter フィールド置換（quote スタイル非依存、double quote で書き戻し）
function replaceFmField(raw, key, value) {
  const m = raw.match(/^(---\r?\n)([\s\S]+?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!m) return raw;
  let fm = m[2];
  const re = new RegExp(`^(${key}:\\s*).*$`, 'm');
  const safe = String(value).replace(/"/g, '\\"');
  if (re.test(fm)) fm = fm.replace(re, `$1"${safe}"`);
  else fm += `\n${key}: "${safe}"`;
  return m[1] + fm + m[3] + m[4];
}

// ── 部分修正プロンプト（title_only）────────────────────────────
function buildTitleOnlyPrompt(meta, comment) {
  return {
    system: 'あなたは日本の税理士事務所のブログ編集者です。記事タイトルとサマリーだけを、検索者が自然に検索しそうな表現に調整します。本文は変更しません。',
    user: `以下の記事のタイトルとサマリーを、差し戻しコメントを踏まえて自然な日本語に調整してください。
本文は一切変更しません。タイトルとサマリーのみを JSON で返してください。

【差し戻しコメント】
${comment}

【現在のタイトル】
${meta.title || ''}

【現在のサマリー】
${meta.summary || ''}

【出力（JSON のみ。コードブロック不要）】
{"title": "新しいタイトル", "summary": "新しいサマリー（120文字以内、具体的な結論を含む）"}`,
  };
}

// ── 部分修正プロンプト（section スコープ）──────────────────────
// 対象セクションだけを渡し、そのセクションだけを返してもらう。
function buildSectionPrompt(meta, comment, section, classification) {
  const isAdd = classification.type === 'add_section';
  const sys = 'あなたは日本の税理士事務所のブログライターです。記事の指定セクションだけを、差し戻しコメントに沿って改善します。記事全体は作り直しません。';

  if (isAdd) {
    return {
      system: sys,
      user: `以下の記事に、差し戻しコメントで求められた新しいセクション（## 見出し付き）を1つだけ作成してください。
既存セクションは出力しないでください。新セクションの Markdown だけを返してください（## 見出しから開始）。

【差し戻しコメント】
${comment}

【記事タイトル】${meta.title || ''}
【記事タイプ】${meta.article_type || ''}
【ターゲット読者】${meta.primary_persona || ''}

表が有効なら GFM テーブルで。穏当な「です・ます」調。誇大表現禁止。`,
    };
  }

  return {
    system: sys,
    user: `以下の記事セクションを、差し戻しコメントに沿って改善してください。
このセクション（## 見出し含む）だけを Markdown で返してください。他のセクションや frontmatter は出力しないでください。

【差し戻しコメント】
${comment}

【対象セクション（現状）】
## ${section.heading}
${section.body}

表の指摘があれば GFM テーブル（| 列 | 列 | と |---|---| 区切り）で正しく整える。
見出しの階層は h2/h3 のみ。穏当な「です・ます」調。誇大表現禁止。`,
  };
}

// ── 部分修正プロンプト（targeted: 全文を渡し最小修正）──────────
function buildTargetedPrompt(meta, comment, body) {
  return {
    system: 'あなたは日本の税理士事務所のブログ編集者です。差し戻しコメントで指摘された箇所のみを最小限修正し、それ以外は元の文章をできるだけ保ちます。',
    user: `以下の記事本文を、差し戻しコメントで指摘された箇所だけ最小限修正してください。
指摘されていない箇所は元の文章をできるだけ維持し、不要な書き換えはしないでください。
修正後の「本文 Markdown 全体」だけを返してください（frontmatter は出力しない）。

【差し戻しコメント】
${comment}

【記事本文（現状）】
${body}

穏当な「です・ます」調。誇大表現禁止。免責文と末尾の相談導線は維持すること。`,
  };
}

module.exports = {
  splitSections,
  joinSections,
  findTargetSectionIndex,
  applyTitleOnly,
  replaceFmField,
  buildTitleOnlyPrompt,
  buildSectionPrompt,
  buildTargetedPrompt,
};
