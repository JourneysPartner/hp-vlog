'use strict';

/**
 * 出典台帳の URL が生きているかを確認する。
 *
 *   node masters/scripts/verify-source-urls.js              # 未確認のものだけ
 *   node masters/scripts/verify-source-urls.js --all        # 全件
 *   node masters/scripts/verify-source-urls.js --write      # 結果を台帳の url_verified に反映
 *
 * 通知の「確認先」として機能しない URL が混ざっていると、
 * 出典が変わったと知らせても人が原文に辿り着けない。
 * 到達性（HTTP 200 が返り、期待する語がページにあるか）だけを機械で確認する。
 * 内容が正しいかは人が読んで判断する。
 */

const fs = require('fs');
const path = require('path');

const MASTERS_DIR = process.env.MASTERS_DIR
  ? path.resolve(process.env.MASTERS_DIR)
  : path.join(__dirname, '..', 'data', 'tax-simulator', 'masters');
const REGISTRY = path.join(MASTERS_DIR, 'sources', 'source-registry.json');

/**
 * 到達性を確かめる。本文は先頭だけ読む。
 * 法令APIのXMLは数MB〜十数MBあり、毎回全部落とすと接続を切られる。
 * 期待語はページ冒頭（法令名・表題）に出るので、先頭を読めば足りる。
 */
const MAX_READ = 512 * 1024;

async function head(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': 'tax-simulator-master-fetch' },
        redirect: 'follow',
      });
      let body = '';
      if (r.body) {
        const reader = r.body.getReader();
        const dec = new TextDecoder('utf-8');
        let read = 0;
        while (read < MAX_READ) {
          const { done, value } = await reader.read();
          if (done) break;
          read += value.length;
          body += dec.decode(value, { stream: true });
        }
        await reader.cancel().catch(() => {});   // 残りは受け取らない
      }
      return { ok: r.ok, status: r.status, finalUrl: r.url, body };
    } catch (e) {
      if (i === tries) return { ok: false, status: 0, error: e.cause ? (e.cause.code || e.cause.message) : e.message };
      await new Promise(s => setTimeout(s, 3000 * i));
    }
  }
}

/** ページが本当に目当てのものかを、含まれるべき語で確かめる */
function expectedTerms(id, src) {
  if (src.kind === 'taxanswer') return [`No.${src.taxanswer_id}`, src.label.replace(/^No\.\d+\s*/, '')];
  const map = {
    'EGOV-INCOME-TAX-APDX5': ['所得税法'],
    'EGOV-HEALTH-INSURANCE-ACT': ['健康保険法'],
    'EGOV-EMPLOYEES-PENSION-ACT': ['厚生年金保険法'],
    'EGOV-PENSION-GRADE-ORDER-R2': ['標準報酬月額の等級区分の改定'],
    'KYOKAI-KENPO-HEALTH': ['保険料率'],
    'KYOKAI-KENPO-NURSING': ['介護保険料率'],
    'KYOKAI-KENPO-BONUS': ['標準賞与額'],
    'NENKIN-PENSION-RATE': ['保険料額表'],
    'NENKIN-NATL': ['国民年金保険料'],
    'NENKIN-BONUS-CAP': ['標準賞与額'],
    'MHLW-CHILD-LEVY': ['子ども・子育て'],
    'MHLW-SUPPORT-R8': ['子ども・子育て'],
    'MOF-R8-LAW': ['税制改正'],
    'NTA-INVOICE-R8': ['インボイス'],
    'NTA-INCOME-R8': ['基礎控除'],
    'NTA-LOCAL-CORP-TAX': ['地方法人税法'],
    // 地方税法の条文は「住民税」ではなく「道府県民税」「市町村民税」と書く
    'SOUMU-CORP-INHAB': ['地方税法'],
    'SOUMU-ENT-TAX': ['地方税法'],
    'SOUMU-SPECIAL-ENT': ['特別法人事業税'],
    'SOUMU-RESIDENT-TAX': ['地方税法'],
    'SOUMU-FOREST-TAX': ['森林環境税'],
    'EGOV-KOKUZEI-TSUSOKU': ['国税通則法'],
    'EGOV-CHIHOUZEI': ['地方税法'],
  };
  return map[id] || [];
}

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const write = argv.includes('--write');

  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  // machine_reachable: false は、URLは正しいと分かっているがこの経路からは繋がらないもの。
  // 何度試しても失敗し続けて通知が鳴りっぱなしになるので、対象から外して一覧にだけ出す。
  const manual = Object.entries(reg.sources).filter(([, s]) => s.machine_reachable === false);
  const entries = Object.entries(reg.sources)
    .filter(([, s]) => s.machine_reachable !== false)
    .filter(([, s]) => all || s.url_verified !== true);

  if (manual.length) {
    console.log(`機械では確認できない出典（人が開いて確認する）: ${manual.length} 件`);
    manual.forEach(([id, s]) => console.log(`  - ${id}: ${s.url}\n      ${s._unreachable_reason || ''}`));
    console.log('');
  }

  console.log(`確認対象: ${entries.length} 件${all ? '（全件）' : '（url_verified が true でないもの）'}\n`);

  const results = [];
  for (const [id, src] of entries) {
    process.stdout.write(`  ${id.padEnd(30)} `);
    const r = await head(src.url);
    if (!r.ok) {
      console.log(`✗ ${r.status || r.error}`);
      results.push({ id, src, ok: false, detail: `HTTP ${r.status || r.error}` });
      continue;
    }
    const terms = expectedTerms(id, src);
    const missing = terms.filter(t => t && !r.body.includes(t));
    const redirected = r.finalUrl && r.finalUrl.replace(/\/$/, '') !== src.url.replace(/\/$/, '');
    if (missing.length) {
      console.log(`△ 200 だが期待語なし: ${missing.join(', ')}`);
      results.push({ id, src, ok: false, detail: `期待語が無い: ${missing.join(', ')}`, finalUrl: r.finalUrl });
    } else {
      console.log(`✓ 200${redirected ? ' (転送先: ' + r.finalUrl + ')' : ''}`);
      results.push({ id, src, ok: true, finalUrl: redirected ? r.finalUrl : null });
    }
    await new Promise(s => setTimeout(s, 1000));   // 1秒あける
  }

  const ok = results.filter(r => r.ok);
  const ng = results.filter(r => !r.ok);
  console.log(`\n到達できた: ${ok.length} / 到達できない・内容が違う: ${ng.length}`);
  if (ng.length) {
    console.log('\n要修正:');
    ng.forEach(r => console.log(`  - ${r.id}（${r.src.label}）: ${r.detail}\n      ${r.src.url}`));
  }
  const moved = ok.filter(r => r.finalUrl);
  if (moved.length) {
    console.log('\n転送されている（台帳のURLを更新すると確実）:');
    moved.forEach(r => console.log(`  - ${r.id}: ${r.src.url}\n      → ${r.finalUrl}`));
  }

  if (write) {
    for (const r of results) reg.sources[r.id].url_verified = r.ok;
    fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n', 'utf8');
    console.log('\n台帳の url_verified を更新しました。');
  } else if (ok.length) {
    console.log('\n--write を付けると台帳の url_verified に反映します。');
  }

  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    fs.appendFileSync(ghOut, `unreachable=${ng.length}\n`);
  }
  if (ng.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(e => { console.error(`[url] 失敗: ${e.message}`); process.exit(1); });
}
