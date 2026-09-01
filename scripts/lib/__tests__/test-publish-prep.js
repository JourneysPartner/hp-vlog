'use strict';

/** 公開準備（U6）の受け入れテスト。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TOOL_DEFINITIONS,
  generateSimulatorPublishing,
  validatePublishConfig,
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

  process.stdout.write('\n=== 公開設定の不変条件・停止判定ファイル ===\n');
  // 公開承認（2026-08-31）以降、実configのenabledは公開状態を表す。
  // テストは状態を固定せず、「enabledなら監修3日付が揃っている」不変条件を検査する。
  check('コミット対象のpublish-configが検証を通り、enabledのツールは監修3日付を持つ', () => {
    validatePublishConfig(defaultConfig);
    for (const type of SIMULATOR_TYPES) {
      if (defaultConfig[type].enabled) {
        assert(typeof defaultConfig[type].firstPublishedOn === 'string');
        assert(typeof defaultConfig[type].lastLegalReviewOn === 'string');
        assert(typeof defaultConfig[type].lastContentUpdateOn === 'string');
      }
    }
  });
  // 以降の「全ツールOFF」の挙動テストは合成configで行う（実configの状態に依存しない）
  const allOffConfig = Object.fromEntries(SIMULATOR_TYPES.map(type => [type, {
    enabled: false, indexable: false,
    firstPublishedOn: null, lastLegalReviewOn: null, lastContentUpdateOn: null,
  }]));

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
    config: allOffConfig,
    now: new Date('2026-08-30T00:00:00.000Z'),
  });
  check('全ツールOFFの設定では4ツールのページを生成しない', () => {
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
    assert(html.includes('配偶者控除・扶養控除・障害者控除・小規模企業共済/iDeCoには対応'));
    assert(html.includes('16歳未満の扶養親族に係る障害者控除'));
    assert(html.includes('配偶者・扶養親族ご自身の国民健康保険料・国民年金保険料（世帯分）'));
  });
  check('④の含めない項目は対応済み控除を除外せず、第1弾の範囲を明示する', () => {
    const definition = TOOL_DEFINITIONS.yakuin_hoshu;
    assert(definition.excludedItems.includes(
      '生命保険料控除等の各種控除（配偶者控除・扶養控除・障害者控除・小規模企業共済/iDeCoには対応）'
    ));
    assert(definition.excludedItems.includes('16歳未満の扶養親族に係る障害者控除'));
    assert(!definition.excludedItems.some(item => item === '配偶者・扶養等の人的控除'));
  });
  check('4ツールは専用ヘッダ・簡素なフッタを持ち、共通ナビと固定CTAを含まない', () => {
    for (const definition of Object.values(TOOL_DEFINITIONS)) {
      const html = fs.readFileSync(path.join(tempRoot, 'tools', definition.slug, 'index.html'), 'utf8');
      assert(html.includes('class="tool-page-header"'));
      assert(html.includes('<a class="tool-page-brand" href="/">毛利順活税理士事務所</a>'));
      assert(html.includes('<a href="/">ホーム</a>'));
      assert(html.includes('<a href="/blog/">税務コラム</a>'));
      assert(html.includes('<a href="/contact.html">お問い合わせ</a>'));
      assert(html.includes('<a class="tool-page-cta" href="/contact.html">無料相談する</a>'));
      assert(html.includes('class="tool-page-footer"'));
      assert(!html.includes('id="header"'));
      assert(!html.includes('navbar-toggler'));
      assert(!html.includes('navbar-nav'));
      assert(!html.includes('mobile-cta-bar'));
      assert(!html.includes('btn-header-cta'));
    }
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
