'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');

// ストアは差し替えず、SDKが発行するHTTP要求だけを受ける。実通信は行わない。
function createBlobsHttp({ delay = 2, writeStatus = 200, readStatus = 200, omitEtag = false } = {}) {
  const origin = 'https://review-blobs.example.invalid';
  const connection = {
    siteID: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'),
    edgeURL: origin, uncachedEdgeURL: origin,
  };
  const records = new Map();
  const etags = new Map();
  const requests = [];
  let version = 0;
  const pause = () => new Promise(resolve => setTimeout(resolve, delay));
  const response = (status, body = '', headers = {}) => new Response(status === 204 ? null : body, { status, headers });
  async function fetch(input, options = {}) {
    const url = new URL(input);
    assert.equal(url.origin, origin);
    const prefix = `/${connection.siteID}/site:review-auth/`;
    assert.ok(url.pathname.startsWith(prefix));
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers);
    // 認証ヘッダを記録しない。条件と結果だけを検証に使う。
    const request = { method, key, ifMatch: headers.get('if-match'), ifNoneMatch: headers.get('if-none-match') };
    requests.push(request);
    if (method === 'GET') {
      const exists = records.has(key);
      const status = readStatus !== 200 ? readStatus : exists ? 200 : 404;
      const body = exists ? records.get(key) : '';
      const responseHeaders = exists && !omitEtag ? { etag: etags.get(key), 'content-type': 'application/json' } : {};
      request.status = status;
      await pause();
      return response(status, body, responseHeaders);
    }
    await pause();
    if (method === 'PUT') {
      const status = typeof writeStatus === 'function' ? writeStatus(key) : writeStatus;
      if (status !== 200) {
        request.status = status;
        // ETag付きのエラーでも成功扱いにしてはいけない。
        return response(status, '', { etag: JSON.stringify(`error-version-${++version}`) });
      }
      if ((request.ifNoneMatch === '*' && records.has(key)) || (request.ifMatch !== null && (!records.has(key) || request.ifMatch !== etags.get(key)))) {
        request.status = 412;
        return response(412);
      }
      assert.equal(typeof options.body, 'string');
      assert.equal(typeof JSON.parse(options.body).count, 'number');
      records.set(key, options.body);
      etags.set(key, JSON.stringify(`version-${++version}`));
      request.status = 200;
      return response(200, '', { etag: etags.get(key) });
    }
    if (method === 'DELETE') {
      records.delete(key); etags.delete(key); request.status = 204;
      return response(204);
    }
    throw new Error('試験で認めていないHTTPメソッド');
  }
  return { connection, fetch, records, etags, requests };
}

module.exports = { createBlobsHttp };
