#!/usr/bin/env node
'use strict';

/**
 * 質疑応答事例 候補の一次選定（curation）
 *
 * 自動スコアラだけだとペルソナ無関係なテーマ（投資信託、リース、公益法人、
 * 不動産取引等）が高スコア候補に多数混入する。タイトルベースのキーワード
 * フィルタで「明らかに無関係」を除外しつつ、ペルソナの実務に直結する
 * テーマだけを残す。
 *
 * 使い方:
 *   node scripts/curate-shitsugi-candidates.js          # adopted を書き換えず dry-run（採用予定を表示）
 *   node scripts/curate-shitsugi-candidates.js --apply  # adopted=true を実際に書き込む
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'nta-shitsugi-topics-candidate.json');

// ── 各ペルソナのフィルタ定義 ────────────────────────────────────
// POSITIVE: タイトルに含まれていれば候補化
// NEGATIVE: 含まれていれば除外（強い NG）
// MAX: 採用上限（多すぎる場合スコア順で上位だけ採用）
//
// 評価順は宣言順（先のペルソナで採用された URL は後のペルソナでは
// 候補にしない）。ebay_export_seller を先に評価して domestic_ec_seller
// 候補から輸出関連を「奪う」設計。
const FILTERS = {
  ebay_export_seller: {
    positive: [
      '輸出', '輸出免税', '非居住者', '国外事業者', '外貨建', '為替',
      '通関', '輸入手続', '国際輸送', '輸入物品', '海外の購入先',
      '国外で行う', '国外工事', '輸入機械', '輸入販売',
    ],
    negative: [
      '居宅介護', '退職', '株式', '配偶者', '相続', '贈与', '遺産',
      '所有権移転', 'プロゴルファー', '米国人', '公益法人',
      '中期国債ファンド', '不動産', '土地', '建物', '貸ビル',
      '馬主', 'ファンド', '債券', '有価証券',
    ],
    max: 12,
    // ebay_export_seller は auto-scorer で domestic_ec_seller に
    // 振り分けられた候補も対象に含める
    reclassifyFromOtherPersonas: ['domestic_ec_seller'],
  },

  domestic_ec_seller: {
    positive: [
      // 課税事業者判定の核
      '課税事業者', '免税事業者', '基準期間', '特定期間', '納税義務',
      // インボイス
      'インボイス', '適格請求書', '免税事業者からの仕入',
      // 仕入税額控除（EC でも関連する範囲）
      '通信販売', '電気通信利用役務', 'クレジットカード', 'ポイント',
      'キャッシュバック', 'クーポン', 'メーカー',
      // 輸入・国際取引（Amazon・Shopify セラーで関連）
      '輸入', '通関', '国外事業者', '外貨建',
      // 雑所得・事業所得（副業 EC）
      '事業所得', '雑所得', '副業', '反復', '継続',
      // 在庫・経費
      '棚卸', '在庫', '開業', '廃業',
      // 簡易課税
      '簡易課税', 'みなし仕入率',
      // 家事按分
      '家事', '事業用', '兼用',
    ],
    negative: [
      // 大企業・特殊法人向け論点
      '投資信託', '債券', '株式売買', '有価証券', '保有目的株式',
      'デリバティブ', 'スワップ', '新株予約権', 'みなし配当',
      '所有権移転外ファイナンス・リース', '所有権移転ファイナンス・リース',
      '公益法人', 'マンション管理組合', 'ＪＶ', 'JV', '共同事業',
      // 不動産（EC セラーの中心テーマではない）
      '土地付建物', '貸ビル', '集合住宅', '不動産鑑定', 'テナント',
      '社宅', '保税', '住宅瑕疵',
      // その他 EC 無関係
      '退職', '弔慰金', '介護', '居宅介護', '障害者手帳',
      '配偶者居住権', '相続', '贈与', '遺産',
      '米国人', 'プロゴルファー', '海外勤務', '海外事業所',
      '野球場', '社員食堂', '転進助成金', 'カフェテリアプラン',
      '中期国債ファンド', '金融機関', '銀行間', '信託報酬',
    ],
    max: 35,
  },

  reseller_marketplace_seller: {
    positive: [
      '雑所得', '事業所得', '事業に該当', '反復', '継続', '営利',
      '古物', '中古', '生活用動産', '個人事業', '副業',
      '開業', '廃業', '棚卸',
      '簡易課税', 'みなし仕入率',
      '基準期間', '特定期間', '課税事業者', '免税事業者',
    ],
    negative: [
      '所有権移転外ファイナンス・リース', '所有権移転ファイナンス・リース',
      '投資信託', '株式売買', '有価証券', '債券', '新株予約権',
      '公益法人', '介護', '配偶者居住権', '相続', '贈与',
      '退職', '弔慰金', 'プロゴルファー', '米国人',
      '農地', '営農型', '太陽光発電', // 物販と関係薄
      '変額年金', '個人年金',
      '社員', '社内', // 法人特有
    ],
    max: 25,
  },

  influencer_creator: {
    positive: [
      // 所得区分
      '雑所得', '事業所得', '副業',
      // 報酬・原稿料・出演料（タレント・クリエイター系）
      '報酬', '原稿料', '出演料', '講演料', '芸能', '芸能人',
      '専属契約', 'タレント',
      // 提供・現物
      '物品の提供', '景品', '謝礼', '謝金',
      // 広告・PR・アフィリエイト
      '広告料', '広告費', 'タイアップ', 'アフィリエイト', '紹介料',
      // クリエイター作品系
      '原稿', 'デザイン料', '撮影', 'モデル',
    ],
    negative: [
      // 一般従業員・主婦・年金生活者向け論点
      'プロゴルファー', '米国人', 'ホステス',
      '所有権移転', '投資信託', '有価証券', '株式',
      '退職', '弔慰金', '配偶者控除', '配偶者居住権',
      '扶養控除', '扶養親族', 'ひとり親',
      '相続', '贈与', '遺産',
      '公益法人', '居宅介護', '農地',
      '財産形成', '異動申告書', '障害者手帳', 'マル優',
      '役員退職金', '通勤', 'カフェテリアプラン', 'ストックオプション',
      '労働組合', '地縁による団体', '納税準備預金',
      // 単発ホテル代等の社員福利厚生
      'ホテル代', '深夜', '出張',
      // 行政・公務員系
      '政治資金', '監査人',
      '生命保険料控除', '書道家', '販売員', '慰留金',
      '住宅取得',
      // 法人税の特別控除 (大企業向け)
      '特別控除', '租税特別措置法第42条',
    ],
    max: 15,
  },

  beauty_salon_owner: {
    positive: [
      // 個人事業の核
      '個人事業', '事業所得', '専従者', '青色申告', '白色',
      // 家族雇用
      '家族', '家事按分', '兼用', '家事',
      // 給与・源泉徴収（小規模事業者向け）
      '常時10人未満', '納期の特例', '源泉徴収義務',
      // 業務委託 vs 雇用
      '業務委託', '請負', '雇用',
      // 前受金・回数券
      '前受金', '繰延', '回数券',
      // 簡易課税・課税事業者
      '簡易課税', 'みなし仕入率',
      // 開廃業・法人成り
      '開業', '廃業', '法人成り', '小規模企業共済',
      // 退職金共済（個人事業主向け）
      '退職給与の引当',
    ],
    negative: [
      '所有権移転', '投資信託', '有価証券', '株式', '債券',
      '配偶者居住権', '相続', '贈与', '遺産',
      'プロゴルファー', '米国人', '公益法人', '居宅介護',
      'カフェテリアプラン', '転進助成金', '海外事業所',
      '不動産鑑定', '貸ビル', '社宅',
      // 大企業向け
      '租税特別措置法第42条', '特別控除', '分割',
      // 法人税系の複雑事例
      '法人成りにより支給を受ける', // タイトルが法人税系なら除外
    ],
    max: 15,
  },

  inheritance_client: {
    positive: [
      // 相続・贈与の中核論点（一般読者向け）
      '小規模宅地', '居住用財産', '居住用不動産',
      '配偶者居住権', '配偶者控除', '基礎控除',
      '生前贈与', '相続時精算課税', '暦年',
      '住宅取得等資金', '教育資金', '結婚・子育て',
      '名義預金', '生命保険金', '死亡退職金',
      '遺産分割', '遺贈', '遺留分', '相続放棄', '限定承認',
      // 評価特例（一般的なもの）
      '路線価', '農地', '借地権',
      // 申告実務
      '相続税の申告', '贈与税の申告', '相続税の納税猶予',
      '事業承継',
    ],
    negative: [
      '消費税', 'インボイス', '輸出', '輸入',
      '所有権移転外ファイナンス・リース', 'ＪＶ', 'JV',
      'プロゴルファー', '米国人', '居宅介護',
      '営農型', '太陽光発電',
      'デリバティブ', 'スワップ', '金融機関の店舗',
      // 専門家向け事例
      '企業組合', '取引相場のない', '純資産価額計算',
      'みなし配当', '1株当たり',
      // 国外特殊事例
      '無制限納税義務者', '制限納税義務者', '国外転出',
      // 信託の複雑事例
      '信託', '受益者',
      // 限定承認後の修正等
      '退職手当金が支給された', '更正の請求',
      '租税特別措置法第９条の７',
      // 民法 255 条系
      '民法第255条', '共有持分',
      // 譲渡所得の還付関係（相続実務とずれる）
      '還付加算金',
      // 認知系
      '認知', '特殊関係者',
      // 公益信託
      '公益信託',
      // 賃貸アパート負担付贈与の複雑論点
      '負担付贈与',
      // 合名会社等
      '合名会社', '無限責任社員',
    ],
    max: 20,
  },
};

// ── タイトルがフィルタにマッチするか ─────────────────────────
// title だけを判定対象にする（kankei_hourei は法令名だけで論点を反映しない）
function matchesFilter(candidate, filter) {
  const title = candidate.shitsugi_title || '';

  // 負キーワード優先（含めば即除外）
  for (const neg of filter.negative) {
    if (title.includes(neg)) return { ok: false, reason: `negative:${neg}` };
  }
  // 正キーワードのいずれかにマッチ
  for (const pos of filter.positive) {
    if (title.includes(pos)) return { ok: true, reason: `positive:${pos}` };
  }
  return { ok: false, reason: 'no_positive_match' };
}

// ── メイン ───────────────────────────────────────────────────
function main() {
  const apply = process.argv.includes('--apply');
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

  const selections = {};  // persona → [candidate, ...]
  const stats = { selected: 0, byPersona: {}, byCategory: {} };

  // どのペルソナでも採用されたら他では採用しない
  const adoptedUrlsGlobal = new Set();

  for (const persona of Object.keys(FILTERS)) {
    const filter = FILTERS[persona];
    // ペルソナの候補プールを構築
    // - proposed.persona === persona の候補
    // - もしくは reclassifyFromOtherPersonas が指定されていればそこも候補に
    const candidatePool = data.candidates.filter(c => {
      if (!c.proposed) return false;
      if (c.proposed.persona === persona) return true;
      if (filter.reclassifyFromOtherPersonas) {
        return filter.reclassifyFromOtherPersonas.includes(c.proposed.persona);
      }
      return false;
    });

    const matches = candidatePool
      .filter(c => !adoptedUrlsGlobal.has(c.shitsugi_url))  // 他ペルソナで既に選定済みは除外
      .map(c => ({ c, match: matchesFilter(c, filter) }))
      .filter(x => x.match.ok)
      .sort((a, b) => b.c.score - a.c.score);

    // 上限を適用
    const selected = matches.slice(0, filter.max);
    selections[persona] = selected;
    for (const { c } of selected) adoptedUrlsGlobal.add(c.shitsugi_url);

    stats.byPersona[persona] = selected.length;
    stats.selected += selected.length;
    for (const { c } of selected) {
      stats.byCategory[c.tax_category] = (stats.byCategory[c.tax_category] || 0) + 1;
    }
  }

  // 結果表示
  console.log('=== 一次選定結果 ===');
  console.log('total selected:', stats.selected);
  console.log('by persona:', stats.byPersona);
  console.log('by category:', stats.byCategory);
  console.log('');

  for (const persona of Object.keys(FILTERS)) {
    console.log('\n=== ' + persona + ' (' + selections[persona].length + ' 件 / 上限 ' + FILTERS[persona].max + ') ===');
    for (const { c, match } of selections[persona]) {
      console.log('  [' + c.score + '] ' + c.tax_category + ' | ' + c.shitsugi_title + '  [' + match.reason + ']');
    }
  }

  if (!apply) {
    console.log('\n--apply 指定なし → 書き換えはスキップ。');
    return;
  }

  // adopted=true を立てる
  const selectedUrls = new Set();
  for (const persona of Object.keys(selections)) {
    for (const { c } of selections[persona]) {
      selectedUrls.add(c.shitsugi_url);
    }
  }

  let updated = 0;
  for (const c of data.candidates) {
    if (selectedUrls.has(c.shitsugi_url) && c.adopted !== true) {
      c.adopted = true;
      c.adoption_note = 'Claude 一次選定: ペルソナ実務との直結性で選別';
      updated++;
    }
  }

  // stats 更新
  if (data.stats) {
    data.stats.adopted_count = data.candidates.filter(c => c.adopted).length;
  }

  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('\n更新: ' + updated + ' 件を adopted=true に設定 → ' + FILE);
}

main();
