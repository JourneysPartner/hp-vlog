#!/usr/bin/env node
'use strict';
/**
 * 国税庁のQ&A・事例集（PDF）を取得してカタログ化する。
 *
 *   node scripts/crawl-nta-qa.js                # 全対象を取得
 *   node scripts/crawl-nta-qa.js --only invoice # 1つだけ
 *   node scripts/crawl-nta-qa.js --limit 5      # 動作確認用に5件だけ
 *
 * 背景（2026-09-01）:
 *   「インボイス登録をやめたい」の記事が、取消届出書の期限を「12月31日まで」と誤り
 *   （正しくは課税期間の初日から起算して15日前の日まで）、さらに「取り消せば免税事業者に
 *   戻れる」と単純化した。実際は登録した経路で結論が変わる（経過措置なら2年縛りがある）。
 *
 *   原因は、カタログがタックスアンサー・質疑応答事例・基本通達の3種類しか収録して
 *   おらず、インボイスの詳細が載っている Q&A（PDF）が入っていなかったこと。
 *   全2,222件を全文検索しても、経過措置の2年縛りは1件も収録されていなかった。
 *
 *   これまでは必要が生じた都度、手で nta-reference-pages.js に登録して凌いできたが、
 *   4件とも記事に誤りが出てから後追いで登録している。後追いをやめるために取り込む。
 *
 * 方針:
 *   - タックスアンサー・質疑応答と同じ考え方。data/nta-qa/ に本文を保存する
 *   - 記事の主出典（source_url）には使わない。参考資料として本文を渡すのに使う
 *   - PDF のテキスト抽出は pdftotext に依存する。無い環境では明示的に失敗させる
 *   - 取得間隔を空ける（既定1.2秒）。国税庁のサーバに負荷をかけない
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'nta-qa');
const INDEX_PATH = path.join(OUT_DIR, 'index.json');
const FETCH_DELAY_MS = 1200;
const HOST = 'https://www.nta.go.jp';

// ── 取得対象 ─────────────────────────────────────────────────
// indexUrl: PDFリンクを拾う目次ページ（linkPattern に一致するリンクを対象にする）
// docs:     目次を持たない単発の資料
const SOURCES = {
  invoice: {
    label: 'インボイス制度に関するQ&A',
    tax_category: '消費税',
    tax_category_code: 'shohi',
    tax_domain: 'invoice_system',
    indexUrl: `${HOST}/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/qa_invoice_mokuji.htm`,
    linkPattern: /pdf\/qa\/[\w-]+\.pdf$/,
    docs: [
      {
        id: 'faq',
        // 総集編（多数の問をまとめた資料）。個別の問より後ろに回す。
        digest: true,
        title: 'インボイス制度に関するQ&A（多く寄せられるご質問）',
        url: `${HOST}/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/0521-1334-faq.pdf`,
      },
      {
        id: 'jireishu',
        digest: true,
        title: 'インボイス制度において事業者が注意すべき事例集',
        url: `${HOST}/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/0023007-071.pdf`,
      },
    ],
  },

  // 電子帳簿保存法の一問一答。PDFではなくHTMLページで公開されている。
  // 1ページに複数の問がまとまっているため、問ごとには分けずページ単位で保存する。
  denshi_torihiki: {
    label: '電子帳簿保存法一問一答【電子取引関係】',
    tax_category: '帳簿・経費',
    tax_category_code: 'chobo',
    tax_domain: 'bookkeeping_expenses',
    format: 'html',
    indexUrl: `${HOST}/law/joho-zeikaishaku/sonota/jirei/07denshi/index.htm`,
    linkPattern: /07denshi\/[^/]+\.htm$/,
  },
  denshi_scan: {
    label: '電子帳簿保存法一問一答【スキャナ保存関係】',
    tax_category: '帳簿・経費',
    tax_category_code: 'chobo',
    tax_domain: 'bookkeeping_expenses',
    format: 'html',
    indexUrl: `${HOST}/law/joho-zeikaishaku/sonota/jirei/07scan/index.htm`,
    linkPattern: /07scan\/[^/]+\.htm$/,
  },

  // 消費税の軽減税率。8%か10%かの判断は事例ごとに分かれ、
  // タックスアンサーには一般論しかない。小売店・飲食業の読者に直結する。
  // まとめPDF1本に多数の問が入っているので、問ごとに分割して保存する。
  keigen: {
    label: '消費税の軽減税率制度に関するQ&A',
    tax_category: '消費税',
    tax_category_code: 'shohi',
    tax_domain: 'consumption_tax',
    split: true,
    docs: [
      {
        id: 'gaiyo',
        title: '消費税の軽減税率制度に関するQ&A（制度概要編）',
        url: `${HOST}/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/02-01.pdf`,
      },
      {
        id: 'jirei',
        title: '消費税の軽減税率制度に関するQ&A（個別事例編）',
        url: `${HOST}/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/pdf/qa/03-01.pdf`,
      },
    ],
  },

  // 国境を越えた役務の提供とプラットフォーム課税。
  // 電子書籍・オンライン講座・広告など、EC・コンテンツ販売の読者に関わる。
  // 2026-08-16: プラットフォーム課税の対象（国外事業者限定）を誤った記事が出ている。
  cross_border: {
    label: '国境を越えた役務の提供に係る消費税',
    tax_category: '消費税',
    tax_category_code: 'shohi',
    tax_domain: 'overseas_transactions',
    docs: [
      {
        id: 'kokunai',
        title: '国境を越えた役務の提供に係る消費税の課税の見直し等について（国内事業者の皆さまへ）',
        url: `${HOST}/publication/pamph/pdf/cross-kokunai.pdf`,
      },
      {
        id: 'platform_kokugai',
        title: '消費税のプラットフォーム課税に関するQ&A（国外事業者用）',
        url: `${HOST}/publication/pamph/shohi/kazei/pdf/0024004-028_02-1.pdf`,
      },
      {
        id: 'platform_jigyosha',
        title: '消費税のプラットフォーム課税に関するQ&A（プラットフォーム事業者用）',
        url: `${HOST}/publication/pamph/shohi/kazei/pdf/0024004-028_02-2.pdf`,
      },
    ],
  },
};

// ── HTTP ────────────────────────────────────────────────────
function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('リダイレクトが多すぎます'));
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (hp-vlog nta-qa crawler)' },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(fetchBuffer(next, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`タイムアウト: ${url}`)); });
  });
}

function decodeHtml(buf) {
  const head = buf.toString('binary').slice(0, 2048);
  const m = head.match(/charset=["']?([\w-]+)/i);
  const charset = (m ? m[1] : 'utf-8').toLowerCase().replace(/[-_]/g, '');
  const enc = (charset === 'shiftjis' || charset === 'sjis' || charset === 'ms932' || charset === 'windows31j')
    ? 'shift_jis' : (charset === 'eucjp' ? 'euc-jp' : 'utf-8');
  try { return new TextDecoder(enc).decode(buf); } catch (_) { return buf.toString('utf8'); }
}

// ── PDF → テキスト ───────────────────────────────────────────
let _pdftotextChecked = false;
function ensurePdftotext() {
  if (_pdftotextChecked) return;
  try {
    execFileSync('pdftotext', ['-v'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // pdftotext -v はバージョンを stderr に出して終了コード99を返す。
    // 「実行できたが非ゼロ終了」と「そもそも見つからない」を区別する。
    if (error.code === 'ENOENT') {
      throw new Error('pdftotext が見つかりません（poppler-utils が必要です）');
    }
  }
  _pdftotextChecked = true;
}

function pdfToText(buf) {
  ensurePdftotext();
  const tmp = path.join(os.tmpdir(), `nta-qa-${process.pid}-${Date.now()}`);
  const pdfPath = `${tmp}.pdf`;
  const txtPath = `${tmp}.txt`;
  try {
    fs.writeFileSync(pdfPath, buf);
    execFileSync('pdftotext', ['-enc', 'UTF-8', pdfPath, txtPath], { stdio: 'ignore' });
    return fs.readFileSync(txtPath, 'utf8');
  } finally {
    for (const f of [pdfPath, txtPath]) { try { fs.unlinkSync(f); } catch (_) { /* noop */ } }
  }
}

/** HTMLページから本文テキストを取り出す（電子帳簿保存法の一問一答はHTMLで公開されている） */
function htmlToText(html) {
  let text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 本文は最初の「問○」から始まる。手前のパンくず・ページ見出しは落とす。
  const first = text.search(/問\s?[\d０-９]/);
  if (first > 0) text = text.slice(first);
  // 末尾はサイト共通のフッタ（関連リンク・サイトマップ等）。そこで切る。
  const tail = text.search(/(?:関連情報|関連リンク|サイトマップ|お問い合わせ先|このページの先頭へ)/);
  if (tail > 200) text = text.slice(0, tail);
  return text.trim();
}

/** 抽出テキストを整形し、題名（問）と本文に分ける */
function parseQaText(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').replace(/[ \t　]+/g, ' ').trim();
  if (!text) return null;
  const flat = text.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // 「（見出し） 問12 …」の形が基本。ただし章の先頭のファイルは
  // 「Ⅰ 適格請求書等保存方式の概要 （見出し） 問1 …」のように章見出しが前に付く。
  // 先頭から探すのではなく、最初の「（見出し）＋問番号」の組を拾う。
  // PDF は「（見出し） 問12 …」。HTML は「問1 電子取引の制度は…」のように
  // 見出しの括弧が無く、問文がそのまま続く。両方に対応する。
  const headed = flat.match(/（([^（）]{2,60})）\s*(問\s?[\d０-９]+(?:\s?[\-－]\s?[\d０-９]+)?)/);
  if (!headed) {
    const plain = flat.match(/^(問\s?[\d０-９]+(?:\s?[\-－]\s?[\d０-９]+)?)\s*([^。]{4,60})/);
    if (plain) {
      const no = plain[1].replace(/\s/g, '');
      return { title: `${no} ${plain[2].trim()}`, qNo: no, body: flat };
    }
  }
  const title = headed ? `${headed[2].replace(/\s/g, '')} ${headed[1]}` : null;
  const qNo = headed ? headed[2].replace(/\s/g, '') : null;

  return { title, qNo, body: flat };
}

/**
 * まとめPDF（1本に多数の問が入っている資料）を問ごとに切り分ける。
 *
 * 軽減税率の個別事例編は約10万字あり、1件として保存すると本文の上限（1,800字）で
 * 冒頭しか渡らず役に立たない。「（見出し）問N …」の区切りで分割する。
 *
 * 先頭には目次が付いており、そこにも同じ「（見出し）問N」が並ぶ。目次側は
 * ページ番号の点線（……）で終わるので、本文が極端に短い塊は目次として捨てる。
 */
function splitByQuestion(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const re = /（([^（）]{2,60})）\s*(問\s?[\d０-９]+(?:\s?[\-－]\s?[\d０-９]+)?)/g;
  const marks = [...flat.matchAll(re)];
  if (marks.length < 5) return [];   // 分割対象ではない

  const out = [];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : flat.length;
    const body = flat.slice(start, end).trim();
    const qNo = marks[i][2].replace(/\s/g, '');
    // 目次の行はページ番号の点線で終わり、本文が無い
    if (body.length < 120) continue;
    if (/…{3,}|\.{6,}\s*\d+$/.test(body)) continue;
    // 同じ問が目次と本文で2回出る。長い方（本文）を採る
    const prev = seen.has(qNo) ? out.find(o => o.qNo === qNo) : null;
    if (prev) {
      if (body.length > prev.body.length) { prev.body = body; prev.title = `${qNo} ${marks[i][1]}`; }
      continue;
    }
    seen.add(qNo);
    out.push({ qNo, title: `${qNo} ${marks[i][1]}`, body });
  }
  return out;
}

// ── 保存 ────────────────────────────────────────────────────
function saveEntry(sourceKey, source, doc, parsed, url) {
  const dir = path.join(OUT_DIR, sourceKey);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${doc.id}.json`;
  const relative = path.join(sourceKey, file).replace(/\\/g, '/');
  const title = doc.title || parsed.title || `${source.label} ${doc.id}`;
  const record = {
    id: doc.id,
    type: 'qa',
    source_key: sourceKey,
    source_label: source.label,
    tax_category: source.tax_category,
    tax_category_code: source.tax_category_code,
    tax_domain: source.tax_domain,
    q_no: parsed.qNo || null,
    digest: doc.digest === true,
    title,
    url,
    body: parsed.body,
    char_count_body: parsed.body.length,
    fetched_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, relative), JSON.stringify(record, null, 2) + '\n', 'utf8');
  return { relative, record };
}

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch (_) { return { version: 1, entries: [] }; }
}

function writeIndex(index) {
  index.generated_at = new Date().toISOString();
  index.total_count = index.entries.length;
  index.by_source = index.entries.reduce((acc, e) => {
    acc[e.source_key] = (acc[e.source_key] || 0) + 1;
    return acc;
  }, {});
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n', 'utf8');
}

// ── 本体 ────────────────────────────────────────────────────
async function crawlSource(sourceKey, source, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null;
  const delayMs = options.delayMs === undefined ? FETCH_DELAY_MS : options.delayMs;
  const logger = options.logger === undefined ? console : options.logger;
  const log = (m) => { if (logger && logger.log) logger.log(m); };
  const warn = (m) => { if (logger && logger.warn) logger.warn(m); };

  const targets = [];

  // 目次ページから PDF リンクを集める
  if (source.indexUrl) {
    const html = decodeHtml(await fetchBuffer(source.indexUrl));
    const seen = new Set();
    // href はアンカー付き（…/01.htm#a001）のことがあるので # の手前まで拾う。
    const ext = source.format === 'html' ? 'htm' : 'pdf';
    const linkRe = new RegExp(`href="([^"#]+\\.${ext})`, 'g');
    for (const m of html.matchAll(linkRe)) {
      const href = m[1];
      if (/index\.(?:htm|pdf)$/.test(href)) continue;   // 目次自身は対象外
      if (source.linkPattern && !source.linkPattern.test(href)) continue;
      const url = new URL(href, source.indexUrl).toString();
      if (seen.has(url)) continue;
      seen.add(url);
      targets.push({ id: path.basename(href, `.${ext}`), url, title: null });
    }
    log(`[nta-qa] ${source.label}: 目次から ${targets.length} 件`);
  }
  for (const doc of (source.docs || [])) targets.push(doc);

  const list = limit ? targets.slice(0, limit) : targets;
  const saved = [];
  let failed = 0;

  for (let i = 0; i < list.length; i++) {
    const doc = list[i];
    try {
      const buf = await fetchBuffer(doc.url);
      const text = source.format === 'html' ? htmlToText(decodeHtml(buf)) : pdfToText(buf);
      // まとめPDF は問ごとに分ける。分けないと本文の上限で冒頭しか渡らない。
      const parts = source.split ? splitByQuestion(text) : [];
      if (parts.length > 0) {
        for (const part of parts) {
          const sub = { id: `${doc.id}-${part.qNo.replace(/[^0-9]/g, '')}`, title: part.title };
          saved.push(saveEntry(sourceKey, source, sub, part, doc.url));
        }
        log(`[nta-qa] ${doc.id}: ${parts.length} 問に分割`);
      } else {
        const parsed = parseQaText(text);
        if (!parsed || parsed.body.length < 50) throw new Error('本文を抽出できませんでした');
        saved.push(saveEntry(sourceKey, source, doc, parsed, doc.url));
      }
    } catch (error) {
      failed++;
      warn(`[nta-qa] ${doc.id} を取得できません: ${error.message}`);
    }
    if (i < list.length - 1 && delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    if ((i + 1) % 20 === 0) log(`[nta-qa] ${i + 1}/${list.length}`);
  }

  log(`[nta-qa] ${source.label}: ${saved.length} 件保存${failed ? `（失敗 ${failed} 件）` : ''}`);
  return { saved, failed };
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : null;

  // PDF を含む対象があるときだけ pdftotext を要求する
  const keysToRun = only ? [only] : Object.keys(SOURCES);
  if (keysToRun.some(k => SOURCES[k] && SOURCES[k].format !== 'html')) ensurePdftotext();

  const index = loadIndex();
  const keys = keysToRun;
  for (const key of keys) {
    const source = SOURCES[key];
    if (!source) { console.error(`[nta-qa] 未知の対象: ${key}`); process.exit(1); }
    const { saved } = await crawlSource(key, source, { limit });
    // --only でも他の対象を消さないよう、同じ source_key の分だけ入れ替える
    index.entries = index.entries.filter(e => e.source_key !== key);
    for (const s of saved) {
      const r = s.record;
      index.entries.push({
        id: r.id, type: r.type, source_key: r.source_key, source_label: r.source_label,
        tax_category: r.tax_category, tax_category_code: r.tax_category_code,
        tax_domain: r.tax_domain, q_no: r.q_no, digest: r.digest, title: r.title, url: r.url,
        file_path: s.relative, char_count_body: r.char_count_body, fetched_at: r.fetched_at,
      });
    }
  }
  index.entries.sort((a, b) => (a.source_key + a.id).localeCompare(b.source_key + b.id));
  writeIndex(index);
  console.log(`[nta-qa] 完了: 合計 ${index.entries.length} 件 → ${path.relative(ROOT, INDEX_PATH)}`);
}

if (require.main === module) {
  main().catch(e => { console.error('[nta-qa] 失敗:', e.message); process.exit(1); });
}

module.exports = { SOURCES, parseQaText, pdfToText, htmlToText, splitByQuestion, crawlSource, OUT_DIR, INDEX_PATH };
