'use strict';
const fs = require('fs');
const path = require('path');
const { readDraftCron, parseCron, latestExpectedSlot, judgeDraftRan } = require('./lib/draft-schedule');

function checkDraftRan(args = process.argv.slice(2), env = process.env, log = console.log) {
  const index = args.indexOf('--runs');
  if (index < 0 || !args[index + 1]) throw new Error('--runs <file> を指定してください');
  const runs = JSON.parse(fs.readFileSync(args[index + 1], 'utf8'));
  const cron = parseCron(readDraftCron(fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8')));
  if (cron.warning) log(`::warning::${cron.warning}`);
  const slot = latestExpectedSlot(env.CHECK_NOW || new Date(), cron);
  const count = judgeDraftRan(runs, slot);
  const jst = new Date(slot.getTime() + 9 * 60 * 60000);
  const date = jst.toISOString().slice(0, 10);
  const time = jst.toISOString().slice(11, 16);
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][jst.getUTCDay()];
  log(`直近の生成予定: ${date} ${time} JST（${weekday}）／その後に成功した生成: ${count} 件`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `count=${count}\nexpected_jst=${date}\n`, 'utf8');
  if (!count) log(`::error::直近の生成予定（${date}）の後に成功した記事生成がありません`);
  return { count, expected_jst: date, slot };
}

if (require.main === module) checkDraftRan();
module.exports = { checkDraftRan };
