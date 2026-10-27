# 01 通達の読み方の修正と、取り込み可否の条件

対象: `scripts/lib/tsutatsu-parser.js`・`scripts/crawl-nta-tsutatsu.js`（と必要なら `scripts/lib/nta-tsutatsu.js` の読み込み側）。背景と分類は `README.md`。

## R1 番号の書式（A・B）

- `parseTsutatsuPage`（ふつうの読み方）と `parseExtendedPage`（財産評価・措置法の読み方）の両方で、段落の先頭に続く `<strong>`・`<span class="bold">`・`<b>` を連結して番号にする。
- 番号を読む前に `&emsp;` `&ensp;` `&thinsp;` `&nbsp;` と数値文字参照（`&#…;`）を空白に戻す（`normalizeProvisionNo` が空白を除く）。
- 番号の形の判定（`PROVISION_NO_RE`・`parseExtendedPage` の `valid`）は変えない。

## R2 措置法・評価用の読み方が 0 件になる原因（E）を直す

- `fixtures/pages/` の E のページ（`expected.json` で `circular` が `hyoka`・`sochi_*`、`expected` が `provisions`）で、なぜ `parseExtendedPage` が 0 件になるかを確かめて直す（README の【推測】は本文の終わりの切り方）。
- 直した後、ふつうの読み方で読める項目（`basic_parser_items`）は、措置法・評価用の読み方でも全部読めること（番号の一覧が同じか、それ以上）。
- 今まで読めていたページ（`data/nta-tsutatsu/` にある既存の通達・`docs/codex-tasks/fact-grounding/fixtures/tsutatsu/` の 04 の試験データ）の結果が変わらないこと。

## R3 項目の無いページとリンク切れを記録する（C・D・F）

- 1 ページの結果を「項目あり」「項目の無いページ」「リンク切れ」「読み落とし（誤り）」の 4 つに分ける。
  - リンク切れ: 今の `assertUsablePage` が「国税庁のエラーページです」とするもの。
  - 項目の無いページ: URL が `fusoku`・`bessi`・`zenbun` を含む、または段落の先頭に番号らしい書式（R1 の 3 つのタグで、中身が数字で始まるもの）が 1 つも無いページ。
  - 読み落とし: 番号らしい書式があるのに項目が 0 件のページ。
- 通達のカタログ（`data/nta-tsutatsu/<key>.json`）に `non_provision_pages: [{url, reason}]`・`missing_pages: [{url}]` を足す。ログにも件数と URL を出す。

## R4 取り込み可否の条件

その通達を取り込まない（既存を保持し、終了コードは今と同じく失敗）のは次のどれか。

1. 読み落としのページが 1 つでもある。
2. リンク切れがその通達の節ページの 3% を超える、または 10 ページを超える。
3. 取得の失敗（リンク切れ以外の HTTP エラー・時間切れ・例外）が 1 つでもある。
4. 取得した項目が 0 件。

それ以外（項目の無いページとリンク切れだけ）は取り込む。

## テスト（`scripts/lib/__tests__/test-tsutatsu-crawl-fixes.js`）

- **T1**: `fixtures/expected.json` の 66 ページそれぞれを、その `circular` の読み方で解析・分類し、`expected` どおりになる（`provisions` は `min_items` 以上の項目で読み落としではない、`missing` はリンク切れ、`provisions_or_non_provision` は項目ありか項目の無いページ。どれも読み落とし・誤りにならない）。
- **T2**: R1 の 3 つのタグと文字参照の単体（`<span class="bold">1－3の2－2</span>`・`<strong>31</strong><strong>の2-21　</strong>`・`16-3の2-1&emsp;`）。
- **T3**: R4 の 4 つの条件それぞれで取り込まない／項目の無いページとリンク切れだけなら取り込む（偽の取得関数で。ネットワークは使わない）。カタログに `non_provision_pages`・`missing_pages` が残る。
- **T4**: 04 の試験データ（`docs/codex-tasks/fact-grounding/fixtures/tsutatsu/`）と既存のテスト（`test-nta-tsutatsu*.js` など通達の取り込み・照合に関わるもの）が通る。

## 変更してはいけないもの

- 番号の形の判定、`provisionsByNumber` の重複の扱い、目次の読み方（`parseIndexPage`）、カタログの既存の項目の形。
- 照合（`scripts/lib/fact-*.js`）。
- `data/`・`content/posts/*.md`・`fixtures/`。
