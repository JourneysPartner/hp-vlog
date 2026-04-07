'use strict';

/**
 * 通知送信ヘルパー（Netlify Functions 内部用）
 *
 * review-approve / review-revise / review-skip / notify-dispatch から呼ぶ。
 * 通知失敗は呼び出し元の処理を止めない。
 */

const { buildMessage } = require('./message');

const providers = {
  chatwork:  () => require('./chatwork'),
  lineworks: () => require('./lineworks'),
};

/**
 * 通知を送信する（非致命的）
 *
 * @param {string} event - イベント種別
 * @param {object} data  - 通知データ
 */
async function sendNotification(event, data) {
  const providerName = (process.env.NOTIFY_PROVIDER || 'chatwork').toLowerCase();

  if (providerName === 'none') {
    console.log('[notify] NOTIFY_PROVIDER=none — スキップ');
    return;
  }

  const factory = providers[providerName];
  if (!factory) {
    console.warn(`[notify] 未対応プロバイダ: ${providerName} — スキップ`);
    return;
  }

  const provider = factory();
  const message  = buildMessage(event, data);

  console.log(`[notify] provider=${providerName}, event=${event}`);

  try {
    await provider.send(message);
    console.log('[notify] 送信完了');
  } catch (err) {
    console.error(`[notify] 送信失敗（${providerName}）: ${err.message}`);
  }
}

module.exports = { sendNotification, buildMessage };
