/**
 * 記事を書く前に「その記事が実際に扱う税務の論点語」を決める
 *
 * なぜ必要か:
 *   企画の段階にあるのは読者の場面のことば（オンライン講座・セット販売・区分）で、
 *   国税庁のページは税務の概念のことば（前受金・譲渡等の時期）で書かれている。
 *   同じことを指していても語が重ならないため、企画のことばだけで出典を探すと当たらない。
 *
 *   実測: 「オンライン講座＋個別コンサルのセット販売」の記事で、正解の
 *   No.6165「前受金や前払金などがあるとき」は企画のことばだけだと 52位。
 *   論点語「前受金 売上計上時期」を足すと 1位になった。
 *
 * 章立てそのものは渡さない。章立ては雑音の方が多く、論点語だけなら1位だった正解が
 * 章立ても渡すと4位まで下がった。
 */

const SYSTEM =
  'あなたは日本の税務に詳しい編集者です。\n' +
  '記事の企画から、その記事が実際に扱う「税務上の論点」を表す用語を挙げます。\n' +
  '重要な制約:\n' +
  '- 読者の場面のことば（業種名・商品名・プラットフォーム名・悩みの言い回し）は挙げない。\n' +
  '  例: オンライン講座、セット販売、メルカリ、ハンドメイド、確定申告が不安 → すべて対象外。\n' +
  '- 国税庁のページ名に使われるような税務の概念の用語だけを挙げる。\n' +
  '  例: 前受金、資産の譲渡等の時期、必要経費、資本的支出、非課税取引、仕入税額控除。\n' +
  '- 一般的すぎる語（消費税、所得税、課税、売上、経費）だけで終わらせない。\n' +
  '  どの論点かが特定できる具体的な用語を挙げること。\n' +
  '- 2〜4語。確信のあるものだけ。無ければ空配列にする（無理に挙げない）。\n' +
  '出力は次のJSONのみ:\n' +
  '{"tax_terms": ["用語1", "用語2"]}';

// 一般的すぎて論点の特定に役立たない語。これだけしか返らなかったら採用しない。
const TOO_GENERIC = new Set([
  '消費税', '所得税', '法人税', '相続税', '贈与税', '課税', '非課税', '売上', '経費',
  '税金', '申告', '確定申告', '納税', 'インボイス', '帳簿', '控除', '税率', '取引',
]);

function buildUserPrompt(topic) {
  const lines = [
    `# 記事の企画`,
    `税目: ${topic.tax_domain || '（未設定）'}`,
    `想定読者: ${topic.persona || topic.customer_segment || '（未設定）'}`,
  ];
  if (topic.title) lines.push(`参考タイトル: ${topic.title}`);
  if (topic.primary_question) lines.push(`読者の問い: ${topic.primary_question}`);
  if (topic.reader_problem) lines.push(`読者の悩み: ${topic.reader_problem}`);
  if (topic.search_intent) lines.push(`検索意図: ${topic.search_intent}`);
  if (topic.summary) lines.push(`要約: ${topic.summary}`);
  lines.push('', 'この記事が実際に扱う税務上の論点の用語を挙げてください。');
  return lines.join('\n');
}

function parseTerms(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { return []; }
  if (!parsed || !Array.isArray(parsed.tax_terms)) return [];
  const out = [];
  for (const t of parsed.tax_terms) {
    const term = String(t || '').trim();
    if (!term || term.length > 24) continue;
    if (out.includes(term)) continue;
    out.push(term);
    if (out.length >= 4) break;
  }
  // 一般的すぎる語しか返らなかった場合は、出典探しの役に立たないので採用しない。
  if (out.length > 0 && out.every(t => TOO_GENERIC.has(t))) return [];
  return out;
}

/**
 * @param {Object} topic
 * @param {Function} callLLM ({system,user}) => Promise<string>
 * @returns {Promise<string[]>} 論点語（見つからなければ空配列）
 */
async function resolveTaxTerms(topic, callLLM) {
  if (typeof callLLM !== 'function') throw new Error('callLLM が必要です');
  const raw = await callLLM({ system: SYSTEM, user: buildUserPrompt(topic) });
  return parseTerms(raw);
}

module.exports = { resolveTaxTerms, parseTerms, buildUserPrompt, SYSTEM, TOO_GENERIC };
