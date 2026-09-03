'use strict';

/**
 * 記事を書いている「いま」が何年分なのかを求める
 *
 * なぜ必要か（2026-09-03）:
 *   生成プロンプトに今日の日付を一切渡していなかった。そのため LLM は学習時点の年を
 *   基準に書き、令和8年9月に生成した記事が令和7年分を「現在」、令和8年分を
 *   「これから変わる予定」として書いた。
 *
 *   時間軸がずれると、金額の誤りが芋づるで出る。実際に同じ日の2記事で
 *     ・基礎控除を「48万円（令和7年分）」と書いた（48万円は令和6年分以前の金額）
 *     ・「103万円の壁（給与所得控除65万円＋所得58万円）」と書いた（足し算が合わない。
 *       103万円は令和6年分以前の 55万＋48万）
 *   が同時に出ている。年分を取り違えたまま金額を書くと、こうなる。
 *
 * 使い方:
 *   buildTaxPeriodBlock() をプロンプトの可変部分（キャッシュ対象外）に入れる。
 *   固定ルール側には「年分の書き方」の方針だけを置き、日付そのものは持たせない
 *   （毎日変わる値を固定ブロックに入れると prompt caching が毎日無効になる）。
 */

// 令和1年 = 2019年。令和N年 = 2018 + N
const REIWA_EPOCH = 2018;

/** 西暦→令和。令和より前は null（この事務所の記事では扱わない） */
function toReiwa(year) {
  const n = year - REIWA_EPOCH;
  return n >= 1 ? n : null;
}

/**
 * Date / ISO文字列 / 未指定 を Date にそろえる。
 * 呼び出し側（generate-draft.js）は now を ISO 文字列で持ち回っているため、
 * 文字列でも受けられるようにする。壊れた値なら現在時刻に落とす。
 */
function toDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Date を JST の {year, month, day} にする */
function toJstParts(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
  };
}

/**
 * いまの年分と、その前後の申告時期を返す。
 *
 * 所得税は暦年課税なので「年分＝暦年」。いま働いて稼いでいる分は今年の年分にあたり、
 * その申告は翌年の2月16日〜3月15日に行う。
 *
 * 1月1日〜3月15日は、前年分の申告期間の最中にあたる。この時期は
 * 「いま稼いでいる分（今年分）」と「いま申告している分（前年分）」が併存するので、
 * 両方を明示しないと記事の主語がぶれる。
 */
function currentTaxPeriod(now) {
  const { year, month, day } = toJstParts(toDate(now));

  // 前年分の申告期限（3月15日）を過ぎたか。3月15日当日は期限内。
  const beforeFilingDeadline = month < 3 || (month === 3 && day <= 15);

  return {
    today: { year, month, day },
    todayReiwa: toReiwa(year),

    // いま稼いでいる分
    currentTaxYear: year,
    currentTaxYearReiwa: toReiwa(year),
    currentFilingYear: year + 1,          // その申告を行う年
    currentFilingYearReiwa: toReiwa(year + 1),

    // ひとつ前の年分
    previousTaxYear: year - 1,
    previousTaxYearReiwa: toReiwa(year - 1),

    // 前年分の申告期間の最中か（1/1〜3/15）
    inFilingSeason: beforeFilingDeadline,
  };
}

function fmtDate({ year, month, day }) {
  return `${year}年${month}月${day}日`;
}

/**
 * プロンプトに渡す「いま何年か」のブロックを組み立てる。
 * 可変部分（キャッシュ対象外）に入れること。
 */
function buildTaxPeriodBlock(now) {
  const p = currentTaxPeriod(now);
  const reiwa = p.todayReiwa;

  const filingLine = p.inFilingSeason
    ? `いまは<strong>令和${p.previousTaxYearReiwa}年分の確定申告期間の最中</strong>です（${p.today.year}年2月16日〜3月15日）。`
      + `「申告している分」は令和${p.previousTaxYearReiwa}年分、`
      + `「いま稼いでいる分」は令和${p.currentTaxYearReiwa}年分です。どちらの話をしているか必ず書き分けること。`
    : `令和${p.previousTaxYearReiwa}年分の確定申告は${p.today.year}年3月15日に期限を過ぎており、`
      + `<strong>すでに申告が終わった年分</strong>です。`;

  return `

═══ いま何年か（時間軸の基準・最優先で従うこと）═══
今日は<strong>${fmtDate(p.today)}（令和${reiwa}年）</strong>です。
あなたの学習時点の年ではなく、この日付を「現在」として書いてください。

- 所得税の<strong>いま進行中の年分は令和${p.currentTaxYearReiwa}年分</strong>（${p.currentTaxYear}年1月1日〜12月31日）。
  この分の確定申告は令和${p.currentFilingYearReiwa}年（${p.currentFilingYear}年）2月16日〜3月15日に行う。
- ${filingLine}

【この記事の主軸】
読者が知りたいのは「自分のいま」です。年分で内容が変わる話は、
<strong>令和${p.currentTaxYearReiwa}年分を主軸</strong>にして書くこと。
過去の年分に触れるときは「すでに申告が終わった年分」と分かるように書く。

【よくある事故】
- 令和${p.previousTaxYearReiwa}年分を「現在」として書いてしまう
- すでに適用が始まっている令和${p.currentTaxYearReiwa}年分の制度を
  「今後変わります」「引き上げられる予定です」と未来形で書いてしまう
- 年分を書かずに金額だけ書き、どの年分の金額か読者に分からない

※ 法人税は事業年度ごとの課税なので「年分」ではなく「事業年度」で考える。
　 法人の話にこの暦年の年分をそのまま当てはめないこと。`;
}

module.exports = { currentTaxPeriod, buildTaxPeriodBlock, toReiwa, REIWA_EPOCH };
