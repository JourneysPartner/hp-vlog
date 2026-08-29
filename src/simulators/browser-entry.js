'use strict';

/**
 * ブラウザ向けの唯一の公開入口。マスター検証が完了するまで計算を許可しない。
 */

const dataSource = require('../tax-engine/masters/data-source.js');
const snapshot = require('../tax-engine/masters/snapshot.js');
const hojinnari = require('./hojinnari/index.js');
const shohizei = require('./shohizei/index.js');
const sozoku = require('./sozoku/index.js');
const yakuinHoshu = require('./yakuin-hoshu/index.js');
const { mountHojinnariApp } = require('../ui/hojinnari/app.js');
const { mountShohizeiApp } = require('../ui/shohizei/app.js');
const { mountYakuinHoshuApp } = require('../ui/yakuin-hoshu/app.js');
const { createRouter } = require('../ui/router.js');

let verificationState = 'unverified';
let verificationPromise = null;

function verificationError(code, message) {
  const error = new Error(message);
  error.name = 'TaxSimulatorVerificationError';
  error.code = code;
  return error;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

function canonicalSnapshotBytes(files) {
  const sorted = files.map(file => ({
    path: file.path.replaceAll('\\', '/'),
    content: typeof file.content === 'string'
      ? utf8Bytes(file.content)
      : new Uint8Array(file.content),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const chunks = [];
  let totalLength = 0;
  for (const file of sorted) {
    const pathBytes = utf8Bytes(file.path);
    const prefix = utf8Bytes(`${pathBytes.length}:`);
    const separator = utf8Bytes(`:${file.content.length}:`);
    for (const chunk of [prefix, pathBytes, separator, file.content]) {
      chunks.push(chunk);
      totalLength += chunk.length;
    }
  }
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function toHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function verify() {
  if (verificationState === 'verified') return Promise.resolve(snapshot.getSnapshotInfo());
  if (verificationPromise !== null) return verificationPromise;

  if (typeof BigInt !== 'function') {
    return Promise.reject(verificationError(
      'BIGINT_UNSUPPORTED',
      'この環境はBigIntに対応していないため、税務計算を開始できません'
    ));
  }
  if (typeof TextEncoder !== 'function') {
    return Promise.reject(verificationError(
      'TEXT_ENCODER_UNSUPPORTED',
      'この環境はUTF-8バイト列の生成に対応していないため、税務計算を開始できません'
    ));
  }
  if (!globalThis.crypto || !globalThis.crypto.subtle ||
      typeof globalThis.crypto.subtle.digest !== 'function') {
    return Promise.reject(verificationError(
      'CRYPTO_SUBTLE_UNSUPPORTED',
      'この環境はWeb Crypto APIに対応していないため、税務計算を開始できません'
    ));
  }

  verificationState = 'verifying';
  verificationPromise = globalThis.crypto.subtle.digest(
    'SHA-256',
    canonicalSnapshotBytes(dataSource.getSnapshotFiles())
  ).then(digest => {
    const actualHash = toHex(new Uint8Array(digest));
    const expectedHash = snapshot.getSnapshotInfo().snapshotHash;
    if (actualHash !== expectedHash) {
      throw verificationError(
        'SNAPSHOT_HASH_MISMATCH',
        '同梱された税務マスターのハッシュ検証に失敗しました'
      );
    }
    verificationState = 'verified';
    return snapshot.getSnapshotInfo();
  }).catch(error => {
    verificationState = 'failed';
    if (error && error.code) throw error;
    throw verificationError('SNAPSHOT_VERIFY_FAILED', '税務マスターを検証できませんでした');
  });
  return verificationPromise;
}

function guardedService(service) {
  return Object.freeze({
    validate: service.validate,
    simulate(...args) {
      if (verificationState !== 'verified') {
        throw verificationError(
          'SNAPSHOT_NOT_VERIFIED',
          '税務マスターの検証が完了するまで計算できません'
        );
      }
      return service.simulate(...args);
    },
  });
}

const services = Object.freeze({
  hojinnari: guardedService(hojinnari),
  shohizei: guardedService(shohizei),
  sozoku: guardedService(sozoku),
  yakuinHoshu: guardedService(yakuinHoshu),
});

/** 公開画面は未生成のまま、明示されたDOMへだけ①のアプリを起動する。 */
function mountHojinnari(rootElement, options = {}) {
  if (options.services) {
    return mountHojinnariApp(rootElement, {
      services: options.services,
      snapshotInfo: options.snapshotInfo || snapshot.getSnapshotInfo(),
      now: options.now,
      handoff: options.handoff,
      handoffExpectedContext: options.handoffExpectedContext,
    });
  }
  const verifiedService = Object.freeze({
    validate: services.hojinnari.validate,
    async simulate(...args) {
      await verify();
      return services.hojinnari.simulate(...args);
    },
  });
  return mountHojinnariApp(rootElement, {
    services: verifiedService,
    snapshotInfo: snapshot.getSnapshotInfo(),
    now: options.now,
    handoff: options.handoff,
    handoffExpectedContext: options.handoffExpectedContext,
  });
}

/** 公開ページは未生成のまま、明示されたDOMへだけ②のアプリを起動する。 */
function mountShohizei(rootElement, options = {}) {
  const selectedService = options.services
    ? (options.services.shohizei || options.services)
    : verifiedUiService('shohizei');
  return mountShohizeiApp(rootElement, {
    services: selectedService,
    snapshotInfo: options.snapshotInfo || snapshot.getSnapshotInfo(),
    now: options.now,
  });
}

function expectedHojinnariContext(handoff, snapshotInfo) {
  const source = handoff.calculationContext;
  const year = 2025;
  return {
    ...source,
    incomeTaxYear: year,
    residentTaxFiscalYear: year,
    fiscalPeriod: { from: `${year}-01-01`, to: `${year}-12-31` },
    socialInsuranceMonths: [`${year}-04`],
    jurisdiction: {
      ...source.jurisdiction,
      country: 'JP',
      codeSystemVersion: `${year}-01`,
      asOfForCodes: `${year}-01-01`,
    },
    masterSnapshotId: snapshotInfo.snapshotId,
    masterSnapshotHash: snapshotInfo.snapshotHash,
  };
}

function verifiedUiService(serviceName) {
  const selected = services[serviceName];
  return Object.freeze({
    validate: selected.validate,
    async simulate(...args) {
      await verify();
      return selected.simulate(...args);
    },
  });
}

/** ④を起動し、確定結果のHandoffは同じrootの①へメモリ内で渡す。 */
function mountYakuinHoshu(rootElement, options = {}) {
  const snapshotForUi = options.snapshotInfo || snapshot.getSnapshotInfo();
  const suppliedServices = options.services;
  const yakuinService = suppliedServices
    ? (suppliedServices.yakuinHoshu || suppliedServices)
    : verifiedUiService('yakuinHoshu');
  const hojinnariService = suppliedServices
    ? (suppliedServices.hojinnari || suppliedServices)
    : verifiedUiService('hojinnari');
  let activeApp;
  let router = null;
  let destroyed = false;

  function defaultHandoffNavigation(handoff) {
    if (destroyed) return;
    const browserWindow = rootElement.ownerDocument && rootElement.ownerDocument.defaultView;
    router = options.router || createRouter({ windowObject: browserWindow });
    router.navigate('hojinnari');
    activeApp.destroy();
    activeApp = mountHojinnariApp(rootElement, {
      services: hojinnariService,
      snapshotInfo: snapshotForUi,
      now: options.now,
      handoff,
      handoffExpectedContext: expectedHojinnariContext(handoff, snapshotForUi),
    });
  }

  activeApp = mountYakuinHoshuApp(rootElement, {
    services: yakuinService,
    snapshotInfo: snapshotForUi,
    now: options.now,
    onHandoff: options.onHandoff || defaultHandoffNavigation,
  });

  return Object.freeze({
    get store() { return activeApp.store; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      activeApp.destroy();
      if (router && router !== options.router) router.destroy();
    },
  });
}

module.exports = Object.freeze({
  verify,
  services,
  snapshotInfo: snapshot.getSnapshotInfo(),
  mountHojinnari,
  mountShohizei,
  mountYakuinHoshu,
});
