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

const { classifyRevision, extractSectionHint, RULES } = require('./revision-classifier');

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

// ── 漢字↔ひらがな等の表記揺れ正規化 ────────────────────────
// ユーザーが「この記事でわかること」と書いて記事が「この記事で分かること」
// だったときの取りこぼしを防ぐ。形態素解析は避け、よくある語彙を
// 単純テーブルで漢字→ひらがなに変換してから比較する。
// 動詞・形容詞のみ。「事」「物」「時」など単漢字の名詞は他の語の一部に
// 紛れ込むため変換しない（例: 「記事」→「記こと」になるのを避ける）。
// 送りがな付きの動詞・形容詞は語境界を持つので安全に変換できる。
const KANJI_TO_KANA_NORMALIZE = {
  '分かる': 'わかる', '分か': 'わか',
  '解る': 'わかる', '判る': 'わかる',
  '行う': 'おこなう', '行な': 'おこな',
  '出来る': 'できる', '出来': 'でき',
  '言う': 'いう', '言い': 'いい',
  '思う': 'おもう', '思い': 'おもい',
  '受け': 'うけ',
  '良い': 'よい', '善い': 'よい',
  '持つ': 'もつ', '持ち': 'もち',
  '起こ': 'おこ',
  '終わ': 'おわ', '始ま': 'はじま', '始め': 'はじめ',
  '考え': 'かんがえ', '答え': 'こたえ',
  '迷う': 'まよう', '迷い': 'まよい',
  '違う': 'ちがう', '違い': 'ちがい',
  '使う': 'つかう', '使い': 'つかい',
  '足す': 'たす', '足り': 'たり',
  '頂く': 'いただく', '頂き': 'いただき',
  '頷く': 'うなずく',
  '基づ': 'もとづ',
  '関わ': 'かかわ',
  '伴う': 'ともなう', '伴い': 'ともない',
  '備える': 'そなえる', '備え': 'そなえ',
  '揃う': 'そろう', '揃え': 'そろえ',
};

function normalizeForSectionMatch(s) {
  if (!s) return '';
  let n = String(s);
  for (const [k, h] of Object.entries(KANJI_TO_KANA_NORMALIZE)) {
    if (n.includes(k)) n = n.split(k).join(h);
  }
  return n;
}

// 簡易類似度: 双方向の文字集合重なり率（短い方の長さに対する共通文字数）
// 厳密な編集距離は重いため、3-gram の Jaccard を採用。
function fuzzyMatchRatio(a, b) {
  if (!a || !b) return 0;
  const toGrams = (s) => {
    const g = new Set();
    for (let i = 0; i + 2 <= s.length; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const ga = toGrams(a);
  const gb = toGrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return inter / union;
}

// ── コメントのヒントから対象セクションの index を推定 ───────────
// sectionHint（見出しキーワード）に最も近い見出しを探す。なければ -1。
// 3 段階で探索: 完全一致 → 表記揺れ正規化一致 → fuzzy（2-gram Jaccard）一致
function findTargetSectionIndex(sections, sectionHint, type) {
  if (sectionHint) {
    // 1. 厳密な includes 一致
    const idx = sections.findIndex(s => s.heading.includes(sectionHint));
    if (idx >= 0) return idx;

    // 2. 漢字↔ひらがな正規化後の一致（「分かる」vs「わかる」を救う）
    const normHint = normalizeForSectionMatch(sectionHint);
    const normIdx = sections.findIndex(s => normalizeForSectionMatch(s.heading).includes(normHint));
    if (normIdx >= 0) return normIdx;

    // 3. fuzzy（2-gram Jaccard）類似度 >= 0.5 のセクション
    let bestIdx = -1, bestRatio = 0;
    for (let i = 0; i < sections.length; i++) {
      const r = fuzzyMatchRatio(sections[i].heading, sectionHint);
      if (r > bestRatio) { bestRatio = r; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestRatio >= 0.5) return bestIdx;

    // h2 の照合をすべて優先した後、h3 でも同じ 3 段階で親の章を探す。
    const nested = sections.flatMap((s, sectionIndex) =>
      [...s.body.matchAll(/^###\s+(.+?)\s*$/gm)].map(m => ({
        heading: m[1], body: '', sectionIndex,
      })));
    if (nested.length) {
      const nestedIdx = findTargetSectionIndex(nested, sectionHint, '');
      if (nestedIdx >= 0) {
        const parentIndex = nested[nestedIdx].sectionIndex;
        if (type !== 'table_fix' || /\|.+\|/.test(sections[parentIndex].body)) return parentIndex;
      }
    }
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

function planRevisionSteps(split, sections) {
  const steps = [], sectionSteps = new Map(), classifications = [];
  let targeted, title;
  const preface = classifyRevision(split.preface);
  if (preface.denySuppression || (preface.type === 'full_regenerate' && preface.reason.startsWith('パターン一致:'))) {
    return { fallback: true, reason: `前置き: ${preface.reason}`, classifications };
  }
  if (preface.type === 'title_only') title = { kind: 'title', points: [], texts: [], classification: preface };
  for (const point of split.points) {
    let classification = classifyRevision(point.text);
    const text = point.text.replace(/\s+/g, ' ').trim();
    if (classification.type === 'full_regenerate' && !classification.denySuppression &&
        classification.reason === 'コメントが長く広範囲の修正と判断（120文字以上）' &&
        !RULES.some(rule => rule.patterns.some(pattern => pattern.test(text)))) {
      // 番号付きの一指摘が具体的で長い場合は、全文を渡して最小修正する。
      classification = { ...classification, type: 'factual_correction', scope: 'targeted',
        sectionHint: extractSectionHint(point.text),
        reason: '指摘が長い（複数の指摘の 1 つなので全文の最小修正）' };
    }
    classifications.push({ no: point.no, ...classification });
    if (classification.type === 'full_regenerate' || classification.denySuppression) {
      return { fallback: true, reason: `指摘 ${point.no}: ${classification.reason}`, classifications };
    }
    let step;
    if (classification.type === 'title_only') {
      step = title ||= { kind: 'title', points: [], texts: [], classification };
    } else if (classification.type === 'add_section') {
      step = { kind: 'add_section', points: [], texts: [], classification };
      steps.push(step);
    } else {
      const sectionIndex = classification.scope === 'section'
        ? findTargetSectionIndex(sections, classification.sectionHint, classification.type) : -1;
      if (sectionIndex >= 0) {
        if (!sectionSteps.has(sectionIndex)) sectionSteps.set(sectionIndex, {
          kind: 'section', sectionIndex, heading: sections[sectionIndex].heading,
          points: [], texts: [], classification,
        });
        step = sectionSteps.get(sectionIndex);
      } else {
        step = targeted ||= { kind: 'targeted', points: [], texts: [], classification };
      }
    }
    step.points.push(point.no);
    step.texts.push(point.text);
  }
  const ordered = [...sectionSteps.values()].sort((a, b) => a.sectionIndex - b.sectionIndex)
    .concat(steps, targeted || [], title || []);
  const notice = '（この段では、次の指摘だけを直します。ほかの指摘は別の段で直すので触れないでください。作業の説明・注記・「変更していません」などの断り書きを本文に書かないでください。）';
  return { fallback: false, classifications, steps: ordered.map(({ texts, ...step }) => ({
    ...step,
    instruction: `${notice}\n${split.preface || ''}\n\n${texts.join('\n\n')}`,
  })) };
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
// YAML double-quoted の完全エスケープ（バックスラッシュ・ダブルクォート・
// 改行・タブ）を行い、改行入り値が複数行 YAML として解釈されないようにする。
function replaceFmField(raw, key, value) {
  const m = raw.match(/^(---\r?\n)([\s\S]+?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!m) return raw;
  let fm = m[2];
  const re = new RegExp(`^(${key}:\\s*).*$`, 'm');
  const safe = String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\t/g, '\\t');
  if (re.test(fm)) fm = fm.replace(re, `$1"${safe}"`);
  else fm += `\n${key}: "${safe}"`;
  return m[1] + fm + m[3] + m[4];
}

// ── コメントから「新タイトルを直接指定している」かを抽出 ─────────
// パターン例:
//   「タイトルを「新」に変更して」
//   「タイトルの「旧」を「新」に変更して」
//   「タイトルを『新』に直して」
//   → 新タイトルを直接返す。マッチしなければ null。
//
// 既存タイトルとの一致確認用に、旧タイトルもあわせて返す（任意）。
function extractDirectTitleSwap(comment) {
  if (!comment) return null;
  const c = comment.replace(/\s+/g, ' ');

  // パターンA: 「タイトルの「旧」を「新」に(変更|直し|変え|...)」
  // 2 つ目の「...」を新タイトルとして採用する。
  const mPair = c.match(
    /タイトル[^「『]*[「『]([^」』]{2,80})[」』]\s*を\s*[「『]([^」』]{2,80})[」』]\s*に\s*(?:変更|変え|直し|つけ直|付け直|修正|して)/
  );
  if (mPair) {
    return { oldTitle: mPair[1].trim(), newTitle: mPair[2].trim(), source: 'pair' };
  }

  // パターンB: 「タイトル(を|は|の)[新]に(変更|直し|...)」
  // 1 つだけ「...」がある場合、それを新タイトルとして採用する。
  const mSingle = c.match(
    /タイトル[^「『]{0,20}(?:を|は|の|→)\s*[「『]([^」』]{2,80})[」』]\s*に?\s*(?:変更|変え|直し|つけ直|付け直|修正|して|でお願い)/
  );
  if (mSingle) {
    return { oldTitle: null, newTitle: mSingle[1].trim(), source: 'single' };
  }

  return null;
}

// ── コメントから「要約/サマリーの新旧」を直接指定しているかを抽出 ──
// パターン例:
//   「要約部分の「旧」を「新」に変更して」
//   「要約を「新」に変更して」
//   「サマリーの「旧」を「新」に直して」
// 戻り値: { oldSummary, newSummary, source } または null
//
// 重要: 「旧」と「新」が深さ 2 までネストした 「」 を含む場合に対応する
// （例: 「中古資産の耐用年数は「法定年数の20%＋経過年数×80%」」のような表記）
function extractDirectSummarySwap(comment) {
  if (!comment) return null;
  const c = comment.replace(/\s+/g, ' ');

  // 深さ 2 までのネストを許す quoted パターン:
  //   open 「 + (非ブラケット | バランス「..」)* + close 」
  // ${quoted} を 2 回使ってOLD/NEW を抽出。
  const quoted = `[「『]((?:[^「『」』]|[「『][^」』]*[」』])*)[」』]`;
  // 助詞「を」「に」前後の読点（、，,）と空白を許容
  const SEP = `[、，,\\s]*`;

  // パターンA: 「要約/サマリー」 ... 「OLD」 を 「NEW」 に 変更/直し/修正
  const reA = new RegExp(
    `(?:要約|サマリー|メタ説明)(?:部分)?[^「『]*${quoted}${SEP}を${SEP}${quoted}${SEP}に${SEP}(?:変更|変え|直し|つけ直|付け直|修正|して)`
  );
  const mA = c.match(reA);
  if (mA) {
    return { oldSummary: mA[1].trim(), newSummary: mA[2].trim(), source: 'pair' };
  }

  // パターンB: 「要約/サマリー」 を/は/の/→ 「NEW」 に 変更/直し/...
  const reB = new RegExp(
    `(?:要約|サマリー|メタ説明)(?:部分)?[^「『]{0,40}(?:を|は|の|→)${SEP}${quoted}${SEP}に?${SEP}(?:変更|変え|直し|つけ直|付け直|修正|して|でお願い)`
  );
  const mB = c.match(reB);
  if (mB) {
    return { oldSummary: null, newSummary: mB[1].trim(), source: 'single' };
  }

  return null;
}

// ── 部分修正プロンプト（title_only）────────────────────────────
function buildTitleOnlyPrompt(meta, comment) {
  // コメント内に新タイトルが直接書かれていれば、LLM に literal 適用を強く指示する。
  const direct = extractDirectTitleSwap(comment);
  const directHint = direct
    ? `\n\n【重要】差し戻しコメントに新タイトル候補「${direct.newTitle}」が明示されています。特段の理由がない限り、これを採用してください（句読点や記号の微調整は可）。`
    : '';

  // 禁止フレーズ（「今後使わない」と指定された語）はタイトルでも使わせない
  let bannedHint = '';
  try { bannedHint = require('./banned-phrases').formatTitleBannedForPrompt(); } catch { /* noop */ }

  return {
    system: 'あなたは日本の税理士事務所のブログ編集者です。記事タイトルとサマリーだけを、差し戻しコメントの指示に従って調整します。本文は変更しません。コメントで明示的に新タイトルが提示されている場合は原則それを採用します。禁止指定された語はタイトルにも使いません。',
    user: `以下の記事のタイトルとサマリーを、差し戻しコメントに沿って調整してください。
本文は一切変更しません。タイトルとサマリーのみを JSON で返してください。${directHint}${bannedHint}

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

// 出典本文ブロックをプロンプト末尾に差し込む形に整える。
// 事実誤認の差し戻し（factual_correction）では、LLM が記憶で数字や適用範囲を
// 補ってしまうのが誤りの主因だった（2026-08-14〜16 に3件）。通常生成には
// PR #404 で出典本文を渡すようにしたが、部分再生成の経路には渡していなかった。
// 「事実を直せ」という差し戻しこそ原文が必要なので、ここでも必ず添付する。
function sourceSection(sourceBlock) {
  const block = String(sourceBlock || '').trim();
  if (!block) return '';
  return `\n\n${block}`;
}

// ── 部分修正プロンプト（section スコープ）──────────────────────
// 対象セクションだけを渡し、そのセクションだけを返してもらう。
function buildSectionPrompt(meta, comment, section, classification, sourceBlock) {
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
${sourceSection(sourceBlock)}
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
${sourceSection(sourceBlock)}
表の指摘があれば GFM テーブル（| 列 | 列 | と |---|---| 区切り）で正しく整える。
見出しの階層は h2/h3 のみ。穏当な「です・ます」調。誇大表現禁止。`,
  };
}

// ── 部分修正プロンプト（targeted: 全文を渡し最小修正）──────────
// sourceBlock は本文より前に置く。本文は末尾に来るほど「これを全文ベースに出力」
// という指示と隣接し、出力が断片化しにくいため。
function buildTargetedPrompt(meta, comment, body, sourceBlock) {
  return {
    system: 'あなたは日本の税理士事務所のブログ編集者です。差し戻しコメントで指摘された箇所のみを最小限修正し、それ以外は元の文章をそのまま保ちます。本文を書き換えたり短くしたりしてはいけません。事実の修正は、添付された出典の本文だけを根拠に行い、記憶で数字や適用範囲を補ってはいけません。',
    user: `以下の記事本文を、差し戻しコメントで指摘された箇所だけ最小限修正してください。
指摘されていない箇所は元の文章をそのまま維持し、不要な書き換えはしないでください。
修正後の「本文 Markdown 全体」だけを返してください（frontmatter は出力しない）。

【絶対に守る制約】
1. **差し戻しコメントで指摘された文字列が本文中に見つからない場合、本文を一切変更せず、元の本文をそのまま全文出力すること**（勝手に新しい構成・新しい本文を作らない）。
2. **本文の章構成（## 見出し）・段落数・表・リストを変更しないこと**。コメントが文字列の置換のみを指示している場合は、その置換以外の変更を加えない。
3. **本文の総文字数は、元の本文の 80% 以上を必ず維持すること**（短縮や要約は禁止）。
4. **新しいタイトル・新しい章・ASCII アート・フローチャート図形を勝手に追加しないこと**。
5. 免責文と末尾の相談導線は元のまま維持すること。
6. **事実（数字・要件・適用範囲）を直す場合は、添付された出典の本文に書かれていることだけを根拠にすること**。出典の本文に無いことを「出典に明示されている」と書かない。

【差し戻しコメント】
${comment}
${sourceSection(sourceBlock)}

【記事本文（現状）— これを全文ベースに、指摘箇所のみ最小修正したものを出力】
${body}

穏当な「です・ます」調。誇大表現禁止。`,
  };
}

// ── 部分修正プロンプト（targeted のリトライ用、より厳格版）──────
// 1 回目で shrinkage が検出されたときに使う。プロンプトの最上部に
// 「前回失敗の通告 + 絶対遵守の出力フォーマット指示」を強化する。
function buildTargetedPromptRetry(meta, comment, body, prevOutputLen, origBodyLen, sourceBlock) {
  return {
    system: 'あなたは日本の税理士事務所のブログ編集者です。差し戻しコメントで指摘された箇所のみを最小限修正し、それ以外は元の文章をそのまま保ちます。指示が技術的に難しい・該当文字列が無い等の場合でも、必ず元の本文を全文そのまま出力すること。短縮・要約・拒否メッセージ・解説文の出力は厳禁です。',
    user: `【前回出力の問題】
前回の出力は ${prevOutputLen} 文字でした（元本文は ${origBodyLen} 文字）。
本文の 60% 未満まで縮小されたため、システムにより破棄されました。

【今回の指示】
以下の記事本文を、差し戻しコメントで指摘された箇所だけ最小限修正してください。
**修正できない・該当箇所が見つからない・指示が曖昧な場合も、必ず元本文を全文そのまま出力してください**。
「拒否メッセージ」「修正不能の説明文」「短い要約」「箇条書きだけ」を返してはいけません。

【絶対に守る出力フォーマット】
- 出力は必ず元本文の Markdown 全体である（${origBodyLen} 文字相当）
- 出力の冒頭は元本文の冒頭（## などの見出し）と一致する
- 出力の末尾は元本文の末尾（免責文・相談導線）と一致する
- frontmatter は出力しない

【絶対に守る制約】
1. 差し戻しコメントで指摘された文字列が本文中に見つからない場合、**本文を一切変更せず、元の本文をそのまま全文出力**する。
2. 章構成（## 見出し）・段落数・表・リストを変更しない。
3. 本文の総文字数は元本文の **90% 以上**（${Math.floor(origBodyLen * 0.9)} 文字以上）を必ず維持する。
4. 新しいタイトル・新しい章・ASCII アート・フローチャート・拒否メッセージ・解説文を勝手に追加しない。
5. 免責文と末尾の相談導線は元のまま維持する。
6. 事実（数字・要件・適用範囲）を直す場合は、添付された出典の本文に書かれていることだけを根拠にする。

【差し戻しコメント】
${comment}
${sourceSection(sourceBlock)}

【記事本文（現状）— これを全文ベースに、指摘箇所のみ最小修正したものを出力】
${body}

穏当な「です・ます」調。誇大表現禁止。`,
  };
}

// ── LLM が「検討過程」を本文の前に書いてしまう事故への対策 ───────
//
// 2026-08-21: ルール自動反映の出力が次のように始まっていた。
//   「差し戻しコメントで指摘された論点（…）を本文中で確認します。
//     該当箇所：…　より精査すると…　最小限加筆します。」
// これがそのまま記事の本文になった。
//
// 短縮ガードは縮んだときしか反応しないため、解説文が前に足されて
// 「増えた」ケースは素通りしていた。
//
// 記事の本文に絶対に現れない、作業指示側の語彙。
// 改行の分割用。エスケープ記法を避けて文字コードから組み立てる。
const NEWLINE_RE = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));

const INTERNAL_PROCESS_WORDS = [
  '差し戻しコメント', '論点別ルール', '参考資料に照らして', '最小限加筆',
  '最小限修正します', '誤記パターン', 'より精査すると', '本文中で確認します',
  '該当箇所：', '該当箇所:', '添付資料', '出典本文ブロック',
];

/**
 * 本文に作業指示側の語彙が混入していないか調べる。
 * @returns {{contaminated: boolean, words: string[]}}
 */
function findInternalProcessWords(body) {
  const s = String(body || '');
  const words = INTERNAL_PROCESS_WORDS.filter(w => s.includes(w));
  return { contaminated: words.length > 0, words };
}

function removeNewInternalNotes(before, after) {
  const original = String(before || ''), revised = String(after || '');
  const oldLines = new Set(original.split(/\r?\n/).map(line => line.trim()));
  const context = /差し戻し|コメント|ご指摘|ご依頼|ご指示|指示どおり|指示通り|指示に従|点目|指摘の[0-9０-９①-⑳]|指摘[0-9０-９①-⑳]|この段|別の段|ほかの指摘|他の指摘|ほかの箇所|他の箇所|その他の箇所|その他の指摘/;
  const result = /変更|修正|反映|対応|対象外|触れ|直し|そのまま/;
  const noteStart = /^(?:※|＊|\*(?![*\s])|注[:：]|（※|\(※|【注)/;
  const report = /(?:変更|修正|反映|対応|直し)(?:して(?:い)?ません|しました)|対象外|触れて(?:い)?ません/;
  const removed = [], remainingWords = [], lines = [];
  let removedGap = false;
  for (const line of revised.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!oldLines.has(trimmed)) {
      if (noteStart.test(trimmed) && report.test(trimmed)) {
        removed.push(line);
        removedGap = true;
        console.warn(`[revise] 作業の注記を除去（${line.length} 文字）: ${trimmed.slice(0, 40)}`);
        continue;
      }
      // 太字・箇条書きの論点列挙は、作業の報告でなければ本文として保持する。
      const articlePoint = /^(?:\*\*|\*\s+)[0-9０-９①-⑳]+点目/.test(trimmed) &&
        !report.test(trimmed) && !context.test(trimmed.replace(/[0-9０-９①-⑳]+点目/g, ''));
      if (!articlePoint && context.test(trimmed) && result.test(trimmed)) remainingWords.push(trimmed.match(context)[0]);
    }
    if (removedGap && !trimmed && lines.length && !lines[lines.length - 1].trim()) continue;
    lines.push(line);
    removedGap = false;
  }
  const newline = revised.includes('\r\n') ? '\r\n' : '\n';
  const body = removed.length ? lines.join(newline) : revised;
  const count = (text, word) => text.split(word).length - 1;
  const words = [...new Set([
    ...INTERNAL_PROCESS_WORDS.filter(word => count(body, word) > count(original, word)),
    ...remainingWords,
  ])];
  if (words.length) console.warn(`[revise] 作業の説明が混入: ${words.join('・')}`);
  return { body, removed, contaminated: words.length > 0, words };
}

/**
 * LLM が本文の前に付けた検討過程を取り除く。
 *
 * 元本文の書き出し（先頭の非空行）が、出力の途中から始まっている場合は
 * その前を捨てる。書き出しが見つからない場合は何もしない
 * （本文を作り替えている可能性があり、切り取ると壊すため）。
 */
function stripAnalysisPreamble(originalBody, revisedBody) {
  const orig = String(originalBody || '').trim();
  const rev = String(revisedBody || '').trim();
  if (!orig || !rev) return { body: rev, stripped: '' };

  const firstLine = (orig.split(NEWLINE_RE).find(l => l.trim().length > 0) || '').trim();
  if (firstLine.length < 12) return { body: rev, stripped: '' };

  const idx = rev.indexOf(firstLine);
  if (idx <= 0) return { body: rev, stripped: '' };

  const prefix = rev.slice(0, idx);
  // 前置きが長すぎる場合は、本文を作り替えている可能性があるので触らない。
  if (prefix.length > orig.length * 0.5) return { body: rev, stripped: '' };
  return { body: rev.slice(idx).trim(), stripped: prefix.trim() };
}

// ── セーフティチェック: LLM 出力が元本文より極端に短くないか ─────
// targeted scope は本文全体を入出力するため、LLM が混乱して本文を
// 大幅に削減/置換するリスクがある。新本文の長さが元の MIN_RATIO
// (デフォルト 0.6 = 60%) 未満なら不正出力と判定し、呼び出し側で
// 元本文を採用する判断材料を返す。
function isBodyShrinkageSuspicious(originalBody, newBody, minRatio = 0.6) {
  const orig = (originalBody || '').trim();
  const next = (newBody || '').trim();
  if (orig.length === 0) return false; // 元が空ならチェック不能
  const ratio = next.length / orig.length;
  if (ratio < minRatio) {
    return {
      suspicious: true,
      ratio,
      origLen: orig.length,
      newLen: next.length,
      reason: `本文長さ ${next.length}/${orig.length} = ${(ratio * 100).toFixed(0)}% (閾値 ${(minRatio * 100).toFixed(0)}%)`,
    };
  }
  // 章数（h2）の激減もチェック
  const origH2 = (orig.match(/^##\s+/gm) || []).length;
  const newH2  = (next.match(/^##\s+/gm) || []).length;
  if (origH2 >= 3 && newH2 < Math.ceil(origH2 * 0.5)) {
    return {
      suspicious: true,
      ratio,
      origLen: orig.length,
      newLen: next.length,
      reason: `h2 章数 ${newH2}/${origH2} = 半減未満`,
    };
  }
  return { suspicious: false, ratio };
}

module.exports = {
  splitSections,
  joinSections,
  findTargetSectionIndex,
  planRevisionSteps,
  applyTitleOnly,
  replaceFmField,
  extractDirectTitleSwap,
  extractDirectSummarySwap,
  buildTitleOnlyPrompt,
  sourceSection,
  buildSectionPrompt,
  buildTargetedPrompt,
  buildTargetedPromptRetry,
  isBodyShrinkageSuspicious,
  findInternalProcessWords,
  removeNewInternalNotes,
  stripAnalysisPreamble,
  INTERNAL_PROCESS_WORDS,
  normalizeForSectionMatch,
  fuzzyMatchRatio,
};
