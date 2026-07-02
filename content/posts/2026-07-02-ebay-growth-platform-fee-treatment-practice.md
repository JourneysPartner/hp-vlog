---
title: "eBay手数料の消費税、仕訳と課税区分はどうする？インボイス対応の実務例"
slug: "ebay-growth-platform-fee-treatment-practice"
category: "消費税"
primary_persona: "ebay_export_seller"
secondary_persona: ""
article_type: "industry_example"
article_role: "support"
related_slug: "ebay-growth-platform-fee-treatment-guide"
related_title: ""
related_link_text: "比較・判断のポイントはこちら"
source_url: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shohi/6501.htm"
source_title: "国税庁タックスアンサー No.6501 納税義務の免除"
search_intent: "eBayセラーがプラットフォーム手数料の処理の実務でつまずく場面を解消したい"
reader_problem: "プラットフォーム手数料の処理 の実務処理が不安"
success_outcome: "プラットフォーム手数料の処理を実務上どう処理するか具体的に分かる"
primary_question: "プラットフォーム手数料の処理を実務でどう処理するか？"
macro: "物販"
cluster: "ebay"
subcluster: "growth-platform-fee-treatment-support"
tax_domain: "consumption_tax"
business_stage: "growth"
life_stage: ""
pain_point: "platform-fee-treatment"
procedure_stage: ""
summary: "eBayの販売手数料にはeBayが消費税10%を課し、Tax Invoice（適格請求書）が発行されます。課税仕入れとしての仕訳・課税区分・売上の総額計上のポイントを具体例で解説します。"
review_status: "draft"
review_comment: ""
approved_at: ""
publish_at: ""
published_at: ""
pr_number: ""
preview_url: ""
created_at: "2026-07-02T00:07:45.117Z"
updated_at: "2026-07-02T00:07:45.117Z"
---

## eBay手数料の消費税、「かかる前提」で仕訳する

eBayで販売すると、毎月Final Value Fee（販売手数料）やStore Subscription（月額ストア料）などが差し引かれます。以前は「海外への支払いだから不課税」と説明されることもありましたが、現在は違います。

<strong>eBay Marketplaces GmbH は日本の適格請求書発行事業者（登録番号 T1700150104215）として、手数料に消費税10%を課しています。</strong>セラーは、eBayが発行するTax Invoice（適格請求書）を保存することで、課税事業者なら仕入税額控除ができます。以下、実務の具体例で整理します。

---

## 課税区分：eBay手数料は「課税仕入れ10%」

会計ソフトへの入力時は、eBay手数料を<strong>「課税仕入れ(10%)」</strong>として登録します（インボイス対応：登録番号あり）。かつての「不課税／対象外」ではない点が最大の変更です。

| 手数料 | 課税区分 |
|---|---|
| Final Value Fee | 課税仕入れ 10% |
| Store Subscription | 課税仕入れ 10% |
| Promoted Listings（広告） | 課税仕入れ 10% |
| 支払い紛争手数料・一部の送料 | 対象外の場合あり |

> **実務メモ**：Tax Invoice は Payments > Reports > Tax invoice からダウンロードでき、税率ごとの消費税額が記載されています。会計ソフト（freee・弥生・MFクラウド等）では取引先にeBayの登録番号 T1700150104215 を登録しておくと処理が安定します。

---

## 仕訳例（Final Value Fee）

手数料が$50、取引日の換算で7,700円（うち消費税700円）だったケース。売上金と相殺されていても、費用は総額で認識します。

```
（借方）支払手数料    7,000 ／（貸方）未払金 7,700
（借方）仮払消費税等    700 ／
　　　　※課税区分：課税仕入れ10%（適格請求書あり）
```

売上金と相殺入金されたとき：

```
（借方）未払金 7,700 ／（貸方）eBay売掛金（普通預金） 7,700
```

---

## つまずきやすい3つのポイント

### 1. 売上と手数料は「総額」で認識する

eBayは売上金から手数料を差し引いて入金します。入金額だけを売上にすると売上が過少になります。<strong>売上は総額、手数料は課税仕入れとして別建て</strong>で計上します。

- 悪い例：売上 $200 − 手数料 $30 = 入金 $170 → 売上 $170
- 正しい例：売上 $200 を計上 → 手数料 $30 を課税仕入れで別計上

### 2. 外貨換算は合理的なレートを継続適用

手数料はUSドル建てです。取引日のTTM（仲値）など合理的なレートを、毎期継続して使用します。月次でまとめる場合は月平均レートの継続適用も認められます。

### 3. 売上（輸出免税）と手数料（課税仕入れ）は別物

海外バイヤーへの売上は輸出免税（0%、国税庁タックスアンサー No.6551）、eBay手数料は課税仕入れ（10%・控除可）です。輸出免税売上は課税売上割合の分子・分母の両方に算入されるため、輸出中心なら手数料の消費税は全額控除でき、<strong>還付</strong>につながります。

---

## まとめ

| 項目 | 実務の結論 |
|---|---|
| eBay手数料の課税区分 | 課税仕入れ10%（適格請求書あり） |
| 控除の要件 | Tax Invoice（登録番号 T1700150104215）の保存 |
| 売上との相殺 | 総額で売上・手数料を認識 |
| 輸出売上 | 輸出免税・課税売上割合に算入・還付につながる |

免税事業者は控除の仕組みがなく経費計上のみ、簡易課税はみなし仕入率で計算します。自分の区分で処理が変わるため、迷ったら早めに確認するのが安心です。

---

本記事は情報提供を目的として作成しており、特定の税務判断を推奨するものではありません。実際の税務処理・申告については、税理士等の専門家にご相談ください。個別事情によって結論が異なる場合があります。

輸出免税や消費税還付、インボイスの保存要件は取引形態によって判断が分かれることが多く、お一人で判断に迷われた際は税理士にご相談いただくと安心です。毛利順活税理士事務所では、eBayセラーの税務相談について、初回のご相談を無料で承っております。お気軽にお問い合わせください。
