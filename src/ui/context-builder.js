'use strict';

/** UI共通のCalculationContextメタデータを組み立てる。 */
function buildContextMetadata(snapshotInfo, calculatedAt) {
  if (!snapshotInfo || typeof snapshotInfo.snapshotId !== 'string' ||
      typeof snapshotInfo.snapshotHash !== 'string' ||
      typeof snapshotInfo.legalStatusAsOf !== 'string') {
    throw new TypeError('snapshotInfoにsnapshotId・snapshotHash・legalStatusAsOfが必要です');
  }
  if (typeof calculatedAt !== 'string' || calculatedAt.length === 0) {
    throw new TypeError('calculatedAtは呼び出し側で取得した日時文字列で指定してください');
  }
  return {
    asOfDate: snapshotInfo.legalStatusAsOf,
    calculatedAt,
    masterSnapshotId: snapshotInfo.snapshotId,
    masterSnapshotHash: snapshotInfo.snapshotHash,
  };
}

module.exports = Object.freeze({ buildContextMetadata });
