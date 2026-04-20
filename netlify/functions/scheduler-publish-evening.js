'use strict';

/**
 * scheduler-publish-evening — Netlify Scheduled Function（17時台公開用）
 *
 * 毎日 JST 17:05 に起動し、GitHub Actions の publish-scheduled.yml を
 * workflow_dispatch で叩く。morning 枠と同じワークフローを使う。
 *
 * スケジュールは netlify.toml [functions."scheduler-publish-evening"] で定義。
 */

const { triggerWorkflow, listWorkflowRuns } = require('./lib/github-api');

const WORKFLOW_FILE = 'publish-scheduled.yml';
const TRIGGER_SOURCE = 'scheduler-publish-evening';

function todayJST() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

exports.handler = async (event) => {
  const dateJST = todayJST();
  console.log(`[scheduler-evening] ${WORKFLOW_FILE} チェック開始 (JST ${dateJST})`);

  try {
    const needle = `[source=${TRIGGER_SOURCE}][jst=${dateJST}]`;

    const data = await listWorkflowRuns(WORKFLOW_FILE, { per_page: '10' });
    const runs = data.workflow_runs || [];
    const alreadyRun = runs.some(r => (r.display_title || '').includes(needle));

    if (alreadyRun) {
      console.log(`[scheduler-evening] ${WORKFLOW_FILE} は JST ${dateJST} に evening scheduler 由来で実行済み → スキップ`);
      return {
        statusCode: 200,
        body: JSON.stringify({ status: 'skipped', reason: 'already dispatched today by evening scheduler', dateJST }),
      };
    }

    await triggerWorkflow(WORKFLOW_FILE, 'main', {
      trigger_source: TRIGGER_SOURCE,
      scheduled_date_jst: dateJST,
    });
    console.log(`[scheduler-evening] ${WORKFLOW_FILE} を dispatch しました (JST ${dateJST})`);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'dispatched', workflow: WORKFLOW_FILE, dateJST }),
    };
  } catch (err) {
    console.error(`[scheduler-evening] ${WORKFLOW_FILE} エラー:`, err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
