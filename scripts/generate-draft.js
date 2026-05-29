'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const { TOPICS } = require('./topic-pool');
const { selectDailyTopics } = require('./lib/topic-selector');
const { getRefsForTopic, formatRefsForPrompt, getDefaultSourceForTopic } = require('./lib/tax-authority-refs');
const { getChangesForTopic, formatChangesForPrompt } = require('./lib/tax-law-changes');
const { loadDenylist, findMatchingEntry, isTimeLimitedExpired, detectDenyIntent } = require('./lib/denylist');
const { classifyRevision } = require('./lib/revision-classifier');
const partial = require('./lib/partial-revise');
const { buildGenerationPrompt } = require('./lib/article-prompt-builder');
const contentModel = require('./lib/content-model');
const auxModel = require('./lib/aux-model');
const { normalizeGeneratedDraft } = require('./lib/draft-normalizer');

// ── トピックに必ず source_url / source_title を埋める fallback ─────
// validate.js は approved/scheduled/published 段階で source_url 空欄を ERROR にするため、
// 生成記事には必ず非空の出典を持たせる。scenario-expansion で対応済みだが、
// 念のため generate-draft でも二重防御する。
function ensureSourceOnTopic(topic) {
  if (!topic.source_url) {
    const def = getDefaultSourceForTopic(topic);
    topic.source_url   = def.url;
    topic.source_title = def.title;
  } else if (!topic.source_title) {
    topic.source_title = topic.source_url;
  }
  return topic;
}

// ── モデル定義（OpenAI GPT-5.4） ───────────────────────────────
const MODEL_STANDARD = process.env.OPENAI_MODEL || 'gpt-5.4';
const MODEL_HIGH     = process.env.OPENAI_MODEL_HIGH || 'gpt-5.4';

// ── ペルソナ定義 ─────────────────────────────────────────────────
const PERSONAS = [
  { id: 'ebay_export_seller',          label: 'eBay輸出セラー',               categories: ['消費税', 'インボイス', '海外取引'] },
  { id: 'domestic_ec_seller',          label: '国内EC物販セラー',              categories: ['消費税', 'インボイス', '帳簿・経費'] },
  { id: 'reseller_marketplace_seller', label: 'フリマ・転売セラー',            categories: ['所得税', '帳簿・経費', 'インボイス'] },
  { id: 'influencer_creator',          label: 'インフルエンサー・クリエイター', categories: ['所得税', '帳簿・経費', 'インボイス'] },
  { id: 'beauty_salon_owner',          label: '美容サロンオーナー',            categories: ['消費税', '所得税', '帳簿・経費'] },
  { id: 'inheritance_client',          label: '相続・贈与の依頼者',            categories: ['相続'] },
];

const PERSONA_MAP = Object.fromEntries(PERSONAS.map(p => [p.id, p]));

// ── ペルソナ別 相談導線（営業色を排し、自然な文脈で相談を促す）───
const CTA_MAP = {
  ebay_export_seller:          '輸出免税や消費税還付は取引形態によって判断が分かれるケースが多く、お一人で判断に迷われた際は税理士にご相談いただくと安心です。毛利順活税理士事務所では、eBayセラーの税務相談を承っております。',
  domestic_ec_seller:          '仕入税額控除の要件や帳簿の付け方は、取扱商品や販売チャネルによって異なります。「自分のケースではどうなるか」を確認したい場合は、税理士への相談がおすすめです。',
  reseller_marketplace_seller: 'せどり・転売の税務は、取引量が増えるほど判断が複雑になります。確定申告の時期に慌てないためにも、早めに税理士に相談しておくと安心です。',
  influencer_creator:          '広告収入・PR案件・海外プラットフォームからの入金など、収入源が多岐にわたる場合は税務処理も複雑になりがちです。不安な点があれば、税理士に相談してみてください。',
  beauty_salon_owner:          'サロン経営では、開業届から日々の記帳、消費税の届出判断まで、段階ごとに異なる税務対応が必要です。「今の自分に必要な手続きは何か」を整理したい方は、お気軽にご相談ください。',
  inheritance_client:          '相続税は、財産の種類や相続人の状況によって計算方法や特例の適用が大きく変わります。「うちの場合はどうなるか」を知りたい方は、早めに税理士へご相談されることをおすすめします。',
};

// ── 記事タイプ別の構成指示と目安文字数 ─────────────────────────
const ARTICLE_TYPE_INSTRUCTIONS = {
  basic_explainer: `この記事は「基本解説」タイプです（本命記事）。
【必須要素】
1. 制度の正式名称・根拠法令の明示（例：「消費税法第7条に基づく輸出免税」）
2. 全体像を示す構造図（箇条書きまたはテーブルで関係性を可視化）
3. 専門用語には初出時に括弧書きで平易な説明を必ず添える
4. 要件・計算方法・手続きを順序立てて体系的に解説
5. 「そもそも○○とは」→「誰が対象か」→「何をすればよいか」の順で構成
6. 読者が「自分に該当するか」をセルフチェックできる判定フローまたはチェックリスト
【構成の注意】
- 冒頭で結論（この制度で何ができるか/何をすべきか）を1〜2文で示す
- 原則を先に述べ、例外は後から補足する
- 「誰にとっての記事か」を冒頭で明示する`,

  comparison_decision: `この記事は「比較・判断」タイプです（本命記事）。
【必須要素】
1. 比較対象の明確な定義（各選択肢の正式名称・概要）
2. 比較表（GFMテーブル形式で、項目・メリット・デメリット・適用条件を整理）
3. 具体的な数値シミュレーション（売上○万円の場合にどちらが有利か）
4. 「どちらを選ぶべきか」の判断フローチャート（条件分岐を明示）
5. 判断を誤った場合のリスク・修正手続きの説明
【構成の注意】
- 冒頭で「この記事を読めば、○○と△△のどちらが自分に合うか判断できます」と明示
- 比較は対等に扱い、片方に誘導しない
- 読者の売上規模・事業形態別に推奨パターンを提示する`,

  edge_case: `この記事は「判断に迷うケース」タイプです（補強記事）。
【必須要素】
1. 「原則」の簡潔な説明（3行以内で要約。詳細は本命記事に委ねる）
2. 例外・グレーゾーンとなる具体的な条件パターン（2〜3パターン）
3. 各パターンの【想定事例】を明記した具体シナリオ
4. 「こう判断する」の根拠（通達・FAQ・実務慣行の引用）
5. 判断に迷った場合の対処法（専門家相談の推奨、書類準備のアドバイス）
【構成の注意】
- 冒頭で「○○の原則は理解しているが、△△のケースで迷っている方向けの記事です」と明示
- 各パターンは独立した小見出し（h3）で区切る
- 「結論が人によって異なる」ことを正直に伝え、判断材料を提供する`,

  industry_example: `この記事は「業種別具体例」タイプです（補強記事）。
【必須要素】
1. この業種の典型的な取引フロー・ビジネスモデルの簡潔な説明
2. 業界特有の用語と税務用語の対応表（テーブル形式）
3. この業種ならではの税務論点（他業種との違いを強調）
4. 実際の取引に即した仕訳例・計算例（数値を含む）
5. この業種で特に多い失敗パターンと対策
【構成の注意】
- 冒頭で対象読者の業種を明示し、「あなたの業種特有の論点をまとめました」と伝える
- 業界用語はそのまま使い、税務用語との対応を括弧書きで補足
- 一般論の解説は最小限に留め、この業種に特化した情報に集中する`,

  filing_practice: `この記事は「申告実務」タイプです（補強記事）。
【必須要素】
1. 手続き全体のタイムライン（テーブルまたはステップ形式で時系列整理）
2. 必要書類の一覧（チェックリスト形式、入手先も記載）
3. 「いつまでに」「何を」「どこに」提出するかの明確な整理
4. よくある記入ミス・提出漏れの具体例と防止策
5. 期限に遅れた場合のペナルティと救済措置
【構成の注意】
- 冒頭で「この記事では○○の申告・届出手続きを時系列で整理します」と明示
- 時系列に沿って「準備期間→書類作成→提出→事後確認」の順で構成
- 各ステップで「ここで間違えやすいポイント」を付記する`,

  misconception_fix: `この記事は「よくある誤解」タイプです（補強記事）。
【必須要素】
1. 冒頭で「○○と思っていませんか？」と誤解を提示
2. 誤解が生じる原因・背景の説明（なぜ多くの人がそう思うのか）
3. 正しい理解の根拠（法令・通達の引用）
4. 誤解のまま対応した場合の具体的なリスク（金額例を含む）
5. 正しい対応手順のステップバイステップ説明
【構成の注意】
- 「誤解 → 正解 → 根拠 → リスク → 正しい対応」の順で構成
- 読者を責めるトーンにせず、「よくある誤解なので確認しましょう」と寄り添う
- 誤解と正解を対比する表を含めると効果的`,

  case_study: `この記事は「ケーススタディ」タイプです（補強記事）。
【必須要素】
1. 【想定事例】と冒頭に明記した具体的な設定（人物像・事業内容・金額）
2. 数値を含む詳細な計算過程（ステップごとに分解して表示）
3. 計算結果のまとめ表（テーブル形式）
4. 条件が異なる場合の結果変動シミュレーション（「もし○○だったら」）
5. 事例から得られる教訓・実務ポイントのまとめ
【構成の注意】
- 「これは想定事例であり、実在する個人・法人とは関係ありません」と明記
- 計算過程は省略せず、読者が自分で再計算できる粒度で示す
- 最後に「自分のケースとの違い」を確認するためのチェックポイントを記載`,
};

// ── 記事タイプ別の目安文字数 ─────────────────────────────────────
const WORD_COUNT_GUIDE = {
  basic_explainer:     '1600〜2600文字',
  comparison_decision: '2000〜3200文字',
  edge_case:           '1200〜1800文字',
  industry_example:    '1200〜2000文字',
  filing_practice:     '2000〜3200文字',
  misconception_fix:   '1200〜1800文字',
  case_study:          '1500〜2500文字',
};

// ── 記事タイプ別の必須要素チェックリスト（内部ロジック）──────────
const ARTICLE_TYPE_CHECKLIST = {
  basic_explainer: [
    'この記事が答える疑問',
    '冒頭の結論',
    '制度の基本',
    '対象者',
    'よくある誤解',
    '実務上の注意点',
    '相談が必要になる境目',
  ],
  comparison_decision: [
    '冒頭の結論',
    '比較表',
    '判断軸',
    'どちらが向くか',
    '例外や注意点',
    '実務での選び方',
  ],
  edge_case: [
    'ケース設定',
    '条件分岐',
    'どこで結論が変わるか',
    '確認すべき事実や証憑',
    '間違えやすい点',
  ],
  industry_example: [
    '業種特有の事情',
    '一般論との違い',
    '具体例',
    '実務上の注意点',
  ],
  filing_practice: [
    '実務フロー',
    '必要書類',
    '保存資料',
    'ミスしやすい点',
    '相談が必要な場面',
  ],
  misconception_fix: [
    '誤解されやすい言い方',
    '何が違うか',
    '正しい考え方',
    '実務上の扱い',
  ],
  case_study: [
    '事例設定',
    '論点',
    '判断の流れ',
    '処理方法',
    '同様ケースへの注意点',
  ],
};

// ── 生成後の自己点検（軽量なヒューリスティック）────────────────
function selfCheckContent(content, articleType, slug) {
  const m = content.match(/^---\r?\n[\s\S]+?\r?\n---\r?\n([\s\S]*)$/);
  const body = m ? m[1] : content;
  const warnings = [];

  const h2Count = (body.match(/^## /gm) || []).length;
  if (h2Count < 3) {
    warnings.push(`h2見出しが${h2Count}個（3個以上推奨）`);
  }

  const hasTable = /\|.+\|/.test(body) && /\|[-:]+\|/.test(body);
  const tableRecommended = ['comparison_decision', 'filing_practice', 'case_study'];
  if (tableRecommended.includes(articleType) && !hasTable) {
    warnings.push(`${articleType} タイプにはテーブルの使用を推奨`);
  }

  if (articleType === 'case_study' && !/想定事例/.test(body)) {
    warnings.push('case_study タイプには【想定事例】の明記を推奨');
  }

  if (articleType === 'misconception_fix' && !/思っていませんか|誤解/.test(body)) {
    warnings.push('misconception_fix タイプには冒頭の誤解提示を推奨');
  }

  const hasConclusion = /^## /.test(body) &&
    (body.indexOf('結論') < 500 || body.indexOf('まとめると') < 500 ||
     body.indexOf('ポイントは') < 500 || body.indexOf('答えは') < 500);
  if (!hasConclusion && body.length > 200) {
    warnings.push('冒頭500文字以内に結論・要点の記載を推奨');
  }

  // ── リスク数値表現の検知（ハルシネーション抑止用 flag）─────────────
  // L2/L3 該当: 業種別/区分別/年度別の具体数値が、対応する出典 ref（国税庁
  // タックスアンサー No.XXXX）を本文に併記せずに書かれているケースを検出。
  // 検出 = ブロックではなく **警告のみ**（人間レビューに委ねる）。
  const numericRisks = detectRiskyNumericClaims(body);
  if (numericRisks.length > 0) {
    warnings.push(
      `具体数値の出典不足の可能性 (${numericRisks.length} 件): 業種別/区分別/年度別の数値に対応する国税庁 No.XXXX が近接していません`
    );
    for (const r of numericRisks.slice(0, 5)) {
      warnings.push(`  - ${r.phrase}（行 ${r.line}）`);
    }
  }

  if (warnings.length > 0) {
    console.warn(`[self-check] ${slug}: ${warnings.length} 件の改善推奨事項`);
    for (const w of warnings) {
      console.warn(`[self-check]   - ${w}`);
    }
  } else {
    console.log(`[self-check] ${slug}: OK`);
  }
  return warnings;
}

// ── リスク数値表現の検知 ─────────────────────────────────────────
// L2: 「第○種事業は X%」「小売業は X%」「卸売業は X%」など業種・区分別の率
// L3: 「令和X年から X 円」「X年から基礎控除 X 万円」など改正値
// 検出した数値表現の近傍（前後 ~200 字）に「No.XXXX」（タックスアンサー番号）
// または明示的な出典 URL がない場合のみ warning として返す。
function detectRiskyNumericClaims(body) {
  const PATTERNS = [
    // 業種別みなし仕入率パターン
    /(?:第[一二三四五六]種事業|卸売業|小売業|製造業|飲食店業|サービス業|不動産業)[はが]?\s*\d{1,3}\s*[%％]/g,
    // 「みなし仕入率 X%」「源泉徴収率 X%」など
    /(?:みなし仕入率|源泉徴収率|還付率|軽減税率)\s*(?:は|が|＝)?\s*\d{1,3}\s*[%％]/g,
    // 改正値: 「令和X年から〜X円」「X年改正後〜X万円」
    /令和\d+年(?:から|以後|度)?[\s\S]{0,30}?\d{1,4}\s*(?:円|万円|％|%)/g,
    /\d{1,4}\s*年(?:改正|度)[\s\S]{0,30}?\d{1,4}\s*(?:円|万円|％|%)/g,
  ];
  const lines = body.split(/\r?\n/);
  const results = [];
  for (const re of PATTERNS) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(body)) !== null) {
      const matched = m[0];
      const idx = m.index;
      // 近傍 ±200 字に出典マークがあるか
      const ctxStart = Math.max(0, idx - 200);
      const ctxEnd   = Math.min(body.length, idx + matched.length + 200);
      const context  = body.slice(ctxStart, ctxEnd);
      const hasSource =
        /No\.\s*\d{3,4}/.test(context) ||         // タックスアンサー番号
        /nta\.go\.jp/.test(context) ||             // 国税庁ドメイン
        /国税庁(?:タックスアンサー|公式)?/.test(context.replace(matched, '')) ||
        /[消所相贈]?税法第\d+条/.test(context);     // 法令条文
      if (!hasSource) {
        // 行番号を概算
        const upto = body.slice(0, idx);
        const line = (upto.match(/\n/g) || []).length + 1;
        results.push({ phrase: matched, line });
      }
    }
  }
  // 重複除去
  const uniq = [];
  const seen = new Set();
  for (const r of results) {
    const key = `${r.phrase}@${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  return uniq;
}

// ── 関連記事リンクテキスト（相手の記事タイプに応じた導線文言）────
const RELATED_LINK_TEXTS = {
  basic_explainer:     '基本から確認したい方はこちら',
  comparison_decision: '比較・判断のポイントはこちら',
  edge_case:           '判断に迷うケースについてはこちら',
  industry_example:    '業種別の具体例はこちら',
  filing_practice:     '申告実務の注意点はこちら',
  misconception_fix:   'よくある誤解と正しい理解はこちら',
  case_study:          '具体的な事例で確認するにはこちら',
};

// ── モデル選択ロジック ──────────────────────────────────────────
function resolveModel(topic) {
  const args = process.argv.slice(2);

  if (args.includes('--high-quality')) {
    return { model: MODEL_HIGH, reason: '--high-quality フラグ' };
  }

  const modelIdx = args.indexOf('--model');
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    return { model: args[modelIdx + 1], reason: `--model フラグ` };
  }

  if (process.env.OPENAI_MODEL) {
    return { model: process.env.OPENAI_MODEL, reason: '環境変数 OPENAI_MODEL' };
  }

  if (topic.quality === 'high') {
    return { model: MODEL_HIGH, reason: `テーマ quality=high（自動判定）` };
  }

  return { model: MODEL_STANDARD, reason: 'デフォルト' };
}

// ── 既存記事のスラグ一覧を取得 ──────────────────────────────────
function getExistingSlugs() {
  if (!fs.existsSync(POSTS_DIR)) return new Set();
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const slugs = new Set();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const m = raw.match(/^slug:\s*"?([^"\n\r]+)"?/m);
    if (m) slugs.add(m[1].trim());
  }
  return slugs;
}

// ── 直近の差し戻しコメントを収集 ────────────────────────────────
function getRecentRevisionComments(limit = 3) {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  const comments = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const status  = (raw.match(/^review_status:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    const comment = (raw.match(/^review_comment:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
    if (status === 'needs_revision' && comment) {
      const updated = (raw.match(/^updated_at:\s*"?([^"\n\r]+)"?/m) || [])[1] || '';
      comments.push({ file, comment, updated });
    }
  }
  comments.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  return comments.slice(0, limit);
}

// ── ペアグループから未使用ペアを選択 ────────────────────────────
//
// 新しい選定ロジック (lib/topic-selector) を使用する。
// 旧 pickPair() は削除し、selectDailyTopics() に一本化。
//
// selectDailyTopics() は以下を行う:
//   1. 既存slug除外（site-corpus全体）
//   2. cooldown フィルタ（subcluster 90日 / cluster 45日 / persona×category 21日）
//   3. 類似度フィルタ（slug/title/intent をJaccardで計算、閾値0.55）
//   4. カテゴリ偏り是正（直近7日で大分類が60%超ならハードブロック）
//   5. 本命+補強のペアリング（pair_group優先、なければ異cluster組合せ）
//   6. 同日2本の最終類似度チェック
function pickPair(dateStr) {
  const { picks, explanation } = selectDailyTopics(TOPICS, { now: new Date() });
  // 選定ログを表示（運用での偏り確認用）
  console.log('[generate] === topic selection ===');
  for (const step of explanation.steps) {
    console.log(`[generate] ${step.step}:`, JSON.stringify({
      remaining: step.remaining, blocked: step.blocked,
    }));
  }
  if (explanation.macroRatios14 || (explanation.steps.find(s => s.macroRatios14))) {
    const ratios = explanation.steps.find(s => s.macroRatios14);
    if (ratios) {
      const r14 = Object.entries(ratios.macroRatios14)
        .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`)
        .join(' ');
      console.log(`[generate] 直近14日 macro比率: ${r14}`);
    }
  }
  if (explanation.warnings) {
    for (const w of explanation.warnings) console.warn(`[generate] ⚠ ${w}`);
  }
  if (explanation.picks) {
    for (const p of explanation.picks) {
      console.log(`[generate] picked: ${p.slug} (${p.macro}/${p.cluster}, ${p.persona}, ${p.article_role})`);
    }
  }
  if (picks.length === 0) {
    console.warn('[generate] テーマプールを全て使い切りました。topic-pool.js への追加を検討してください。');
    // 最終フォールバック: ハッシュで選ぶ
    const hash = [...dateStr].reduce((a, c) => a + c.charCodeAt(0), 0);
    return [TOPICS[hash % TOPICS.length]];
  }
  return picks;
}

// ── JST の今日の日付文字列 (YYYY-MM-DD) ─────────────────────────
function getTodayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// ── テンプレートベース生成（APIキー未設定時フォールバック）────────
function generateFromTemplate(dateStr, topic, pairedTopic) {
  const now     = new Date().toISOString();
  const persona = PERSONA_MAP[topic.persona];
  const cta     = CTA_MAP[topic.persona] || 'ご不明な点がございましたらお気軽にご相談ください。';
  const articleType = topic.article_type || 'basic_explainer';
  const mainTypes = new Set(['basic_explainer', 'comparison_decision']);
  const articleRole = mainTypes.has(articleType) ? 'main' : 'support';

  const sourceBlock = topic.source_url
    ? `source_url: "${topic.source_url}"\nsource_title: "${topic.source_title}"`
    : `source_url: ""\nsource_title: ""`;

  const relatedSlug      = pairedTopic ? pairedTopic.slug : '';
  const relatedTitle     = pairedTopic ? pairedTopic.title : '';
  const relatedLinkText  = pairedTopic ? (RELATED_LINK_TEXTS[pairedTopic.article_type] || 'あわせて読みたい') : '';

  return `---
title: "${topic.title}"
slug: "${topic.slug}"
category: "${topic.category}"
primary_persona: "${topic.persona}"
secondary_persona: ""
article_type: "${articleType}"
article_role: "${articleRole}"
related_slug: "${relatedSlug}"
related_title: "${relatedTitle}"
related_link_text: "${relatedLinkText}"
${sourceBlock}
search_intent: "${topic.search_intent || ''}"
reader_problem: "${topic.reader_problem || ''}"
success_outcome: "${topic.success_outcome || ''}"
primary_question: "${topic.primary_question || ''}"
macro: "${topic.macro || ''}"
cluster: "${topic.cluster || ''}"
subcluster: "${topic.subcluster || ''}"
tax_domain: "${topic.tax_domain || ''}"
business_stage: "${topic.business_stage || ''}"
life_stage: "${topic.life_stage || ''}"
pain_point: "${topic.pain_point || ''}"
procedure_stage: "${topic.procedure_stage || ''}"
summary: "${persona.label}向けに、${topic.category}の基本と実務上の注意点を解説します。"
review_status: "draft"
review_comment: "テンプレートから自動生成された下書きです。内容の加筆・修正が必要です。"
approved_at: ""
publish_at: ""
published_at: ""
pr_number: ""
preview_url: ""
created_at: "${now}"
updated_at: "${now}"
---

## はじめに

${persona.label}の方にとって、${topic.category}は事業運営に直結する重要なテーマです。本記事では、${topic.hint}について、基本的な考え方と実務上のポイントを整理します。

なお、個別の事情によって取り扱いが異なる場合がありますので、具体的な判断は税理士等の専門家にご確認ください。

## ${topic.category}の基本的な考え方

${topic.hint}について、まず押さえておきたい基本事項を解説します。

<!-- TODO: 国税庁等の公的情報を根拠に、具体的な制度説明を加筆してください -->

## 実務上の注意点

${persona.label}が${topic.category}に対応する際、特に注意したいポイントを整理します。

- 届出や申告の期限を確認し、余裕を持って準備を進めること
- 帳簿や証拠書類を日頃から整理しておくこと
- 判断に迷う場合は、早めに専門家に相談すること

<!-- TODO: テーマに即した具体的な注意点に差し替えてください -->

## まとめ

本記事では、${persona.label}向けに${topic.category}の基本と実務上の注意点を解説しました。制度の詳細や個別の事情への対応については、税理士等の専門家への相談をおすすめします。

${cta}

毛利順活税理士事務所では、初回のご相談を無料で承っております。お気軽にお問い合わせください。

---

本記事は情報提供を目的として作成しており、特定の税務判断を推奨するものではありません。実際の税務処理・申告については、税理士等の専門家にご相談ください。個別事情によって結論が異なる場合があります。
`;
}

// ── 標準免責事項ブロック ─────────────────────────────────────────
const DISCLAIMER_BLOCK = `\n\n---\n\n本記事は情報提供を目的として作成しており、特定の税務判断を推奨するものではありません。実際の税務処理・申告については、税理士等の専門家にご相談ください。個別事情によって結論が異なる場合があります（免責事項）。\n`;

function ensureDisclaimer(content) {
  const m = content.match(/^---\r?\n[\s\S]+?\r?\n---\r?\n([\s\S]*)$/);
  const body = m ? m[1] : content;
  const hasDisclaimer =
    /本記事は.{0,30}情報提供/.test(body) ||
    /免責/.test(body) ||
    /個別事情/.test(body);
  if (hasDisclaimer) return content;
  console.warn('[generate] 免責事項が検出できなかったため自動補完します');
  return content.replace(/\s*$/, '') + DISCLAIMER_BLOCK;
}

const BANNED_REPLACEMENTS = [
  [/必ず節税/g,    '節税につながる場合があります'],
  [/絶対安心/g,    '安心につながります'],
  [/確実に節税/g,  '節税につながる場合があります'],
  [/100%節税/g,    '節税につながる場合があります'],
  [/受賞歴/g,      '実績'],
  [/最優秀/g,      '高い評価'],
  [/No\.1税理士/g, '税理士'],
];
function sanitizeBannedPhrases(content) {
  let out = content;
  for (const [re, rep] of BANNED_REPLACEMENTS) {
    if (re.test(out)) {
      console.warn(`[generate] 禁止表現を置換: ${re}`);
      out = out.replace(re, rep);
    }
  }
  return out;
}

function postProcess(content) {
  return ensureDisclaimer(sanitizeBannedPhrases(content));
}

// ── OpenAI クライアント生成 ─────────────────────────────────────
function createOpenAIClient() {
  const _sdk = require('openai');
  const OpenAI = _sdk.default || _sdk.OpenAI || _sdk;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function extractText(completion) {
  const choice = completion && completion.choices && completion.choices[0];
  if (!choice) return '';
  if (choice.message && typeof choice.message.content === 'string') {
    return choice.message.content;
  }
  if (choice.message && Array.isArray(choice.message.content)) {
    return choice.message.content.map(p => (typeof p === 'string' ? p : p.text || '')).join('');
  }
  return '';
}

// ── 本文生成（content-model 経由。Sonnet 4.6 / 失敗時 OpenAI gpt-5.4）────
// strictFormat=true で「---開始・コードブロック禁止・h2 3個以上」を強く指示する。
async function generateWithOpenAI(dateStr, topic, pairedTopic, strictFormat) {
  const now     = new Date().toISOString();
  const persona = PERSONA_MAP[topic.persona];
  const cta     = CTA_MAP[topic.persona] || 'ご不明な点がございましたらお気軽にご相談ください。';
  const articleType = topic.article_type || 'basic_explainer';
  const mainTypes = new Set(['basic_explainer', 'comparison_decision']);
  const articleRole = mainTypes.has(articleType) ? 'main' : 'support';

  const sourceInstruction = topic.source_url
    ? `- 出典として「${topic.source_title}」（${topic.source_url}）を参照すること`
    : '- このテーマは公的URLが未指定です。source_url / source_title は空文字のまま出力してください。本文中で根拠を示す場合は「国税庁によると」等の一般的な表現に留めてください';

  // 国税庁タックスアンサー / 関連レファレンス（必要な場合に優先して参考にする）
  const ntaRefs = getRefsForTopic(topic, 4);
  const ntaRefsBlock = ntaRefs.length > 0
    ? `\n\n═══ 関連する国税庁タックスアンサー / 公式情報（必要に応じて参考）═══\n以下は本テーマに関連しうる国税庁タックスアンサー等の公式情報です。\n必ずすべてを引用する必要はありませんが、原則確認・誤解整理・税目典型論点では優先的に参考にしてください。\nタックスアンサー番号は捏造せず、ここに掲載のものか確実に存在するもののみ記載すること。\n${formatRefsForPrompt(ntaRefs)}`
    : '';

  // 近年の税法改正論点（テーマが影響範囲なら参考にする。無理に書かない）
  const lawChanges = topic.freshness_sensitive ? getChangesForTopic(topic, 2) : [];
  const lawChangesBlock = lawChanges.length > 0
    ? `\n\n═══ 近年の改正・制度変更で参考になる論点 ═══\n本テーマは改正論点と関係がある可能性があります。読者の実務に影響しうる場合に限り、現行ルールと改正点を区別して触れてください。\n（"最新ニュースだから書く" のではなく、"読者の判断に影響するから書く" を基準に取り上げ要否を判断すること）\n${formatChangesForPrompt(lawChanges)}`
    : '';

  const typeInstruction = ARTICLE_TYPE_INSTRUCTIONS[articleType] || '';

  const wordCount = WORD_COUNT_GUIDE[articleType] || '1000〜1500文字';
  const roleLabel = articleRole === 'main' ? '本命記事' : '補強記事';
  const checklist = ARTICLE_TYPE_CHECKLIST[articleType] || [];

  const searchIntent   = topic.search_intent || '';
  const readerProblem  = topic.reader_problem || '';
  const successOutcome = topic.success_outcome || '';
  const primaryQuestion = topic.primary_question || '';

  const systemPrompt = `あなたは日本の税理士事務所（毛利順活税理士事務所）のブログライターです。
${persona.label}が実務で直面する税務上の疑問に答える、検索意図に合った独自価値のある記事を書いてください。

═══ 最上位ルール ═══
この記事の目的は「記事の量産」ではなく「読者の検索意図に正確に応え、独自の価値を提供すること」です。
記事は、検索順位を取るためだけではなく、特定の悩みを持つ見込み客が判断・行動しやすくなるために作るものです。
SEOはその結果として取りにいきます。単なる言い換えや薄い量産記事は禁止です。

以下の順で優先してください:
1. 読者が検索した疑問に直接答える
2. 他のサイトにはない具体性・実務性を提供する
3. 結果として「この税理士事務所に相談してみよう」と思わせる

═══ 企画メタ情報（この記事の設計意図）═══
検索意図: ${searchIntent || '（テーマから推測してください）'}
読者の課題: ${readerProblem || '（テーマから推測してください）'}
読後の成功状態: ${successOutcome || '（テーマから推測してください）'}
中心疑問: ${primaryQuestion || '（テーマから推測してください）'}

═══ 記事の役割: ${roleLabel} ═══
${articleRole === 'main'
  ? `この記事は「本命記事」です。
- このテーマの入口・全体像を提供する記事です
- 原則・基本ルールを網羅的に解説してください
- 補強記事で掘り下げる例外・応用には深入りせず、基本の理解を優先してください`
  : `この記事は「補強記事」です。
- 本命記事では扱いきれない例外・応用・具体例を深掘りする記事です
- 原則の説明は最小限（3行以内の要約）に留め、すぐに本題に入ってください
- 「原則は理解している読者」を想定し、応用的な内容に集中してください`}

═══ 記事タイプ別の構成指示 ═══
${typeInstruction}

═══ 記事タイプの必須要素チェックリスト ═══
この記事タイプ（${articleType}）では、以下の要素を必ず本文に含めてください:
${checklist.map((item, i) => `${i + 1}. ${item}`).join('\n')}

═══ 出典・根拠の引用ルール ═══
以下の優先順位で根拠を示してください:
1. 国税庁タックスアンサー（No.XXXX形式で番号を明記。必要な場合に優先して参考にする）
2. 法令・通達（条文番号を明記。例：「消費税法第7条」「所得税法第37条第1項」）
3. 国税庁公式ページ・パンフレット・e-Tax手続案内
4. 自社の実務観点による整理・解説（「実務上の一般的な取り扱いとして」等、根拠の強さを明示）

タックスアンサー活用の位置づけ:
- 「必ず全記事で使う」ものではなく、「必要な場合に優先して参考にする」
- 原則確認・制度の基本整理・よくある誤解の確認・税目ごとの典型論点の洗い出しには有力に使う
- 業種別具体例・実務フロー・ケース判断では、無理に毎回タックスアンサーに寄せなくてよい
- 番号は正確に記載し、存在しない番号を捏造しないこと
- 不確かな場合は番号を省略し、「国税庁のウェブサイトで確認できます」と案内すること

出典の禁止事項:
- タックスアンサーの要約や言い換えだけで記事を作ること
- 見出しだけ焼き直すこと
- 原則だけで終わること（必ず例外・実務上の注意・相談の境目を加えること）
${sourceInstruction}${ntaRefsBlock}${lawChangesBlock}

═══ コンテンツ構成ルール ═══
1. 結論ファースト: 冒頭で「この記事で分かること」「結論」を1〜2文で示す
2. 対象読者の明示: 「誰にとっての記事か」を冒頭で明確にする
3. 原則→例外の順序: 原則を先に述べ、例外は後から補足する
4. 実務メモ: 税理士ならではの実務上の注意点・コツを随所に挟む（「実務上は○○に注意が必要です」）
5. 相談の目安: 「自分で判断できる範囲」と「専門家に相談すべき範囲」の境界を示す
6. テーブルの活用: 比較・一覧・チェックリスト・計算結果は積極的にGFMテーブルで表現する

═══ SEOルール ═══
- summary（meta description）は「○○を解説します」のような曖昧な文言ではなく、記事の結論や具体的な情報を含む文にすること
- h2見出しにはテーマのキーワードを自然に含めること
- 見出しの階層は h2 → h3 の順で使い、h1 は使わないこと（テンプレート側で自動出力）
- 記事タイトルと内容に乖離がないこと

═══ 顧客獲得ルール ═══
- 記事の主目的は「情報提供」であり、営業色を出さないこと
- 記事の終盤またはまとめ部分で、以下を自然に示すこと:
  - 自力で進めやすいケース
  - 専門家に相談した方がよいケース
  - 相談すると何が整理できるか
- 「税理士に相談すべきケース」は、記事の文脈の中で自然に言及する（専用セクションを作らない）
- 本文中で「当事務所では〜」「弊所では〜」等の自己PRは一切行わない
- 免責事項の後に置く相談導線のみが唯一の営業接点とする
- 目的は問い合わせを無理に増やすことではなく、相談すべき読者が自然に相談しやすくなること

═══ 文体・トーン ═══
- 税理士事務所として穏当で信頼感のある文体にすること
- 「です・ます」調で統一すること
- 読者（${persona.label}）に直接語りかける視点で書くこと
- 他のペルソナ（他業種）の話題には触れず、このペルソナに集中すること

═══ 禁止事項 ═══
- 誇大表現（「必ず節税」「絶対安心」「確実に節税」「100%節税」等）は使用禁止
- 「受賞歴」「最優秀」「No.1税理士」等の自称・権威付けは禁止
- 断定を避け、「〜の場合があります」「〜が一般的です」等の穏当な表現を使うこと
- 事実（法令・通達）と解釈（実務上の判断）を混同しないこと
- 本文中に他の記事への直接リンクは挿入しないこと（関連記事の導線はサイト側で自動生成します）

═══ 末尾の必須要素 ═══
- 記事末尾に必ず以下の免責事項ブロックを含めること（文言は変更しない）:
  「本記事は情報提供を目的として作成しており、特定の税務判断を推奨するものではありません。実際の税務処理・申告については、税理士等の専門家にご相談ください。個別事情によって結論が異なる場合があります。」
- 免責事項の後に、以下の相談導線を自然に入れること（営業色を排した文脈で）:
  「${cta}」
  「毛利順活税理士事務所では、初回のご相談を無料で承っております。お気軽にお問い合わせください。」

═══ 記事のヒント ═══
${topic.hint}`;

  const revisions = getRecentRevisionComments(3);
  let revisionHint = '';
  if (revisions.length > 0) {
    const items = revisions.map(r => `- ${r.comment}`).join('\n');
    revisionHint = `\n\n過去の記事で以下のレビュー指摘がありました。同様の問題を避けてください:\n${items}`;
  }

  // 強い形式指定（retry 時）。frontmatter はシステム側で再構築するが、
  // 本文の構造崩れ（h2 不足・前置き混入）を防ぐために明示する。
  if (strictFormat) {
    revisionHint += `\n\n═══ 出力フォーマット厳守（必須）═══
- 出力は必ず frontmatter の \`---\` から開始する
- コードブロック（\`\`\`）で全体を囲まない
- frontmatter と Markdown 本文以外の説明文・前置きを書かない
- 本文には h2（## ）見出しを3個以上含める
${ARTICLE_TYPE_CHECKLIST[topic.article_type] && (topic.article_type === 'comparison_decision' || topic.article_type === 'filing_practice' || topic.article_type === 'case_study')
  ? '- この記事タイプでは GFM テーブル（| 列 | 列 | と |---|---|）を必ず1つ以上含める'
  : ''}`;
  }

  const sourceUrl      = topic.source_url || '';
  const sourceTitle    = topic.source_title || '';
  const relatedSlug    = pairedTopic ? pairedTopic.slug : '';
  const relatedTitle   = pairedTopic ? pairedTopic.title : '';
  const relatedLinkText = pairedTopic ? (RELATED_LINK_TEXTS[pairedTopic.article_type] || 'あわせて読みたい') : '';

  const userPrompt = `以下の条件でブログ記事の下書きを1本作成してください。

テーマ: ${topic.title}
ターゲット読者: ${persona.label}
カテゴリ: ${topic.category}
記事タイプ: ${articleType}
記事の役割: ${roleLabel}${revisionHint}

【記事作成前の計画（出力には含めない）】
記事を書き始める前に、以下を内部的に整理してから執筆してください:
1. 検索意図: 「${searchIntent || topic.title}」— この疑問に直接答えているか？
2. 読者の課題: 「${readerProblem || '（テーマから推測）'}」— この迷いを解消できているか？
3. 読後の成功状態: 「${successOutcome || '（テーマから推測）'}」— この状態に導けているか？
4. 必須要素チェック: ${checklist.join(' / ')} — すべて本文に含められるか？
5. テーブルを使って整理すべき情報はあるか？
6. 自力で進めやすいケースと、専門家に相談すべきケースの境目を自然に示せているか？

以下の形式でそのまま出力してください（コードブロック不要）:

---
title: "${topic.title}"
slug: "${topic.slug}"
category: "${topic.category}"
primary_persona: "${topic.persona}"
secondary_persona: ""
article_type: "${articleType}"
article_role: "${articleRole}"
related_slug: "${relatedSlug}"
related_title: "${relatedTitle}"
related_link_text: "${relatedLinkText}"
source_url: "${sourceUrl}"
source_title: "${sourceTitle}"
search_intent: "${searchIntent}"
reader_problem: "${readerProblem}"
success_outcome: "${successOutcome}"
primary_question: "${primaryQuestion}"
macro: "${topic.macro || ''}"
cluster: "${topic.cluster || ''}"
subcluster: "${topic.subcluster || ''}"
tax_domain: "${topic.tax_domain || ''}"
business_stage: "${topic.business_stage || ''}"
life_stage: "${topic.life_stage || ''}"
pain_point: "${topic.pain_point || ''}"
procedure_stage: "${topic.procedure_stage || ''}"
summary: "（記事の結論や具体的な情報を含む自然な文章。120文字以内。「○○を解説します」のような曖昧な表現ではなく、読者が検索結果で見て「これが知りたかった」と思える内容にすること）"
review_status: "draft"
review_comment: ""
approved_at: ""
publish_at: ""
published_at: ""
pr_number: ""
preview_url: ""
created_at: "${now}"
updated_at: "${now}"
---

（Markdown本文 ${wordCount}）`;

  // 本文生成は content-model 経由（CONTENT_MODEL_PROVIDER=anthropic なら
  // Claude Sonnet 4.6 + prompt caching、失敗時は OpenAI gpt-5.4 に fallback）。
  // 固定ルールは article-prompt-static の STATIC_RULES（キャッシュ対象）に集約。
  // userPrompt/systemPrompt の従来文面はフォールバック互換のため温存しつつ、
  // builder の中間表現を主経路にする。
  const promptIR = buildGenerationPrompt({
    topic, persona, cta, articleType, articleRole,
    ntaRefsBlock, lawChangesBlock, revisionHint,
    relatedSlug, relatedTitle, relatedLinkText, now,
  });
  const result = await contentModel.generateContent(promptIR, { maxTokens: 4096 });
  // raw を返す（frontmatter 正規化は呼び出し側 generateArticle で行う）。
  // provider/model は content-model がログ出力済み。
  return { raw: result.text || '', provider: result.provider, model: result.model };
}

// ── 新規記事を生成し、frontmatter を保証して返す（retry 付き）─────
// 1. 本文生成（content-model）
// 2. normalizeGeneratedDraft で frontmatter をシステム側から再構築
// 3. 本文 h2 が0個など形式異常なら、strictFormat で1回だけ再生成
// 4. それでも h2 が0個なら本文をそのまま採用（frontmatter は保証済みなので validate は通る）
async function generateArticle(dateStr, topic, pairedTopic) {
  const now = new Date().toISOString();
  let gen = await generateWithOpenAI(dateStr, topic, pairedTopic, false);
  let normalized = normalizeGeneratedDraft(postProcess(gen.raw), topic, { now, pairedTopic });

  if (normalized.bodyH2Count === 0) {
    console.warn(`[generate] 本文に h2 見出しが0個（形式異常の可能性）→ strictFormat で1回再生成`);
    try {
      gen = await generateWithOpenAI(dateStr, topic, pairedTopic, true);
      const retryNorm = normalizeGeneratedDraft(postProcess(gen.raw), topic, { now, pairedTopic });
      if (retryNorm.bodyH2Count > 0) {
        normalized = retryNorm;
        console.log('[generate] 再生成で h2 見出しを確保しました');
      } else {
        console.warn('[generate] 再生成後も h2 が0個。frontmatter は保証済みのため本文をそのまま採用します');
        normalized = retryNorm;
      }
    } catch (e) {
      console.warn(`[generate] strictFormat 再生成失敗（${e.message}）→ 初回結果を使用`);
    }
  }

  if (normalized.hadFrontmatter === false) {
    console.log('[generate] LLM出力に frontmatter が無かったため topic metadata から構築しました');
  }
  if (normalized.bodyH2Count < 3) {
    console.warn(`[self-check] h2 見出しが ${normalized.bodyH2Count} 個（3個以上推奨）`);
  }
  return { content: normalized.content, provider: gen.provider, model: gen.model, h2: normalized.bodyH2Count };
}

// ── 既存記事の frontmatter をパースする ─────────────────────────
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w[\w_]*):\s*"?([^"]*)"?\s*$/);
    if (m) meta[m[1]] = m[2];
  }
  return { meta, body: match[2] };
}

// ── 差し戻し対応の再生成 (OpenAI API) ──────────────────────────────
async function regenerateWithOpenAI(existingContent, comment, modelId) {
  const client = createOpenAIClient();

  const { meta, body: existingBody } = parseFrontmatter(existingContent);
  const persona = PERSONA_MAP[meta.primary_persona] || { label: meta.primary_persona || '' };
  const cta     = CTA_MAP[meta.primary_persona] || 'ご不明な点がございましたらお気軽にご相談ください。';
  const now     = new Date().toISOString();
  const articleType = meta.article_type || 'basic_explainer';
  const articleRole = meta.article_role || 'main';

  const sourceInstruction = meta.source_url
    ? `- 出典として「${meta.source_title || ''}」（${meta.source_url}）を参照すること`
    : '- source_url / source_title は空文字のまま出力してください';

  const typeInstruction = ARTICLE_TYPE_INSTRUCTIONS[articleType] || '';

  const wordCount = WORD_COUNT_GUIDE[articleType] || '1000〜1500文字';
  const roleLabel = articleRole === 'main' ? '本命記事' : '補強記事';
  const checklist = ARTICLE_TYPE_CHECKLIST[articleType] || [];

  const searchIntent    = meta.search_intent || '';
  const readerProblem   = meta.reader_problem || '';
  const successOutcome  = meta.success_outcome || '';
  const primaryQuestion = meta.primary_question || '';

  const systemPrompt = `あなたは日本の税理士事務所（毛利順活税理士事務所）のブログライターです。
差し戻しコメントを踏まえて記事を改善してください。改善時も以下のルールを遵守すること。

═══ 最上位ルール ═══
この記事の目的は「読者の検索意図に正確に応え、独自の価値を提供すること」です。
差し戻しで別テーマの記事に変えてはいけません。検索意図・対象読者・記事の役割を維持したまま改善してください。

═══ 企画メタ情報（維持すべき設計意図）═══
検索意図: ${searchIntent || '（元の記事テーマから維持）'}
読者の課題: ${readerProblem || '（元の記事テーマから維持）'}
読後の成功状態: ${successOutcome || '（元の記事テーマから維持）'}
中心疑問: ${primaryQuestion || '（元の記事テーマから維持）'}

═══ 記事の役割: ${roleLabel} ═══
${articleRole === 'main'
  ? '本命記事として、テーマの入口・全体像を網羅的に提供してください。'
  : '補強記事として、原則の説明は最小限に留め、例外・応用・具体例の深掘りに集中してください。'}

${typeInstruction}

═══ 必須要素チェックリスト ═══
${checklist.map((item, i) => `${i + 1}. ${item}`).join('\n')}

═══ 出典・根拠の引用ルール ═══
引用の優先順位: 1. タックスアンサー（No.XXXX、必要な場合に優先参考） 2. 法令・通達 3. 国税庁公式ページ 4. 実務観点の整理
タックスアンサー番号は正確に記載し、不確かな場合は番号を省略すること。
出典の単なる言い換えや原則だけで終わることは禁止。
${sourceInstruction}

═══ コンテンツ構成ルール ═══
- 結論ファースト: 冒頭で結論を1〜2文で示す
- 原則→例外の順序で構成する
- 実務上の注意点を随所に挟む
- テーブルを積極的に活用する
- 自力で進めやすいケースと専門家に相談すべきケースの境目を自然に示す

═══ 文体・トーン ═══
- 税理士事務所として穏当で信頼感のある「です・ます」調
- 読者（${persona.label}）に直接語りかける視点
- 誇大表現・自称・権威付けは禁止
- 断定を避け、穏当な表現を使うこと

═══ 禁止事項 ═══
- 本文中に他の記事への直接リンクは挿入しないこと
- 本文中で「当事務所では〜」等の自己PRは行わないこと
- 事実と解釈を混同しないこと

═══ 末尾の必須要素 ═══
- 免責事項: 「本記事は情報提供を目的として作成しており、特定の税務判断を推奨するものではありません。実際の税務処理・申告については、税理士等の専門家にご相談ください。個別事情によって結論が異なる場合があります。」
- 相談導線: 「${cta}」
  「毛利順活税理士事務所では、初回のご相談を無料で承っております。お気軽にお問い合わせください。」

═══ 差し戻し再生成の注意 ═══
- コメントで指摘された箇所を重点的に修正すること
- 指摘されていない部分の品質も記事タイプの必須要素チェックリストに照らして改善すること
- 修正の際に記事全体の論理的一貫性が保たれるよう注意すること`;

  const userPrompt = `以下のブログ記事に対して、レビュー担当者から差し戻しがありました。
コメントの内容を踏まえて、記事を改善してください。

【差し戻しコメント】
${comment}

【現在の記事】
${existingBody.substring(0, 3000)}

【記事情報】
タイトル: ${meta.title || ''}
ターゲット読者: ${persona.label}
カテゴリ: ${meta.category || ''}
記事タイプ: ${articleType}
記事の役割: ${roleLabel}

【改善前の確認（出力には含めない）】
1. 差し戻しコメントの指摘は具体的にどの部分に関するか？
2. 必須要素チェック: ${checklist.join(' / ')} — すべて本文に含まれているか？
3. 出典・根拠は適切に引用されているか？
4. テーブルで整理すべき情報はあるか？
5. 自力で進めやすいケースと専門家に相談すべきケースの境目が示せているか？

改善した記事を、以下の形式でそのまま出力してください（コードブロック不要）:

---
title: "${meta.title || ''}"
slug: "${meta.slug || ''}"
category: "${meta.category || ''}"
primary_persona: "${meta.primary_persona || ''}"
secondary_persona: "${meta.secondary_persona || ''}"
article_type: "${articleType}"
article_role: "${articleRole}"
related_slug: "${meta.related_slug || ''}"
related_title: "${meta.related_title || ''}"
related_link_text: "${meta.related_link_text || ''}"
source_url: "${meta.source_url || ''}"
source_title: "${meta.source_title || ''}"
search_intent: "${searchIntent}"
reader_problem: "${readerProblem}"
success_outcome: "${successOutcome}"
primary_question: "${primaryQuestion}"
summary: "（記事の結論や具体的情報を含む要約。120文字以内。曖昧な表現を避けること）"
review_status: "draft"
review_comment: ""
approved_at: ""
publish_at: ""
published_at: ""
pr_number: "${meta.pr_number || ''}"
preview_url: "${meta.preview_url || ''}"
created_at: "${meta.created_at || now}"
updated_at: "${now}"
---

（改善した Markdown 本文 ${wordCount}）`;

  // full_regenerate も content-model 経由（Sonnet 4.6 / 失敗時 OpenAI gpt-5.4）。
  // 差し戻し再生成は per-article 指示が多いため cache 効果は限定的だが provider 統一のため使用。
  const regenResult = await contentModel.generateSimple(
    { system: systemPrompt, user: userPrompt }, { maxTokens: 4096 });
  const raw = regenResult.text || '';
  const fenced = raw.match(/^```(?:markdown|yaml|md)?\n([\s\S]+)\n```\s*$/m);
  return postProcess((fenced ? fenced[1] : raw).trim());
}

// ── シンプルな system/user プロンプトでモデルを呼ぶ（部分再生成用）──
// 本文に直結する部分修正（section / targeted / title_only）は品質維持のため
// content-model（本文 provider = Sonnet 4.6、失敗時 OpenAI gpt-5.4 fallback）を使う。
async function callSimpleOpenAI({ system, user }, maxTokens) {
  const result = await contentModel.generateSimple({ system, user }, { maxTokens });
  return (result.text || '').trim();
}

// ── 部分再生成: title_only（本文を保持し title/summary だけ更新）──
async function regenerateTitleOnly(existingContent, comment) {
  const { meta } = parseFrontmatter(existingContent);

  // ① コメントに新タイトルが明示されていれば、LLM を呼ばず直接置換する。
  //    これは最も信頼でき、ユーザー意図を取りこぼさない。
  const direct = partial.extractDirectTitleSwap(comment);
  if (direct && direct.newTitle && direct.newTitle.length >= 4 && direct.newTitle.length <= 120) {
    let finalTitle = direct.newTitle;
    const cur = meta.title || '';
    // 旧タイトル指定が現タイトルの一部（例: 「｜初動を整理」のような suffix を伴う）なら、
    // suffix/prefix を保持したまま該当部分のみ置換する。
    if (direct.oldTitle && cur && cur.includes(direct.oldTitle) && cur !== direct.oldTitle) {
      finalTitle = cur.replace(direct.oldTitle, direct.newTitle);
      console.log(`[regenerate] title_only: 部分一致 → サフィックス/プレフィックスを保持して置換 → "${finalTitle}"`);
    } else {
      console.log(`[regenerate] title_only: コメントから新タイトルを直接抽出 → "${finalTitle}"`);
    }
    const now = new Date().toISOString();
    return partial.applyTitleOnly(
      existingContent,
      { title: finalTitle, summary: meta.summary }, // summary は据え置き
      now,
    ).replace(/\s*$/, '\n').trimEnd() + '\n';
  }

  // ② 明示指定が無ければ LLM に整文してもらう（既存ロジック）。
  const { system, user } = partial.buildTitleOnlyPrompt(meta, comment);
  const raw = await callSimpleOpenAI({ system, user }, 512);
  // JSON 抽出
  let title = meta.title, summary = meta.summary;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.title)   title = parsed.title;
      if (parsed.summary) summary = parsed.summary;
    }
  } catch (e) {
    console.warn(`[regenerate] title_only JSON 解析失敗 → 元タイトル維持: ${e.message}`);
  }
  const now = new Date().toISOString();
  return partial.applyTitleOnly(existingContent, { title, summary }, now).replace(/\s*$/, '\n').trimEnd() + '\n';
}

// ── 部分再生成: section（対象セクションのみ差し替え／追加）──────
async function regenerateSection(existingContent, comment, classification) {
  const { meta, body } = parseFrontmatter(existingContent);
  const { intro, sections } = partial.splitSections(body);

  if (classification.type === 'add_section') {
    // 新セクションを生成して末尾（まとめの前）に挿入
    const { system, user } = partial.buildSectionPrompt(meta, comment, null, classification);
    const newSection = postProcessBodyOnly(await callSimpleOpenAI({ system, user }, 2048));
    // まとめセクションがあればその前に、なければ末尾に追加
    const concludeIdx = sections.findIndex(s => /まとめ|結論|おわり/.test(s.heading));
    const parsedNew = partial.splitSections(newSection).sections[0] ||
      { heading: '補足', body: newSection };
    if (concludeIdx >= 0) sections.splice(concludeIdx, 0, parsedNew);
    else sections.push(parsedNew);
    const newBody = partial.joinSections(intro, sections);
    return rebuildWithBody(existingContent, newBody);
  }

  // 既存セクションの差し替え
  const idx = partial.findTargetSectionIndex(sections, classification.sectionHint, classification.type);
  if (idx < 0) {
    // 対象が特定できない → targeted にフォールバック（全文最小修正）
    console.warn('[regenerate] 対象セクション特定不可 → targeted にフォールバック');
    return regenerateTargeted(existingContent, comment);
  }
  const { system, user } = partial.buildSectionPrompt(meta, comment, sections[idx], classification);
  const revisedRaw = postProcessBodyOnly(await callSimpleOpenAI({ system, user }, 2048));
  const reparsed = partial.splitSections(revisedRaw).sections[0];
  if (reparsed) sections[idx] = reparsed;
  else sections[idx] = { heading: sections[idx].heading, body: revisedRaw };
  const newBody = partial.joinSections(intro, sections);
  return rebuildWithBody(existingContent, newBody);
}

// ── 部分再生成: targeted（本文全体を渡し最小修正）──────────────
// 本文全体を再出力させるため、本文生成と同じ 4096 トークンを必ず確保する。
// 以前は maxTokens 未指定で generateSimple のデフォルト 2048 が効き、
// 本文が途中で切れる事故が発生していた（PR #129 で修正済）。
//
// セーフティ: LLM が「コメントに該当する箇所が本文に無い」状況で混乱して
// 本文を ASCII フローチャート等に書き換えてしまう事故があった（実例 2026-05-29）。
// 出力本文が元の 60% 未満（または h2 章数が半減未満）なら不正出力と判定し、
// 元本文を維持して human レビューに委ねる。
async function regenerateTargeted(existingContent, comment) {
  const { body } = parseFrontmatter(existingContent);
  const { system, user } = partial.buildTargetedPrompt({ ...parseFrontmatter(existingContent).meta }, comment, body);
  const revised = postProcessBodyOnly(await callSimpleOpenAI({ system, user }, 4096));

  const guard = partial.isBodyShrinkageSuspicious(body, revised, 0.6);
  if (guard.suspicious) {
    console.warn(`[regenerate] ⚠ targeted: 本文が異常に短縮された → 元本文を維持。${guard.reason}`);
    console.warn('[regenerate] ⚠ 差し戻しコメントが本文の内容と合っていない、または LLM が混乱した可能性。レビューで再判断してください。');
    return rebuildWithBody(existingContent, body);
  }
  return rebuildWithBody(existingContent, revised);
}

// 本文だけ後処理（禁止表現置換のみ。免責は本文側で維持される前提）
function postProcessBodyOnly(text) {
  const fenced = text.match(/^```(?:markdown|md)?\n([\s\S]+)\n```\s*$/m);
  return sanitizeBannedPhrases((fenced ? fenced[1] : text).trim());
}

// 既存 frontmatter を保ち、本文だけ差し替えて updated_at / review_status を更新
function rebuildWithBody(existingContent, newBody) {
  const m = existingContent.match(/^(---\r?\n[\s\S]+?\r?\n---\r?\n)([\s\S]*)$/);
  if (!m) return existingContent;
  const now = new Date().toISOString();
  const fmBlock = m[1]
    .replace(/^(updated_at:\s*).*$/m, `$1"${now}"`)
    .replace(/^(review_status:\s*).*$/m, `$1"draft"`)
    .replace(/^(review_comment:\s*).*$/m, `$1""`);
  const ensured = ensureDisclaimer(`${fmBlock}${newBody}`);
  return ensured.replace(/\s*$/, '\n');
}

// ── CLI 引数ヘルパー ────────────────────────────────────────────────
function getArg(name) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

// ── エントリポイント ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // ── 選定 dry-run モード（OpenAI を呼ばずに選定結果のみ出力）──
  if (args.includes('--explain') || args.includes('--dry-run')) {
    const { picks, explanation } = selectDailyTopics(TOPICS, { now: new Date() });
    console.log('\n=== Topic Selection Explanation ===\n');
    console.log(JSON.stringify(explanation, null, 2));
    console.log('\n=== Final Picks ===\n');
    if (picks.length === 0) {
      console.log('（候補なし）');
    }
    for (const p of picks) {
      console.log(`- [${p.macro}/${p.cluster}] ${p.slug}`);
      console.log(`    title: ${p.title}`);
      console.log(`    persona/category: ${p.persona} / ${p.category}`);
      console.log(`    article_type/role: ${p.article_type} (${p.article_role || (['basic_explainer','comparison_decision'].includes(p.article_type)?'main':'support')})`);
    }
    return;
  }

  // ── 再生成モード ──────────────────────────────────────────────
  if (args.includes('--regenerate')) {
    const filename = getArg('--filename');
    const comment  = getArg('--comment');
    if (!filename || !comment) {
      console.error('[regenerate] --filename と --comment は必須です');
      process.exit(1);
    }

    const filepath = path.join(POSTS_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.error(`[regenerate] ファイルが見つかりません: ${filepath}`);
      process.exit(1);
    }

    const existing = fs.readFileSync(filepath, 'utf8');
    console.log(`[regenerate] 対象: content/posts/${filename}`);
    console.log(`[regenerate] コメント: ${comment}`);

    // ── テーマ禁止チェック ──────────────────────────────────────
    // 当該記事の frontmatter から topic 情報を取り出し、以下のいずれかなら
    // 同テーマ再生成をしない（明示的に止める）:
    //   1. denylist (data/topic-denylist.json) に登録済み
    //   2. 単年限定 / historical_only / valid_to が過ぎている
    //   3. コメント自体が「今後このテーマは生成しない」と明示している
    //      （review-revise 側で denylist 登録するが、念のためここでも再判定）
    const { meta: existingMeta } = parseFrontmatter(existing);
    const topicSnapshot = {
      slug:           existingMeta.slug,
      title:          existingMeta.title,
      cluster:        existingMeta.cluster,
      subcluster:     existingMeta.subcluster,
      category:       existingMeta.category,
      primary_persona: existingMeta.primary_persona,
      primary_question: existingMeta.primary_question,
      search_intent:  existingMeta.search_intent,
      reader_problem: existingMeta.reader_problem,
      historical_only: existingMeta.historical_only === 'true',
      valid_to:       existingMeta.valid_to,
    };
    const denyHit = findMatchingEntry(topicSnapshot, loadDenylist(), new Date());
    const timeLimited = isTimeLimitedExpired(topicSnapshot, new Date());
    const commentDeny = detectDenyIntent(comment);
    if (denyHit || timeLimited.expired || commentDeny) {
      const reasons = [];
      if (denyHit) reasons.push(`denylist[${denyHit.type}=${denyHit.value}]`);
      if (timeLimited.expired) reasons.push(`time_limited[${timeLimited.reason}]`);
      if (commentDeny) reasons.push('コメントで明示的に「今後このテーマは生成しない」指示');
      console.error(`[regenerate] テーマ禁止のため再生成を中止: ${reasons.join(' / ')}`);
      console.error('[regenerate] frontmatter の review_status を needs_revision のまま残し、再生成スキップを報告します。');

      // 既存ファイルは触らず、GitHub Actions の outputs にスキップ理由を出力
      const ghOutput = process.env.GITHUB_OUTPUT;
      if (ghOutput) {
        fs.appendFileSync(ghOutput, `regenerate_skipped=true\n`);
        fs.appendFileSync(ghOutput, `regenerate_skip_reason=${reasons.join('; ')}\n`);
      }
      // 非ゼロ終了で「スキップ」を表現（CIから検知しやすく）
      process.exit(2);
    }

    if (!process.env.OPENAI_API_KEY && (process.env.CONTENT_MODEL_PROVIDER || 'openai') === 'openai') {
      console.error('[regenerate] OPENAI_API_KEY が必要です');
      process.exit(1);
    }

    // ── 差し戻しコメントを分類し、再生成範囲を決める（部分再生成）──
    const classification = classifyRevision(comment);
    console.log(`[regenerate] 分類: type=${classification.type} scope=${classification.scope} (${classification.reason})`);

    // ENABLE_PARTIAL_REVISE=false で従来の全文再生成に固定可能
    const partialEnabled = (process.env.ENABLE_PARTIAL_REVISE || 'true').toLowerCase() !== 'false';
    const scope = partialEnabled ? classification.scope : 'full';

    let content;
    const modelId = MODEL_STANDARD;

    if (scope === 'frontmatter') {
      // title_only: 本文を保ったまま title/summary だけ調整（最も安価）
      content = await regenerateTitleOnly(existing, comment);
      console.log('[regenerate] title_only: 本文を保持し frontmatter のみ更新');
    } else if (scope === 'section') {
      // section スコープ: 対象セクションだけ抽出して差し替え／追加
      content = await regenerateSection(existing, comment, classification);
      console.log('[regenerate] section: 対象セクションのみ差し替え');
    } else if (scope === 'targeted') {
      // targeted: 本文全体を渡し「指摘箇所のみ最小修正」
      content = await regenerateTargeted(existing, comment);
      console.log('[regenerate] targeted: 指摘箇所のみ最小修正');
    } else {
      // full: 全文再生成（従来）
      console.log(`[regenerate] full: 全文再生成（${modelId}）...`);
      content = await regenerateWithOpenAI(existing, comment, modelId);
    }

    fs.writeFileSync(filepath, content + '\n', 'utf8');
    console.log(`[regenerate] 再生成完了: content/posts/${filename}`);

    const ghOut = process.env.GITHUB_OUTPUT;
    if (ghOut) {
      fs.appendFileSync(ghOut, `revision_type=${classification.type}\n`);
      fs.appendFileSync(ghOut, `revision_scope=${scope}\n`);
    }

    const { meta: regenMeta } = parseFrontmatter(content);
    selfCheckContent(content, regenMeta.article_type || 'basic_explainer', regenMeta.slug || filename);
    return;
  }

  // ── 通常の新規生成モード（2本ペア生成）────────────────────────
  const dateStr = getTodayJST();
  const pair = pickPair(dateStr);

  console.log(`[generate] 日付: ${dateStr}`);
  console.log(`[generate] 生成本数: ${pair.length}`);

  const results = [];

  // 各トピックに source_url / source_title が必ず付くよう fallback を適用
  pair.forEach(ensureSourceOnTopic);

  // 本文生成 provider/model の表示（content-model の解決結果）
  const contentProvider = contentModel.resolveProvider();
  const contentModelId  = contentModel.resolveModel(contentProvider);
  const hasContentKey = contentProvider === 'anthropic'
    ? !!process.env.ANTHROPIC_API_KEY
    : !!process.env.OPENAI_API_KEY;

  for (let i = 0; i < pair.length; i++) {
    const topic = pair[i];
    const pairedTopic = pair.length === 2 ? pair[1 - i] : null;

    console.log(`[generate] ── 記事 ${i + 1}/${pair.length} ──`);
    // タイトルは LLM が本文生成と同時に決定するため、ここでは slug を識別子として表示。
    // 参考タイトル（curated TOPICS の場合のみ存在）は併記する。
    console.log(`[generate] slug: ${topic.slug}${topic.title ? ` / 参考タイトル: ${topic.title}` : ''}`);
    console.log(`[generate] ペルソナ: ${topic.persona} / カテゴリ: ${topic.category}`);
    console.log(`[generate] タイプ: ${topic.article_type || 'basic_explainer'} / ペアグループ: ${topic.pair_group || 'なし'}`);
    console.log(`[generate] 本文生成: content-model 経由 provider=${contentProvider} model=${contentModelId} cache=${contentModel.useCache()}`);
    if (pairedTopic) {
      console.log(`[generate] ペア記事: ${pairedTopic.title}`);
    }

    const revisionComments = getRecentRevisionComments(3);
    if (i === 0 && revisionComments.length > 0) {
      console.log(`[generate] 差し戻しコメント ${revisionComments.length} 件を改善ヒントとして使用`);
    }

    let content, usedModel = contentModelId;

    if (hasContentKey || process.env.OPENAI_API_KEY) {
      try {
        const art = await generateArticle(dateStr, topic, pairedTopic);
        content = art.content;
        usedModel = art.model || contentModelId;
        // content-model 内で provider=anthropic から openai に fallback した場合はここで明示
        if (contentProvider === 'anthropic' && art.provider === 'openai') {
          console.warn(`[generate] ⚠ Anthropic 失敗のため OpenAI fallback で生成（model=${art.model}）`);
        }
      } catch (err) {
        console.warn(`[generate] 本文生成 API 失敗: ${err.message} → テンプレートにフォールバック`);
        content = generateFromTemplate(dateStr, topic, pairedTopic);
        usedModel = 'template';
      }
    } else {
      console.log('[generate] APIキー未設定（ANTHROPIC_API_KEY / OPENAI_API_KEY）→ テンプレートで生成します');
      content = generateFromTemplate(dateStr, topic, pairedTopic);
      usedModel = 'template';
    }

    const filename = `${dateStr}-${topic.slug}.md`;
    const filepath = path.join(POSTS_DIR, filename);

    fs.mkdirSync(POSTS_DIR, { recursive: true });
    fs.writeFileSync(filepath, content + '\n', 'utf8');
    console.log(`[generate] 生成完了: content/posts/${filename}`);

    selfCheckContent(content, topic.article_type || 'basic_explainer', topic.slug);

    results.push({ filename, slug: topic.slug, model: usedModel });
  }

  // GitHub Actions 出力変数（2本分）
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    fs.appendFileSync(ghOutput, `date=${dateStr}\n`);
    fs.appendFileSync(ghOutput, `count=${results.length}\n`);

    // 1本目
    fs.appendFileSync(ghOutput, `filename1=${results[0].filename}\n`);
    fs.appendFileSync(ghOutput, `slug1=${results[0].slug}\n`);
    fs.appendFileSync(ghOutput, `model1=${results[0].model}\n`);

    // 2本目（ある場合）
    if (results.length >= 2) {
      fs.appendFileSync(ghOutput, `filename2=${results[1].filename}\n`);
      fs.appendFileSync(ghOutput, `slug2=${results[1].slug}\n`);
      fs.appendFileSync(ghOutput, `model2=${results[1].model}\n`);
    }

    // カンマ区切りリスト（通知・コミット用）
    fs.appendFileSync(ghOutput, `filenames=${results.map(r => r.filename).join(',')}\n`);
    fs.appendFileSync(ghOutput, `slugs=${results.map(r => r.slug).join(',')}\n`);
  }
}

main().catch(err => {
  console.error('[generate] エラー:', err.message);
  process.exit(1);
});
