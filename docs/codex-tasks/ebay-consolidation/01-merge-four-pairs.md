# 01 eBay 記事 4 組の統合

## R1 統合する 4 組と移す節

ファイルはすべて `content/posts/` にある。見出しは原文の文字列そのまま（全角・半角・記号も一致させる）。

### 組 1 課税事業者の判定

- 残す: `2026-05-03-ebay-taxable-vs-exempt-business.md`（slug `ebay-taxable-vs-exempt-business`）
- 消す: `2026-05-22-ebay-just-opened-consumption-tax-judgement-practice.md`（slug `ebay-just-opened-consumption-tax-judgement-practice`）
- 追加する H2: `## 実務編：eBayの売上に消費税はいつから関係する？課税事業者の判断基準｜手続きの進め方`
- 移す節（この順）:
  1. `eBay売上の消費税課税事業者の判断基準を時系列で整理`
  2. `準備期間：eBayセラーが最初に確認する判定資料`
  3. `書類作成：必要書類の一覧と入手先`
  4. `提出：いつまでに、何を、どこに出すか`
  5. `事後確認：申告前に見直すべきミスと防止策`
  6. `期限に遅れた場合のペナルティと救済の考え方`
  7. `自分で進めやすいケースと、相談した方がよい境目`
- 移さない: 最初の H2 より前の導入文、末尾の定型文（下の「節の範囲」参照）。

### 組 2 インボイス

- 残す: `2026-05-03-ebay-export-invoice-system-impact.md`（slug `ebay-export-invoice-system-impact`）
- 消す: `2026-05-22-ebay-just-opened-invoice-judgement-guide.md`（slug `ebay-just-opened-invoice-judgement-guide`）
- 追加する H2: `## 実務編：eBayセラーはインボイス登録すべき？判断のポイント｜基本を整理`
- 移す節（この順）:
  1. `eBayセラーのインボイス登録判断の全体像`
  2. `誰がインボイス登録を検討すべきか`
  3. `eBayセラー向け インボイス登録のセルフチェック`
  4. `よくある誤解と実務上の注意点`
  5. `開業直後のeBayセラーは何をすればよいか`
- 移さない: 導入文、`そもそもeBayセラーにインボイス制度は関係あるのか`（残す側の記事全体と同じ問い）、`まとめ`、末尾の定型文。

### 組 3 法人成り

- 残す: `2026-06-08-ebay-growth-incorporation-threshold-guide.md`（slug `ebay-growth-incorporation-threshold-guide`）
- 消す: `2026-06-08-ebay-growth-incorporation-threshold-practice.md`（slug `ebay-growth-incorporation-threshold-practice`）
- 追加する H2: `## 実務編：eBay法人成り「いつから法人で売上計上するか」で迷わないための実務整理`
- 移す節（この順）:
  1. `よくある誤解とその実態`
  2. `設立日を境にした実務処理の整理`
  3. `実務上の注意点：個人の廃業届と法人設立届は別に動く`
  4. `自分で判断できる範囲と、専門家に確認すべき範囲`
- 移さない: `「法人成りしたら翌日から法人として売ればいい」は正しいようで落とし穴がある`（導入の役割の節）、`まとめ`、末尾の定型文。

### 組 4 経費のグレーゾーン

- 残す: `2026-07-18-ebay-growth-expense-grayzone-guide.md`（slug `ebay-growth-expense-grayzone-guide`）
- 消す: `2026-07-18-ebay-growth-expense-grayzone-practice.md`（slug `ebay-growth-expense-grayzone-practice`）
- 追加する H2: `## 実務編：eBay経費のグレーゾーン、実務でどう記録・判断する？保存書類と処理手順`
- 移す節（この順）:
  1. `グレーゾーン経費の実務処理、核心は「証跡と按分根拠の記録」`
  2. `グレーゾーン経費の種類と実務処理フロー`
  3. `保存すべき書類の一覧チェックリスト`
  4. `よくある処理ミスと対策`
- 移さない: `この記事でわかること`（導入）、`eBay手数料の消費税処理（インボイス対応）`（残す側の `eBay手数料と消費税の関係（見落とされがちな論点）` と同内容）、`自分で確認できるチェックリスト`（残す側に同名の節）、`税理士に相談した方がいい場面`（残す側の `税理士に相談した方がよいケース` と同趣旨）、`まとめ`、末尾の定型文。

### 節の範囲

- 1 つの節は、その `## 見出し` の行から、次の `## ` で始まる行の直前まで。
- ただし、末尾の定型文で止める: 行頭が `本記事は情報提供を目的として` または `「本記事は情報提供を目的として` の行から後ろは節に含めない。
- 節の中の `---`（区切り線）や空行は原文のまま含める。

## R2 移し方

1. 残す側の本文で、末尾の定型文（行頭が `本記事は情報提供を目的として` の段落）の**直前**に、追加する H2 の行と移す節を入れる。残す側の `まとめ` とその後の `---` はそのまま、その後ろに入る形になる。
2. 移す節は見出しを 1 段下げる（`##` → `###`、`###` → `####`）。見出し以外の行は 1 文字も変えない（表・強調・`<strong>`・全角スペース・行末の半角スペース 2 個も含む）。
3. 追加する H2 の前後には空行を 1 行ずつ置く。節と節の間の空行は原文のまま。
4. 残す側の frontmatter で変えるのは `updated_at` だけ。値は実装した日（日本時間）を `"YYYY-MM-DD"` で書く（前例 #645 と同じ形）。
5. 消す側の frontmatter は `review_status: "merged"` にし、`merged_into: "<残す側の slug>"` を `review_status` の次の行に足す。消す側の本文と他の項目は変えない。
6. 判断に迷う箇所は実装せず、最終報告に【要判断】として書く。言い換え・要約・数字の変更・新しい税務記述の追加は禁止。

## R3 301 リダイレクト

`netlify.toml` の既存の記事用 301（最後は `ebay-tax-refund-required-documents`）の直後、管理画面用のルールより前に、次の形で 4 本足す（`to` の前は半角スペース 1 個、前例と同じ書式）。

```
[[redirects]]
  from = "/blog/ebay-just-opened-consumption-tax-judgement-practice/"
  to = "/blog/ebay-taxable-vs-exempt-business/"
  status = 301
```

残り 3 本も同じ形で、`from` に消す側、`to` に残す側の `/blog/<slug>/`。

## R4 索引リクエストの順番表

`docs/seo/index-request-queue.md` で、消す側の URL の行（現在 3 行: 23・41・65 番）の最後の列の末尾に `／統合済み（2026-10 統合先へ 301）・リクエスト不要` を足す。番号と並び順は変えない。

## R5 テスト

`scripts/lib/__tests__/test-consolidation.js` を次のとおり拡張する（新しいファイルは作らない）。

1. `pairs` に 4 組を足す（`keep`・`merged`・`heading`・`moved` は R1 のとおり）。
2. `extractH2` を「節の範囲」に合わせ、行頭が `本記事は情報提供を目的として` または `「本記事は情報提供を目的として` の行でも止める（既存 4 組の結果は変わらないはず。変わったら報告）。
3. 全組について、ビルド後のすべての HTML（リポジトリ直下の `index.html` と、`blog/`・`services/`・`area/`・`pricing/`・`tools/` 配下の `*.html`。`node_modules`・`content`・`templates`・`docs` は対象外）に、消す側の `/blog/<slug>/` へのリンク（`href="/blog/<slug>/"` または `href='/blog/<slug>/'`）が無いことを確かめる。
4. 新しい 4 組の残す側について、`title`・`slug`・`related_slug`・`source_url` が main（`git show origin/main:<path>`）と同じであることを確かめる。`git` が使えない環境では、この項目は飛ばして「飛ばした」と表示する（失敗にはしない）。
5. `sitemap.xml` の `<loc>` の数を表示する（変更前 310 → 変更後 306 を最終報告に書く）。

## 変更してはいけないもの

- R1 の 8 ファイル以外の `content/posts/*.md`。
- `data/pickup-posts.json`・`data/hub-config.json`（残す側の 2 本は「まずここから」の枠のまま）。
- 手数料の双子 `ebay-growth-platform-fee-treatment-guide`／`-practice`。
- `scripts/build.js` などの本体コード（テストで不具合が見つかった場合は直さずに報告）。
