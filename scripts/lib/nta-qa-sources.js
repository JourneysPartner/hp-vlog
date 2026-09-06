'use strict';

/**
 * 国税庁 Q&A 資料の「適用条件」。
 *
 * 背景（2026-09-06）:
 *   Q&A カタログは主題の狭い資料の寄せ集めで、例えば income_tax に入っているのは
 *   暗号資産 FAQ（47 件）だけ。生成時のマッチングは税目（tax_domain）でしか資料を
 *   絞っておらず、所得税の記事なら何であれ暗号資産 FAQ の上位 3 問が添付されていた
 *   （土地の一部譲渡の記事に「暗号資産取引で損失が生じた場合」が付いた）。
 *   347 件の標本では、添付 106 件のうち 58% が記事の論点と無関係だった
 *   （所得税 84%、帳簿・経費 100%）。
 *
 *   資料が記事に関係あるかは「資料の主題語が記事の企画メタに出てくるか」で決める。
 *   ここに載っていない資料は、どの記事にも添付しない（安全側）。
 *   資料を crawl-nta-qa.js の SOURCES に追加したら、必ずここにも scope を書くこと
 *   （書き忘れは crawl 時に警告される）。
 *
 * scope の語は normalize（NFKC・空白除去）後の記事メタに含まれるかで見る。
 * 全角・半角は同一視される（「２割特例」と「2割特例」は同じ）。
 */

const SCOPES = {
  // インボイス制度に関するQ&A
  invoice: ['インボイス', '適格請求書', '適格簡易請求書', '登録番号', '2割特例', '少額特例', '免税事業者'],

  // 電子帳簿保存法一問一答【電子取引関係】
  denshi_torihiki: ['電子取引', '電子帳簿保存', '電帳法', '電子データ'],

  // 電子帳簿保存法一問一答【スキャナ保存関係】
  denshi_scan: ['スキャナ保存', 'スキャン', '電子帳簿保存', '電帳法'],

  // 消費税の軽減税率制度に関するQ&A
  keigen: ['軽減税率', '飲食料品', 'イートイン', 'テイクアウト', '持ち帰り', '一体資産', '8%', '外食', 'ケータリング', '新聞'],

  // 国境を越えた役務の提供に係る消費税
  cross_border: ['国境を越え', '電気通信利用役務', 'リバースチャージ', '国外事業者', 'プラットフォーム課税'],

  // 暗号資産等に関する税務上の取扱いについて（FAQ）
  kasou: ['暗号資産', '仮想通貨', 'ビットコイン', 'イーサリアム', 'NFT', '電子決済手段', 'ステーブルコイン', 'マイニング', 'ステーキング'],

  // 相続税及び贈与税等に関する質疑応答事例（令和5年度税制改正関係）
  sozoku: ['生前贈与加算', '相続時精算課税', '暦年課税', '持ち戻し', '加算期間', '贈与税の基礎控除'],

  // 相続税・贈与税のパンフレット（改正のあらまし・教育資金の一括贈与）
  sozoku_pamph: ['教育資金', '一括贈与', '相続時精算課税', '暦年課税', '生前贈与加算', '税制改正'],
};

function normalizeText(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, '');
}

/**
 * 記事の企画メタ（正規化前のテキスト）を受け取り、添付候補にしてよい資料の
 * source_key の集合を返す。scope が無い資料は含めない。
 */
function eligibleSourceKeys(text, scopes = SCOPES) {
  const haystack = normalizeText(text);
  const out = new Set();
  if (!haystack) return out;
  for (const [key, words] of Object.entries(scopes)) {
    if (!Array.isArray(words) || words.length === 0) continue;
    if (words.some(w => haystack.includes(normalizeText(w)))) out.add(key);
  }
  return out;
}

/** SOURCES のキーのうち scope が未定義のものを返す（crawl 時の警告用） */
function sourceKeysWithoutScope(keys, scopes = SCOPES) {
  return (keys || []).filter(k => !Array.isArray(scopes[k]) || scopes[k].length === 0);
}

module.exports = { SCOPES, eligibleSourceKeys, sourceKeysWithoutScope, normalizeText };
