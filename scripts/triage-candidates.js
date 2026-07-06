'use strict';

/**
 * triage-candidates.js — 質疑応答事例候補に自動一次選別フィールドを付与する
 *
 * data/nta-shitsugi-topics-candidate.json の各候補に
 *   auto_score / auto_decision / auto_reasons / target_segments / article_potential
 * を付与して書き戻す。
 *
 * adopted / rejected / adoption_note / rejection_note / proposed など手動編集は変更しない。
 * 何度実行しても安全（冪等）。
 *
 *   node scripts/triage-candidates.js          # dry-run（件数集計のみ）
 *   node scripts/triage-candidates.js --apply  # 書き込む
 */

const fs = require('fs');
const path = require('path');
const { applyTriage } = require('./lib/candidate-triage');

const FILE = path.join(__dirname, '..', 'data', 'nta-shitsugi-topics-candidate.json');

function main() {
  const apply = process.argv.includes('--apply');
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const candidates = data.candidates || [];

  const counts = applyTriage(candidates);
  const adopted = candidates.filter(c => c.adopted === true).length;
  const rejected = candidates.filter(c => c.rejected === true).length;

  console.log('[triage] 候補総数:', candidates.length);
  console.log('[triage] auto_decision:', counts);
  console.log('[triage] adopted:', adopted, '/ rejected:', rejected);

  if (data.stats) {
    data.stats.auto_recommend = counts.recommend || 0;
    data.stats.auto_review = counts.review || 0;
    data.stats.auto_reject = counts.reject || 0;
    data.stats.adopted_count = adopted;
    data.stats.rejected_count = rejected;
  }

  if (apply) {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log('[triage] 書き込みました:', FILE);
  } else {
    console.log('[triage] dry-run（--apply で書き込み）');
  }
}

main();
