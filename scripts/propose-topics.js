'use strict';

/**
 * テーマ候補提案スクリプト
 *
 * 用途:
 *   AIに新規テーマ候補を提案させ、レビュー用JSONファイルに出力する。
 *   承認されたテーマだけを人間が topic-pool.js に追加する。
 *
 * 実行:
 *   node scripts/propose-topics.js              # 5件提案（デフォルト）
 *   node scripts/propose-topics.js --count 10   # 10件提案
 *
 * 出力:
 *   content/proposed-topics/YYYY-MM-DD.json
 */

const fs   = require('fs');
const path = require('path');

const ROOT         = path.join(__dirname, '..');
const PROPOSED_DIR = path.join(ROOT, 'content', 'proposed-topics');

const { TOPICS } = require('./topic-pool');

// ── 既存スラグ一覧 ──────────────────────────────────────────────
function getExistingSlugs() {
  const slugs = new Set(TOPICS.map(t => t.slug));
  // 過去の提案もチェック
  if (fs.existsSync(PROPOSED_DIR)) {
    for (const file of fs.readdirSync(PROPOSED_DIR).filter(f => f.endsWith('.json'))) {
      const data = JSON.parse(fs.readFileSync(path.join(PROPOSED_DIR, file), 'utf8'));
      for (const t of data.topics || []) slugs.add(t.slug);
    }
  }
  return slugs;
}

// ── 引数パース ──────────────────────────────────────────────────
function parseArgs() {
  const args  = process.argv.slice(2);
  const idx   = args.indexOf('--count');
  const count = (idx !== -1 && args[idx + 1]) ? parseInt(args[idx + 1], 10) : 5;
  return { count };
}

// ── JST 日付 ────────────────────────────────────────────────────
function getTodayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// ── Claude でテーマ候補を生成 ───────────────────────────────────
async function proposeWithClaude(count, existingSlugs) {
  const _sdk      = require('@anthropic-ai/sdk');
  const Anthropic = _sdk.default || _sdk;
  const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const existingTitles = TOPICS.map(t => `- ${t.title}`).join('\n');

  const systemPrompt = `あなたは日本の税理士事務所（毛利順活税理士事務所）のブログ企画担当です。
検索ニーズが高く、ターゲット読者が実務で抱える具体的な疑問に答える税務記事テーマを提案してください。

対象ペルソナ（primary_persona の値）:
- ebay_export_seller: eBay輸出セラー
- domestic_ec_seller: 国内EC物販セラー（Amazon・楽天等）
- reseller_marketplace_seller: フリマ・転売セラー（メルカリ・ヤフオク等）
- influencer_creator: インフルエンサー・クリエイター（YouTuber・ブロガー等）
- beauty_salon_owner: 美容サロンオーナー（美容室・エステ・脱毛・ネイル等）
- inheritance_client: 相続・贈与の依頼者

対象カテゴリ:
- 消費税 / 所得税 / インボイス / 帳簿・経費 / 相続 / 海外取引

quality の判断基準:
- standard: 基礎知識・手続きの流れ・経費の考え方など
- high: 税制度の複雑な論点・特例・複数制度の比較・法改正への対応など

source_url のルール（重要）:
- 国税庁タックスアンサー等、公的根拠が明確に確認できるテーマのみ source_url / source_title を設定すること
- 妥当な根拠URLが思いつかない場合、無理にURLを入れず空文字にすること
- 「とりあえず何かURLを入れる」は禁止
- source_url を空にする場合は source_title も空にすること

テーマ設計の方針:
- タイトルは「具体的な悩み・疑問」に寄せること（例: 「〜はどうなる？」「〜の条件を解説」）
- 薄いまとめ記事ではなく、実務で判断に迷うポイントに踏み込むこと
- 1テーマにつき1ペルソナに絞り、複数ペルソナに広く触れないこと
- 既存テーマとタイトル・論点が近すぎるものは避けること
- slug は英数字とハイフンのみ、20〜50文字`;

  const userPrompt = `以下の既存テーマと重複しない新規テーマを${count}件提案してください。
ペルソナ・カテゴリがバランスよく分散するようにしてください。

【既存テーマ一覧】
${existingTitles}

以下のJSON配列形式で出力してください（コードブロック不要、JSONのみ）:

[
  {
    "persona": "（primary_persona値）",
    "category": "（カテゴリ名）",
    "quality": "standard または high",
    "title": "（60文字以内のタイトル）",
    "slug": "（英数字とハイフンのみ）",
    "source_url": "（公的根拠が明確な場合のみ。不明なら空文字）",
    "source_title": "（source_urlに対応するタイトル。不明なら空文字）",
    "hint": "（記事生成時のヒント、50文字程度）",
    "notes": "（このテーマを提案する理由。検索ニーズや想定読者の疑問を簡潔に）"
  }
]`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_completion_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';
  // コードブロックで包まれていた場合は除去
  const fenced = raw.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
  const jsonStr = (fenced ? fenced[1] : raw).trim();
  const proposed = JSON.parse(jsonStr);

  // 既存スラグとの重複除去
  return proposed.filter(t => !existingSlugs.has(t.slug));
}

// ── エントリポイント ─────────────────────────────────────────────
async function main() {
  const { count }    = parseArgs();
  const dateStr      = getTodayJST();
  const existingSlugs = getExistingSlugs();

  console.log(`[propose] 日付: ${dateStr}`);
  console.log(`[propose] 既存テーマ数: ${TOPICS.length}（pool） + 提案済み`);
  console.log(`[propose] 提案数: ${count}件`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[propose] ANTHROPIC_API_KEY が未設定です。テーマ提案にはAPIキーが必要です。');
    process.exit(1);
  }

  const proposed = await proposeWithClaude(count, existingSlugs);
  console.log(`[propose] 生成されたテーマ: ${proposed.length}件`);

  // 出力
  fs.mkdirSync(PROPOSED_DIR, { recursive: true });
  const outPath = path.join(PROPOSED_DIR, `${dateStr}.json`);
  const output  = {
    generated_at: new Date().toISOString(),
    status: 'pending_review',
    topics: proposed,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`[propose] 保存先: content/proposed-topics/${dateStr}.json`);
  console.log('[propose] ──────────────────────────────────');
  for (const t of proposed) {
    console.log(`  [${t.quality}] ${t.persona} / ${t.category}`);
    console.log(`    ${t.title}`);
  }
  console.log('[propose] ──────────────────────────────────');
  console.log('[propose] 承認したテーマを scripts/topic-pool.js に手動で追加してください。');
}

main().catch(err => {
  console.error('[propose] エラー:', err.message);
  process.exit(1);
});
