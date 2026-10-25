'use strict';

// 基準の主張・articleEvidenceOptionsで作った検索オプションを固定。TEMPやAI・ネットワークには依存しない。
const assert = require('assert/strict');
const E = require('../fact-evidence');
const { rankSources, TAX_CATEGORY_CODES, tokenizeForMatcher } = require('../nta-source-matcher');

const articleOptions = {
  "newseg-retail_store-retail-apparel-season-inventory-apparel-guide": {
    "tax_domain": "bookkeeping_expenses",
    "source_url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm",
    "source_supplements": []
  },
  "shitsugi-sozoku-10-05": {
    "tax_domain": "inheritance_tax",
    "source_url": "https://www.nta.go.jp/law/shitsugi/sozoku/10/05.htm",
    "source_supplements": []
  },
  "suggest-zouyo-hikazei-5be58f": {
    "tax_domain": "inheritance_tax",
    "source_url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm",
    "source_supplements": [
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4510.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4511.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4405.htm"
      }
    ]
  },
  "gift-cash-procedure-tax-return": {
    "tax_terms": "暦年課税 贈与税の基礎控除 贈与税の申告 相続時精算課税",
    "source_bundle": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4429.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm;相続税法28条;相続税法33条;相続税法38条;相続税法39条;相続税法52条;相続税法62条;相続税法21条の2;相続税法21条の5",
    "tax_domain": "inheritance_tax",
    "source_url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4429.htm",
    "source_supplements": [
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm"
      }
    ]
  },
  "solo-contractor-invoice-registration": {
    "tax_terms": "適格請求書発行事業者 仕入税額控除 免税事業者 課税事業者選択届出書",
    "source_bundle": "",
    "tax_domain": "invoice_system",
    "source_url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6451.htm",
    "source_supplements": [
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6498.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6613.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6630.htm"
      }
    ]
  },
  "exp-plan-642": {
    "tax_terms": "",
    "source_bundle": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1110.htm;law:shotokuzei_rei:102;tsutatsu:shotoku:47-9;tsutatsu:shotoku:47-11;law:shotokuzei_hou:47;tsutatsu:shotoku:47-5;tsutatsu:shotoku:47-4;law:shotokuzei_rei:3;law:shotokuzei_rei:99;https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2090.htm",
    "tax_domain": "bookkeeping_expenses",
    "source_url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm",
    "source_supplements": []
  },
  "exp-plan-644": {
    "tax_terms": "",
    "source_bundle": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4510.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4511.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4405.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4402.htm;law:sozokuzei:21_5;https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4452.htm;law:sozokuzei:21_6;law:sozeki_hou:70_2;law:sozeki_hou:70_2_2;law:sozeki_hou:70_2_3;law:sozokuzei:21_4;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4141.htm;law:sozeki_rei:25_17;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4301.htm",
    "tax_domain": "inheritance_tax",
    "source_url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm",
    "source_supplements": [
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4510.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4511.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4405.htm"
      }
    ]
  },
  "exp-plan-solo": {
    "source_supplements": []
  },
  "stock-gift-tax-valuation": {
    "tax_terms": "取引相場のない株式の評価 財産評価基本通達 贈与税の申告 相続時精算課税",
    "source_bundle": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/hyoka/4638.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4429.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4602.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4152.htm;評基通168;評基通178;相続税法28条;相続税法33条;相続税法38条;相続税法39条;相続税法62条;相続税法21条の5",
    "tax_domain": "inheritance_tax",
    "source_url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/hyoka/4638.htm",
    "source_supplements": [
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4429.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4602.htm"
      }
    ]
  },
  "tip-income-tax-threshold": {
    "tax_terms": "事業所得 雑所得 必要経費 基礎控除",
    "source_bundle": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1500.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm;https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1191.htm;所得税法86条;租税特別措置法41条の16の2;所得税法35条;所得税法67条;所得税法69条;所得税法120条;所得税法203条の2;所得税法204条",
    "tax_domain": "income_tax",
    "source_url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm",
    "source_supplements": [
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1500.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1350.htm"
      },
      {
        "url": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm"
      }
    ]
  }
};

const targets = [
  {
    "slug": "suggest-zouyo-hikazei-5be58f",
    "claim": {
      "type": "要件",
      "subject": "暦年課税の基礎控除",
      "claim": "受贈者1人あたり年間合計110万円以下なら目的不問で非課税",
      "sentence": "| 暦年課税の基礎控除 | 年110万円 | 目的不問 | 受贈者1人あたり年間合計が110万円以下 |"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4402.htm"
  },
  {
    "slug": "gift-cash-procedure-tax-return",
    "claim": {
      "type": "判定",
      "subject": "贈与税の申告要否",
      "claim": "年間合計額が110万円以内なら通常は贈与税がかからず申告不要",
      "sentence": "合計額が110万円以内であれば、通常は贈与税はかからず、申告も不要です。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4402.htm"
  },
  {
    "slug": "gift-cash-procedure-tax-return",
    "claim": {
      "type": "判定",
      "subject": "贈与税の申告要否",
      "claim": "その年の贈与合計が110万円以内なら申告は通常不要",
      "sentence": "| 110万円以内 | 通常は不要 |"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4402.htm"
  },
  {
    "slug": "gift-cash-procedure-tax-return",
    "claim": {
      "type": "判定",
      "subject": "贈与税の申告要否",
      "claim": "その年の贈与合計が110万円を超えると申告が必要",
      "sentence": "| 110万円を超える | 必要 |"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4402.htm"
  },
  {
    "slug": "gift-cash-procedure-tax-return",
    "claim": {
      "type": "判定",
      "subject": "贈与税の課税対象",
      "claim": "110万円を超えた場合、税額は超えた部分にかかる",
      "sentence": "なお、110万円を超えた場合でも、実際に納める税額は「超えた部分」にかかります。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4402.htm"
  },
  {
    "slug": "gift-cash-procedure-tax-return",
    "claim": {
      "type": "判定",
      "subject": "贈与税の申告要否",
      "claim": "110万円以内の贈与は申告が通常不要",
      "sentence": "贈与税の申告は、通常不要です。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4402.htm"
  },
  {
    "slug": "tip-income-tax-threshold",
    "claim": {
      "type": "要件",
      "subject": "確定申告の要否",
      "claim": "給与収入が2,000万円を超える人は投げ銭の金額にかかわらず申告が必要",
      "sentence": "| 給与収入が2,000万円を超える | 投げ銭の金額にかかわらず申告が必要 |"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1900.htm"
  },
  {
    "slug": "tip-income-tax-threshold",
    "claim": {
      "type": "判定",
      "subject": "投げ銭の所得区分",
      "claim": "投げ銭は一般に雑所得として扱われる",
      "sentence": "投げ銭は、他のどの所得にも当てはまらない「雑所得」として扱われるのが一般的です。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1500.htm"
  }
];

const keep = [
  {
    "slug": "newseg-retail_store-retail-apparel-season-inventory-apparel-guide",
    "claim": {
      "type": "期限",
      "subject": "低価法の届出",
      "claim": "新たに事業を開始した場合はその年の確定申告書の提出期限までに届け出る",
      "sentence": "- 新たに事業を開始した場合：その年の確定申告書の提出期限まで"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2090.htm"
  },
  {
    "slug": "newseg-retail_store-retail-apparel-season-inventory-apparel-guide",
    "claim": {
      "type": "期限",
      "subject": "帳簿書類の保存",
      "claim": "棚卸表その他の決算書類は5年間保存する",
      "sentence": "国税庁タックスアンサー No.2080 では、棚卸表その他の決算書類について<strong>5年間の保存</strong>が定められています。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2080.htm"
  },
  {
    "slug": "shitsugi-sozoku-10-05",
    "claim": {
      "type": "要件",
      "subject": "小規模宅地等の特例（特定居住用宅地等）",
      "claim": "対象の土地は被相続人等の居住の用に供されていたものである必要がある",
      "sentence": "小規模宅地等の特例（特定居住用宅地等）は相続税の負担を大幅に軽減できる制度ですが、その前提として、対象の土地が<strong>「被相続人等の居住の用に供されていた」</strong>ものでなければなりません。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4124.htm"
  },
  {
    "slug": "shitsugi-sozoku-10-05",
    "claim": {
      "type": "判定",
      "subject": "居住の用に供されていた宅地等の判定",
      "claim": "被相続人等がその建物に生活の拠点を置いていたかどうかで判定する",
      "sentence": "小規模宅地の特例における「居住の用に供されていた宅地等」かどうかは、<strong>被相続人等がその建物に生活の拠点を置いていたかどうか</strong>によって判定します。"
    },
    "page": "https://www.nta.go.jp/law/shitsugi/sozoku/10/05.htm"
  },
  {
    "slug": "suggest-zouyo-hikazei-5be58f",
    "claim": {
      "type": "金額",
      "subject": "暦年課税の基礎控除",
      "claim": "暦年課税の基礎控除は年110万円である",
      "sentence": "1. <strong>毎年少しずつ渡す</strong>——暦年課税の基礎控除（年110万円）"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm"
  },
  {
    "slug": "suggest-zouyo-hikazei-5be58f",
    "claim": {
      "type": "金額",
      "subject": "住宅取得等資金の贈与の非課税特例",
      "claim": "非課税上限は省エネ等住宅で1,000万円、それ以外で500万円",
      "sentence": "| 住宅取得等資金の贈与（特例） | 最大1,000万円（省エネ等住宅）/ 500万円（それ以外） | 住宅の新築・取得・増改築 | 直系尊属から・受贈者18歳以上・合計所得2,000万円以下 等 |"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4508.htm"
  },
  {
    "slug": "gift-cash-procedure-tax-return",
    "claim": {
      "type": "金額",
      "subject": "贈与税の基礎控除",
      "claim": "1月1日～12月31日の贈与合計額から基礎控除110万円を引いて計算する",
      "sentence": "贈与税は、1年間（1月1日から12月31日）に贈与を受けた財産の合計額から基礎控除110万円を引いて計算します。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4402.htm"
  },
  {
    "slug": "gift-cash-procedure-tax-return",
    "claim": {
      "type": "金額",
      "subject": "相続時精算課税の特別控除",
      "claim": "年110万円の基礎控除とは別に特定贈与者ごと累計2,500万円の特別控除",
      "sentence": "この制度を選ぶと、年110万円の基礎控除とは別に、特定贈与者ごとに累計2,500万円までの特別控除があり、超えた部分には一律20%の税率がかかります。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm"
  },
  {
    "slug": "solo-contractor-invoice-registration",
    "claim": {
      "type": "要件",
      "subject": "適格請求書発行事業者の納税義務",
      "claim": "登録事業者は基準期間の課税売上高が1,000万円以下でも免税にならない",
      "sentence": "適格請求書発行事業者は、基準期間の課税売上高が1,000万円以下になっても免税事業者になりません（消費税法第9条第1項）。"
    },
    "page": "law:shohizei_hou:9"
  },
  {
    "slug": "solo-contractor-invoice-registration",
    "claim": {
      "type": "判定",
      "subject": "納税義務の判定",
      "claim": "納税義務は基準期間（前々年）の課税売上高で判定する",
      "sentence": "この場合、令和8年分は基準期間（令和6年）の課税売上高で判定するため免税事業者のままですが、令和9年分は令和7年の1,200万円が基準になり課税事業者になります。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm"
  },
  {
    "slug": "exp-plan-642",
    "claim": {
      "type": "期限",
      "subject": "棚卸資産の評価方法の届出",
      "claim": "事業開始時の届出期限は開始日の属する年分の確定申告期限までである",
      "sentence": "届出書の提出期限は、事業を開始した場合にはその日の属する年分の確定申告期限までです。"
    },
    "page": "law:shotokuzei_rei:100"
  },
  {
    "slug": "exp-plan-642",
    "claim": {
      "type": "期限",
      "subject": "棚卸資産の評価方法の届出",
      "claim": "他の種類の事業を開始・事業の種類を変更した場合もその年分の確定申告期限まで",
      "sentence": "事業を開始した後に新たに他の種類の事業を開始した場合や、事業の種類を変更した場合も、同じくその年分の確定申告期限までとなっています。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2090.htm"
  },
  {
    "slug": "exp-plan-644",
    "claim": {
      "type": "金額",
      "subject": "暦年課税の基礎控除",
      "claim": "暦年課税の贈与税は1年間の贈与財産の合計額から基礎控除110万円を差し引いた残りにかかる",
      "sentence": "暦年課税の贈与税は、その年の1月1日から12月31日までの1年間に贈与を受けた財産の合計額から基礎控除110万円を差し引いた残りにかかります。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4402.htm"
  },
  {
    "slug": "exp-plan-644",
    "claim": {
      "type": "金額",
      "subject": "配偶者控除",
      "claim": "基礎控除110万円のほかに最高2,000万円を控除できる",
      "sentence": "| 配偶者控除 | 婚姻期間20年以上の配偶者からの居住用不動産・取得資金 | 基礎控除110万円のほかに最高2,000万円 | 同じ配偶者からは一生に一度、翌年3月15日までに居住 |"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4452.htm"
  },
  {
    "slug": "exp-plan-solo",
    "claim": {
      "type": "要件",
      "subject": "簡易課税",
      "claim": "年間売上5,000万円超や法人では使える制度の組み合わせが変わる",
      "sentence": "法人化済みの方や、年間売上が5,000万円を超える方は、使える制度の組み合わせが変わるため別の判断になります。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6505.htm"
  },
  {
    "slug": "exp-plan-solo",
    "claim": {
      "type": "判定",
      "subject": "免税事業者",
      "claim": "売上1,000万円以下でも、登録すれば納税義務は免除されない",
      "sentence": "→ 売上1,000万円以下でも、登録すれば納税義務は免除されません。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6613.htm"
  },
  {
    "slug": "stock-gift-tax-valuation",
    "claim": {
      "type": "期限",
      "subject": "非上場株式の贈与",
      "claim": "贈与税は翌年2月1日から3月15日までに申告する",
      "sentence": "結論からいうと、非上場株式の贈与は「贈与日の株価を評価する」「贈与税を計算する」「翌年の2月1日から3月15日までに申告する」という3段階で進みます。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4103.htm"
  },
  {
    "slug": "stock-gift-tax-valuation",
    "claim": {
      "type": "判定",
      "subject": "取引相場のない株式の評価",
      "claim": "評価方法は会社の規模と株式の取得者によって変わる",
      "sentence": "ただし株価の評価方法は、会社の規模と、誰が株を受け取るかによって変わります。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/hyoka/4638.htm"
  },
  {
    "slug": "tip-income-tax-threshold",
    "claim": {
      "type": "金額",
      "subject": "給与所得者の確定申告不要制度",
      "claim": "会社員の申告判定ラインは給与以外の所得年間20万円",
      "sentence": "結論から言うと、会社員として給与を1か所から受けている場合は、投げ銭の収入から経費を引いた金額が年間20万円を超えたときが確定申告の目安です。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1900.htm"
  },
  {
    "slug": "tip-income-tax-threshold",
    "claim": {
      "type": "金額",
      "subject": "基礎控除",
      "claim": "基礎控除の額は104万円",
      "sentence": "給与のない専業配信者なら、合計所得が基礎控除（令和8年分は104万円）を超えるかどうかで判断します。"
    },
    "page": "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm"
  }
];

let checked = 0;
for (const [kind, cases] of [['target', targets], ['keep', keep]]) {
  for (const c of cases) {
    const options = articleOptions[c.slug];
    const rows = E.searchEvidence(c.claim, options), ids = rows.map(e => e.id);
    const label = kind + ' ' + c.slug + ': ' + c.claim.claim;
    assert(ids.includes(c.page), label + ': ' + c.page + ' が候補に残る');
    assert(rows.length <= 7, label + ': 7件上限');
    assert.equal(new Set(ids).size, ids.length, label + ': 重複なし');
    if (options.source_url) assert.equal(rows[0].url, options.source_url, label + ': 主出典が先頭');
    const name = E.subjectWithoutTrailingParens(c.claim.subject);
    const ranking = rankSources({ tax_domain: options.tax_domain, tax_terms: name },
      { allCategories: !TAX_CATEGORY_CODES[options.tax_domain], limit: 1 });
    assert(!ranking.errorCode, '制度名カタログが読める');
    if (ranking.top1?.score > 0) assert(rows.some(e => e.url === ranking.top1.url), label + ': subjectTopを維持');
    checked++;
  }
}
const groups = new Map();
for (const c of keep) groups.set(c.slug, [...(groups.get(c.slug) || []), c]);
assert.equal(groups.size, 10);
for (const cases of groups.values()) {
  assert.equal(cases.length, 2);
  assert.notDeepEqual(cases[0].claim, cases[1].claim);
}
const direct = keep.find(c => c.page === 'law:shohizei_hou:9');
assert(direct, 'keepに直接引用の回帰を含む');
assert(E.scoreEvidence(direct.claim, articleOptions[direct.slug]).scored.find(r => r.e.id === direct.page).score >= 10000);
const salary = targets.find(c => c.page.endsWith('/1900.htm'));
const salaryIds = E.searchEvidence(salary.claim, articleOptions[salary.slug]).map(e => e.id);
for (const amount of ['2000', '２，０００']) {
  const claim = { ...salary.claim, claim: salary.claim.claim.replaceAll('2,000', amount),
    sentence: salary.claim.sentence.replaceAll('2,000', amount) };
  assert.deepEqual(E.searchEvidence(claim, articleOptions[salary.slug]).map(e => e.id), salaryIds, '桁区切り・全角でも同じ候補');
  checked++;
}
const shortNumberClaim = {
  "type": "割合",
  "subject": "簡易課税",
  "claim": "建設業はみなし仕入率70%のため、3割特例と同じ納付額になる",
  "sentence": "建設業はみなし仕入率70%のため、3割特例と同じ30万円の納付になります。"
};
assert(!E.searchEvidence(shortNumberClaim, articleOptions['solo-contractor-invoice-registration'])
  .some(e => e.id === 'https://www.nta.go.jp/law/shitsugi/shohi/20/15.htm'), '短い数値だけで題名の異なる資料を足さない');
checked++;
console.log('fact-search-recall: ' + checked + ' 件成功（target 8件・10記事のkeep各2件・数値表記2件・短い数字1件・7件上限・主出典・direct・subjectTop）');

const reviewTests = [];
const reviewTest = (name, run) => reviewTests.push({ name, run });
const idsFor = (claim, options) => {
  const rows = E.searchEvidence(claim, options), ids = rows.map(e => e.id);
  assert(rows.length <= 7, '01b: 7件上限');
  assert.equal(new Set(ids).size, ids.length, '01b: 重複なし');
  if (options.source_url) assert.equal(rows[0].url, options.source_url, '01b: 主出典が先頭');
  return ids;
};

// articleOptions は cases.json の articles[slug].opts を転記したもの。
reviewTest('01b-H1-a 誤った面積で納税猶予のページを追加しない', () => {
  const ids = idsFor({ type: '割合', subject: '小規模宅地等の特例（特定居住用宅地等）',
    claim: '特定居住用宅地等は400平方メートルまで80%減額',
    sentence: '特定居住用宅地等は400平方メートルまで80%減額されます。' }, articleOptions['shitsugi-sozoku-10-05']);
  assert(!ids.includes('https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4153.htm'), '誤った面積を持つ別制度を追加しない');
  assert(ids.includes('https://www.nta.go.jp/law/shitsugi/sozoku/10/08.htm'), '居住用宅地の資料を残す');
});
reviewTest('01b-H1-b 誤った特別控除額で贈与の設例を追加しない', () => {
  const sentence = '特定贈与者ごとに累計2,000万円まで特別控除';
  const ids = idsFor({ type: '金額', subject: '相続時精算課税の特別控除', claim: sentence, sentence },
    articleOptions['gift-cash-procedure-tax-return']);
  assert(!ids.includes('https://www.nta.go.jp/taxes/shiraberu/taxanswer/sozoku/4504.htm'), '誤った額を持つ設例を追加しない');
  assert(ids.includes('law:sozokuzei:21_11_2'), '相続時精算課税の条文を残す');
});
reviewTest('01b-M2 消費税の申告に所得税の概説を追加しない', () => {
  // 2026-07-16-deepdive-general_individual_proprietor-import-tax-refund-detail-practice.md
  // の前付けを articleEvidenceOptions に渡した結果を転記（cases.json には未収録）。
  const options = {
    tax_domain: 'consumption_tax',
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm',
    source_supplements: [],
  };
  const ids = idsFor({ type: '手続', subject: '消費税の確定申告',
    claim: '確定申告の消費税申告書（一般課税）を作成する',
    sentence: '1. 確定申告の消費税申告書（一般課税）を作成する' }, options);
  assert(!ids.includes('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2020.htm'), '所得税の確定申告を追加しない');
  assert(ids.includes('law:shohizei_hou:49'), '消費税法49条を残す');
});
reviewTest('01b-L1 末尾に入る記事資料のために検索結果を落とさない', () => {
  const ids = idsFor({ type: '判定', subject: '損益通算',
    claim: '判定は経費控除後の所得で行い雑所得の赤字は給与と相殺できない',
    sentence: '判定は入金額ではなく経費を引いた所得で行い、雑所得の赤字は給与と相殺できません。' },
  articleOptions['tip-income-tax-threshold']);
  assert(ids.includes('law:shotokuzei_rei:198'), '所得税法施行令198条を残す');
  assert(ids.includes('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1500.htm'), '雑所得の記事資料も残す');
});

function reviewCatalog(entries) {
  entries = entries.map(e => ({ ...e, tokens: tokenizeForMatcher(e.title + ' ' + (e.text || '')),
    titleTokens: tokenizeForMatcher(e.title) }));
  const df = new Map();
  for (const e of entries) for (const token of e.tokens) df.set(token, (df.get(token) || 0) + 1);
  return { entries, df };
}
function slotEntries() {
  return [
    ...['甲', '乙', '丙'].map((word, i) => ({ id: 'search-' + i, no: String(9101 + i), kind: 'taxanswer',
      url: 'https://example.jp/search-' + i, title: '索引主題 資料' + word, text: '資料' + word })),
    ...['d', 'e'].map(id => ({ id, kind: 'taxanswer', url: 'https://example.jp/' + id, title: '所得税', text: '補足' + id })),
  ];
}
reviewTest('01b-M1 新しい枠で法令本文や本文のない索引を選ばない', () => {
  const claim = { type: '判定', subject: '索引主題', claim: '所得税を申告する。' };
  for (const change of [e => ({ ...e, kind: 'law' }), e => ({ ...e, text: undefined })]) {
    const entries = slotEntries().map(e => ['d', 'e'].includes(e.id) ? change(e) : e);
    assert.deepEqual(idsFor(claim, { catalog: reviewCatalog(entries) }), ['search-0', 'search-1', 'search-2']);
  }
});
reviewTest('01b-M3 かなだけの6字一致を加点しない', () => {
  const claim = { type: '判定', subject: '主題', claim: 'についてはこれまでのとおり' };
  const options = { catalog: reviewCatalog([{ id: 'kana', kind: 'taxanswer', title: '補足',
    url: 'https://example.jp/kana', text: claim.claim }]) };
  assert.equal(E.scoreEvidence(claim, options).scored[0].statementScore, 0);
});
reviewTest('01b-M3 数字の前後を主張と資料の双方で確かめる', () => {
  const entries = [
    { id: 'whole', text: '1200万円以上' },
    { id: 'partial-before', text: '91200万円以上。別の条件は1200口' },
    { id: 'partial-after', text: '12000万円以上。別の条件は1200口' },
    ...Array.from({ length: 301 }, (_, i) => ({ id: 'filler-' + i, text: '参考資料12000' })),
  ].map(e => ({ ...e, title: '資料', kind: 'taxanswer', url: 'https://example.jp/' + e.id }));
  const options = { catalog: reviewCatalog(entries) };
  const score = claim => E.scoreEvidence({ type: '要件', subject: '申告', claim }, options).scored;
  const rows = score('1200万円以上');
  assert(rows.find(r => r.e.id === 'whole').numericMatch, '完全な数字なら資格を持つ');
  assert(!rows.find(r => r.e.id === 'partial-before').numericMatch, '資料の前の桁を切らない');
  assert(!rows.find(r => r.e.id === 'partial-after').numericMatch, '資料の後の桁を切らない');
  assert(!score('91200万円以上。別の条件は1200口').find(r => r.e.id === 'whole').numericMatch, '主張の前の桁を切らない');
  assert(!score('12000万円以上。1200個').find(r => r.e.id === 'partial-after').numericMatch, '主張・資料の後の桁を切らない');
  for (const type of ['金額', '割合', '期限', '適用年', '番号', '未定義']) {
    assert(!E.scoreEvidence({ type, subject: '申告', claim: '1200万円以上' }, options).scored
      .find(r => r.e.id === 'whole').numericMatch, '01b-H1 ' + type + ' は数字だけで資格を持たない');
  }
  for (const type of ['金額', '割合', '期限', '適用年', '番号']) {
    const row = E.scoreEvidence({ type, subject: '索引主題', claim: '所得税を申告する' },
      { catalog: reviewCatalog(slotEntries()) }).scored.find(r => r.e.id === 'd');
    assert(row.titleMatch, '01b-H1 ' + type + ' でも題名一致は残す');
  }
});
reviewTest('01b-L2 3枠目が直接引用なら本文の最上位で置き換えない', () => {
  const claim = { type: '判定', subject: '索引主題',
    claim: 'TA9101・TA9102・TA9103の本文を確認して所得税を申告する。' };
  const options = { catalog: reviewCatalog(slotEntries()) };
  const scored = E.scoreEvidence(claim, options).scored;
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
  assert.deepEqual(ranked.slice(0, 3).map(r => r.e.id), ['search-0', 'search-1', 'search-2']);
  assert(ranked[2].direct, '実際に3枠目が直接引用');
  const top = [...scored].sort((a, b) => b.statementScore - a.statementScore)[0];
  assert(top.titleMatch && top.e.id === 'd', '置き換え候補が本文の最上位にいる');
  assert.deepEqual(idsFor(claim, options), ['search-0', 'search-1', 'search-2']);
});
reviewTest('01b-L2 本文の同点は元の検索点、次いでID順で決める', () => {
  const claim = { type: '判定', subject: '索引主題', claim: '所得税を申告する。' };
  const entries = slotEntries();
  const ids = idsFor(claim, { catalog: reviewCatalog(entries) });
  assert.deepEqual(ids, ['search-0', 'search-1', 'd'], '同点ならID順');
  assert.deepEqual(idsFor(claim, { catalog: reviewCatalog([...entries].reverse()) }), ids, '入力順に依存しない');
  entries.find(e => e.id === 'e').text += ' 索引主題';
  const options = { catalog: reviewCatalog(entries) }, scored = E.scoreEvidence(claim, options).scored;
  const d = scored.find(r => r.e.id === 'd'), e = scored.find(r => r.e.id === 'e');
  assert.equal(d.statementScore, e.statementScore, '本文順位は同点');
  assert(e.score > d.score, '元の検索点に差がある');
  assert.deepEqual(idsFor(claim, options), ['search-0', 'search-1', 'e'], '同点なら元の検索点を優先');
});

reviewTest('01c-M1 本文なし索引の増減で数字の132・133ページの境目を動かさない', () => {
  const bodies = Array.from({ length: 2227 }, (_, i) => ({ id: 'body-' + i, kind: 'taxanswer',
    title: '申告', url: 'https://example.jp/body-' + i,
    text: i < 132 ? '22万円以上 33万円以上 40万円以上 70万円以上' : i === 132 ? '33万円以上' : '参考資料' }));
  for (const indexCount of [0, 12046]) {
    const indexes = Array.from({ length: indexCount }, (_, i) => ({ id: 'index-' + i,
      kind: 'law', title: '索引', url: 'https://example.jp/index-' + i }));
    const options = { catalog: reviewCatalog([...bodies, ...indexes]) };
    for (const [number, eligible] of [[22, true], [40, true], [70, true], [33, false]]) {
      const row = E.scoreEvidence({ type: '要件', subject: '申告', claim: number + '万円以上の申告が必要' }, options)
        .scored.find(r => r.e.id === 'body-0');
      assert.equal(row.numericMatch, eligible, number + ': 本文なし索引' + indexCount + '件');
    }
  }
});
reviewTest('01c-M2 税目なしの記事でも主張の税目から別税目の追加を防ぐ', () => {
  // 2026-04-12-lifetime-gift-inheritance-tax-planning.md の前付けを
  // articleEvidenceOptions に渡した結果を転記（税目の指定なし）。
  const options = {
    source_url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/4408.htm',
    source_supplements: [],
  };
  const ids = idsFor({ type: '金額', subject: '相続時精算課税',
    claim: '相続時精算課税制度にも年110万円の基礎控除',
    sentence: '近年は、相続時精算課税制度にも年110万円の基礎控除が設けられています。' }, options);
  assert(!ids.includes('https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1199.htm'), '所得税の基礎控除を追加しない');
  assert(ids.includes('law:sozokuzei:21_11_2'), '相続時精算課税の基礎控除の条文を残す');
});

reviewTest('01c-M2 主張の税目が一意のときだけ補い、記事の税目を優先する', () => {
  const catalog = reviewCatalog([
    { id: 'income', kind: 'taxanswer', title: '資料', text: '控除額',
      url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1000.htm' },
    { id: 'inheritance', kind: 'taxanswer', title: '資料', text: '控除額',
      url: 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/zoyo/1000.htm' },
  ]);
  const eligible = (claim, options = {}) => E.scoreEvidence({ type: '金額', subject: '相続税', claim },
    { catalog, ...options }).scored.filter(r => r.statementEligible).map(r => r.e.id);
  assert.deepEqual(eligible('控除額を確認する', { tax_terms: '贈与税' }), ['income', 'inheritance'], '主題や記事全体の語からは補わない');
  assert.deepEqual(eligible('所得税と贈与税の控除額を確認する'), ['income', 'inheritance'], '複数の税目なら限定しない');
  assert.deepEqual(eligible('相続税と贈与税の控除額を確認する'), ['inheritance'], '同じ税目の複数の語は一意とする');
  assert.deepEqual(eligible('贈与税の控除額を確認する', { tax_domain: 'income_tax' }), ['income'], '記事の税目があればそちらを優先する');
});

let reviewPassed = 0;
for (const { name, run } of reviewTests) {
  try { run(); reviewPassed++; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name + ': ' + error.message); process.exitCode = 1; }
}
console.log('01b: PASS ' + reviewPassed + ' / FAIL ' + (reviewTests.length - reviewPassed));
