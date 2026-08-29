'use strict';

/** シミュレーターUI基盤（U1）の受け入れテスト。 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const builder = require('../../build-simulator-bundle.js');
const dataSource = require('../../../src/tax-engine/masters/data-source.js');
const snapshot = require('../../../src/tax-engine/masters/snapshot.js');
const forms = require('../../../src/ui/forms.js');
const analytics = require('../../../src/ui/analytics.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'assets', 'js');
let passed = 0;

async function check(label, action) {
  await action();
  process.stdout.write(`  ✓ ${label}\n`);
  passed++;
}

function evaluateBundle(bundle, overrides = {}) {
  const context = {
    window: {},
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    ...overrides,
  };
  vm.runInNewContext(bundle, context, { filename: 'tax-simulator.bundle.js' });
  return context.window.TaxSimulator;
}

function yen(value) {
  return { unit: 'JPY', value: BigInt(value) };
}

function context(snapshotInfo) {
  return {
    asOfDate: '2026-08-27',
    calculatedAt: '2026-08-27T12:00:00+09:00',
    incomeTaxYear: 2025,
    residentTaxFiscalYear: 2025,
    fiscalPeriod: { from: '2025-04-01', to: '2026-03-31' },
    socialInsuranceMonths: ['2025-04'],
    jurisdiction: {
      country: 'JP',
      codeSystemVersion: '2025-01',
      asOfForCodes: '2025-04-01',
      prefectureCode: '13',
      municipalityCode: '13113',
      isDesignatedCity: false,
    },
    masterSnapshotId: snapshotInfo.snapshotId,
    masterSnapshotHash: snapshotInfo.snapshotHash,
  };
}

function modeCInput() {
  return {
    mode: 'C',
    precision: 'detailed',
    officerResidenceSameAsCompany: 'yes',
    capital: yen(3000000),
    employeeCount: 0,
    healthInsurer: { kind: 'kyokai_kenpo', prefectureCode: '13' },
    officer: { ageAtYearEnd: 39 },
    specialistChecks: {},
    profitBeforeOfficerCompensation: yen(12000000),
    plan: {
      monthlySegments: [{
        period: { from: '2025-04-01', to: '2026-03-31' },
        value: { monthlyAmount: yen(500000) },
      }],
    },
  };
}

function selectedCandidate(result) {
  return result.breakdown.data.candidates.find(candidate =>
    candidate.planId === result.breakdown.data.selectedPlanId
  ) || result.breakdown.data.candidates[0];
}

function reorderedModuleMaps() {
  const records = {
    entry: { id: 'entry.js', extension: '.js', source: "require('./a.js'); require('./b.js');", dependencies: { './a.js': 'a.js', './b.js': 'b.js' } },
    a: { id: 'a.js', extension: '.js', source: 'module.exports = 1;', dependencies: {} },
    b: { id: 'b.js', extension: '.js', source: 'module.exports = 2;', dependencies: {} },
  };
  return [
    new Map([['entry.js', records.entry], ['a.js', records.a], ['b.js', records.b]]),
    // 同じrequireグラフを逆の到達順で収集した状態を再現する。
    new Map([['entry.js', records.entry], ['b.js', records.b], ['a.js', records.a]]),
  ];
}

async function main() {
  process.stdout.write('\n=== バンドル生成・決定性 ===\n');
  const first = builder.build();
  const firstBytes = fs.readFileSync(path.join(OUTPUT_DIR, first.fileName));
  const second = builder.build();
  const secondBytes = fs.readFileSync(path.join(OUTPUT_DIR, second.fileName));
  await check('同じ入力の2回ビルドがバイト一致する', async () => {
    assert.strictEqual(first.fileName, second.fileName);
    assert(firstBytes.equals(secondBytes));
  });
  await check('require到達順が違ってもパスソートで同じ出力になる', async () => {
    const [left, right] = reorderedModuleMaps();
    assert.strictEqual(builder.renderBundle(left, 'entry.js'), builder.renderBundle(right, 'entry.js'));
  });
  await check('fsスナップショット不一致をビルド時検証が拒否する', async () => {
    assert.throws(() => builder.validateBundledSnapshot(
      dataSource.getSnapshotFiles(),
      { ...snapshot.getSnapshotInfo(), snapshotHash: '0'.repeat(64) },
      dataSource.computeSnapshotHash
    ), /一致しません/);
  });

  process.stdout.write('\n=== ブラウザ公開API・実行時検証 ===\n');
  const unverified = evaluateBundle(first.bundle);
  await check('公開名前空間は検証・サービス・スナップショット・①④マウントだけを持つ', async () => {
    assert.deepStrictEqual(Object.keys(unverified).sort(),
      ['mountHojinnari', 'mountYakuinHoshu', 'services', 'snapshotInfo', 'verify']);
  });
  await check('検証前のsimulateを理由コード付き例外で拒否する', async () => {
    assert.throws(
      () => unverified.services.yakuinHoshu.simulate(modeCInput(), context(unverified.snapshotInfo), unverified.snapshotInfo),
      error => error && error.code === 'SNAPSHOT_NOT_VERIFIED'
    );
  });
  await check('verify後のGC-YH-MODE-C-500Kが手残り8,538,900円になる', async () => {
    await unverified.verify();
    const result = unverified.services.yakuinHoshu.simulate(
      modeCInput(), context(unverified.snapshotInfo), unverified.snapshotInfo
    );
    assert.strictEqual(selectedCandidate(result).combinedCash.value, 8538900n);
  });
  await check('同梱データの1バイト改変をverifyが拒否する', async () => {
    const marker = first.bundle.indexOf('BUNDLED_SNAPSHOT_FILES_START');
    assert(marker >= 0);
    const before = first.bundle.slice(0, marker);
    const after = first.bundle.slice(marker);
    const tamperedAfter = after.replace('R-TRUNC-1000-BASE', 'R-TRUNC-1000-BAZE');
    assert.notStrictEqual(after, tamperedAfter);
    const tampered = evaluateBundle(before + tamperedAfter);
    await assert.rejects(tampered.verify(), error => error && error.code === 'SNAPSHOT_HASH_MISMATCH');
  });
  await check('BigInt非対応を理由コード付きで拒否する', async () => {
    const unsupported = evaluateBundle(first.bundle, { BigInt: undefined });
    await assert.rejects(unsupported.verify(), error => error && error.code === 'BIGINT_UNSUPPORTED');
  });
  await check('crypto.subtle非対応を理由コード付きで拒否する', async () => {
    const unsupported = evaluateBundle(first.bundle, { crypto: undefined });
    await assert.rejects(
      unsupported.verify(),
      error => error && error.code === 'CRYPTO_SUBTLE_UNSUPPORTED'
    );
  });

  process.stdout.write('\n=== 金額入力・Analytics ===\n');
  await check('全角数字と万単位をWire文字列へ変換する', async () => {
    assert.deepStrictEqual(forms.parseMoneyInput('１２３４'), { ok: true, value: '1234' });
    assert.deepStrictEqual(forms.parseMoneyInput('1,200万'), { ok: true, value: '12000000' });
  });
  await check('小数・負数・桁あふれを理由コード付きで拒否する', async () => {
    assert.strictEqual(forms.parseMoneyInput('1.5万').code, 'MONEY_FRACTIONAL_YEN');
    assert.strictEqual(forms.parseMoneyInput('-1').code, 'MONEY_NEGATIVE');
    assert.strictEqual(forms.parseMoneyInput('9'.repeat(31)).code, 'MONEY_OVERFLOW');
  });
  await check('確認表示を円と万の併記にする', async () => {
    assert.strictEqual(forms.formatDisplayMoney('12000000'), '12,000,000');
    assert.strictEqual(
      forms.formatMoneyConfirmation('12000000'),
      '12,000,000円（1,200万円）'
    );
  });
  await check('許可外Analyticsイベントと余分なペイロードを拒否する', async () => {
    assert.throws(() => analytics.queueEvent('purchase', { tool: 'hojinnari' }), /許可/);
    assert.throws(() => analytics.queueEvent('simulator_view', {
      tool: 'hojinnari', amount: '1000000',
    }), /許可リスト/);
  });

  // スナップショットIDはマスターの生バイト列から決まるため、改行コードが
  // 環境（autocrlf の有無）で揺れると ID が環境依存になる。.gitattributes で
  // masters/ を LF 固定しており、CR が混入したらここで止める（§48 の同一性）。
  await check('マスターのバイト列に CR（\\r）が混入していない', () => {
    const mastersRoot = path.join(REPO_ROOT, 'data', 'tax-simulator', 'masters');
    const offenders = [];
    const walk = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (fs.readFileSync(target).includes(0x0d)) {
          offenders.push(path.relative(mastersRoot, target));
        }
      }
    };
    walk(mastersRoot);
    assert.deepStrictEqual(offenders, []);
  });

  process.stdout.write(`\n${passed} passed, 0 failed\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
