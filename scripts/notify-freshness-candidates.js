#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildFreshnessNotification } = require('./lib/freshness-candidates');

const ROOT = path.join(__dirname, '..');
const CANDIDATES_FILE = path.join(ROOT, 'data', 'freshness', 'candidates.json');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--pr-url') options.prUrl = argv[++index] || '';
  }
  return options;
}

function notificationArgs(notification) {
  return [
    '--event', notification.event,
    '--title', notification.title,
    '--summary', notification.summary,
    '--pr-url', notification.prUrl || '',
  ];
}

function invokeNotify(args) {
  return spawnSync(process.execPath, [path.join(__dirname, 'notify.js'), ...args], {
    stdio: 'inherit',
    env: process.env,
  });
}

function run(options = {}) {
  const log = options.log || console.log;
  const candidatesPath = options.candidatesPath || CANDIDATES_FILE;
  let candidates = options.candidates;
  if (!Array.isArray(candidates)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
      candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    } catch (_) {
      candidates = [];
    }
  }
  const notification = buildFreshnessNotification(candidates, options.prUrl || '');
  if (!notification) {
    log('[freshness] 更新候補が 0 件のため通知しません');
    return { status: 'skipped' };
  }
  const args = notificationArgs(notification);
  const result = (options.notifyImpl || invokeNotify)(args, notification);
  if (result && result.error) throw result.error;
  if (result && Number.isInteger(result.status) && result.status !== 0) {
    throw new Error(`通知スクリプトが終了コード ${result.status} で終了しました`);
  }
  return { status: 'sent', notification };
}

if (require.main === module) {
  try {
    run(parseArgs());
  } catch (error) {
    console.error(`[freshness] 通知に失敗しました: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { CANDIDATES_FILE, parseArgs, notificationArgs, invokeNotify, run };
