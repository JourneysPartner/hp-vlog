#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectContentChange } = require('./lib/nta-content-change');
const indexBuilder = require('./lib/nta-index-builder');
const store = require('./lib/nta-store');

const ROOT = path.join(__dirname, '..');

function git(root, args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim(); }
  catch (_) { return ''; }
}

function gitVersion(root, commit, relativeFile) {
  if (!commit) return null;
  try { return JSON.parse(git(root, ['show', `${commit}:${relativeFile}`])); }
  catch (_) { return null; }
}

function firstAddedCommits(root) {
  const output = git(root, ['log', '--diff-filter=A', '--name-only', '--format=COMMIT:%H', '--', 'data/nta-sources/taxanswer', 'data/nta-sources/shitsugi']);
  const commits = new Map();
  let commit = '';
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('COMMIT:')) commit = line.slice(7);
    else if (line.endsWith('.json') && commit) commits.set(line.replace(/\\/g, '/'), commit);
  }
  return commits;
}

function backfill(options = {}) {
  const root = options.root || ROOT;
  const dryRun = Boolean(options.dryRun);
  const dataDir = path.join(root, 'data', 'nta-sources');
  const files = ['taxanswer', 'shitsugi'].flatMap(type => indexBuilder.listJsonFiles(path.join(dataDir, type)));
  const historyFile = options.historyFile || process.env.NTA_BACKFILL_HISTORY_FILE;
  const historyCache = historyFile ? JSON.parse(fs.readFileSync(historyFile, 'utf8').replace(/^\uFEFF/, '')) : null;
  const added = historyCache ? new Map() : firstAddedCommits(root);
  let firstFetchedCount = 0;
  const changed = [];
  const updates = [];
  for (const file of files) {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    const relativeFile = path.relative(root, file).split(path.sep).join('/');
    const initial = historyCache
      ? historyCache.firstVersions[relativeFile] || null
      : gitVersion(root, added.get(relativeFile), relativeFile);
    const first = initial && initial.fetched_at || current.fetched_at;
    const next = { ...current };
    if (!next.first_fetched_at) {
      next.first_fetched_at = first;
      firstFetchedCount++;
    }
    if (initial && current.fetched_at === initial.fetched_at) {
      delete next.content_changed_at;
      delete next.content_change_kind;
    } else if (initial && current.fetched_at !== initial.fetched_at) {
      const history = historyCache ? [] : git(root, ['log', '--format=%H', '--', relativeFile]).split(/\r?\n/).filter(Boolean);
      let previous = historyCache ? historyCache.previousVersions[relativeFile] || null : null;
      if (!historyCache) {
        for (const commit of history.slice(1)) {
          const version = gitVersion(root, commit, relativeFile);
          if (version && version.fetched_at !== current.fetched_at) {
            previous = version;
            break;
          }
        }
      }
      if (previous) {
        const result = detectContentChange(previous, current, current.fetched_at);
        if (result.content_changed_at) {
          next.content_changed_at = result.content_changed_at;
          next.content_change_kind = result.content_change_kind;
        } else {
          delete next.content_changed_at;
          delete next.content_change_kind;
        }
      }
    }
    if (next.content_changed_at) {
      changed.push({ id: next.id, type: next.type, date: next.content_changed_at, kind: next.content_change_kind });
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) updates.push([file, next]);
  }
  if (!dryRun) {
    for (const [file, entry] of updates) store.writeJsonAtomic(file, entry);
    if (root === ROOT) indexBuilder.saveIndex(indexBuilder.buildIndex());
  }
  return { total: files.length, firstFetchedCount, updated: updates.length, changed };
}

if (require.main === module) {
  const result = backfill({ dryRun: process.argv.includes('--dry-run') });
  console.log(`対象 ${result.total} 件、first_fetched_at 追加 ${result.firstFetchedCount} 件、書換 ${result.updated} 件`);
  for (const item of result.changed) console.log(`${item.id}\t${item.type}\t${item.date}\t${item.kind}`);
}

module.exports = { backfill };
