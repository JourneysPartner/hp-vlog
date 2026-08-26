'use strict';

const { connectLambda, getStore } = require('@netlify/blobs');
const { requireBasicAuth } = require('./lib/admin-auth');
const { jstDate, dateOffset, countPrefix, transitionKey } = require('./lib/analytics-store');

async function mapWithConcurrency(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

function sumRows(rows) {
  return rows.reduce((sum, row) => ({
    pageviews: sum.pageviews + row.pageviews,
    visitors: sum.visitors + row.visitors,
  }), { pageviews: 0, visitors: 0 });
}

exports.handler = async (event) => {
  const auth = requireBasicAuth(event);
  if (auth) return auth;
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    // Lambda 互換形式で Netlify Blobs を初期化する。
    connectLambda(event);
    const store = getStore('analytics');
    const today = jstDate();
    const dates = Array.from({ length: 90 }, (_, i) => dateOffset(today, -89 + i));
    const rows = await mapWithConcurrency(dates, 6, async date => {
      const [daily, visitors, transitions] = await Promise.all([
        // アクセス解析は参考値であり、Lambda互換Functionで利用可能な
        // Blobs標準のeventual consistency（最大約60秒の反映差）で取得する。
        store.get(`daily/${date}`, { type: 'json' }),
        countPrefix(store, `uniq/${date}/`),
        store.get(transitionKey(date), { type: 'json' }),
      ]);
      const data = daily && typeof daily === 'object' ? daily : {};
      return {
        date,
        pageviews: Number.isSafeInteger(data.pageviews) ? data.pageviews : 0,
        visitors,
        byPath: data.byPath && typeof data.byPath === 'object' ? data.byPath : {},
        // 問い合わせページへの遷移（遷移元パス別）。どの記事が問い合わせを生んだかの実測。
        contactFrom: transitions && typeof transitions.byFrom === 'object' ? transitions.byFrom : {},
      };
    });

    const contactFrom = {};
    for (const row of rows) {
      for (const [from, count] of Object.entries(row.contactFrom)) {
        if (Number.isSafeInteger(count) && count > 0) contactFrom[from] = (contactFrom[from] || 0) + count;
      }
    }

    const byPath = {};
    for (const row of rows) {
      for (const [path, pageviews] of Object.entries(row.byPath)) {
        if (Number.isSafeInteger(pageviews) && pageviews > 0) byPath[path] = (byPath[path] || 0) + pageviews;
      }
    }
    const summaries = {
      today: sumRows(rows.slice(-1)),
      yesterday: sumRows(rows.slice(-2, -1)),
      sevenDays: sumRows(rows.slice(-7)),
      thirtyDays: sumRows(rows.slice(-30)),
    };
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, today, daily: rows, summaries, byPath, contactFrom }),
    };
  } catch (err) {
    console.error('[admin-analytics] list failed:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'アクセス解析データの取得に失敗しました。' }),
    };
  }
};
