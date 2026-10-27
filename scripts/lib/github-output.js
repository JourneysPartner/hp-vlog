'use strict';

const fs = require('fs');
const crypto = require('crypto');

function formatGithubOutputs(rows, randomBytes = crypto.randomBytes) {
  return Object.entries(rows || {}).map(([key, rawValue]) => {
    const value = String(rawValue == null ? '' : rawValue);
    let delimiter;
    do {
      delimiter = `CODEX_${randomBytes(18).toString('hex')}`;
    } while (value.includes(delimiter));
    return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
  }).join('');
}

function writeGithubOutputs(file, rows) {
  if (!file) return;
  fs.appendFileSync(file, formatGithubOutputs(rows), 'utf8');
}

module.exports = { formatGithubOutputs, writeGithubOutputs };
