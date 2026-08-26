'use strict';

const { connectLambda, getStore } = require('@netlify/blobs');
const {
  COOKIE_NAME, DEFAULT_PRODUCTION_HOST, jstDate, jstMinute, hash, parseCookies,
  issueVisitorCookie, verifyVisitorCookie, cookieHeader, isProductionRequest, isBot,
  parseBeaconBody, parseBeaconPayload, markUnique, markRate, rateKey, incrementPageview, incrementTransition,
} = require('./lib/analytics-store');

function noContent(headers = {}) {
  return { statusCode: 204, headers: { 'Cache-Control': 'no-store', ...headers }, body: '' };
}

function rawBody(event) {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

async function handler(event, { getStoreFn = getStore } = {}) {
  if (event.httpMethod !== 'POST') return noContent();
  const productionHost = process.env.ANALYTICS_PRODUCTION_HOST || DEFAULT_PRODUCTION_HOST;
  if (!isProductionRequest(event, productionHost) || isBot((event.headers || {})['user-agent'] || (event.headers || {})['User-Agent'])) return noContent();

  const payload = parseBeaconPayload(rawBody(event));
  if (!payload) return noContent();
  const { path, ref } = payload;

  const secret = process.env.ANALYTICS_COOKIE_SECRET;
  if (!secret) {
    console.error('[analytics] ANALYTICS_COOKIE_SECRET is not configured');
    return noContent();
  }

  const cookies = parseCookies((event.headers || {}).cookie || (event.headers || {}).Cookie || '');
  let visitor = verifyVisitorCookie(cookies[COOKIE_NAME], secret);
  let setCookie;
  if (!visitor) {
    const value = issueVisitorCookie(secret);
    visitor = verifyVisitorCookie(value, secret);
    setCookie = cookieHeader(value);
  }

  let store;
  let ownRateMarker;
  try {
    // Netlify Functions の Lambda 互換形式では、Blobs 利用前にリクエストの
    // 接続情報を渡す必要がある。テスト時の注入ストアには不要。
    if (getStoreFn === getStore) connectLambda(event);
    store = getStoreFn('analytics');
    const now = new Date();
    const date = jstDate(now);
    const vidHash = hash(visitor.id);

    // UU は daily に加算せず uniq マーカーの件数から管理画面で算出する。
    await markUnique(store, date, vidHash);

    const minute = jstMinute(now);
    const rate = await markRate(store, minute, vidHash, path);
    if (!rate.modified) return noContent(setCookie ? { 'Set-Cookie': setCookie } : {});
    ownRateMarker = rateKey(minute, vidHash, path);

    const stored = await incrementPageview(store, date, path);
    // 問い合わせページへの遷移なら、どのページから来たかも記録する
    // （どの記事が問い合わせを生んだかの実測。失敗しても閲覧記録には影響させない）
    if (ref) {
      try { await incrementTransition(store, date, ref); }
      catch (e) { console.warn('[track-visit] 遷移の記録に失敗:', e.message); }
    }
    if (!stored) {
      // 自分が作ったマーカーだけを補償削除する。再送は同じ分でも再試行できる。
      await store.delete(ownRateMarker);
      ownRateMarker = null;
      console.warn('[analytics] PV CAS retries exhausted; released own rate marker');
    }
  } catch (err) {
    // Blobs 通信例外でも、作成済みのレートマーカーだけは可能な限り解放する。
    if (store && ownRateMarker) {
      try { await store.delete(ownRateMarker); } catch (cleanupErr) {
        console.warn('[analytics] failed to release own rate marker:', cleanupErr.message);
      }
    }
    // 計測の失敗は公開サイトの表示に影響させない。
    console.warn('[analytics] track failed:', err.message);
  }

  return noContent(setCookie ? { 'Set-Cookie': setCookie } : {});
}

exports.handler = handler;
