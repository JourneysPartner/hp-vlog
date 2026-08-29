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

module.exports = Object.freeze({
  verify,
  services: Object.freeze({
    hojinnari: guardedService(hojinnari),
    shohizei: guardedService(shohizei),
    sozoku: guardedService(sozoku),
    yakuinHoshu: guardedService(yakuinHoshu),
  }),
  snapshotInfo: snapshot.getSnapshotInfo(),
});
