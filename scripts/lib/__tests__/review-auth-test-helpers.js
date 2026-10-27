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

module.exports = { authenticatedEvent };
