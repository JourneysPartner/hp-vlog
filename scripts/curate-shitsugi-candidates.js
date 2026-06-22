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
 *   node scripts/curate-shitsugi-candidates.js          # adopted を書き換えず dry-run
 *   node scripts/curate-shitsugi-candidates.js --apply  # adopted=true を実際に書き込む
 *
 * 注意:
 *   既存 adopted=true のエントリは触らない（user が手動で立てたフラグを保持）。
 *   候補リストにマッチした新規エントリだけ adopted=true に切り替える。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'nta-shitsugi-topics-candidate.json');

// ── 各ペルソナのフィルタ定義 ────────────────────────────────────
// POSITIVE: タイトルに含まれていれば候補化
// NEGATIVE: 含まれていれば除外（強い NG）
// MAX: 採用上限
//
// 評価順は宣言順（先のペルソナで採用された URL は後では候補にしない）。
// ebay_export_seller を先に評価して domestic_ec_seller 候補から
// 輸出関連を「奪う」設計（auto-scorer がほぼ全て domestic に分類しているため）。
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
    reclassifyFromOtherPersonas: ['domestic_ec_seller'],
  },

  domestic_ec_seller: {
    positive: [
      '課税事業者', '免税事業者', '基準期間', '特定期間', '納税義務',
      'インボイス', '適格請求書', '免税事業者からの仕入',
      '通信販売', '電気通信利用役務', 'クレジットカード', 'ポイント',
      'キャッシュバック', 'クーポン', 'メーカー',
      '輸入', '通関', '国外事業者', '外貨建',
      '事業所得', '雑所得', '副業', '反復', '継続',
      '棚卸', '在庫', '開業', '廃業',
      '簡易課税', 'みなし仕入率',
      '家事', '事業用', '兼用',
    ],
    negative: [
      '投資信託', '債券', '株式売買', '有価証券', '保有目的株式',
      'デリバティブ', 'スワップ', '新株予約権', 'みなし配当',
      '所有権移転外ファイナンス・リース', '所有権移転ファイナンス・リース',
      '公益法人', 'マンション管理組合', 'ＪＶ', 'JV', '共同事業',
      '土地付建物', '貸ビル', '集合住宅', '不動産鑑定', 'テナント',
      '社宅', '保税', '住宅瑕疵',
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
      '農地', '営農型', '太陽光発電',
      '変額年金', '個人年金',
      '社員', '社内',
    ],
    max: 25,
  },

  influencer_creator: {
    positive: [
      '雑所得', '事業所得', '副業',
      '報酬', '原稿料', '出演料', '講演料', '芸能', '芸能人',
      '専属契約', 'タレント',
      '物品の提供', '景品', '謝礼', '謝金',
      '広告料', '広告費', 'タイアップ', 'アフィリエイト', '紹介料',
      '原稿', 'デザイン料', '撮影', 'モデル',
    ],
    negative: [
      'プロゴルファー', '米国人', 'ホステス',
      '所有権移転', '投資信託', '有価証券', '株式',
      '退職', '弔慰金', '配偶者控除', '配偶者居住権',
      '扶養控除', '扶養親族', 'ひとり親',
      '相続', '贈与', '遺産',
      '公益法人', '居宅介護', '農地',
      '財産形成', '異動申告書', '障害者手帳', 'マル優',
      '役員退職金', '通勤', 'カフェテリアプラン', 'ストックオプション',
      '労働組合', '地縁による団体', '納税準備預金',
      'ホテル代', '深夜', '出張',
      '政治資金', '監査人',
      '生命保険料控除', '書道家', '販売員', '慰留金',
      '住宅取得',
      '特別控除', '租税特別措置法第42条',
    ],
    max: 15,
  },

  beauty_salon_owner: {
    positive: [
      '個人事業', '事業所得', '専従者', '青色申告', '白色',
      '家族', '家事按分', '兼用', '家事',
      '常時10人未満', '納期の特例', '源泉徴収義務',
      '業務委託', '請負', '雇用',
      '前受金', '繰延', '回数券',
      '簡易課税', 'みなし仕入率',
      '開業', '廃業', '法人成り', '小規模企業共済',
      '退職給与の引当',
    ],
    negative: [
      '所有権移転', '投資信託', '有価証券', '株式', '債券',
      '配偶者居住権', '相続', '贈与', '遺産',
      'プロゴルファー', '米国人', '公益法人', '居宅介護',
      'カフェテリアプラン', '転進助成金', '海外事業所',
      '不動産鑑定', '貸ビル', '社宅',
      '租税特別措置法第42条', '特別控除', '分割',
      '法人成りにより支給を受ける',
    ],
    max: 15,
  },

  inheritance_client: {
    positive: [
      '小規模宅地', '居住用財産', '居住用不動産',
      '配偶者居住権', '配偶者控除', '基礎控除',
      '生前贈与', '相続時精算課税', '暦年',
      '住宅取得等資金', '教育資金', '結婚・子育て',
      '名義預金', '生命保険金', '死亡退職金',
      '遺産分割', '遺贈', '遺留分', '相続放棄', '限定承認',
      '路線価', '農地', '借地権',
      '相続税の申告', '贈与税の申告', '相続税の納税猶予',
      '事業承継',
    ],
    negative: [
      '消費税', 'インボイス', '輸出', '輸入',
      '所有権移転外ファイナンス・リース', 'ＪＶ', 'JV',
      'プロゴルファー', '米国人', '居宅介護',
      '営農型', '太陽光発電',
      'デリバティブ', 'スワップ', '金融機関の店舗',
      '企業組合', '取引相場のない', '純資産価額計算',
      'みなし配当', '1株当たり',
      '無制限納税義務者', '制限納税義務者', '国外転出',
      '信託', '受益者',
      '退職手当金が支給された', '更正の請求',
      '租税特別措置法第９条の７',
      '民法第255条', '共有持分',
      '還付加算金',
      '認知', '特殊関係者',
      '公益信託',
      '負担付贈与',
      '合名会社', '無限責任社員',
    ],
    max: 20,
  },

  // 業種を問わない個人事業者全般向け
  general_individual_proprietor: {
    positive: [
      // 青色・白色申告
      '青色申告', '白色申告', '青色事業専従者', '専従者給与', '専従者控除',
      // 経費・必要経費
      '必要経費', '家事関連費', '家事按分',
      // 減価償却・固定資産
      '減価償却', '少額減価償却資産', '一括償却資産', '取得価額',
      // 開業・廃業
      '開業費', '廃業', '相続による事業承継', '事業承継',
      // 中間申告・予定納税
      '予定納税', '中間申告',
      // 共済・年金
      '小規模企業共済', '国民年金基金', '個人型確定拠出年金', 'iDeCo',
      // 損益通算・繰越
      '損益通算', '純損失の繰越', '繰戻し還付',
      // 売上の認識・期間
      '計上時期', '売上計上', '帰属年分',
    ],
    negative: [
      // 業種特化系（既存ペルソナでカバー）
      '美容', 'ネイル', 'サロン', 'インフルエンサー', 'YouTube',
      'eBay', 'Amazon', 'メルカリ', '輸出',
      // 大企業・特殊主体
      '所有権移転外ファイナンス・リース', '公益法人', 'プロゴルファー',
      '米国人', 'ＪＶ', 'JV', '居宅介護', '障害者手帳',
      'カフェテリアプラン', '退職手当金が支給された',
      // 相続・贈与（既存）
      '相続', '贈与', '遺産', '配偶者居住権', '小規模宅地',
      // 法人特化
      '法人成り', '役員報酬', '取締役', '取締役会', '株主総会',
    ],
    max: 25,
    // どの auto-scorer 分類からも拾い上げる
    reclassifyFromOtherPersonas: ['domestic_ec_seller', 'reseller_marketplace_seller', 'influencer_creator', 'beauty_salon_owner'],
  },

  // 業種を問わない法人全般向け
  general_corporation: {
    positive: [
      // 法人税の基本
      '法人税', '中間申告', '予定申告', '確定申告書',
      // 役員・株主
      '役員報酬', '役員退職金', '役員給与', '定期同額給与',
      '株主', '取締役', '使用人兼務役員',
      // 減価償却・棚卸
      '減価償却', '取得価額', '耐用年数',
      '棚卸資産の評価方法',
      // 交際費・福利厚生
      '交際費', '寄附金', '福利厚生費',
      // 設立・組織再編
      '新設法人', '設立', '事業承継', '組織再編',
      // 繰越欠損金
      '欠損金', '繰越控除',
      // 中小法人特例
      '中小法人', '中小企業',
    ],
    negative: [
      // 業種特化系（既存ペルソナでカバー）
      '美容', 'ネイル', 'サロン', 'インフルエンサー', 'YouTube',
      'eBay', 'Amazon', 'メルカリ',
      // 個人特化
      '専従者', '家事按分', '個人事業者',
      // 相続贈与
      '相続', '贈与', '遺産',
      // 居宅介護等
      '居宅介護', '障害者手帳', '公益法人', 'プロゴルファー',
      '所有権移転外ファイナンス・リース',
      // 高度・特殊
      '取引相場のない', '純資産価額計算', 'デリバティブ',
    ],
    max: 30,
    reclassifyFromOtherPersonas: ['domestic_ec_seller', 'reseller_marketplace_seller', 'influencer_creator', 'beauty_salon_owner', 'ebay_export_seller'],
  },
};

// ── タイトルがフィルタにマッチするか ─────────────────────────
function matchesFilter(candidate, filter) {
  const title = candidate.shitsugi_title || '';
  for (const neg of filter.negative) {
    if (title.includes(neg)) return { ok: false, reason: `negative:${neg}` };
  }
  for (const pos of filter.positive) {
    if (title.includes(pos)) return { ok: true, reason: `positive:${pos}` };
  }
  return { ok: false, reason: 'no_positive_match' };
}

// ── メイン ───────────────────────────────────────────────────
function main() {
  const apply = process.argv.includes('--apply');
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

  const selections = {};
  const stats = { selected: 0, byPersona: {}, byCategory: {} };
  const adoptedUrlsGlobal = new Set();

  for (const persona of Object.keys(FILTERS)) {
    const filter = FILTERS[persona];
    const candidatePool = data.candidates.filter(c => {
      if (!c.proposed) return false;
      if (c.proposed.persona === persona) return true;
      if (filter.reclassifyFromOtherPersonas) {
        return filter.reclassifyFromOtherPersonas.includes(c.proposed.persona);
      }
      return false;
    });

    const matches = candidatePool
      .filter(c => !adoptedUrlsGlobal.has(c.shitsugi_url))
      .map(c => ({ c, match: matchesFilter(c, filter) }))
      .filter(x => x.match.ok)
      .sort((a, b) => b.c.score - a.c.score);

    const selected = matches.slice(0, filter.max);
    selections[persona] = selected;
    for (const { c } of selected) adoptedUrlsGlobal.add(c.shitsugi_url);

    stats.byPersona[persona] = selected.length;
    stats.selected += selected.length;
    for (const { c } of selected) {
      stats.byCategory[c.tax_category] = (stats.byCategory[c.tax_category] || 0) + 1;
    }
  }

  console.log('=== 一次選定結果 ===');
  console.log('total selected:', stats.selected);
  console.log('by persona:', stats.byPersona);
  console.log('by category:', stats.byCategory);

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

  // adopted を更新 + 新ペルソナで再分類された候補は persona も更新
  // 既存 adopted=true は保持。新規にマッチしたものを追加。
  //
  // 各候補が「どのペルソナで選定されたか」を記録する map を作る。
  // 同じ URL が複数ペルソナで選ばれた場合は、宣言順で最初のペルソナを優先
  // （selections の処理順で adoptedUrlsGlobal が排他制御する設計）。
  const urlToSelectedPersona = new Map();
  for (const persona of Object.keys(selections)) {
    for (const { c } of selections[persona]) {
      if (!urlToSelectedPersona.has(c.shitsugi_url)) {
        urlToSelectedPersona.set(c.shitsugi_url, persona);
      }
    }
  }

  let added = 0, alreadyAdopted = 0, reclassified = 0;
  for (const c of data.candidates) {
    const selectedPersona = urlToSelectedPersona.get(c.shitsugi_url);
    if (!selectedPersona) continue;

    // 新ペルソナ（general_*）で選ばれた場合、proposed.persona を更新する
    const isReclassifying = selectedPersona.startsWith('general_') &&
                            c.proposed && c.proposed.persona !== selectedPersona;
    if (isReclassifying) {
      c.proposed.persona = selectedPersona;
      reclassified++;
    }

    if (c.adopted === true) {
      alreadyAdopted++;
    } else {
      c.adopted = true;
      if (!c.adoption_note) c.adoption_note = 'Claude 一次選定: ペルソナ実務との直結性で選別';
      added++;
    }
  }

  // stats 更新
  const totalAdopted = data.candidates.filter(c => c.adopted).length;
  if (data.stats) {
    data.stats.adopted_count = totalAdopted;
  }

  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('\n=== 適用結果 ===');
  console.log('  新規追加: ' + added + ' 件');
  console.log('  既に採用済（保持）: ' + alreadyAdopted + ' 件');
  console.log('  proposed.persona を general_* に再分類: ' + reclassified + ' 件');
  console.log('  合計採用: ' + totalAdopted + ' 件');
  console.log('  ファイル: ' + FILE);
}

main();
