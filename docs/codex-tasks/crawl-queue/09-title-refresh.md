# 09 上位表示なのにクリックされない記事の題名・説明文を差し替える

## 背景

`docs/seo/ctr-title-proposals.md` の 10 本を毛利が 2026-09-27 に「全部よい」と承認した。変更するのは各記事の frontmatter の `title` と `summary` だけ。本文・slug・URL・日付は変えない。

## R1 差し替え

対象ファイルは `content/posts/` から `slug` で引く（`review_status: published` のもの 1 本ずつ。同じ slug が複数あれば中止して報告）。`title` と `summary` を下表の「新」にする。表で「説明文は現状維持」のものは `summary` を触らない。`updated_at` は**動かさない**（題名だけの変更で更新日を進めない。build の `dateModified` も動かさない）。

| slug | 新 title | 新 summary |
|---|---|---|
| `newseg-construction_solo-construction-consumables-painting-guide` | 塗料・ペンキの勘定科目は？塗装工の消耗品費・材料費の分け方と年末在庫の処理 | 塗料・ペンキ・シンナー・刷毛の勘定科目は消耗品費か材料費か。使い切った分だけが経費で、年末に残った分は棚卸資産にして翌年へ繰り越します。仕訳例つき。 |
| `newseg-retail_store-retail-register-sales-guide` | レジの現金過不足の仕訳と勘定科目｜小売店のレジ売上（現金・カード・電子マネー）の計上方法 | レジの現金過不足は原因を確認したうえで雑収入・雑損失で処理します。レジ売上は販売時点で計上し、現金・クレジットカード・電子マネーで仕訳が変わります。仕訳例で解説。 |
| `youtube-side-business-withholding-treatment-guide` | YouTubeの収入に源泉徴収はある？AdSenseは原則なし・PR案件はあり｜副業の確定申告での処理 | YouTubeの広告収入（AdSense）は原則源泉徴収なし、PR案件の報酬は支払者が源泉徴収する場合があります。副業の確定申告でどう精算するかを整理します。 |
| `newseg-content_seller-content-subscription-revenue-guide` | オンラインサロン・サブスク収入の勘定科目と経費｜確定申告での所得区分と計上時期 | オンラインサロンやサブスクの会費収入は受取月ごとに計上。勘定科目、経費にできる範囲、事業所得か雑所得かの判断を、運営者の側から整理します。 |
| `deepdive-beauty_salon_owner-simplified-vs-standard-judgment-guide` | 美容室の簡易課税は第何種？みなし仕入率50%と原則課税の有利判定 | 美容室・美容サロンは簡易課税の第5種（みなし仕入率50%）。課税仕入れの割合が50%を下回るなら簡易課税が有利、大型の設備投資がある年は原則課税で還付になることも。判定の手順を解説。 |
| `deepdive-general_individual_proprietor-lease-transaction-guide` | リース料の勘定科目と経費処理｜売買処理か賃貸借処理かの判断基準（フルペイアウト・中途解約不可） | （説明文は現状維持） |
| `newseg-youtuber-youtube-gaming-capture-gaming-guide` | ゲーム機・配信機材は経費にできる？ゲーム実況をする個人事業主の減価償却と少額特例 | ゲーム機・キャプチャボード・配信用PCは、業務に使う分が経費。10万円未満は全額その年の経費、10万円以上は少額特例・一括償却・減価償却の3通りに分かれます。 |
| `newseg-retail_store-retail-gift-certificate-practice` | 商品券・ギフトカードの消費税はどうなる？発行・譲渡・使用時の扱いと売上計上の仕訳 | （説明文は現状維持） |
| `shopify-growth-overseas-tax-uncertain-practice` | Shopifyの海外販売と消費税｜売上は輸出免税でゼロ、仕入や手数料の控除はどうなる？具体例で解説 | Shopifyで海外の消費者に販売した売上は輸出免税で消費税がかかりません。ただし帳簿と証拠書類の保存が条件で、仕入や手数料の消費税を控除し損ねる記帳ミスが多い点を具体例で解説。 |
| `shitsugi-shohi-26-01` | 特定課税仕入れとは？リバースチャージで申告した支払いは課税売上高に入るのか（納税義務判定の落とし穴） | （説明文は現状維持） |

## R2 確認

- `summary` はいずれも 120 文字以内であること（超えるものがあれば末尾を削らず報告して止める）。
- 本文の H1 が `title` から出る作りなら H1 も変わる。それ以外の本文差分がゼロであること（`git diff` が frontmatter の 2 行だけ）。
- `npm run build` と `npm run validate` が通る。`sitemap.xml` の URL と件数は不変。

## R3 テスト

`scripts/lib/__tests__/test-title-refresh.js`（`npm run masters:test` に追加）: 10 本の `title` が新しい値、`summary` が指定どおり（現状維持のものは元のまま）、`updated_at` が変わっていない、各 summary が 120 文字以内。

## 変更してはいけないもの

- 10 本以外の記事。10 本の本文・slug・日付・出典。
- 生成側の題名ルール（`article-prompt-static.js` 等）。
