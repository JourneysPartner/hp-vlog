'use strict';

/**
 * 税務マスターのNode向けデータ供給源。
 * ブラウザバンドルでは、このモジュールだけをビルド時生成モジュールへ差し替える。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MASTER_ROOT_DIR = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'data',
  'tax-simulator',
  'masters'
);
const MASTER_DATA_DIR = path.join(MASTER_ROOT_DIR, 'data');
const DEPENDENCIES_FILE = path.join(MASTER_ROOT_DIR, 'simulator-dependencies.json');
const ROUNDING_RULES_PATH = 'data/rounding-rules/rules.json';

function normalizedSnapshotPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function listFiles(directory, jsonOnly) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(target, jsonOnly));
    else if (entry.isFile() && (!jsonOnly || entry.name.endsWith('.json'))) files.push(target);
  }
  return files.sort();
}

function getMasterDocuments() {
  return listFiles(MASTER_DATA_DIR, true).map(file => ({
    path: normalizedSnapshotPath(path.relative(MASTER_ROOT_DIR, file)),
    content: fs.readFileSync(file, 'utf8'),
  }));
}

function getRoundingRulesContent() {
  return fs.readFileSync(path.join(MASTER_ROOT_DIR, ...ROUNDING_RULES_PATH.split('/')), 'utf8');
}

function getSnapshotFiles() {
  return [
    ...listFiles(MASTER_DATA_DIR, false),
    DEPENDENCIES_FILE,
  ].map(file => ({
    path: normalizedSnapshotPath(path.relative(MASTER_ROOT_DIR, file)),
    content: fs.readFileSync(file),
  }));
}

/**
 * 相対パスと生バイト列を長さ付きで連結し、列挙順に依存しないSHA-256を返す。
 */
function computeSnapshotHash(files) {
  if (!Array.isArray(files)) throw new TypeError('filesは配列で指定してください');
  const normalized = files.map((file, index) => {
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      throw new TypeError(`files[${index}]はオブジェクトで指定してください`);
    }
    if (typeof file.path !== 'string' || file.path.length === 0) {
      throw new TypeError(`files[${index}].pathは空でない文字列で指定してください`);
    }
    const content = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, 'utf8');
    return { path: normalizedSnapshotPath(file.path), content };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const hash = crypto.createHash('sha256');
  for (const file of normalized) {
    const pathBytes = Buffer.from(file.path, 'utf8');
    hash.update(Buffer.from(`${pathBytes.length}:`, 'utf8'));
    hash.update(pathBytes);
    hash.update(Buffer.from(`:${file.content.length}:`, 'utf8'));
    hash.update(file.content);
  }
  return hash.digest('hex');
}

function getBundledSnapshotInfo() {
  return null;
}

module.exports = Object.freeze({
  getMasterDocuments,
  getRoundingRulesContent,
  getSnapshotFiles,
  computeSnapshotHash,
  getBundledSnapshotInfo,
});
