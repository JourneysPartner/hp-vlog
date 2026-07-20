'use strict';

const { connectLambda, getStore } = require('@netlify/blobs');
const { jstDate, dateOffset, listPrefixKeys, deleteKeys } = require('./lib/analytics-store');

exports.handler = async (event) => {
  try {
    // Scheduled Function でも Blobs の接続情報を初期化する。
    connectLambda(event);
    const store = getStore('analytics');
    const today = jstDate();
    const oldestRetained = dateOffset(today, -89); // 今日を含む直近90日を残す
    const uniqKeys = await listPrefixKeys(store, 'uniq/');
    const staleUniq = uniqKeys.filter(key => {
      const date = key.split('/')[1];
      return date && date < oldestRetained;
    });
    const rateKeys = await listPrefixKeys(store, 'rate/');
    const staleRate = rateKeys.filter(key => {
      const minute = key.split('/')[1];
      return minute && minute.slice(0, 10) < today;
    });
    await deleteKeys(store, staleUniq);
    await deleteKeys(store, staleRate);
    console.log(`[analytics-cleanup] uniq=${staleUniq.length} rate=${staleRate.length}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, uniq: staleUniq.length, rate: staleRate.length }) };
  } catch (err) {
    console.error('[analytics-cleanup] failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
