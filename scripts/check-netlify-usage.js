'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const TOKEN = process.env.NETLIFY_AUTH_TOKEN;
if (!TOKEN) {
  console.error('NETLIFY_AUTH_TOKEN が設定されていません');
  process.exit(1);
}

const SITE_ID = '47d6068a-b960-45ca-aa58-f1f997b00344';

function api(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.netlify.com/api/v1${path}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        resolve(JSON.parse(body));
      });
    });
    req.on('error', reject);
  });
}

async function main() {
  const account = (await api('/accounts'))[0];
  const periodStart = account.current_usage_period_start?.split('T')[0] || '?';
  const periodEnd = account.next_usage_period_start?.split('T')[0] || '?';
  const creditsIncluded = account.capabilities?.credits?.included || '?';
  const creditsUsed = account.capabilities?.credits?.used || 0;

  console.log(`\n== Netlify 利用状況 (${account.name}) ==`);
  console.log(`請求期間: ${periodStart} 〜 ${periodEnd}`);
  console.log(`クレジット: ${creditsUsed} / ${creditsIncluded} 使用\n`);

  let allDeploys = [];
  for (let page = 1; page <= 10; page++) {
    const ds = await api(`/sites/${SITE_ID}/deploys?per_page=100&page=${page}`);
    if (!ds.length) break;
    allDeploys = allDeploys.concat(ds);
    const oldest = ds[ds.length - 1].created_at?.split('T')[0];
    if (oldest < periodStart) break;
  }

  const inPeriod = allDeploys.filter((d) => d.created_at >= account.current_usage_period_start);

  let built = 0, skipped = 0, totalSec = 0;
  let previewBuilt = 0, previewSkipped = 0;
  let productionBuilt = 0;
  for (const d of inPeriod) {
    const isPreview = d.context === 'deploy-preview';
    if (d.deploy_time) {
      built++;
      totalSec += d.deploy_time;
      if (isPreview) previewBuilt++;
      if (d.context === 'production') productionBuilt++;
    } else {
      skipped++;
      if (isPreview) previewSkipped++;
    }
  }

  const days = Math.max(1, Math.ceil((Date.now() - new Date(account.current_usage_period_start).getTime()) / 86400000));
  const mins = Math.ceil(totalSec / 60);

  console.log(`== mori-zeirishi.net デプロイ (今期 ${periodStart}〜) ==`);
  console.log(`デプロイ総数: ${inPeriod.length} 件`);
  console.log(`ビルド実行:   ${built} 件 (${totalSec} 秒 ≒ ${mins} 分)`);
  console.log(`  本番:       ${productionBuilt} 件`);
  console.log(`  プレビュー: ${previewBuilt} 件`);
  console.log(`スキップ:     ${skipped} 件 (うちプレビュー ${previewSkipped} 件)`);
  console.log(`1日平均:      ${(mins / days).toFixed(1)} 分/日 (${days} 日間)`);
  console.log(`月間推計:     ${Math.round((mins / days) * 30)} 分/月`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
