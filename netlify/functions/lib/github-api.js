'use strict';

const jwt = require('jsonwebtoken');

/**
 * GitHub API 共通モジュール
 *
 * 認証優先順位:
 *   1. GitHub App (本番推奨)
 *      - GH_APP_ID              — GitHub App ID
 *      - GH_APP_PRIVATE_KEY     — PEM 秘密鍵（改行は \n リテラルで可）
 *      - GH_APP_INSTALLATION_ID — Installation ID
 *   2. PAT フォールバック (ローカル確認用)
 *      - GITHUB_TOKEN           — Personal Access Token
 *
 * 共通:
 *   GITHUB_REPO   — owner/repo (デフォルト: JourneysPartner/hp-vlog)
 *   GITHUB_BRANCH — 対象ブランチ (デフォルト: main)
 */

const REPO   = () => process.env.GITHUB_REPO   || 'JourneysPartner/hp-vlog';
const BRANCH = () => process.env.GITHUB_BRANCH || 'main';

const API_BASE = 'https://api.github.com';
const UA = 'mori-tax-review';

// ── GitHub App 秘密鍵の正規化 ──────────────────────────────────────────
function normalizePrivateKey(raw) {
  if (!raw) return null;

  let key = raw
    .trim()
    .replace(/^["']+|["']+$/g, '')   // 先頭末尾の引用符を除去
    .trim()
    .replace(/\\n/g, '\n');           // リテラル \n → 実改行

  if (!key.includes('-----BEGIN') || !key.includes('-----END')) {
    throw new Error(
      'GH_APP_PRIVATE_KEY の秘密鍵形式が不正です。' +
      '-----BEGIN RSA PRIVATE KEY----- で始まる PEM 形式が必要です。'
    );
  }

  return key;
}

// ── GitHub App JWT 生成 ─────────────────────────────────────────────────
function createAppJWT() {
  const appId = process.env.GH_APP_ID;
  const privateKey = normalizePrivateKey(process.env.GH_APP_PRIVATE_KEY);

  if (!appId || !privateKey) return null;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,       // 60秒前（クロックスキュー対策）
    exp: now + 10 * 60,  // 10分後
    iss: appId,
  };
  return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
}

// ── Installation Access Token 取得 ──────────────────────────────────────
let _tokenCache = { token: null, expiresAt: 0 };

async function getInstallationToken() {
  // キャッシュが有効なら再利用（有効期限の5分前まで）
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 5 * 60 * 1000) {
    return _tokenCache.token;
  }

  const appJwt = createAppJWT();
  if (!appJwt) return null;

  const installationId = process.env.GH_APP_INSTALLATION_ID;
  if (!installationId) return null;

  const url = `${API_BASE}/app/installations/${installationId}/access_tokens`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${appJwt}`,
      'User-Agent': UA,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub App token取得失敗 ${res.status}: ${text}`);
  }

  const data = await res.json();
  _tokenCache = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
  return data.token;
}

// ── トークン取得（App優先 → PATフォールバック）──────────────────────────
async function getToken() {
  // 1. GitHub App
  const appToken = await getInstallationToken();
  if (appToken) return appToken;

  // 2. PAT フォールバック
  const pat = process.env.GITHUB_TOKEN;
  if (pat) return pat;

  throw new Error('認証情報が未設定です。GH_APP_ID/GH_APP_PRIVATE_KEY/GH_APP_INSTALLATION_ID または GITHUB_TOKEN を設定してください。');
}

// ── 共通ヘッダー ────────────────────────────────────────────────────────
async function headers(accept = 'application/vnd.github.v3+json') {
  const token = await getToken();
  return {
    'Accept': accept,
    'User-Agent': UA,
    'Authorization': `token ${token}`,
  };
}

// ── ファイル取得 (content + sha) ────────────────────────────────────────
// ref: 省略時は GITHUB_BRANCH (デフォルト main)
async function getFile(filepath, ref) {
  const branch = ref || BRANCH();
  const url = `${API_BASE}/repos/${REPO()}/contents/${filepath}?ref=${branch}`;
  const h = await headers();
  const res = await fetch(url, { headers: h });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub GET ${res.status}: ${text}`);
  }
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { content, sha: data.sha };
}

// ── ファイル書き戻し (PUT) ──────────────────────────────────────────────
// ref: 省略時は GITHUB_BRANCH (デフォルト main)
async function putFile(filepath, content, sha, message, ref) {
  const branch = ref || BRANCH();
  const url = `${API_BASE}/repos/${REPO()}/contents/${filepath}`;
  const h = await headers();
  const body = JSON.stringify({
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha,
    branch,
  });
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...h, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT ${res.status}: ${text}`);
  }
  return res.json();
}

// ── frontmatter フィールド更新 ──────────────────────────────────────────
function updateFrontmatter(raw, updates) {
  const match = raw.match(/^(---\r?\n)([\s\S]+?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new Error('frontmatter が見つかりません');

  let fm = match[2];
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^(${key}:\\s*)"?[^"\\n]*"?\\s*$`, 'm');
    if (regex.test(fm)) {
      fm = fm.replace(regex, `$1"${value}"`);
    } else {
      fm += `\n${key}: "${value}"`;
    }
  }
  return match[1] + fm + match[3] + match[4];
}

// ── JST 現在時刻 ISO 文字列 ─────────────────────────────────────────────
function nowJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

// ── PR 一覧から branch に一致する PR を取得 ────────────────────────────
async function findPR(headBranch) {
  const url = `${API_BASE}/repos/${REPO()}/pulls?head=${REPO().split('/')[0]}:${headBranch}&state=open&per_page=5`;
  const h = await headers();
  const res = await fetch(url, { headers: h });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PR list ${res.status}: ${text}`);
  }
  const prs = await res.json();
  return prs.length > 0 ? prs[0] : null;
}

// ── PR の詳細を取得する ───────────────────────────────────────────────
async function getPR(prNumber) {
  const url = `${API_BASE}/repos/${REPO()}/pulls/${prNumber}`;
  const h = await headers();
  const res = await fetch(url, { headers: h });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub get PR ${res.status}: ${text}`);
  }
  return res.json();
}

// ── PR の mergeable 状態が確定するまで待つ ─────────────────────────────
// GitHub は GET /pulls/{n} を呼んだ瞬間に mergeable の再計算を開始するため、
// 1) 初回呼び出しで再計算をトリガ → 2) 短いインターバルでポーリング、という流れ。
//
// mergeable_state の意味（GitHub 公式）:
//   clean       — マージ可能（CI も green）
//   has_hooks   — マージ可能（pre-receive hook あり）
//   unstable    — マージ可能（CI 失敗中だが merge は可能）
//   unknown     — まだ計算中（再試行対象）
//   blocked     — branch protection 等で blocked（再試行対象 / 場合により失敗）
//   behind      — base に追いついていない
//   dirty       — コンフリクトあり（マージ不可）
//   draft       — draft PR
//
async function waitForMergeable(prNumber, { maxAttempts = 12, intervalMs = 2000 } = {}) {
  const MERGEABLE_STATES = new Set(['clean', 'has_hooks', 'unstable']);
  let lastPr = null;

  for (let i = 0; i < maxAttempts; i++) {
    const pr = await getPR(prNumber);
    lastPr = pr;

    // mergeable=true かつ state がマージ許可セットなら即 OK
    if (pr.mergeable === true && MERGEABLE_STATES.has(pr.mergeable_state)) {
      return pr;
    }

    // mergeable=true だが state が unknown/blocked でも少し待って再試行
    // mergeable=null = GitHub がまだ計算中 → 待機
    // mergeable=false でも mergeable_state が unknown のうちは再計算待ちのことがある
    //   （push 直後など）→ ここでは throw しない
    if (pr.mergeable === false && pr.mergeable_state === 'dirty') {
      throw new Error(`PR #${prNumber} はコンフリクト状態です (mergeable_state=dirty)`);
    }

    console.log(`[waitForMergeable] PR #${prNumber} attempt ${i + 1}/${maxAttempts}: mergeable=${pr.mergeable} state=${pr.mergeable_state}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }

  // 最後まで確定しなかった → 楽観的に最後の状態を返す（mergePR 側でリトライ）
  console.warn(`[waitForMergeable] PR #${prNumber} 状態未確定のままタイムアウト → 楽観的に続行`);
  return lastPr;
}

// ── PR をマージする（405 not mergeable に対するリトライ付き）───────────
async function mergePR(prNumber, commitTitle, { maxAttempts = 4, intervalMs = 3000 } = {}) {
  const url = `${API_BASE}/repos/${REPO()}/pulls/${prNumber}/merge`;
  const body = JSON.stringify({
    commit_title: commitTitle || `merge: PR #${prNumber}`,
    merge_method: 'squash',
  });

  let lastError = null;
  for (let i = 0; i < maxAttempts; i++) {
    const h = await headers();
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) return res.json();

    const text = await res.text();
    lastError = new Error(`GitHub merge ${res.status}: ${text}`);

    // 405 "not mergeable" は GitHub の mergeable 再計算待ちで一時的に出ることがある
    // → 待って再取得 → 再試行
    const retryable = res.status === 405 || res.status === 409 || res.status === 502 || res.status === 503;
    if (!retryable || i === maxAttempts - 1) {
      throw lastError;
    }
    console.warn(`[mergePR] PR #${prNumber} attempt ${i + 1}/${maxAttempts} 失敗 (${res.status}) → ${intervalMs}ms 待機して再試行`);
    await new Promise(r => setTimeout(r, intervalMs));
    // 再取得して状態を更新（GitHub に再計算を促す）
    try { await getPR(prNumber); } catch { /* noop */ }
  }
  throw lastError || new Error(`GitHub merge failed after ${maxAttempts} attempts`);
}

// ── PR をクローズする ──────────────────────────────────────────────────
async function closePR(prNumber) {
  const url = `${API_BASE}/repos/${REPO()}/pulls/${prNumber}`;
  const h = await headers();
  const body = JSON.stringify({ state: 'closed' });
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...h, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub close PR ${res.status}: ${text}`);
  }
  return res.json();
}

// ── PR にコメントを追加する ────────────────────────────────────────────
async function commentOnPR(prNumber, body) {
  const url = `${API_BASE}/repos/${REPO()}/issues/${prNumber}/comments`;
  const h = await headers();
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub comment ${res.status}: ${text}`);
  }
  return res.json();
}

// ── GitHub Actions workflow_dispatch をトリガーする ─────────────────────
async function triggerWorkflow(workflowFile, ref, inputs) {
  const url = `${API_BASE}/repos/${REPO()}/actions/workflows/${workflowFile}/dispatches`;
  const h = await headers();
  const body = JSON.stringify({ ref: ref || 'main', inputs: inputs || {} });
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub dispatch ${res.status}: ${text}`);
  }
  // 204 No Content = 成功
  return { ok: true };
}

// ── Workflow Runs 一覧取得 ─────────────────────────────────────────────
// params 例: { created: '>=2026-04-12', per_page: '1' }
async function listWorkflowRuns(workflowFile, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}/repos/${REPO()}/actions/workflows/${workflowFile}/runs${qs ? '?' + qs : ''}`;
  const h = await headers();
  const res = await fetch(url, { headers: h });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub workflow runs ${res.status}: ${text}`);
  }
  return res.json();
}

// ── ディレクトリ内容一覧取得 ──────────────────────────────────────────
async function listDirectory(dirpath, ref) {
  const branch = ref || BRANCH();
  const url = `${API_BASE}/repos/${REPO()}/contents/${dirpath}?ref=${branch}`;
  const h = await headers();
  const res = await fetch(url, { headers: h });
  if (!res.ok) {
    if (res.status === 404) return [];
    const text = await res.text();
    throw new Error(`GitHub listDir ${res.status}: ${text}`);
  }
  return res.json();
}

// ── frontmatter フィールド抽出 ────────────────────────────────────────
function extractFmField(raw, key) {
  const m = raw.match(new RegExp(`^${key}:\\s*"?([^"\\n\\r]+)"?`, 'm'));
  return m ? m[1].trim() : '';
}

// ── 指定日の approved 記事を検索（main ブランチ）────────────────────
async function findApprovedArticlesForDate(targetDateJST, excludeFilename) {
  let items;
  try {
    items = await listDirectory('content/posts', 'main');
  } catch (e) {
    console.warn(`[findApproved] ディレクトリ読み取り失敗: ${e.message}`);
    return [];
  }

  const approved = [];
  for (const item of items) {
    if (!item.name.endsWith('.md') || item.name === excludeFilename) continue;
    try {
      const { content, sha } = await getFile(item.path, 'main');
      const status = extractFmField(content, 'review_status');
      if (status !== 'approved') continue;
      const pa = extractFmField(content, 'publish_at');
      if (!pa) continue;
      const d = new Date(pa);
      if (isNaN(d)) continue;
      const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      if (jst.toISOString().split('T')[0] !== targetDateJST) continue;
      const slot = extractFmField(content, 'publish_slot');
      const title = extractFmField(content, 'title');
      approved.push({ filename: item.name, slot, title, content, sha });
    } catch (e) {
      console.warn(`[findApproved] ${item.name} 読み取りスキップ: ${e.message}`);
    }
  }
  return approved;
}

// ── 公開枠の再調整（承認済み1本だけ残った場合 evening→morning）─────
async function readjustPublishSlots(publishAtStr, excludeFilename) {
  if (!publishAtStr) return null;
  const d = new Date(publishAtStr);
  if (isNaN(d)) return null;
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const targetDate = jst.toISOString().split('T')[0];

  const approved = await findApprovedArticlesForDate(targetDate, excludeFilename);
  if (approved.length === 1 && approved[0].slot === 'evening') {
    const article = approved[0];
    const morningAt = `${targetDate}T11:05:00.000+09:00`;
    const updated = updateFrontmatter(article.content, {
      publish_slot: 'morning',
      publish_at: morningAt,
      updated_at: nowJST(),
    });
    await putFile(`content/posts/${article.filename}`, updated, article.sha,
      `readjust: ${article.title || article.filename} を morning 枠へ変更`, 'main');
    console.log(`[readjust] ${article.filename} を evening → morning に変更`);
    return { filename: article.filename, title: article.title, publishAt: morningAt };
  }
  return null;
}

module.exports = {
  getFile, putFile, updateFrontmatter, nowJST,
  findPR, getPR, waitForMergeable, mergePR, closePR, commentOnPR,
  triggerWorkflow, listWorkflowRuns,
  listDirectory, extractFmField, findApprovedArticlesForDate, readjustPublishSlots,
};
