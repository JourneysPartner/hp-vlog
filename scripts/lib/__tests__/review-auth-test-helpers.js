'use strict';

const crypto = require('crypto');
const auth = require('../../../netlify/functions/lib/review-auth');
const secret = crypto.randomBytes(32).toString('hex');

// 実際の署名・検証を通る要求を作る。認証関門を差し替えない。
function authenticatedEvent(event) {
  process.env.REVIEW_PASSWORD = '試験用のパスワードです。本番では使いません。';
  process.env.REVIEW_SESSION_SECRET = secret;
  process.env.CONTEXT = 'production';
  const { key } = auth.configuration(event);
  const value = auth.issueSession(key);
  const session = auth.verifySession(value, key);
  return { ...event, headers: {
    origin: 'https://mori-zeirishi.net',
    'content-type': 'application/json',
    cookie: `${auth.COOKIE_NAME}=${value}`,
    'x-review-token': auth.csrfToken(session, key),
    ...event.headers,
  } };
}

// 実物の認証の部品（review-auth・admin-auth）はそのままに、Blobs の保存先だけを
// 試験用のものに差し替える。入口のモジュールを読み込む前に呼ぶ。
function useTestBlobs(store, { sleep = async () => {} } = {}) {
  const authPath = require.resolve('../../../netlify/functions/lib/review-auth');
  const adminPath = require.resolve('../../../netlify/functions/lib/admin-auth');
  const real = require(authPath);
  const instance = real.createReviewAuth({ env: process.env, getStoreFn: () => store, sleep, log: () => {} });
  require.cache[authPath].exports = { ...real, ...instance };
  delete require.cache[adminPath];
  return instance;
}

// 失敗回数の記録用の偽物。実物と同じ条件付きの書き込みと版を扱う。
function memoryRateStore() {
  const records = new Map();
  const etags = new Map();
  let version = 0;
  return {
    records,
    etags,
    async getWithMetadata(key) {
      return records.has(key) ? { data: structuredClone(records.get(key)), etag: etags.get(key), metadata: {} } : null;
    },
    async set(key, serialized, condition) {
      const modified = condition && condition.onlyIfNew ? !records.has(key) : records.has(key) && condition && condition.onlyIfMatch === etags.get(key);
      if (!modified) return { modified: false };
      records.set(key, JSON.parse(serialized));
      etags.set(key, `版${++version}`);
      return { modified: true, etag: etags.get(key) };
    },
    async delete(key) { records.delete(key); etags.delete(key); },
  };
}

module.exports = { authenticatedEvent, useTestBlobs, memoryRateStore };
