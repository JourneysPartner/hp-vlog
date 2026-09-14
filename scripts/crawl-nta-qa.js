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
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'nta-qa');
const INDEX_PATH = path.join(OUT_DIR, 'index.json');
const FETCH_DELAY_MS = 1200;
const HOST = 'https://www.nta.go.jp';
const DOT_LEADER_RE = /[·・．.…]{6,}/;

function looksLikeTableOfContents(body) {
  return DOT_LEADER_RE.test(String(body || ''));
}

function hasAnswerLikeContent(body) {
  return /【答】|（答）|【回答要旨】|【回答】|(?:^|\s)答(?=\s|[：:]|$)/.test(String(body || ''));
}

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

  // 暗号資産の税務。売却・交換・マイニング・ステーキングなど、
  // タックスアンサーには載っていない具体的な計算と判定が並ぶ。
  // クリエイター・EC・投資をする個人事業主の読者に関わる。
  // 「（見出し）問N」ではなく「１－１ 見出し 問 … 答 …」の形式なので
  // splitBy: 'numbered' で分割する。
  kasou: {
    label: '暗号資産等に関する税務上の取扱いについて（FAQ）',
    tax_category: '所得税',
    tax_category_code: 'shotoku',
    tax_domain: 'income_tax',
    splitBy: 'numbered',
    docs: [
      {
        id: 'faq',
        title: '暗号資産等に関する税務上の取扱いについて（情報）',
        url: `${HOST}/publication/pamph/pdf/0025012-067.pdf`,
      },
    ],
  },

  // 相続税・贈与税。令和5年度改正で暦年課税の加算期間が3年から7年に延び、
  // 相続時精算課税に年110万円の基礎控除ができた。改正直後で判断が固まっておらず、
  // タックスアンサーには結論しか載っていない。具体的な計算例は質疑応答事例にある。
  // 相続は問い合わせにつながりやすく、読者の関心も高い。
  sozoku: {
    label: '相続税及び贈与税等に関する質疑応答事例（令和5年度税制改正関係）',
    tax_category: '相続税・贈与税',
    tax_category_code: 'sozoku',
    tax_domain: 'inheritance_tax',
    splitBy: 'paren',
    docs: [
      {
        id: 'r5kaisei',
        title: '相続税及び贈与税等に関する質疑応答事例（令和5年度税制改正関係）',
        url: `${HOST}/law/joho-zeikaishaku/sozoku/pdf/0024006-159.pdf`,
      },
    ],
  },

  // 相続税・贈与税の改正のあらましと、教育資金の一括贈与の非課税制度。
  // どちらも問と答の形ではないので分割しない（1件の資料として保存する）。
  sozoku_pamph: {
    label: '相続税・贈与税のパンフレット',
    tax_category: '相続税・贈与税',
    tax_category_code: 'sozoku',
    tax_domain: 'inheritance_tax',
    docs: [
      {
        id: 'kaisei_r5',
        title: '相続税及び贈与税の税制改正のあらまし（令和5年度）',
        url: `${HOST}/publication/pamph/pdf/0023006-004.pdf`,
      },
      {
        id: 'kyoiku_shikin',
        title: '祖父母などから教育資金の一括贈与を受けた場合の贈与税の非課税制度のあらまし',
        url: `${HOST}/publication/pamph/sozoku-zoyo/201304/pdf/0023004-114_02.pdf`,
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
 * 先頭には目次が付いており、そこにも同じ「（見出し）問N」が並ぶ。本文にだけある
 * 「【答】」と長さ、ページ番号の点線で目次を除外する。
 */
function splitByQuestion(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const re = /（([^（）]{2,60})）\s*(問\s?[\d０-９]+(?:\s?[\-－]\s?[\d０-９]+)?)/g;
  const marks = [...flat.matchAll(re)];
  if (marks.length < 5) return [];   // 分割対象ではない

  const out = [];
  const seen = new Map();
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : flat.length;
    const body = flat.slice(start, end).trim();
    const qNo = marks[i][2].replace(/\s/g, '');
    // 本文は「【答】」を含む。目次には答が無く、ページ番号の点線がある。
    if (!/【答】/.test(body)) continue;
    if (body.length < 150) continue;
    if (looksLikeTableOfContents(body)) continue;
    // 同じ問が目次と本文で2回出る。長い方（本文）を採る
    const prev = seen.get(qNo);
    if (prev) {
      if (body.length > prev.body.length) { prev.body = body; prev.title = `${qNo} ${marks[i][1]}`; }
      continue;
    }
    const rec = { qNo, title: `${qNo} ${marks[i][1]}`, body };
    seen.set(qNo, rec);
    out.push(rec);
  }
  return out;
}

/**
 * 番号見出し形式のまとめPDFを節ごとに切り分ける。
 *
 * 暗号資産のFAQは「１－１ 暗号資産を売却した場合〔令和○年更新〕 問 … 答 …」の形で、
 * 軽減税率のような「（見出し）問N」ではない。約14万字あるため分割しないと使えない。
 *
 * 先頭は目次で、同じ番号見出しがページ番号つきで並ぶ。
 * 本文は「問」と「答」の両方を含むので、それで目次と区別する。
 */
function splitByNumberedHeading(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const re = /([\d０-９]+(?:[－-][\d０-９]+){1,2})\s+([^0-9０-９\s][^【】]{2,50}?)(?=〔|\s+問\s)/g;
  const marks = [...flat.matchAll(re)];
  if (marks.length < 5) return [];

  const out = [];
  const seen = new Map();
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : flat.length;
    const body = flat.slice(start, end).trim();
    const no = marks[i][1].replace(/－/g, '-');
    if (!/問/.test(body) || !/答/.test(body)) continue;   // 目次には答が無い
    if (body.length < 150) continue;
    if (looksLikeTableOfContents(body)) continue;
    const prev = seen.get(no);
    if (prev) {
      if (body.length > prev.body.length) {
        prev.body = body;
        prev.title = `${no} ${marks[i][2].trim()}`;
      }
      continue;
    }
    const rec = { qNo: no, title: `${no} ${marks[i][2].trim()}`, body };
    seen.set(no, rec);
    out.push(rec);
  }
  return out;
}

/**
 * 括弧つき問番号形式のまとめPDFを問ごとに切り分ける。
 *
 * 相続税の質疑応答事例は「（問２－４）相続時精算課税に係る贈与により…
 * 【照会要旨】…【回答要旨】…」の形で、問番号が括弧に入り見出しが続く。
 *
 * 先頭は目次で、同じ「（問N）見出し」がページ番号つきで並ぶ。
 * 本文は【照会要旨】か【回答要旨】を含むので、それで目次と区別する。
 */
function splitByParenQuestion(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  // 見出しに括弧が入ることがある（例: …の計算（相続の開始前３年以内に…））ので、
  // 括弧を除外せず「【」「（問）」「点線」「次の（問N）」の手前までを見出しとする。
  const re = /（問\s?([\d０-９]+(?:[－-][\d０-９]+)?)\s?）\s*(.{4,90}?)(?=\s*【|\s*（問）|\s*\.{3,}|\s*（問\s?[\d０-９]|$)/g;
  const marks = [...flat.matchAll(re)];
  if (marks.length < 3) return [];

  const out = [];
  const seen = new Map();
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : flat.length;
    const body = flat.slice(start, end).trim();
    const no = `問${marks[i][1].replace(/－/g, '-')}`;
    // 本文は照会要旨・回答要旨を含む。目次はページ番号の点線で終わる。
    // 本文は「（問）…（答）」または「【照会要旨】…【回答要旨】」を含む。
    // 目次にはどちらも無く、ページ番号の点線で終わる。
    if (!/（答）|【回答要旨】|【回答】/.test(body)) continue;
    if (body.length < 150) continue;
    if (looksLikeTableOfContents(body)) continue;
    const title = marks[i][2].replace(/\.{3,}.*$/, '').trim();
    const prev = seen.get(no);
    if (prev) {
      if (body.length > prev.body.length) {
        prev.body = body;
        prev.title = `${no} ${title}`;
      }
      continue;
    }
    const rec = { qNo: no, title: `${no} ${title}`, body };
    seen.set(no, rec);
    out.push(rec);
  }
  return out;
}

// ── 保存 ────────────────────────────────────────────────────
function shouldSkipBodyUpdate(existingRecord, newRecord) {
  if (!existingRecord || typeof existingRecord.body !== 'string') return false;
  if (!newRecord || typeof newRecord.body !== 'string') return false;
  if (!hasAnswerLikeContent(existingRecord.body) || looksLikeTableOfContents(existingRecord.body)) {
    return false;
  }
  return existingRecord.body.length >= 300
    && newRecord.body.length < existingRecord.body.length * 0.5;
}

function getStaleSplitFileNames(source, writtenFileNames, existingFileNames, options = {}) {
  if (!source || (!source.split && !source.splitBy) || options.limitSpecified) return [];
  const written = new Set(writtenFileNames || []);
  return [...new Set(existingFileNames || [])]
    .filter(name => /\.json$/i.test(name) && !written.has(name))
    .sort();
}

/** 分割した問の、ASCII だけからなる安定した id を作る。 */
function buildEntryId(docId, qNo) {
  const compact = String(qNo || '').replace(/\s/g, '');
  const hasWideDigit = /[０-９]/.test(compact);
  // 軽減税率資料では単独の全角問番号が、別の節の半角問番号と重なる。
  // w (wide) は PDF の組版に由来するため読み順に左右されず、半角の既存 id も保てる。
  // 暗号資産・相続の階層番号は従来どおり正規化だけを行い、既存 id を変更しない。
  const wideMarker = hasWideDigit && /^問[0-9０-９]+$/.test(compact) ? 'w' : '';
  const slugNo = compact
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/－/g, '-')
    .replace(/[^0-9-]/g, '');
  return `${docId}-${slugNo}${wideMarker}`;
}

/**
 * 分割結果すべてに id を付け、全角・半角以外の衝突も安定した形で解消する。
 * 衝突時に素の id を残す問は内容のソートで決めるため、入力順には依存しない。
 */
function resolveEntryIds(docId, parts, options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : console.warn;
  const pending = (parts || []).map((part, index) => {
    const fingerprint = JSON.stringify([
      String(part.qNo || ''),
      String(part.title || ''),
      String(part.body || ''),
    ]);
    return {
      part,
      index,
      baseId: buildEntryId(docId, part.qNo),
      fingerprint,
      hash: crypto.createHash('sha256').update(fingerprint).digest('hex'),
      id: null,
    };
  });
  const groups = new Map();
  for (const entry of pending) {
    if (!groups.has(entry.baseId)) groups.set(entry.baseId, []);
    groups.get(entry.baseId).push(entry);
  }

  for (const [baseId, group] of groups) {
    if (group.length === 1) {
      group[0].id = baseId;
      continue;
    }

    const sorted = [...group].sort((a, b) => {
      if (a.fingerprint < b.fingerprint) return -1;
      if (a.fingerprint > b.fingerprint) return 1;
      return a.index - b.index;
    });
    const used = new Set([baseId]);
    sorted[0].id = baseId;
    for (let i = 1; i < sorted.length; i++) {
      const entry = sorted[i];
      const suffix = entry.hash.slice(0, 8);
      let id = `${baseId}-${suffix}`;
      let ordinal = 2;
      while (used.has(id)) id = `${baseId}-${suffix}-${ordinal++}`;
      entry.id = id;
      used.add(id);
    }

    warn(`[warn] ファイル名が衝突しました: ${baseId}\n`
      + sorted.map(entry => `       ${entry.part.title || entry.part.qNo || '(表題なし)'} → ${entry.id}`).join('\n'));
  }

  return pending.map(entry => ({ ...entry.part, id: entry.id }));
}

/** index には同じファイルを一度だけ入れる（先に来たエントリを残す）。 */
function dedupeIndexEntries(entries, options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : console.warn;
  const seen = new Set();
  const unique = [];
  for (const entry of (entries || [])) {
    if (seen.has(entry.file_path)) {
      warn(`[warn] index の重複した file_path を除外しました: ${entry.file_path}`);
      continue;
    }
    seen.add(entry.file_path);
    unique.push(entry);
  }
  return unique;
}

function saveEntry(sourceKey, source, doc, parsed, url, options = {}) {
  const dir = path.join(OUT_DIR, sourceKey);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${doc.id}.json`;
  const relative = path.join(sourceKey, file).replace(/\\/g, '/');
  const filePath = path.join(OUT_DIR, relative);
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
  let existingRecord = null;
  try { existingRecord = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { /* 新規ファイル、または既存ファイルを読み取れない場合は通常どおり保存する */ }

  if (shouldSkipBodyUpdate(existingRecord, record)) {
    const warn = typeof options.warn === 'function' ? options.warn : console.warn;
    const displayPath = path.relative(ROOT, filePath).replace(/\\/g, '/');
    warn(`[warn] 本文が大幅に短くなるため更新を見送りました\n`
      + `       ${displayPath}  ${existingRecord.body.length}字 → ${record.body.length}字\n`
      + '       PDF のテキスト抽出が目次を拾った可能性があります');
    return { relative, record: existingRecord, skipped: true };
  }

  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
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
  const limitSpecified = options.limit !== undefined && options.limit !== null;
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
  let skippedUpdates = 0;

  const save = (doc, parsed, url) => {
    const result = saveEntry(sourceKey, source, doc, parsed, url, { warn });
    if (result.skipped) skippedUpdates++;
    saved.push(result);
  };

  for (let i = 0; i < list.length; i++) {
    const doc = list[i];
    try {
      const buf = await fetchBuffer(doc.url);
      const text = source.format === 'html' ? htmlToText(decodeHtml(buf)) : pdfToText(buf);
      // まとめPDF は問ごとに分ける。分けないと本文の上限で冒頭しか渡らない。
      // まとめPDF の分け方は資料によって違う。
      //   question … 「（見出し）問N …」（軽減税率）
      //   numbered … 「１－１ 見出し 問 … 答 …」（暗号資産）
      const splitBy = source.splitBy || (source.split ? 'question' : null);
      //   paren    … 「（問N-N）見出し （問）… （答）…」（相続税）
      const parts = splitBy === 'numbered' ? splitByNumberedHeading(text)
        : splitBy === 'paren' ? splitByParenQuestion(text)
        : splitBy === 'question' ? splitByQuestion(text) : [];
      if (parts.length > 0) {
        for (const part of resolveEntryIds(doc.id, parts, { warn })) {
          const sub = { id: part.id, title: part.title };
          save(sub, part, doc.url);
        }
        log(`[nta-qa] ${doc.id}: ${parts.length} 問に分割`);
      } else {
        const parsed = parseQaText(text);
        if (!parsed || parsed.body.length < 50) throw new Error('本文を抽出できませんでした');
        save(doc, parsed, doc.url);
      }
    } catch (error) {
      failed++;
      warn(`[nta-qa] ${doc.id} を取得できません: ${error.message}`);
    }
    if (i < list.length - 1 && delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    if ((i + 1) % 20 === 0) log(`[nta-qa] ${i + 1}/${list.length}`);
  }

  const sourceDir = path.join(OUT_DIR, sourceKey);
  const existingFileNames = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
    : [];
  const writtenFileNames = saved.map(result => path.basename(result.relative));
  const staleFileNames = getStaleSplitFileNames(
    source,
    writtenFileNames,
    existingFileNames,
    { limitSpecified },
  );
  for (const fileName of staleFileNames) fs.unlinkSync(path.join(sourceDir, fileName));
  if (staleFileNames.length > 0) {
    log(`[nta-qa] ${sourceKey}: 取り込めなくなった ${staleFileNames.length} 件を削除しました\n`
      + `         ${staleFileNames.join(', ')}`);
  }

  log(`[nta-qa] ${source.label}: ${saved.length} 件保存${failed ? `（失敗 ${failed} 件）` : ''}`
    + `${skippedUpdates ? `（本文短縮による更新見送り ${skippedUpdates} 件）` : ''}`);
  return { saved, failed, skippedUpdates };
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : null;

  // PDF を含む対象があるときだけ pdftotext を要求する
  const keysToRun = only ? [only] : Object.keys(SOURCES);
  // scope（適用条件）が未定義の資料は、生成時にどの記事にも添付されない。
  // 追加した資料に scope を書き忘れていたら、ここで気づけるようにする。
  {
    const { sourceKeysWithoutScope } = require('./lib/nta-qa-sources');
    const missing = sourceKeysWithoutScope(Object.keys(SOURCES));
    if (missing.length > 0) {
      console.warn(`[nta-qa] ⚠ scope 未定義の資料があります（生成時に添付されません）: ${missing.join(', ')}`
        + ' → scripts/lib/nta-qa-sources.js に追加してください');
    }
  }
  if (keysToRun.some(k => SOURCES[k] && SOURCES[k].format !== 'html')) ensurePdftotext();

  const index = loadIndex();
  const keys = keysToRun;
  let skippedUpdates = 0;
  for (const key of keys) {
    const source = SOURCES[key];
    if (!source) { console.error(`[nta-qa] 未知の対象: ${key}`); process.exit(1); }
    const result = await crawlSource(key, source, { limit });
    const { saved } = result;
    skippedUpdates += result.skippedUpdates;
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
  index.entries = dedupeIndexEntries(index.entries, { warn: console.warn });
  index.entries.sort((a, b) => (a.source_key + a.id).localeCompare(b.source_key + b.id));
  writeIndex(index);
  if (skippedUpdates > 0) {
    console.warn(`[warn] 本文が大幅に短くなるため ${skippedUpdates} 件の更新を見送りました`);
  }
  console.log(`[nta-qa] 完了: 合計 ${index.entries.length} 件 → ${path.relative(ROOT, INDEX_PATH)}`);
}

if (require.main === module) {
  main().catch(e => { console.error('[nta-qa] 失敗:', e.message); process.exit(1); });
}

module.exports = {
  SOURCES,
  parseQaText,
  pdfToText,
  htmlToText,
  looksLikeTableOfContents,
  hasAnswerLikeContent,
  splitByQuestion,
  splitByNumberedHeading,
  splitByParenQuestion,
  shouldSkipBodyUpdate,
  getStaleSplitFileNames,
  buildEntryId,
  resolveEntryIds,
  dedupeIndexEntries,
  crawlSource,
  OUT_DIR,
  INDEX_PATH,
};
