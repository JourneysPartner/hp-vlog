'use strict';

const { requireBasicAuth } = require('./lib/admin-auth');

exports.handler = async (event) => {
  const auth = requireBasicAuth(event);
  if (auth) return auth;

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: {
        Allow: 'GET',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=UTF-8',
      },
      body: 'Method Not Allowed\n',
    };
  }

  return {
    statusCode: 302,
    headers: {
      Location: '/admin/articles',
      'Cache-Control': 'no-store',
    },
    body: '',
  };
};
