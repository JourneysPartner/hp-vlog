'use strict';

/**
 * シミュレーター専用の依存ゼロCommonJSバンドラ。
 * 公開ページ生成とは独立しており、このスクリプトを明示実行したときだけ成果物を作る。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const ENTRY_FILE = path.join(REPO_ROOT, 'src', 'simulators', 'browser-entry.js');
const DATA_SOURCE_FILE = path.join(
  REPO_ROOT, 'src', 'tax-engine', 'masters', 'data-source.js'
);
const OUTPUT_DIR = path.join(REPO_ROOT, 'assets', 'js');
const MANIFEST_FILE = path.join(OUTPUT_DIR, 'tax-simulator-manifest.json');

function normalizedPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function moduleId(filePath) {
  return normalizedPath(path.relative(REPO_ROOT, filePath));
}

function extractRequires(source, id) {
  const dependencies = [];
  const requireCall = /\brequire\s*\(([^)]*)\)/g;
  let match;
  while ((match = requireCall.exec(source)) !== null) {
    const argument = match[1].trim();
    const literal = /^(?:'([^']+)'|"([^"]+)")$/.exec(argument);
    if (!literal) throw new Error(`${id}: 動的requireには対応していません: ${match[0]}`);
    const request = literal[1] || literal[2];
    if (!request.startsWith('./') && !request.startsWith('../')) {
      throw new Error(`${id}: 相対パス以外のrequireには対応していません: ${request}`);
    }
    dependencies.push(request);
  }
  return dependencies;
}

function resolveModule(fromFile, request) {
  const unresolved = path.resolve(path.dirname(fromFile), request);
  const candidates = path.extname(unresolved)
    ? [unresolved]
    : [unresolved, `${unresolved}.js`, `${unresolved}.json`, path.join(unresolved, 'index.js')];
  const resolved = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!resolved) throw new Error(`${moduleId(fromFile)}: 依存を解決できません: ${request}`);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${moduleId(fromFile)}: リポジトリ外の依存は読み込めません: ${request}`);
  }
  if (!['.js', '.json'].includes(path.extname(resolved))) {
    throw new Error(`${moduleId(fromFile)}: .js/.json以外は読み込めません: ${request}`);
  }
  return resolved;
}

function collectDependencyGraph(entryFile, overrides = new Map()) {
  const modules = new Map();

  function visit(filePath) {
    const id = moduleId(filePath);
    if (modules.has(id)) return;
    const extension = path.extname(filePath);
    // checkout 環境（autocrlf）でソースの改行が CRLF になっても contenthash が
    // 揺れないよう、バンドルへ埋め込む前に LF へ正規化する（決定性の担保）
    const rawSource = overrides.has(id) ? overrides.get(id) : fs.readFileSync(filePath, 'utf8');
    const source = rawSource.replaceAll('\r\n', '\n');
    if (extension === '.json') JSON.parse(source);
    const requests = extension === '.js' ? extractRequires(source, id) : [];
    const dependencies = {};
    modules.set(id, { id, extension, source, dependencies });
    for (const request of requests) {
      const resolved = resolveModule(filePath, request);
      dependencies[request] = moduleId(resolved);
      visit(resolved);
    }
  }

  visit(entryFile);
  return modules;
}

function renderModuleBody(record) {
  if (record.extension === '.json') return `module.exports = ${record.source.trim()};`;
  return record.source.replace(/^#![^\n]*(?:\n|$)/, '');
}

function renderBundle(modules, entryId) {
  // モジュール表・依存表の双方をパス順に固定し、探索順やファイルシステム順を出力へ漏らさない。
  const records = [...modules.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const moduleRows = records.map(record =>
    `${JSON.stringify(record.id)}: function (module, exports, require) {\n${renderModuleBody(record)}\n}`);
  const dependencyRows = records.map(record => {
    const sortedDependencies = {};
    for (const request of Object.keys(record.dependencies).sort()) {
      sortedDependencies[request] = record.dependencies[request];
    }
    return `${JSON.stringify(record.id)}: ${JSON.stringify(sortedDependencies)}`;
  });

  return `'use strict';\n(function (root) {\n` +
    `  'use strict';\n` +
    `  var modules = {\n${moduleRows.map(row => `    ${row}`).join(',\n')}\n  };\n` +
    `  var dependencies = {\n${dependencyRows.map(row => `    ${row}`).join(',\n')}\n  };\n` +
    `  var cache = Object.create(null);\n` +
    `  function load(id) {\n` +
    `    if (cache[id]) return cache[id].exports;\n` +
    `    if (!Object.prototype.hasOwnProperty.call(modules, id)) throw new Error('Unknown module: ' + id);\n` +
    `    var module = { exports: {} };\n` +
    `    cache[id] = module;\n` +
    `    modules[id](module, module.exports, function (request) {\n` +
    `      var target = dependencies[id][request];\n` +
    `      if (!target) throw new Error(id + ': Unknown dependency: ' + request);\n` +
    `      return load(target);\n` +
    `    });\n` +
    `    return module.exports;\n` +
    `  }\n` +
    `  root.TaxSimulator = load(${JSON.stringify(entryId)});\n` +
    `})(window);\n`;
}

function validateBundledSnapshot(snapshotFiles, fsSnapshotInfo, computeHash) {
  const bundledHash = computeHash(snapshotFiles);
  if (bundledHash !== fsSnapshotInfo.snapshotHash) {
    throw new Error(
      `同梱マスターのsnapshotHashがfs版と一致しません: ${bundledHash} !== ${fsSnapshotInfo.snapshotHash}`
    );
  }
  const bundledId = `tax-masters-${bundledHash.slice(0, 16)}`;
  if (bundledId !== fsSnapshotInfo.snapshotId) {
    throw new Error(
      `同梱マスターのsnapshotIdがfs版と一致しません: ${bundledId} !== ${fsSnapshotInfo.snapshotId}`
    );
  }
  return bundledHash;
}

function createBrowserDataSourceModule(snapshotFiles, snapshotInfo) {
  const serializableFiles = snapshotFiles.map(file => ({
    path: normalizedPath(file.path),
    content: Buffer.isBuffer(file.content) ? file.content.toString('utf8') : String(file.content),
  }));
  for (let index = 0; index < snapshotFiles.length; index++) {
    const original = Buffer.isBuffer(snapshotFiles[index].content)
      ? snapshotFiles[index].content
      : Buffer.from(snapshotFiles[index].content, 'utf8');
    const roundTrip = Buffer.from(serializableFiles[index].content, 'utf8');
    if (!original.equals(roundTrip)) {
      throw new Error(`${snapshotFiles[index].path}: 同梱時のUTF-8変換で生バイト列が変化しました`);
    }
  }

  return `'use strict';\n\n` +
    `// BUNDLED_SNAPSHOT_FILES_START（実行時WebCrypto検証の対象）\n` +
    `const SNAPSHOT_FILES = Object.freeze(${JSON.stringify(serializableFiles)});\n` +
    `const SNAPSHOT_INFO = Object.freeze(${JSON.stringify(snapshotInfo)});\n` +
    `const ROUNDING_RULES_PATH = 'data/rounding-rules/rules.json';\n\n` +
    `function getSnapshotFiles() { return SNAPSHOT_FILES; }\n` +
    `function getMasterDocuments() {\n` +
    `  return SNAPSHOT_FILES.filter(file => file.path.startsWith('data/') && file.path.endsWith('.json'));\n` +
    `}\n` +
    `function getRoundingRulesContent() {\n` +
    `  const file = SNAPSHOT_FILES.find(item => item.path === ROUNDING_RULES_PATH);\n` +
    `  if (!file) throw new Error('端数規則マスターが同梱されていません');\n` +
    `  return file.content;\n` +
    `}\n` +
    `function getBundledSnapshotInfo() { return SNAPSHOT_INFO; }\n` +
    `function computeSnapshotHash() {\n` +
    `  throw new Error('ブラウザではTaxSimulator.verify()で非同期検証してください');\n` +
    `}\n\n` +
    `module.exports = Object.freeze({\n` +
    `  getSnapshotFiles, getMasterDocuments, getRoundingRulesContent,\n` +
    `  getBundledSnapshotInfo, computeSnapshotHash,\n` +
    `});\n`;
}

function build() {
  const dataSource = require('../src/tax-engine/masters/data-source.js');
  const snapshot = require('../src/tax-engine/masters/snapshot.js');
  const snapshotFiles = dataSource.getSnapshotFiles();
  const snapshotInfo = snapshot.getSnapshotInfo();
  validateBundledSnapshot(snapshotFiles, snapshotInfo, dataSource.computeSnapshotHash);

  const browserDataSource = createBrowserDataSourceModule(snapshotFiles, snapshotInfo);
  const overrides = new Map([[moduleId(DATA_SOURCE_FILE), browserDataSource]]);
  const modules = collectDependencyGraph(ENTRY_FILE, overrides);
  const bundle = renderBundle(modules, moduleId(ENTRY_FILE));
  const bytes = Buffer.from(bundle, 'utf8');
  const contentHash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const fileName = `tax-simulator.${contentHash}.js`;
  const integrity = `sha384-${crypto.createHash('sha384').update(bytes).digest('base64')}`;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const oldFile of fs.readdirSync(OUTPUT_DIR)) {
    if (/^tax-simulator\.[0-9a-f]{8}\.js$/.test(oldFile) && oldFile !== fileName) {
      fs.unlinkSync(path.join(OUTPUT_DIR, oldFile));
    }
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, fileName), bytes);
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify({
    fileName,
    integrity,
    snapshotId: snapshotInfo.snapshotId,
  }, null, 2)}\n`, 'utf8');
  return Object.freeze({ fileName, integrity, snapshotId: snapshotInfo.snapshotId, bundle });
}

if (require.main === module) {
  try {
    const result = build();
    process.stdout.write(`シミュレーターバンドルを生成しました: ${result.fileName}\n`);
  } catch (error) {
    process.stderr.write(`シミュレーターバンドル生成失敗: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  build,
  collectDependencyGraph,
  renderBundle,
  validateBundledSnapshot,
  createBrowserDataSourceModule,
});
