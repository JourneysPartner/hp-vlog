'use strict';

/**
 * 税制改正の大綱（財務省）を監視し、未登録の改正項目を検出する。
 *
 *   node scripts/check-tax-reform-outline.js            # 差分チェック（スナップショットは更新しない）
 *   node scripts/check-tax-reform-outline.js --update   # スナップショットを更新する
 *   node scripts/check-tax-reform-outline.js --year 2027
 *
 * 背景（2026-08）:
 *   令和8年度税制改正で 3割特例・少額減価償却資産40万円・扶養の所得要件62万円 などが
 *   変わったが、国税庁のタックスアンサーは 672 件中 665 件が「令和7年4月1日現在法令等」の
 *   ままで未反映だった。出典どおりに書くと古い内容の記事になる。
 *   改正がタックスアンサーへ反映されるのを待つのではなく、大綱の側で把握する必要がある。
 *
 * 監視範囲:
 *   一 個人所得課税 / 二 資産課税 / 三 法人課税 / 四 消費課税 の4章のみ。
 *   五 国際課税・六 防衛力強化 は当ブログの読者に関係しないため対象外。
 *
 * 検出するもの:
 *   1. スナップショットに無い項目（新設・改題）
 *   2. status が 'todo' のまま残っている項目
 *
 * 各項目の status:
 *   'todo'           未判断。通知に出続ける
 *   'registered'     tax-law-changes.js / nta-reference-pages.js に登録済み
 *   'not_applicable' 当ブログの読者に関係しないので対象外（理由を note に書く）
 *   → 定常状態で通知が鳴らないよう、判断したものは必ず todo 以外にすること。
 *
 * 登録そのものは人が行う。改正内容の要約を自動生成すると、原文にない数値や
 * 適用範囲を書いてしまうため。このスクリプトが出すのは「未登録の項目一覧」まで。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT_PATH = path.join(ROOT, 'data', 'tax-reform-outline.json');

// 監視する章（この4つだけ）。キーは大綱のファイル番号。
const CHAPTERS = {
  '01': { label: '個人所得課税', tax_domains: ['income_tax'] },
  '02': { label: '資産課税',     tax_domains: ['inheritance_tax'] },
  '03': { label: '法人課税',     tax_domains: ['bookkeeping_expenses', 'corporate_tax'] },
  '04': { label: '消費課税',     tax_domains: ['consumption_tax', 'invoice_system'] },
};

function outlineUrl(year, chapter) {
  // 令和8年度 → fy2026 / 08taikou_01.htm
  const era = year - 2018;                       // 2026 → 令和8
  const prefix = String(era).padStart(2, '0');   // 08
  return `https://www.mof.go.jp/tax_policy/tax_reform/outline/fy${year}/${prefix}taikou_${chapter}.htm`;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** h2 を章名、h3 を項目名として抽出する */
function parseChapter(html) {
  const chapterTitle = (html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1];
  const items = [];
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = stripTags(m[1]);
    if (!raw) continue;
    // 先頭の番号（１ ２ …）を分離する
    const mm = raw.match(/^([０-９0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*(.+)$/);
    items.push({
      no: mm ? mm[1] : '',
      title: (mm ? mm[2] : raw).trim(),
    });
  }
  return { chapterTitle: chapterTitle ? stripTags(chapterTitle) : '', items };
}

async function fetchChapter(year, chapter) {
  const url = outlineUrl(year, chapter);
  const res = await fetch(url, { headers: { 'user-agent': 'hp-vlog-tax-reform-check' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return { url, html: await res.text() };
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return { year: null, chapters: {} };
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch (e) {
    console.warn(`[tax-reform] スナップショットを読めませんでした（${e.message}）→ 空として続行`);
    return { year: null, chapters: {} };
  }
}

function keyOf(item) {
  return `${item.no}|${item.title}`;
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const yearArg = args.indexOf('--year');
  const year = yearArg >= 0 ? Number(args[yearArg + 1]) : new Date().getFullYear();

  const prev = loadSnapshot();
  const prevChapters = prev.chapters || {};
  const next = { year, checked_at: new Date().toISOString(), chapters: {} };

  const added = [];
  const unregistered = [];
  const errors = [];

  for (const [ch, def] of Object.entries(CHAPTERS)) {
    let parsed;
    let url;
    try {
      const got = await fetchChapter(year, ch);
      url = got.url;
      parsed = parseChapter(got.html);
    } catch (e) {
      errors.push(`${def.label}: ${e.message}`);
      // 取得に失敗した章は前回の内容を保つ（消えたと誤検知しないため）
      if (prevChapters[ch]) next.chapters[ch] = prevChapters[ch];
      continue;
    }

    if (parsed.items.length === 0) {
      errors.push(`${def.label}: 項目を1件も抽出できませんでした（ページ構成が変わった可能性）`);
      if (prevChapters[ch]) next.chapters[ch] = prevChapters[ch];
      continue;
    }

    const prevItems = (prevChapters[ch] && prevChapters[ch].items) || [];
    const prevByKey = Object.fromEntries(prevItems.map(i => [keyOf(i), i]));

    const items = parsed.items.map(i => {
      const old = prevByKey[keyOf(i)];
      if (!old) {
        added.push({ chapter: def.label, ...i });
        return { ...i, status: 'todo', note: '' };
      }
      // 既知の項目は status / note を引き継ぐ
      return { ...i, status: old.status || 'todo', note: old.note || '' };
    });

    for (const i of items) {
      if (i.status === 'todo') unregistered.push({ chapter: def.label, ...i });
    }

    next.chapters[ch] = {
      label: def.label,
      tax_domains: def.tax_domains,
      url,
      chapter_title: parsed.chapterTitle,
      items,
    };
  }

  // ── レポート ──────────────────────────────────────────────
  const lines = [];
  lines.push(`税制改正の大綱チェック（${year}年度 / 監視対象: 個人所得課税・資産課税・法人課税・消費課税）`);
  lines.push('');
  for (const [ch, def] of Object.entries(CHAPTERS)) {
    const c = next.chapters[ch];
    if (!c) { lines.push(`  ${def.label}: 取得できず`); continue; }
    const total = c.items.length;
    const reg = c.items.filter(i => i.status === 'registered').length;
    const na  = c.items.filter(i => i.status === 'not_applicable').length;
    const todo = c.items.filter(i => i.status === 'todo').length;
    lines.push(`  ${def.label}: ${total} 項目（登録済 ${reg} / 対象外 ${na} / 未判断 ${todo}）`);
  }
  lines.push('');

  if (added.length > 0) {
    lines.push(`■ 前回に無かった項目（${added.length} 件）`);
    added.forEach(i => lines.push(`  [${i.chapter}] ${i.no} ${i.title}`));
    lines.push('');
  }
  if (unregistered.length > 0) {
    lines.push(`■ 未判断の項目（${unregistered.length} 件）`);
    lines.push('  当ブログに関係するなら、原文を確認して');
    lines.push('  scripts/lib/tax-law-changes.js または scripts/lib/nta-reference-pages.js に登録し、');
    lines.push('  data/tax-reform-outline.json の status を registered にしてください。');
    lines.push('  関係しないなら status を not_applicable にし、note に理由を書いてください。');
    unregistered.forEach(i => lines.push(`  [${i.chapter}] ${i.no} ${i.title}`));
    lines.push('');
  }
  if (errors.length > 0) {
    lines.push(`■ エラー（${errors.length} 件）`);
    errors.forEach(e => lines.push(`  ${e}`));
    lines.push('');
  }
  if (added.length === 0 && unregistered.length === 0 && errors.length === 0) {
    lines.push('■ 新規項目・未判断項目はありません');
  }

  const report = lines.join('\n');
  console.log(report);

  if (update) {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(`\n[tax-reform] スナップショットを更新しました: ${path.relative(ROOT, SNAPSHOT_PATH)}`);
  }

  // GitHub Actions 用の出力
  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    fs.appendFileSync(ghOut, `added=${added.length}\n`);
    fs.appendFileSync(ghOut, `unregistered=${unregistered.length}\n`);
    fs.appendFileSync(ghOut, `errors=${errors.length}\n`);
    fs.appendFileSync(ghOut, `report<<REPORT_EOF\n${report}\nREPORT_EOF\n`);
  }

  // 抽出そのものが壊れた場合だけ異常終了する。
  // 未登録項目があること自体は「通知して人が判断する」ものなので失敗にしない。
  if (errors.length > 0) process.exitCode = 1;
}

module.exports = { CHAPTERS, outlineUrl, parseChapter, stripTags, keyOf };

if (require.main === module) {
  main().catch(e => {
    console.error(`[tax-reform] 失敗: ${e.message}`);
    process.exit(1);
  });
}
