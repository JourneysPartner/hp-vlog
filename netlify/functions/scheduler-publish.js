'use strict';

/**
 * scheduler-publish — Netlify Scheduled Function
 *
 * 毎日 JST 11:05 に起動し、GitHub Actions の publish-scheduled.yml を
 * workflow_dispatch で叩く。
 *
 * 二重起動防止:
 *   GitHub workflow runs の display_title に
 *   [source=scheduler-publish][jst=YYYY-MM-DD] が含まれるかで判定。
 *   手動実行 (source=manual) は対象外なので、手動 → 自動の順でも自動がスキップされない。
 *
 * スケジュールは netlify.toml [functions."scheduler-publish"] で定義。
 */

const { triggerWorkflow, listWorkflowRuns } = require('./lib/github-api');

const WORKFLOW_FILE = 'publish-scheduled.yml';
const TRIGGER_SOURCE = 'scheduler-publish';

// JST の今日の日付 (YYYY-MM-DD) を返す
function todayJST() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

exports.handler = async (event) => {
  const dateJST = todayJST();
  console.log(`[scheduler] ${WORKFLOW_FILE} チェック開始 (JST ${dateJST})`);

  try {
    // display_title (= run-name) に [source=...][jst=...] が入っているので判定
    const needle = `[source=${TRIGGER_SOURCE}][jst=${dateJST}]`;

    const data = await listWorkflowRuns(WORKFLOW_FILE, { per_page: '10' });
    const runs = data.workflow_runs || [];
    const alreadyRun = runs.some(r => (r.display_title || '').includes(needle));

    if (alreadyRun) {
      console.log(`[scheduler] ${WORKFLOW_FILE} は JST ${dateJST} に scheduler 由来で実行済み → スキップ`);
      return {
        statusCode: 200,
        body: JSON.stringify({ status: 'skipped', reason: 'already dispatched today by scheduler', dateJST }),
      };
    }

    // workflow_dispatch で起動
    await triggerWorkflow(WORKFLOW_FILE, 'main', {
      trigger_source: TRIGGER_SOURCE,
      scheduled_date_jst: dateJST,
    });
    console.log(`[scheduler] ${WORKFLOW_FILE} を dispatch しました (JST ${dateJST})`);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'dispatched', workflow: WORKFLOW_FILE, dateJST }),
    };
  } catch (err) {
    console.error(`[scheduler] ${WORKFLOW_FILE} エラー:`, err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
