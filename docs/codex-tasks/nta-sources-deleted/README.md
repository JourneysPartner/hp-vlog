# 国税庁で消えたページを「削除済み」として扱う（2026-11-17）

## 背景

国税庁ソース DB（`data/nta-sources/`）の月次の取り込み（`crawl-nta-sources.yml` → `scripts/crawl-nta-sources.js`）は、11/01 の実行で 13 件を「取り込み失敗」と数えた（`meta.json` の `errors_sample`、理由はどれも `parse_failed`「bodyArea が見つかりません」）。

2026-11-17 に確かめた事実:

- 13 件とも、国税庁は `302 Found` で `https://www.nta.go.jp/error/404.htm` へ転送し、そのエラーページが `200 OK` で返る。Node の `fetch` は転送をたどるので、今の仕組みは「エラーページの HTML を本文として読もうとして失敗した」と扱っている。
- 13 件のうち 12 件は DB に中身のファイルが無い（10/01 から毎月同じものが失敗している）。害は無いが、毎月「失敗」に数えられる。
- 中身が残っているのは `taxanswer/hojin/5441.json`（No.5441「研究開発税制について(概要)」、6/21 取得）だけ。国税庁では消えているのに、DB では生きた資料として照合・出典の候補に使われ得る。記事・照合の記録・シミュレーターからの参照は今は無い。
- 今の仕組みにも「削除済み」の印（`deleted: true`、JSON は残す）がある。HEAD が 404/410 のときだけ付く。照合・鮮度の確認・出典の候補・語の頻度表など、DB を読む部品はほぼすべてこの印の付いた資料を使わない。印を見ていないのは、質疑応答から題材を作る `scripts/lib/shitsugi-topics.js` の `expandShitsugiTopics` だけ。
- 同じ取り違えで、`--backfill-figures` は消えたページのエラーページの hash を `html_hash` に書き込み得る（今の穴）。

## 方針（2026-11-15 利用者決定「1〜3 とも実施」の 3 番目）

- 国税庁のエラーページへの転送を「国税庁で削除された」と扱う。DB に記録がある資料には今の「削除済み」の印を付ける（ファイルは消さない）。記録が無いものは失敗に数えず、報告に件数で出す。
- 削除と見なすのは、行き先が国税庁のエラーページと完全に一致するときと、今までどおり 404/410 のときだけ。それ以外の失敗は今までどおり「失敗」で、記録は変えない。
- 一回の実行で新しく削除にする数に上限を置く（既定 20）。超えたら一件も印を付けず、報告と通知に出す。人が上限を上げて手動で実行し直せる。
- 新しく削除にした資料は、題名・URL・理由・その資料を使っている所を PR 本文に全部出す。利用者が PR で確かめてからマージする。
- 削除済みの資料が国税庁で復活したら、印を外す。

## 段階

| 段 | 中身 | 指示書 |
|---|---|---|
| 1 | 判定・上限・報告・復活・題材の除外・ワークフローの PR 本文 | `01-error-page-as-deleted.md` |
| 2 | 国税庁の一覧から外れた DB の記録も本文で確かめる（段 1 の S7 の穴） | `02-unlisted-records.md` |

段 1 のマージ後、Claude が `crawl-nta-sources.yml` を手動実行（incremental）し、できた PR の本文で No.5441 が「削除済み」になること、残りの 12 件が失敗に数えられないことを確かめる。マージは利用者が削除の一覧を確かめてから。

段 1 は 2026-11-17 に完了（コード #792、データ #793 で No.5441 を削除済み）。#793 の取り込みで、国税庁の一覧から外れた DB の記録 2 件（No.2882・No.6555、どちらもエラーページへ転送）が訪ねられずに生きたまま残ると分かった（段 1 の S7「一覧に無いものは訪ねない」の穴）。利用者が続きとして直すことを了承（11/17）し、段 2 で扱う。段 2 のマージ後も同じく手動実行し、できた PR の本文で 2 件が「削除済み（国税庁の一覧からも外れている）」になることを確かめ、利用者が確かめてからマージする。

## 全段共通の厳守事項

- `data/` は変えない（本物の取り込みはしない。ネットワークにも出ない）。試験の資料は `scripts/lib/__tests__/fixtures/nta-deleted-pages/` に新しく作る。
- 変えてよいファイルは 01 の「この段の厳守事項」にあるものだけ。
- 中身のファイルを消す処理（`unlink`・`rm` など）を足さない。
- コミット・push・パッケージのインストールはしない（Claude が行う）。

## 元に戻す方法

- コードは PR を revert すれば元の動きに戻る（印の付いた資料は印が付いたまま残るが、どの部品も今と同じ扱い）。
- 一件だけ印を外すには、その JSON から `deleted`・`deleted_reason`・`deleted_at` を消して `node scripts/crawl-nta-sources.js --rebuild-index` を流す。国税庁でページが戻れば、次の月次で自動で外れる。

## コードの入口

- `scripts/lib/nta-crawler.js`: `fetchWithRetry`・`fetchPage`・`fetchPageHead`・`decideIncrementalAction`
- `scripts/crawl-nta-sources.js`: `performIncrementalFetch`・`crawlTaxAnswer`・`crawlShitsugi`・`crawlAll`・`buildAndSaveIndex`・`backfillFigures`
- `scripts/lib/nta-index-builder.js`: `saveMeta`
- `scripts/lib/shitsugi-topics.js`: `expandShitsugiTopics`
- 段 2: `scripts/lib/nta-store.js`（記録の一覧）・`scripts/lib/nta-unlisted.js`（新規、一覧から外れた記録を選ぶ）・`scripts/lib/nta-deletions.js` の `renderReport`
- `.github/workflows/crawl-nta-sources.yml`
- 試験の型: `scripts/lib/__tests__/test-freshness-as-of.js` の `crawlWithFigures`（取り込みの CLI を偽の部品で 1 回動かす）
