'use strict';

/**
 * scheduler-daily-draft — Netlify Scheduled Function
 *
 * 毎日 JST 09:05 に起動し、GitHub Actions の daily-draft.yml を
 * workflow_dispatch で叩く。
 *
 * - GitHub Actions の schedule は数時間遅延することがあるため、
 *   時刻トリガーを Netlify 側に移管した。
 * - 二重起動防止: 同日 (UTC) にすでにワークフロー実行がある場合はスキップ。
 * - auto=true を渡し、workflow 内で 0〜50分のランダム待機を実行させる。
 *
 * スケジュールは netlify.toml [functions."scheduler-daily-draft"] で定義。
 */

const { triggerWorkflow, listWorkflowRuns } = require('./lib/github-api');

const WORKFLOW_FILE = 'daily-draft.yml';

exports.handler = async (event) => {
  console.log(`[scheduler] ${WORKFLOW_FILE} チェック開始`);

  try {
    // 今日の UTC 日付を取得（JST 09:05 = UTC 00:05 なのでほぼ同日）
    const todayUTC = new Date().toISOString().split('T')[0];

    // 本日すでに実行済みかチェック
    const data = await listWorkflowRuns(WORKFLOW_FILE, {
      created: `>=${todayUTC}`,
      per_page: '1',
    });

    if (data.total_count > 0) {
      console.log(`[scheduler] ${WORKFLOW_FILE} は本日すでに ${data.total_count} 件実行済み → スキップ`);
      return {
        statusCode: 200,
        body: JSON.stringify({ status: 'skipped', reason: 'already run today', count: data.total_count }),
      };
    }

    // workflow_dispatch で起動 (auto=true → ランダム待機あり)
    await triggerWorkflow(WORKFLOW_FILE, 'main', { auto: 'true' });
    console.log(`[scheduler] ${WORKFLOW_FILE} を dispatch しました`);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'dispatched', workflow: WORKFLOW_FILE }),
    };
  } catch (err) {
    console.error(`[scheduler] ${WORKFLOW_FILE} エラー:`, err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
