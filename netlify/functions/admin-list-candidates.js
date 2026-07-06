'use strict';

/**
 * admin-list-candidates — 質疑応答事例の候補リストを返す API
 *
 * GET /admin/api/candidates/list
 *
 * 必須認証: HTTP Basic（ADMIN_BASIC_USER / ADMIN_BASIC_PASS）
 *
 * GitHub 上の data/nta-shitsugi-topics-candidate.json を取得して、
 * フロントエンドが必要なフィールドだけに整形して返す。
 * sha も返し、後続の save API で楽観的並行制御に使う。
 */

const { requireBasicAuth } = require('./lib/admin-auth');
const { getFile } = require('./lib/github-api');

const CANDIDATES_FILE = 'data/nta-shitsugi-topics-candidate.json';

exports.handler = async (event) => {
  const auth = requireBasicAuth(event);
  if (auth) return auth;  // 401/503 のときは早期 return

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const file = await getFile(CANDIDATES_FILE, 'main');
    const data = JSON.parse(file.content);

    // フロント用に軽量化（不要な breakdown は省く）
    const candidates = (data.candidates || []).map((c, idx) => ({
      idx: idx + 1,
      shitsugi_url: c.shitsugi_url,
      shitsugi_title: c.shitsugi_title,
      tax_category: c.tax_category,
      tax_category_code: c.tax_category_code,
      section: c.section,
      id: c.id,
      score: c.score,
      proposed_persona: c.proposed && c.proposed.persona,
      auto_decision: c.auto_decision || '',
      auto_score: c.auto_score != null ? c.auto_score : c.score,
      auto_reasons: c.auto_reasons || [],
      target_segments: c.target_segments || [],
      article_potential: c.article_potential || '',
      adopted: c.adopted === true,
      rejected: c.rejected === true,
      adoption_note: c.adoption_note || '',
      rejection_note: c.rejection_note || '',
    }));

    // 件数集計（管理画面のタブ表示用）
    const summary = { total: candidates.length, recommend: 0, review: 0, reject: 0, adopted: 0, rejected: 0 };
    for (const c of candidates) {
      if (c.auto_decision && summary[c.auto_decision] != null) summary[c.auto_decision]++;
      if (c.adopted) summary.adopted++;
      if (c.rejected) summary.rejected++;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        version: data.version,
        generated_at: data.generated_at,
        sha: file.sha,
        stats: data.stats,
        summary,
        candidates,
      }),
    };
  } catch (e) {
    console.error('[admin-list-candidates]', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
