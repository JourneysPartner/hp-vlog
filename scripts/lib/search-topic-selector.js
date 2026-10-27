'use strict';

const { parseJsonLoose } = require('./llm-source-selector');
const { MACRO_BY_PERSONA } = require('./shitsugi-topics');
const {
  ALLOWED_TAX_DOMAINS, ALLOWED_CATEGORIES, ALLOWED_ARTICLE_TYPES,
} = require('./suggest-topics');

const SELECT_BATCH = 8;

// サジェスト候補で使ってきた選別プロンプト。GSC 候補も同じ文面を共用する。
const SELECT_SYSTEM = [
  'あなたは日本の税理士事務所ブログの編集長です。',
  '実際に Google で打ち込まれている検索語の一覧から、ブログ記事の候補を作ります。',
  '',
  '# 当ブログの顧客層と使える persona ID',
  Object.keys(MACRO_BY_PERSONA).join(' / '),
  '',
  '# 記事候補にする条件',
  '- 税務の疑問・判断に関する検索であること（単なる用語検索・ツール検索は除く）',
  '- 顧客層のいずれかが実際に検索する場面が想像できること',
  '- 1つの候補は「1つの問い」に絞る。近い検索語は同じ候補にまとめてよい',
  '',
  '# 除外するもの',
  '- 税務と無関係（例: 集客ノウハウ、ツールの使い方）',
  '- 顧客層の外（大企業・金融機関・公益法人など）',
  '- 検索語から問いが特定できないもの',
  '',
  '# 出力（JSON のみ。コードフェンス禁止）',
  '{"topics": [{',
  '  "seed_id": "<元の種語ID>",',
  '  "phrases": ["<裏づけになった検索語>", "..."],',
  '  "persona": "<persona ID>",',
  `  "tax_domain": "<${[...ALLOWED_TAX_DOMAINS].join(' | ')}>",`,
  `  "category": "<${[...ALLOWED_CATEGORIES].join(' | ')}>",`,
  `  "article_type": "<${[...ALLOWED_ARTICLE_TYPES].join(' | ')}>",`,
  '  "primary_question": "<読者の問い（日本語1文）>",',
  '  "reader_problem": "<読者の悩み（日本語1文）>"',
  '}]}',
  '',
  '候補にできる検索語が無ければ {"topics": []} を返す。無理に作らない。',
].join('\n');

function buildSelectPrompt(batch) {
  const lines = ['次の種語ごとの検索語一覧から、記事候補を作ってください。', ''];
  for (const seed of batch) {
    lines.push(`## 種語 ${seed.id}（参考 persona: ${seed.persona_hint || '無し'}）`);
    lines.push(`検索語: ${seed.phrases.join(' / ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function selectTopicProposals(seeds, options = {}) {
  const callLLM = options.callLLM;
  if (typeof callLLM !== 'function') throw new Error('callLLM が必要です');
  const logger = options.logger === undefined ? console : options.logger;
  const prefix = options.prefix || 'suggest';
  const batchSize = options.batchSize || SELECT_BATCH;
  const warn = message => { if (logger && typeof logger.warn === 'function') logger.warn(message); };
  const proposals = [];
  let skippedBatches = 0;

  for (let offset = 0; offset < seeds.length; offset += batchSize) {
    const batch = seeds.slice(offset, offset + batchSize);
    let parsed = null;
    for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
      try {
        parsed = parseJsonLoose(await callLLM(SELECT_SYSTEM, buildSelectPrompt(batch)));
        if ((!parsed || !Array.isArray(parsed.topics)) && attempt === 1) {
          parsed = null;
          warn(`[${prefix}] 応答の形式が不正 → 1回だけリトライします`);
        }
      } catch (error) {
        warn(`[${prefix}] LLM 呼び出し失敗 (${attempt}回目): ${error.message}`);
      }
    }
    if (!parsed || !Array.isArray(parsed.topics)) {
      skippedBatches++;
      continue;
    }
    proposals.push(...parsed.topics);
  }
  return { proposals, skippedBatches };
}

module.exports = { SELECT_SYSTEM, SELECT_BATCH, buildSelectPrompt, selectTopicProposals };
