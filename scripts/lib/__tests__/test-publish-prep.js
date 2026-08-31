'use strict';

/** 公開準備（U6）の受け入れテスト。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TOOL_DEFINITIONS,
  generateSimulatorPublishing,
} = require('../publish-prep');
const { evaluateRuntimeGate } = require('../../../src/ui/simulator-runtime-gate');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'data', 'tax-simulator', 'publish-config.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'assets', 'js', 'tax-simulator-manifest.json');
const SIMULATOR_TYPES = Object.keys(TOOL_DEFINITIONS);
let passed = 0;

function check(label, action) {
  action();
  process.stdout.write(`  ✓ ${label}\n`);
  passed++;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function enabledConfig(indexable = false) {
  const config = clone(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  config.hojinnari = {
    enabled: true,
    indexable,
    firstPublishedOn: '2026-09-01',
    lastLegalReviewOn: '2026-08-30',
    lastContentUpdateOn: '2026-08-31',
  };
  return config;
}

function passingGates() {
  return Object.fromEntries(SIMULATOR_TYPES.map(type => [type, { publishable: true }]));
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-prep-'));
try {
  const defaultConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  process.stdout.write('\n=== 既定OFF・停止判定ファイル ===\n');
  check('コミット対象のpublish-configは全ツールenabled=false', () => {
    assert(SIMULATOR_TYPES.every(type => defaultConfig[type].enabled === false));
  });

  const representativeFiles = [
    path.join(tempRoot, 'index.html'),
    path.join(tempRoot, 'blog', 'representative', 'index.html'),
  ];
  fs.mkdirSync(path.dirname(representativeFiles[1]), { recursive: true });
  fs.writeFileSync(representativeFiles[0], 'existing fixed page\n', 'utf8');
  fs.writeFileSync(representativeFiles[1], 'existing article page\n', 'utf8');
  const before = representativeFiles.map(file => fs.readFileSync(file));

  const generated = generateSimulatorPublishing({
    outputRoot: tempRoot,
    now: new Date('2026-08-30T00:00:00.000Z'),
  });
  check('既定OFFでは4ツールのページを生成しない', () => {
    for (const definition of Object.values(TOOL_DEFINITIONS)) {
      assert(!fs.existsSync(path.join(tempRoot, 'tools', definition.slug, 'index.html')));
    }
  });
  check('status.jsonは全ツールdisabledでsnapshotIdだけを持つ', () => {
    const status = JSON.parse(fs.readFileSync(
      path.join(tempRoot, 'tools', 'simulator-status.json'), 'utf8'
    ));
    assert.strictEqual(status.snapshotId, manifest.snapshotId);
    assert(SIMULATOR_TYPES.every(type => status.tools[type].enabled === false));
    assert.deepStrictEqual(Object.keys(status).sort(), ['generatedAt', 'snapshotId', 'tools']);
    assert.deepStrictEqual(generated.status, status);
  });
  check('訂正履歴ページを常に生成する', () => {
    const html = fs.readFileSync(path.join(tempRoot, 'tools', 'corrections', 'index.html'), 'utf8');
    assert(html.includes('現在、訂正はありません'));
    assert(html.includes('影響した計算バージョン'));
    assert(html.includes('マスタースナップショットID'));
    assert(html.includes('再計算の要否'));
  });
  check('ツール生成は代表の固定ページ・記事を変更しない', () => {
    representativeFiles.forEach((file, index) => assert(before[index].equals(fs.readFileSync(file))));
  });

  process.stdout.write('\n=== 有効時のページ内容・ビルドゲート ===\n');
  generateSimulatorPublishing({
    outputRoot: tempRoot,
    config: enabledConfig(false),
    gates: passingGates(),
    now: new Date('2026-08-30T00:00:00.000Z'),
  });
  const hojinnariPath = path.join(tempRoot, 'tools', 'hojinnari-simulator', 'index.html');
  check('canonical・noindex・監修3日付・免責・SRI・JSON-LDを静的HTMLへ出す', () => {
    const html = fs.readFileSync(hojinnariPath, 'utf8');
    assert(html.includes('<link rel="canonical" href="https://mori-zeirishi.net/tools/hojinnari-simulator/">'));
    assert(html.includes('<meta name="robots" content="noindex">'));
    assert(html.includes('初回公開日'));
    assert(html.includes('2026-09-01'));
    assert(html.includes('2026-08-30'));
    assert(html.includes('2026-08-31'));
    assert(html.includes('本ツールは概算と論点整理を目的とし、申告書作成・税務代理・個別案件への適用保証を行いません'));
    assert(html.includes(`src="/assets/js/${manifest.fileName}" integrity="${manifest.integrity}" defer`));
    assert(html.includes('src="/assets/js/tax-simulator-boot.js" integrity="sha384-'));
    assert(html.includes('"@type":"WebApplication"'));
    assert(html.includes('"isAccessibleForFree":true'));
    assert(html.includes('無料で利用できるツールです'));
    assert(!html.includes('/assets/js/main.js'));
    assert(!html.includes('sendBeacon'));
    assert(!html.includes('input-secret-value'));
    assert(!html.includes('9876543212345'));
  });
  check('indexable=trueならnoindexメタを出さない', () => {
    generateSimulatorPublishing({
      outputRoot: tempRoot,
      config: enabledConfig(true),
      gates: passingGates(),
    });
    assert(!fs.readFileSync(hojinnariPath, 'utf8').includes('name="robots" content="noindex"'));
  });
  check('enabled=trueで日付nullなら例外', () => {
    const config = enabledConfig(false);
    config.hojinnari.lastLegalReviewOn = null;
    assert.throws(() => generateSimulatorPublishing({
      outputRoot: tempRoot, config, gates: passingGates(),
    }), /lastLegalReviewOn.*必須/);
  });
  check('enabled=trueでmasters:gate公開不可なら例外', () => {
    const gates = passingGates();
    gates.hojinnari = { publishable: false };
    assert.throws(() => generateSimulatorPublishing({
      outputRoot: tempRoot, config: enabledConfig(false), gates,
    }), /masters:gate.*公開不可/);
  });

  process.stdout.write('\n=== 実行時停止ゲート純関数 ===\n');
  const expected = manifest.snapshotId;
  const activeStatus = {
    snapshotId: expected,
    tools: { hojinnari: { enabled: true } },
  };
  check('status取得失敗は停止する', () => {
    const result = evaluateRuntimeGate({
      statusError: new Error('offline'), simulatorType: 'hojinnari', expectedSnapshotId: expected,
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.code, 'STATUS_FETCH_FAILED');
  });
  check('ツール無効は停止する', () => {
    const status = clone(activeStatus);
    status.tools.hojinnari.enabled = false;
    assert.strictEqual(evaluateRuntimeGate({
      status, simulatorType: 'hojinnari', expectedSnapshotId: expected,
    }).code, 'TOOL_DISABLED');
  });
  check('snapshotId不一致は停止する', () => {
    assert.strictEqual(evaluateRuntimeGate({
      status: activeStatus, simulatorType: 'hojinnari', expectedSnapshotId: 'different-snapshot',
    }).code, 'SNAPSHOT_MISMATCH');
  });
  check('有効かつsnapshotId一致なら続行する', () => {
    assert.deepStrictEqual(evaluateRuntimeGate({
      status: activeStatus, simulatorType: 'hojinnari', expectedSnapshotId: expected,
    }), { allowed: true, code: 'CONTINUE', category: null, detail: null });
  });

  process.stdout.write(`\n${passed} passed, 0 failed\n`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
