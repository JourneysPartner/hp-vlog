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

// ── PR をマージする ────────────────────────────────────────────────────
async function mergePR(prNumber, commitTitle) {
  const url = `${API_BASE}/repos/${REPO()}/pulls/${prNumber}/merge`;
  const h = await headers();
  const body = JSON.stringify({
    commit_title: commitTitle || `merge: PR #${prNumber}`,
    merge_method: 'squash',
  });
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...h, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub merge ${res.status}: ${text}`);
  }
  return res.json();
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

module.exports = {
  getFile, putFile, updateFrontmatter, nowJST,
  findPR, mergePR, closePR, commentOnPR, triggerWorkflow,
};
