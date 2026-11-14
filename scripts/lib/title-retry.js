'use strict';

/**
 * 題名だけを作り直すときの、きっかけ・採否・指示。
 *
 * 2026-11-14: 検索語「せどり 確定申告 バレない」を空白区切りのまま
 * 題名の頭に貼った記事が公開された。点検（title-lint / seo-lint）で
 * 止め、作り直しの指示でも空白区切りを禁じる。
 */

// 検索語の点検で、題名だけ作り直すきっかけにする fail。
const RETITLE_TRIGGER_CODES = Object.freeze([
  'title_missing_query',
  'title_too_long',
  'title_raw_query',
]);

function countTitleFails(fails) {
  const list = Array.isArray(fails) ? fails : [];
  return list.filter(code => String(code).startsWith('title_')).length;
}

// 作り直した題名を採るか。
// beforeFails / retriedFails は lintSeo の fails（題名以外の code も混ざってよい）。
// titleCheck は checkLlmTitle の結果 { ok, reasons }。
// 返り値 { accept: boolean, reason: string }。reason は採らないときの理由（採るときは ''）。
function decideRetitle({ beforeFails, retriedFails, titleCheck } = {}) {
  const check = titleCheck || {};
  if (!check.ok) {
    return { accept: false, reason: `題名の点検: ${(check.reasons || []).join(' / ')}` };
  }
  if ((Array.isArray(retriedFails) ? retriedFails : []).includes('title_raw_query')) {
    return { accept: false, reason: '検索語を空白区切りのまま貼っている' };
  }
  const before = countTitleFails(beforeFails);
  const after = countTitleFails(retriedFails);
  if (after >= before) {
    return { accept: false, reason: `題名の fail が減らない（${before} → ${after}）` };
  }
  return { accept: true, reason: '' };
}

// 本文の見出しと冒頭から、題名だけを作り直す指示を組み立てる。
function buildRetitlePrompt(body, topic = {}) {
  const text = String(body || '');
  const heads = (text.match(/^#{2,3} .*$/gm) || []).slice(0, 12).map(h => h.replace(/^#+ /, ''));
  const lead = text.replace(/^#{1,6} .*$/gm, '').trim().slice(0, 300);
  const system = [
    'あなたは日本の税務ブログの編集者です。記事本文に合った日本語のタイトルを1つ作ります。',
    '制約:',
    '- 28〜45文字。45文字を超えない。',
    '- 主検索語が渡されたときは、その各語を先頭15文字以内に入れる。各語は助詞などを補って、自然な日本語の文としてつなぐ。',
    '- 題名に空白を入れない。主検索語を空白で区切ったまま並べない。',
    '  悪い例（主検索語「メルカリ 売上 確定申告」）: メルカリ 売上 確定申告 いくらから必要か',
    '  良い例: メルカリの売上は確定申告が必要？いくらからかと申告の流れ',
    '- 末尾に「を解説」「について」「まとめ」を付けない。',
    '- 「徹底解説」「完全ガイド」「必読」は使わない。',
    '- 同じ名詞を繰り返さない。',
    '- 記事に書かれていないことをタイトルにしない。',
    '出力はタイトルの文字列のみ。前置きも引用符も付けない。',
  ].join('\n');
  const userLines = [
    `税目カテゴリ: ${topic.category || ''}`,
    `想定読者: ${topic.persona || ''}`,
    `主検索語: ${topic.target_query || '（指定なし）'}`,
  ];
  const tokens = String(topic.target_query || '')
    .normalize('NFKC')
    .split(/[\s・、／/]+/u)
    .map(t => t.trim())
    .filter(Boolean);
  if (tokens.length > 0) {
    userLines.push(`主検索語の各語: ${tokens.join('／')}`);
  }
  userLines.push(
    '',
    '# 記事の見出し',
    ...heads.map(h => `- ${h}`),
    '',
    '# 本文の冒頭',
    lead,
  );
  return { system, user: userLines.join('\n') };
}

// 検索語の点検に落ちた題名を、1 回だけ作り直す。
// 採らないとき・作り直せないとき・失敗したときは、元の題名のまま返す（仮置きにしない）。
// retry(body, topic) は題名の文字列か null を返す（generate-draft の retryTitleOnce）。
// lintSeo・checkTitle は seo-lint の lintSeo と draft-normalizer の checkLlmTitle。
// 返り値 { accepted: boolean, title: string }。accepted が false なら title は元の題名。
async function retitleForSeo({
  title, summary, body, topic, seoFails, retry, lintSeo, checkTitle, warn = console.warn,
}) {
  const fails = Array.isArray(seoFails) ? seoFails : [];
  if (!fails.some(code => RETITLE_TRIGGER_CODES.includes(code))) {
    return { accepted: false, title };
  }

  const failingTitleCodes = fails.filter(code => String(code).startsWith('title_'));
  warn(`[seo] 題名が点検に落ちました（${failingTitleCodes.join(', ')}）: "${title}" → 題名だけ作り直します`);

  let retried;
  try {
    retried = await retry(body, topic);
  } catch (e) {
    warn(`[seo] 題名の作り直しに失敗（${e.message}）→ 元の題名を維持`);
    return { accepted: false, title };
  }

  if (!retried) {
    return { accepted: false, title };
  }

  const retriedSeo = lintSeo({
    title: retried,
    summary,
    body,
    target_query: topic.target_query,
    secondary_queries: topic.secondary_queries,
  });
  const titleCheck = checkTitle(retried, { macro: topic.macro, article_type: topic.article_type });
  const decision = decideRetitle({
    beforeFails: fails,
    retriedFails: retriedSeo.fails,
    titleCheck,
  });
  if (!decision.accept) {
    warn(`[seo] 作り直した題名を採用せず（${decision.reason}）: "${retried}" → 元の題名のまま`);
    return { accepted: false, title };
  }
  return { accepted: true, title: retried };
}

module.exports = {
  RETITLE_TRIGGER_CODES,
  decideRetitle,
  buildRetitlePrompt,
  retitleForSeo,
};
