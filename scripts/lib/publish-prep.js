'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  SIMULATOR_TYPES,
  loadSimulatorDependencies,
  inspectSimulatorDependencies,
  evaluateSimulatorGates,
} = require('./simulator-dependencies');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'data', 'tax-simulator', 'publish-config.json');
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, 'assets', 'js', 'tax-simulator-manifest.json');
const MASTERS_DIR = path.join(REPO_ROOT, 'data', 'tax-simulator', 'masters');

const TOOL_DEFINITIONS = Object.freeze({
  hojinnari: Object.freeze({
    slug: 'hojinnari-simulator',
    name: '法人成りシミュレーター',
    description: '無料で利用できるツールです。個人事業を続ける場合と法人化した場合を同じ前提で比べ、税・社会保険を含む概算と検討すべき論点を整理します。',
    excludedItems: Object.freeze([
      '移行年度の個人期間・法人期間を分けた比較',
      'その他所得、各種所得控除・税額控除',
      '従業員の雇用保険・労災保険',
      '配偶者役員や複数役員',
      '交際費等の申告調整・繰越欠損金',
      '開廃業年の期間分割',
      '消費税を含めた比較（既定では比較対象外として表示）',
    ]),
  }),
  shohizei: Object.freeze({
    slug: 'shohizei-simulator',
    name: '消費税シミュレーター',
    description: '無料で利用できるツールです。消費税の課税方式ごとの概算を比較し、届出やインボイス制度を含む確認ポイントを整理します。',
    excludedItems: Object.freeze([
      '簡易課税選択届出などの届出期限そのものの判定',
      '課税期間短縮、特定新設法人、相続・合併等の免税点特例',
      '相手先別上限の名寄せが必要なケース',
      '課税期間途中のインボイス登録に伴う期間分割',
      '輸出免税売上を含む還付の計算',
      '売上返品・値引き・貸倒れ、旧税率（8%経過措置以前）の取引',
    ]),
  }),
  sozoku: Object.freeze({
    slug: 'sozokuzei-simulator',
    name: '相続税シミュレーター',
    description: '無料で利用できるツールです。相続人と財産の概要から相続税の概算を確認し、分割方法や特例について相談すべき論点を整理します。',
    excludedItems: Object.freeze([
      '二次相続まで含めた配分シミュレーション',
      '小規模宅地等の特例の複数筆・事業用等の区分・併用限度調整',
      '共有持分、倍率地域、借地権等の個別評価',
      '未成年者控除・障害者控除の不足額を扶養義務者から控除する計算',
      '生前贈与加算（相続開始前7年内の贈与）・相続時精算課税',
    ]),
  }),
  yakuin_hoshu: Object.freeze({
    slug: 'yakuin-hoshu-simulator',
    name: '役員報酬シミュレーター',
    description: '無料で利用できるツールです。役員報酬の候補ごとに法人と個人を合わせた概算を比較し、決定前に確認すべき税務・社会保険の論点を整理します。',
    excludedItems: Object.freeze([
      '配偶者・扶養等の人的控除',
      '期中改定・事前確定届出給与',
      '複数役員、使用人兼務役員、非常勤役員',
      '協会けんぽ以外の健康保険組合',
      '法人利益を入力しない個人側だけの順算',
    ]),
  }),
});

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label}を読めません: ${error.message}`);
  }
}

function listJsonFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJsonFiles(target));
    else if (entry.name.endsWith('.json')) files.push(target);
  }
  return files;
}

function collectRecords(node, records) {
  if (Array.isArray(node)) {
    for (const value of node) collectRecords(value, records);
  } else if (node && typeof node === 'object') {
    if (typeof node.record_id === 'string') records.push(node);
    else for (const value of Object.values(node)) collectRecords(value, records);
  }
  return records;
}

function loadRealSimulatorGates() {
  const records = [];
  for (const filePath of listJsonFiles(path.join(MASTERS_DIR, 'data'))) {
    collectRecords(readJson(filePath, 'マスターデータ'), records);
  }
  const table = loadSimulatorDependencies(MASTERS_DIR);
  const inspection = inspectSimulatorDependencies(records, table);
  if (inspection.errors.length) {
    throw new Error(`シミュレーター依存表に誤りがあります: ${inspection.errors.join(' / ')}`);
  }
  return evaluateSimulatorGates(records, inspection);
}

function validatePublishConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('publish-config はオブジェクトで指定してください');
  }
  for (const simulatorType of SIMULATOR_TYPES) {
    const entry = config[simulatorType];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`publish-config に ${simulatorType} がありません`);
    }
    if (typeof entry.enabled !== 'boolean' || typeof entry.indexable !== 'boolean') {
      throw new Error(`${simulatorType}: enabled と indexable は boolean で指定してください`);
    }
    if (!entry.enabled) continue;
    for (const field of ['firstPublishedOn', 'lastLegalReviewOn', 'lastContentUpdateOn']) {
      if (typeof entry[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry[field])) {
        throw new Error(`${simulatorType}: enabled=true のとき ${field} は YYYY-MM-DD で必須です`);
      }
    }
  }
  return config;
}

function validateManifest(manifest) {
  if (!manifest || !/^tax-simulator\.[0-9a-f]{8}\.js$/.test(manifest.fileName || '') ||
      !/^sha384-[A-Za-z0-9+/]+={0,2}$/.test(manifest.integrity || '') ||
      typeof manifest.snapshotId !== 'string' || manifest.snapshotId === '') {
    throw new Error('tax-simulator-manifest.json の形式が不正です');
  }
  return manifest;
}

function render(template, variables) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    variables[key] == null ? '' : String(variables[key]));
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sha384(bytes) {
  return `sha384-${crypto.createHash('sha384').update(bytes).digest('base64')}`;
}

function renderToolPage({ simulatorType, config, manifest, bootIntegrity, template }) {
  const definition = TOOL_DEFINITIONS[simulatorType];
  const canonical = `https://mori-zeirishi.net/tools/${definition.slug}/`;
  const structuredData = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: definition.name,
    description: definition.description,
    provider: {
      '@type': 'Organization',
      name: '毛利順活税理士事務所',
      url: 'https://mori-zeirishi.net/',
    },
    isAccessibleForFree: true,
  });
  return render(template, {
    PAGE_TITLE: escapeHtml(definition.name),
    META_DESCRIPTION: escapeHtml(definition.description),
    DESCRIPTION: escapeHtml(definition.description),
    ROBOTS_META: config.indexable ? '' : '<meta name="robots" content="noindex">',
    CANONICAL_URL: canonical,
    STRUCTURED_DATA: structuredData,
    SIMULATOR_TYPE: simulatorType,
    EXCLUDED_ITEMS: definition.excludedItems.map(item => `<li>${escapeHtml(item)}</li>`).join(''),
    FIRST_PUBLISHED_ON: config.firstPublishedOn,
    LAST_LEGAL_REVIEW_ON: config.lastLegalReviewOn,
    LAST_CONTENT_UPDATE_ON: config.lastContentUpdateOn,
    BUNDLE_FILE: manifest.fileName,
    BUNDLE_INTEGRITY: manifest.integrity,
    BOOT_INTEGRITY: bootIntegrity,
  });
}

function generateSimulatorPublishing(options = {}) {
  const outputRoot = path.resolve(options.outputRoot || REPO_ROOT);
  const config = validatePublishConfig(options.config || readJson(
    options.configPath || DEFAULT_CONFIG_PATH, 'publish-config'
  ));
  const manifest = validateManifest(options.manifest || readJson(
    options.manifestPath || DEFAULT_MANIFEST_PATH, 'tax-simulator-manifest.json'
  ));
  const enabledTypes = SIMULATOR_TYPES.filter(type => config[type].enabled);
  const gates = options.gates || (enabledTypes.length ? loadRealSimulatorGates() : {});
  for (const simulatorType of enabledTypes) {
    if (!gates[simulatorType] || gates[simulatorType].publishable !== true) {
      throw new Error(`${simulatorType}: masters:gate が公開不可のためページを生成できません`);
    }
  }

  const templatesRoot = path.join(REPO_ROOT, 'templates');
  const header = fs.readFileSync(path.join(templatesRoot, 'partials', 'header.html'), 'utf8');
  const footer = fs.readFileSync(path.join(templatesRoot, 'partials', 'footer.html'), 'utf8');
  const toolTemplate = fs.readFileSync(path.join(templatesRoot, 'pages', 'tools', 'simulator.html'), 'utf8');
  const correctionsTemplate = fs.readFileSync(path.join(templatesRoot, 'pages', 'tools', 'corrections.html'), 'utf8');
  const bootBytes = fs.readFileSync(path.join(REPO_ROOT, 'src', 'ui', 'simulator-runtime-gate.js'));
  const bootIntegrity = sha384(bootBytes);

  const toolsOut = path.join(outputRoot, 'tools');
  fs.mkdirSync(toolsOut, { recursive: true });
  const bootOutDir = path.join(outputRoot, 'assets', 'js');
  fs.mkdirSync(bootOutDir, { recursive: true });
  fs.writeFileSync(path.join(bootOutDir, 'tax-simulator-boot.js'), bootBytes);

  for (const simulatorType of SIMULATOR_TYPES) {
    const definition = TOOL_DEFINITIONS[simulatorType];
    const toolOut = path.join(toolsOut, definition.slug);
    if (!config[simulatorType].enabled) {
      fs.rmSync(toolOut, { recursive: true, force: true });
      continue;
    }
    fs.mkdirSync(toolOut, { recursive: true });
    fs.writeFileSync(path.join(toolOut, 'index.html'), renderToolPage({
      simulatorType,
      config: config[simulatorType],
      manifest,
      bootIntegrity,
      template: toolTemplate,
    }), 'utf8');
  }

  const correctionsOut = path.join(toolsOut, 'corrections');
  fs.mkdirSync(correctionsOut, { recursive: true });
  fs.writeFileSync(path.join(correctionsOut, 'index.html'), render(correctionsTemplate, {
    HEADER: header,
    FOOTER: footer,
  }), 'utf8');

  const status = {
    generatedAt: (options.now || new Date()).toISOString(),
    snapshotId: manifest.snapshotId,
    tools: Object.fromEntries(SIMULATOR_TYPES.map(type => [type, { enabled: config[type].enabled }])),
  };
  fs.writeFileSync(path.join(toolsOut, 'simulator-status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  return Object.freeze({ config, manifest, status, enabledTypes, bootIntegrity });
}

module.exports = Object.freeze({
  TOOL_DEFINITIONS,
  validatePublishConfig,
  loadRealSimulatorGates,
  renderToolPage,
  generateSimulatorPublishing,
});
