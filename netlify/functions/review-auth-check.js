'use strict';

const { requireAction } = require('./lib/review-auth');

exports.handler = async event => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  const auth = requireAction(event);
  if (auth.response) return auth.response;
  return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
};
