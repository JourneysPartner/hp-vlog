'use strict';

/**
 * マスターデータの鮮度チェック
 *
 *   node masters/scripts/check-master-freshness.js
 *   node masters/scripts/check-master-freshness.js --as-of 2027-01-15
 *   node masters/scripts/check-master-freshness.js --gate      # 未承認があれば異常終了（公開前ゲート）
 *   node masters/scripts/check-master-freshness.js --json      # 機械可読出力
 *
 * 何をするか:
 *   1. マスターの source_hash と、国税庁ソースDBの現在の html_hash を突き合わせる
 *      → ズレていれば「出典が更新された。マスターの見直しが要る」
 *   2. 年度で揃える必要があるマスター（給与所得控除・社会保険料率など）について、
 *      対象年度のレコードが存在するかを確認する
 *      → 無ければ「新年度分が未登録」
 *   3. blocked / 未承認のレコードを列挙する
 *
 * 何をしないか:
 *   値の自動更新はしない。出典が変わったことを知らせるところまで。
 *   改正後の金額は、原文を読んで人が入力し、二者確認を通す（仕様書 §50-1）。
 *   自動で値を書き換えると、表の列を読み違えたまま本番計算に載る事故が起きる。
 */

const fs = require('fs');
const path = require('path');

// 場所は環境変数で差し替えられる（CI やテストから別の場所を指すため）。
const REPO_ROOT = path.join(__dirname, '..');
const MASTERS_DIR = process.env.MASTERS_DIR
  ? path.resolve(process.env.MASTERS_DIR)
  : path.join(REPO_ROOT, 'data', 'tax-simulator', 'masters');
const DATA_DIR = path.join(MASTERS_DIR, 'data');
const REGISTRY_PATH = path.join(MASTERS_DIR, 'sources', 'source-registry.json');

// 国税庁ソースDB。crawl-nta-sources.js が更新している同じディレクトリを見る。
const NTA_SOURCES_DIR = process.env.NTA_SOURCES_DIR
  ? path.resolve(process.env.NTA_SOURCES_DIR)
  : path.join(REPO_ROOT, 'data', 'nta-sources');

// ── 入出力 ────────────────────────────────────────────────────
function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`${path.relative(MASTERS_DIR, filePath)} を読めません: ${e.message}`);
  }
}

function listDataFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...listDataFiles(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

/**
 * ネストしたデータファイルから record_id を持つオブジェクトを再帰的に拾う。
 * データファイルは年度ごとに { r7: { records: [...] }, r8: { records: [...] } } のような
 * 入れ子になっているため、決め打ちのパスでは辿れない。
 *
 * groupNote は、レコードを囲むグループに書かれた _status / _blocked_reason を引き継ぐためのもの。
 * 「R8分はまとめて blocked」のように理由がグループ側にしか無い書き方を許すため。
 */
function collectRecords(node, filePath, acc, groupNote) {
  if (Array.isArray(node)) {
    for (const item of node) collectRecords(item, filePath, acc, groupNote);
    return acc;
  }
  if (!node || typeof node !== 'object') return acc;

  if (typeof node.record_id === 'string') {
    acc.push({ record: node, filePath, groupNote: groupNote || null });
    // レコードの中の入れ子（per_capita_amounts 等）は個別レコードではないので降りない
    return acc;
  }

  const note = node._blocked_reason || node._status || groupNote || null;
  for (const value of Object.values(node)) collectRecords(value, filePath, acc, note);
  return acc;
}

// ── 期間の判定 ────────────────────────────────────────────────
function coversPeriod(record, periodStart, periodEnd) {
  const from = record.effective_from || null;
  const to = record.effective_to || null;
  if (from && from > periodEnd) return false;
  if (to && to < periodStart) return false;
  return true;
}

/** 対象とする期間を決める。暦年は当年、年度は4月始まりの当年度。 */
function targetPeriods(asOf) {
  const [y, m] = asOf.split('-').map(Number);
  const fiscalYear = m >= 4 ? y : y - 1;
  return {
    calendar_year: {
      label: `${y}年（暦年）`,
      start: `${y}-01-01`,
      end: `${y}-12-31`,
    },
    fiscal_april: {
      label: `${fiscalYear}年度（${fiscalYear}-04-01〜${fiscalYear + 1}-03-31）`,
      start: `${fiscalYear}-04-01`,
      end: `${fiscalYear + 1}-03-31`,
    },
  };
}

/**
 * 次の期間。告示時期に入ったら、切替前に「次はまだ入っていない」と予告するために使う。
 * 4月になってから気づくと、その時点で計算できない状態が既に起きている。
 */
function nextPeriods(asOf) {
  const [y, m] = asOf.split('-').map(Number);
  const fiscalYear = m >= 4 ? y : y - 1;
  return {
    calendar_year: {
      label: `${y + 1}年（暦年）`,
      start: `${y + 1}-01-01`,
      end: `${y + 1}-12-31`,
    },
    fiscal_april: {
      label: `${fiscalYear + 1}年度（${fiscalYear + 1}-04-01〜${fiscalYear + 2}-03-31）`,
      start: `${fiscalYear + 1}-04-01`,
      end: `${fiscalYear + 2}-03-31`,
    },
  };
}

/**
 * 次の期間の予告を出すべき時期か。
 * expected_update_month（告示月）が来ていれば、切替までに用意する必要がある。
 * 暦年ものは税制改正の大綱が出る12月から予告する。
 */
function inNoticeWindow(source, asOf) {
  const month = Number(asOf.split('-')[1]);
  if (source.coverage_basis === 'fiscal_april') {
    // 4月に切り替わる。告示月から3月末までが予告期間。
    const notice = source.expected_update_month || 3;
    if (notice <= 3) return month >= notice && month <= 3;
    return month >= notice || month <= 3;   // 年をまたぐ告示（例: 12月告示）
  }
  if (source.coverage_basis === 'calendar_year') {
    // 1月1日に切り替わる。税制改正の大綱が出る12月から予告する。
    return month === 12;
  }
  return false;
}

// ── 国税庁ソースDBの現在の hash ────────────────────────────────
function currentSourceHash(source) {
  if (source.kind !== 'taxanswer') return { ok: false, reason: 'not_taxanswer' };
  const p = path.join(NTA_SOURCES_DIR, 'taxanswer', source.category, `${source.taxanswer_id}.json`);
  if (!fs.existsSync(p)) return { ok: false, reason: 'source_file_missing', path: p };
  const entry = readJson(p);
  if (!entry) return { ok: false, reason: 'source_file_unreadable', path: p };
  if (entry.deleted) return { ok: false, reason: 'source_deleted', path: p };
  return {
    ok: true,
    hash: entry.html_hash || null,
    lawVersion: entry.law_version || null,
    lastCheckedAt: entry.last_checked_at || null,
  };
}

// ── 本体 ──────────────────────────────────────────────────────
function check(asOf) {
  const registry = readJson(REGISTRY_PATH);
  if (!registry) throw new Error(`出典台帳が見つかりません: ${REGISTRY_PATH}`);
  const sources = registry.sources || {};
  const periods = targetPeriods(asOf);
  const upcoming = nextPeriods(asOf);

  // マスターの全レコードを集める
  const all = [];
  for (const f of listDataFiles(DATA_DIR)) {
    const data = readJson(f);
    if (!data) continue;
    const found = collectRecords(data, f, [], null);
    // ファイル単位の _extraction_source は、そのファイルが主に写した1件の出典を指す。
    // 別の出典を引くレコードに流用すると、他所のハッシュを自分の出典として記録したことになり、
    // その出典が変わっても気づけない。taxanswer_id が一致するときだけ控えに使う。
    const ex = data._extraction_source || {};
    for (const item of found) {
      item.fileHash = ex.html_hash || null;
      item.fileTaxanswerId = ex.taxanswer_id ? String(ex.taxanswer_id) : null;
      all.push(item);
    }
  }

  const findings = {
    hashMismatch: [],     // 出典が更新された → 見直しが要る
    hashUntracked: [],    // source_hash 未記録 → 変更を検知できない
    sourceUnknown: [],    // 台帳に無い出典
    sourceMissing: [],    // 国税庁ソースDBにファイルが無い
    coverageGap: [],      // 対象年度のレコードが無い
    coverageUpcoming: [], // 次の期間のレコードが無い（切替前の予告）
    blocked: [],          // 確認待ちで止まっているレコード
    notApproved: [],      // 税理士承認前のレコード
  };

  // 出典ごとに、そこを参照しているレコードをまとめる
  const bySource = new Map();

  for (const { record, filePath, fileHash, fileTaxanswerId, groupNote } of all) {
    const rel = path.relative(MASTERS_DIR, filePath).replace(/\\/g, '/');
    const status = record.data_review_status;

    if (status === 'blocked') {
      findings.blocked.push({
        record_id: record.record_id,
        file: rel,
        reason: record._blocked_reason || groupNote || '（理由の記載なし）',
      });
    } else if (status !== 'approved') {
      // data_review_status が無いレコードも未承認として数える。
      // 「書かれていないものは通す」にすると、項目を書き忘れただけで公開ゲートをすり抜ける。
      findings.notApproved.push({
        record_id: record.record_id,
        file: rel,
        status: status || '(未設定)',
      });
    }

    const sid = record.source_document_id;
    if (!sid) continue;

    if (!bySource.has(sid)) bySource.set(sid, []);
    bySource.get(sid).push({ record, rel, fileHash, fileTaxanswerId });

    if (!sources[sid]) {
      findings.sourceUnknown.push({ record_id: record.record_id, file: rel, source_document_id: sid });
    }
  }

  // 出典ごとの hash 照合
  for (const [sid, items] of bySource) {
    const source = sources[sid];
    if (!source) continue;
    if (source.kind !== 'taxanswer') continue;   // タックスアンサー以外は自動照合できない

    const cur = currentSourceHash(source);
    if (!cur.ok) {
      if (cur.reason === 'source_file_missing' || cur.reason === 'source_deleted') {
        findings.sourceMissing.push({
          source_document_id: sid,
          label: source.label,
          reason: cur.reason,
          affected: items.length,
        });
      }
      continue;
    }

    for (const { record, rel, fileHash, fileTaxanswerId } of items) {
      // ファイル冒頭の hash は、その出典を写したファイルの中でのみ控えとして使える
      const inheritable = fileTaxanswerId && fileTaxanswerId === String(source.taxanswer_id);
      const recorded = record.source_hash || (inheritable ? fileHash : null);
      if (!recorded) {
        findings.hashUntracked.push({ record_id: record.record_id, file: rel, source_document_id: sid });
        continue;
      }
      if (cur.hash && recorded !== cur.hash) {
        findings.hashMismatch.push({
          record_id: record.record_id,
          file: rel,
          source_document_id: sid,
          label: source.label,
          url: source.url,
          recorded_hash: recorded.slice(0, 12),
          current_hash: cur.hash.slice(0, 12),
          law_version: cur.lawVersion,
        });
      }
    }
  }

  // 年度カバレッジの確認
  for (const [sid, source] of Object.entries(sources)) {
    const basis = source.coverage_basis;
    if (!basis || basis === 'none') continue;
    const period = periods[basis];
    if (!period) continue;

    const items = bySource.get(sid) || [];

    // 対象期間を覆う「使えるレコード」があるか。blocked は使えない扱い。
    const usableNow = items.filter(({ record }) =>
      coversPeriod(record, period.start, period.end) && record.data_review_status !== 'blocked'
    );
    if (usableNow.length === 0) {
      const blockedOnly = items.filter(({ record }) => coversPeriod(record, period.start, period.end));
      findings.coverageGap.push({
        source_document_id: sid,
        label: source.label,
        period: period.label,
        url: source.url,
        expected_update_month: source.expected_update_month || null,
        state: blockedOnly.length > 0 ? 'blocked のみ' : 'レコード無し',
        note: source.note || '',
      });
    }

    // 告示時期に入っていれば、次の期間についても先に知らせる。
    // 切り替わってから気づくと、その時点で計算できない状態が既に起きている。
    if (!inNoticeWindow(source, asOf)) continue;
    const nextPeriod = upcoming[basis];
    if (!nextPeriod) continue;
    const usableNext = items.filter(({ record }) =>
      coversPeriod(record, nextPeriod.start, nextPeriod.end) && record.data_review_status !== 'blocked'
    );
    if (usableNext.length > 0) continue;

    findings.coverageUpcoming.push({
      source_document_id: sid,
      label: source.label,
      period: nextPeriod.label,
      url: source.url,
      expected_update_month: source.expected_update_month || null,
      note: source.note || '',
    });
  }

  return { asOf, periods, findings, totalRecords: all.length, sourceCount: bySource.size };
}

// ── レポート ──────────────────────────────────────────────────
function buildReport(result) {
  const { findings: f, asOf, periods } = result;
  const L = [];
  L.push(`マスターデータ鮮度チェック（基準日 ${asOf}）`);
  L.push(`  対象レコード ${result.totalRecords} 件 / 参照している出典 ${result.sourceCount} 件`);
  L.push(`  暦年の対象: ${periods.calendar_year.label} / 年度の対象: ${periods.fiscal_april.label}`);
  L.push('');

  if (f.hashMismatch.length > 0) {
    L.push(`■ 出典が更新されました（${f.hashMismatch.length} 件）— マスターの見直しが必要です`);
    L.push('  出典の原文を読み、変更が税率・控除額に及ぶか確認してください。');
    L.push('  影響があれば新しい値でレコードを追加し、data_review_status を unverified に戻して二者確認を通します。');
    L.push('  影響が無ければ source_hash だけ現在値に更新してください。');
    for (const h of f.hashMismatch) {
      L.push(`  - ${h.record_id}（${h.label}）`);
      L.push(`      ${h.file}`);
      L.push(`      hash ${h.recorded_hash}… → ${h.current_hash}…  法令基準日: ${h.law_version || '不明'}`);
      L.push(`      ${h.url}`);
    }
    L.push('');
  }

  if (f.coverageGap.length > 0) {
    L.push(`■ 対象期間のレコードがありません（${f.coverageGap.length} 件）`);
    for (const c of f.coverageGap) {
      const when = c.expected_update_month ? `毎年${c.expected_update_month}月頃に告示` : '';
      L.push(`  - ${c.label} … ${c.period} が ${c.state}${when ? `（${when}）` : ''}`);
      if (c.note) L.push(`      ${c.note}`);
      L.push(`      ${c.url}`);
    }
    L.push('');
  }

  if (f.coverageUpcoming.length > 0) {
    L.push(`■ 次の期間のレコードがまだありません（${f.coverageUpcoming.length} 件）— 切替前に用意してください`);
    L.push('  告示の時期に入っています。切り替わってから気づくと、その時点で計算できない状態になります。');
    for (const c of f.coverageUpcoming) {
      L.push(`  - ${c.label} … ${c.period} が未登録`);
      if (c.note) L.push(`      ${c.note}`);
      L.push(`      ${c.url}`);
    }
    L.push('');
  }

  if (f.sourceMissing.length > 0) {
    L.push(`■ 国税庁ソースDBに出典が見つかりません（${f.sourceMissing.length} 件）`);
    L.push('  ページが削除・移転した可能性があります。台帳の URL を確認してください。');
    for (const s of f.sourceMissing) {
      L.push(`  - ${s.source_document_id}（${s.label}）: ${s.reason} / 影響レコード ${s.affected} 件`);
    }
    L.push('');
  }

  if (f.sourceUnknown.length > 0) {
    L.push(`■ 出典台帳に無い source_document_id（${f.sourceUnknown.length} 件）`);
    L.push('  masters/sources/source-registry.json に登録してください。登録しないと変更を検知できません。');
    for (const s of f.sourceUnknown) L.push(`  - ${s.source_document_id} … ${s.record_id}（${s.file}）`);
    L.push('');
  }

  if (f.hashUntracked.length > 0) {
    L.push(`■ source_hash が未記録（${f.hashUntracked.length} 件）— 出典の変更を検知できません`);
    for (const s of f.hashUntracked) L.push(`  - ${s.record_id}（${s.file}）出典 ${s.source_document_id}`);
    L.push('');
  }

  if (f.blocked.length > 0) {
    L.push(`■ 確認待ちで止まっているレコード（${f.blocked.length} 件）`);
    for (const b of f.blocked) L.push(`  - ${b.record_id}: ${b.reason}`);
    L.push('');
  }

  const approvedGate = f.notApproved.length + f.blocked.length;
  L.push(`■ 承認状況: 未承認 ${f.notApproved.length} 件 / 確認待ち ${f.blocked.length} 件`);
  if (approvedGate > 0) {
    L.push('  すべて approved になるまで本番公開はできません（仕様書 §48）。');
  }

  return L.join('\n');
}

// ── main ──────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const asOfIdx = argv.indexOf('--as-of');
  const asOf = asOfIdx >= 0 ? argv[asOfIdx + 1] : new Date().toISOString().slice(0, 10);
  const gate = argv.includes('--gate');
  const asJson = argv.includes('--json');

  const result = check(asOf);
  const f = result.findings;

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(buildReport(result));
  }

  // 「人の確認が要る」件数。これが 0 なら定常状態。
  const needsAttention =
    f.hashMismatch.length + f.coverageGap.length + f.coverageUpcoming.length +
    f.sourceMissing.length + f.sourceUnknown.length + f.hashUntracked.length;

  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    const report = buildReport(result);
    fs.appendFileSync(ghOut, `needs_attention=${needsAttention}\n`);
    fs.appendFileSync(ghOut, `hash_mismatch=${f.hashMismatch.length}\n`);
    fs.appendFileSync(ghOut, `coverage_gap=${f.coverageGap.length}\n`);
    fs.appendFileSync(ghOut, `coverage_upcoming=${f.coverageUpcoming.length}\n`);
    fs.appendFileSync(ghOut, `blocked=${f.blocked.length}\n`);
    fs.appendFileSync(ghOut, `not_approved=${f.notApproved.length}\n`);
    fs.appendFileSync(ghOut, `report<<REPORT_EOF\n${report}\nREPORT_EOF\n`);
  }

  // --gate: 公開前チェック。承認されていないものが1つでもあれば止める。
  if (gate && (f.notApproved.length > 0 || f.blocked.length > 0)) {
    console.error('\n[gate] 未承認または確認待ちのレコードがあるため、公開できません。');
    process.exitCode = 1;
    return;
  }

  // 通常実行では、要確認があっても異常終了はしない（通知して人が判断するため）。
  // ただし出典そのものが消えている場合は構成が壊れているので落とす。
  if (f.sourceMissing.length > 0) {
    console.error('\n[error] 出典が取得できていません。台帳の URL か crawl の状態を確認してください。');
    process.exitCode = 1;
  }
}

module.exports = {
  check, buildReport, collectRecords, coversPeriod,
  targetPeriods, nextPeriods, inNoticeWindow,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[freshness] 失敗: ${e.message}`);
    process.exit(1);
  }
}
