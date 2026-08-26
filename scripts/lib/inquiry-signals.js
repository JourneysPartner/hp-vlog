'use strict';
/**
 * 問い合わせ実績の信号（段階2）
 *
 * data/contact-transitions.json（週次エクスポート）には「どのページから
 * 問い合わせページへ進んだか」の実測が入る。ここでは遷移元の記事の
 * 論点（pain_point / subcluster / cluster）を引き、同じ・近い論点の候補を
 * 選定で優先するための判定を提供する。
 *
 * ファイルが無い・実測ゼロの間はすべて 0 を返す（現状はアクセスが少ないため、
 * 効き始めるのはデータが貯まってから）。
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const ROOT = path.join(__dirname, '..', '..');
const SIGNALS_FILE = path.join(ROOT, 'data', 'contact-transitions.json');
const POSTS_DIR = path.join(ROOT, 'content', 'posts');

let _cache;   // { keys:Set<string>, fromCount:number } | null

function slugFromBlogPath(p) {
  const m = String(p || '').match(/^\/blog\/([a-z0-9-]+)\/?$/);
  return m ? m[1] : null;
}

/** 遷移元パス → 記事の論点キー集合（pain / subcluster / cluster）。options はテスト用注入口 */
function buildSignalKeys(options = {}) {
  const signalsFile = options.signalsFile || SIGNALS_FILE;
  const postsDir = options.postsDir || POSTS_DIR;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(signalsFile, 'utf8'));
  } catch (_) {
    return { keys: new Set(), fromCount: 0 };
  }
  const byFrom = parsed && typeof parsed.byFrom === 'object' ? parsed.byFrom : {};
  const slugs = new Set(Object.keys(byFrom).map(slugFromBlogPath).filter(Boolean));
  if (slugs.size === 0) return { keys: new Set(), fromCount: 0 };

  const keys = new Set();
  let matched = 0;
  let files = [];
  try { files = fs.readdirSync(postsDir); } catch (_) { /* 生成環境以外 */ }
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    try {
      const fm = matter(fs.readFileSync(path.join(postsDir, file), 'utf8')).data || {};
      if (!slugs.has(String(fm.slug || ''))) continue;
      matched++;
      for (const key of [fm.pain_point, fm.subcluster, fm.cluster]) {
        if (key) keys.add(String(key));
      }
    } catch (_) { /* 壊れた記事は無視 */ }
  }
  return { keys, fromCount: matched };
}

function loadSignals() {
  if (_cache === undefined) _cache = buildSignalKeys();
  return _cache;
}

/** テスト用: キャッシュを破棄（signalsFile 差し替え後に使う） */
function resetSignalCacheForTest() { _cache = undefined; }

/**
 * この候補は「問い合わせを生んだ記事」と同じ・近い論点か（0 or 1）。
 * pain_point / subcluster / cluster のいずれかが一致すれば 1。
 */
function inquirySignalFor(topic = {}) {
  const { keys } = loadSignals();
  if (keys.size === 0) return 0;
  for (const key of [topic.pain_point, topic.subcluster, topic.cluster]) {
    if (key && keys.has(String(key))) return 1;
  }
  return 0;
}

module.exports = { inquirySignalFor, loadSignals, resetSignalCacheForTest, buildSignalKeys, SIGNALS_FILE };
