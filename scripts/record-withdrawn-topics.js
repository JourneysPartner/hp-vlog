'use strict';
const fs = require('fs');
const { appendWithdrawnTopics } = require('./lib/withdrawn-topics');

function recordWithdrawnFile(file, target) {
  if (!file || !fs.existsSync(file)) return;
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('取り下げ記録は JSON 配列で指定してください');
  if (entries.length) appendWithdrawnTopics(entries, target);
}

if (require.main === module) recordWithdrawnFile(process.argv[2]);
module.exports = { recordWithdrawnFile };
