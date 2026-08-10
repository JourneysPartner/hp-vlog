---
title: "QR決済の売上、入金が遅れる場合の記帳方法｜仕訳の具体例"
slug: "newseg-retail_store-retail-qr-payment-practice"
category: "帳簿・経費"
primary_persona: "retail_store"
secondary_persona: ""
article_type: "industry_example"
article_role: "support"
related_slug: "newseg-retail_store-retail-return-handling-guide"
related_title: ""
related_link_text: "基本から確認したい方はこちら"
source_url: "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2200.htm"
source_title: "国税庁タックスアンサー No.2200 収入金額とその計算"
source_provenance: "curated"
source_confidence: 1
source_guard_version: 1
search_intent: "小売店 QR決済 入金ズレ どう 記帳 売掛金 具体例 仕訳"
reader_problem: "決済日と入金日がずれる売上の記帳が不安"
success_outcome: "キャッシュレス売上の売掛計上と入金消込が分かる。具体的な仕訳・手順が分かる"
primary_question: "QR決済売上の入金が後日になる場合、どう記帳する？（具体例で解説）"
macro: "小売"
cluster: "newseg-retail_store"
subcluster: "bookkeeping-expenses-retail-qr-payment-support"
tax_domain: "bookkeeping_expenses"
business_stage: ""
life_stage: ""
pain_point: "retail-qr-payment"
procedure_stage: ""
customer_segment: "retail_store"
customer_fit_score: 5
search_intent_score: 5
source_alignment_score: 5
practical_usefulness_score: 5
lead_value_score: 2
tax_risk_score: 3
recommendation: "publish"
review_warning: ""
summary: "PayPayなどQR決済は決済日に売上を計上し、入金日に売掛金を消込む2段階で記帳します。具体的な仕訳例と手順を解説します。"
review_status: "draft"
review_comment: ""
approved_at: ""
publish_at: ""
published_at: ""
pr_number: ""
preview_url: ""
created_at: "2026-08-10T00:06:27.838Z"
updated_at: "2026-08-10T00:06:27.838Z"
---

## QR決済の記帳、現金と違うのは「2段階」になること

PayPayやd払いなどのQR決済を導入している小売店では、「お客さんが決済した日」と「口座に入金される日」がズレます。このズレを正しく記帳できていないと、売上の計上漏れや帳簿の不整合が起きます。

結論からいうと、<strong>QR決済は決済日に売上（売掛金）を立て、入金日に売掛金を消込む</strong>という2段階の仕訳が基本です。

---

## なぜ「決済日」に売上を計上するのか

国税庁タックスアンサー No.2200「収入金額とその計算」では、収入の計上は「その収入の原因となる権利が確定した時点」とされています。QR決済の場合、お客さんが決済した時点で売上の権利は確定しているため、入金を待たずに決済日で売上を計上するのが原則です。

現金売上との違いを整理すると、次のとおりです。

| 項目 | 現金売上 | QR決済売上 |
|---|---|---|
| 売上計上日 | 販売日（即日） | 決済日（販売日と同じ） |
| 入金日 | 販売日（即日） | 数日〜翌月（サービスにより異なる） |
| 仕訳の数 | 1回 | 2回（計上＋消込） |
| 使う勘定科目 | 現金 | 売掛金（→後日 普通預金） |

---

## 具体的な仕訳例

### ケース：8月1日に3,300円（税込）をPayPayで決済、8月10日に入金

<strong>【8月1日：決済日の仕訳（売上計上）】</strong>

| 借方 | 金額 | 貸方 | 金額 |
|---|---|---|---|
| 売掛金 | 3,300円 | 売上高 | 3,000円 |
| | | 仮受消費税 | 300円 |

消費税込みで入金されるため、売掛金は税込額で立てます。

<strong>【8月10日：入金日の仕訳（売掛金の消込）】</strong>

| 借方 | 金額 | 貸方 | 金額 |
|---|---|---|---|
| 普通預金 | 3,267円 | 売掛金 | 3,300円 |
| 支払手数料 | 33円 | | |

QR決済サービスは決済手数料（例：PayPayは1.98%）を差し引いた金額が入金されます。差額は<strong>支払手数料</strong>として処理します。手数料率はサービスや契約内容によって異なるため、加盟店管理画面や明細で確認してください。

---

## 実務上のよくある間違い

<strong>①「入金されたときに売上を計上」してしまうケース</strong>
入金日に全額を売上として仕訳するのは誤りです。決済日と入金日が月をまたぐ場合、売上が翌月にずれ込んでしまい、正しい損益になりません。

<strong>②手数料を売上の控除として処理してしまうケース</strong>
手数料は売上のマイナスではなく、<strong>支払手数料（経費）</strong>として計上します。売上高は決済額（税込）のままにしておきましょう。

<strong>③複数のQR決済を一括で入力してしまうケース</strong>
PayPay・楽天ペイ・d払いなど複数サービスを利用している場合、入金がバラバラになります。サービスごとに売掛金の補助科目（または相手先）を分けて管理すると、消込作業がスムーズです。

---

## 月次確認のチェックリスト

- [ ] 決済日の売掛金計上は漏れていないか
- [ ] 入金ごとに手数料を差し引いて消込できているか
- [ ] 月末時点で未消込の売掛金残高がサービス側の入金予定と合っているか
- [ ] 手数料の計上先が支払手数料になっているか（売上のマイナスにしていないか）

---

## まとめ

QR決済の記帳は、①決済日に売掛金で売上を立て、②入金日に手数料を差し引いて消込む、という流れが基本です。月をまたぐ取引が増えるほど、この2段階を省略すると帳簿の残高がずれていきます。管理画面の入金明細と帳簿を月次で照合する習慣をつけると、ミスを早期に発見できます。

---

本記事は情報提供を目的として作成しており、特定の税務判断を推奨するものではありません。実際の税務処理・申告については、税理士等の専門家にご相談ください。個別事情によって結論が異なる場合があります。

小売店では、軽減税率・在庫評価・返品値引・商品券など、日々の販売処理が税務に直結します。店舗の取扱商品や販売方法に合わせて整理したい方は、お気軽にご相談ください。

毛利順活税理士事務所では、初回のご相談を無料で承っております。お気軽にお問い合わせください。

