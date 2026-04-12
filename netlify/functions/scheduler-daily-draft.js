'use strict';

/**
 * scheduler-daily-draft — Netlify Scheduled Function
 *
 * 毎日 JST 09:05 に起動し、GitHub Actions の daily-draft.yml を
 * workflow_dispatch で叩く。
 *
 * 二重起動防止:
 *   GitHub workflow runs の display_title に
 *   [source=scheduler-daily-draft][jst=YYYY-MM-DD] が含まれるかで判定。
 *   手動実行 (source=manual) は対象外なので、手動 → 自動の順でも自動がスキップされない。
 *
 * スケジュールは netlify.toml [functions."scheduler-daily-draft"] で定義。
 */

const { triggerWorkflow, listWorkflowRuns } = require('./lib/github-api');

const WORKFLOW_FILE = 'daily-draft.yml';
const TRIGGER_SOURCE = 'scheduler-daily-draft';

// JST の今日の日付 (YYYY-MM-DD) を返す
function todayJST() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

exports.handler = async (event) => {
  const dateJST = todayJST();
  console.log(`[scheduler] ${WORKFLOW_FILE} チェック開始 (JST ${dateJST})`);

  try {
    // 直近のワークフロー実行を取得し、同日・同ソースの run があるか確認する。
    // display_title (= run-name) に [source=...][jst=...] が入っているのでそれで判定。
    const needle = `[source=${TRIGGER_SOURCE}][jst=${dateJST}]`;

    // 直近 10 件を取得して display_title にマッチする run を探す
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
