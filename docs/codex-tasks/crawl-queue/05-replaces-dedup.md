# 05 置き換え記事（replaces）: 生成後の重複判定の限定免除と、公開後の差し替え補助

## 背景

02 R5 で追加した eBay 消費税還付の完全ガイド（`ebay-export-consumption-tax-refund-complete-guide`）を
2026-09-27 に `--force-slug` で生成したところ、**生成後の重複判定**（`checkGeneratedArticle` →
`checkGeneratedDuplicateWithAI`）が「`ebay-export-consumption-tax-refund-guide` と論点が同一」と判定して
取り下げた（GitHub Actions run 36303455198）。この記事は既存 3 本を**意図的に置き換える**ものなので、
置き換え対象との重複だけは判定から外す必要がある。毛利の決定（2026-09-27）: 「案 A（判定を一部だけ外して
作り直す）で」。

品質ゲートの方針（不適合記事を通さない）は維持する。免除は「トピックが名指しした slug との重複」だけで、
それ以外の既存記事と重複すれば従来どおり取り下げる。

## R1 トピックの `replaces`

- `scripts/topic-pool.js` の該当トピックに `replaces: ['ebay-shouhizei-kanpu-kihon', 'ebay-export-consumption-tax-refund-guide', 'ebay-tax-refund-required-documents']` を追加する。
- 他のトピックには付けない。`replaces` は「公開後にこの記事へ 301 で統合する既存記事」の意味。

## R2 生成後の重複判定で `replaces` を除く

- `scripts/generate-draft.js` の `checkGeneratedArticle(content, topic, sameRunSlugs)`:
  `exclude` に `topic.replaces`（配列。無ければ空）を加える。これで比較コーパスから置き換え対象が消える。
- 判定結果が「重複」で `similar_to` が `replaces` に含まれる場合も、念のため重複扱いにしない（コーパスから除いても
  モデルが記憶で挙げる可能性があるため）。ログに「置き換え対象のため許容: <slug>」と出す。
- `similar_to` が `replaces` 以外なら従来どおり取り下げる。
- 選定時の判定（`checkDuplicatesWithAI`、Jaccard の類似度フィルタ、cooldown）は変更しない。`--force-slug` は
  もともと選定を通らない。

## R3 生成プロンプトに「置き換える記事の見出し」を渡す

- 本文生成のプロンプト（`topic.hint` を差し込んでいる箇所。テンプレート生成の経路ではなく API 生成の経路）に、
  `replaces` の各記事の `title` と H2 見出し一覧を「置き換える既存記事。ここで扱っている論点は漏れなく含める」
  として追加する。記事本文そのものは渡さない（長くなるのと、コピーを誘発するため）。
- 対象ファイルは `content/posts/` から slug で引く（`review_status` を問わない）。読めない slug は黙って飛ばす。
- `replaces` が無いトピックではプロンプトは 1 文字も変わらない（テストで担保）。

## R4 生成物の frontmatter に `replaces` を残す

- 生成物の frontmatter（テンプレート経路・API 経路の両方）に `replaces: "slugA,slugB,slugC"`（カンマ区切りの
  文字列。既存の `parseFrontmatter` は `key: "value"` しか読めないため配列表記は使わない）を出す。
  `replaces` が無いトピックでは行を出さない。
- `scripts/validate.js` が未知の項目で落ちる作りなら、`replaces` を許可する。必須項目には**しない**。

## R5 公開後の差し替え補助スクリプト `scripts/apply-replaces.js`

公開されたあとに Claude が手で実行する道具。**自動では走らせない**（公開ワークフローには組み込まない）。

```
node scripts/apply-replaces.js --slug ebay-export-consumption-tax-refund-complete-guide [--dry-run]
```

- 新記事のファイルを `content/posts/` から探し、`review_status` が `published` でなければ「未公開のため中止」で終了（exit 1）。
- frontmatter の `replaces` を読み、各旧 slug について:
  1. 旧記事ファイルの `review_status` を `"merged"` に、`merged_into` を新 slug にする（01 と同じ形。本文は触らない。
     すでに `merged` なら何もしない）。
  2. `netlify.toml` に `[[redirects]] from="/blog/<旧>/" to="/blog/<新>/" status=301` を追加する（同じ `from` が
     あれば追加しない。01 で入れたブロックの直後に置く）。
  3. `data/pickup-posts.json` の `netshop_core` で旧 slug を新 slug に置き換える（新 slug が既にあれば旧 slug を
     削除するだけ。順序は最初に現れた位置を保つ）。
  4. `data/hub-config.json` の各ハブの `featured` も同様に置き換える。
- 実行結果を「変更したファイルと内容」として標準出力にまとめる。`--dry-run` は書き込まずに同じ出力をする。
- パス（posts ディレクトリ・netlify.toml・data の場所）は引数か環境変数で差し替えられるようにし、テストは一時
  ディレクトリのコピーで行う。

## R6 テスト

`scripts/lib/__tests__/test-replaces.js`（`npm run masters:test` に追加）:

- `checkGeneratedArticle` に偽の判定関数を差し込み、`replaces` の slug がコーパスに含まれない／`similar_to` が
  `replaces` 内なら `duplicate: false` になる／`replaces` 外なら `duplicate: true` のまま。
  （`checkGeneratedArticle` が差し込み可能でなければ、`options.checkImpl` のような引数を足してよい。既定は現状の実装）
- プロンプトに置き換え対象の見出しが入る／`replaces` が無いトピックではプロンプトが変わらない。
- 生成物 frontmatter に `replaces` 行が出る／無いトピックでは出ない。`parseFrontmatter` で読み戻せる。
- `apply-replaces.js`: 一時ディレクトリの fixture（新記事 published、旧記事 3 本、netlify.toml、pickup-posts.json、
  hub-config.json）に対して、上記 1〜4 の結果と冪等性（2 回実行しても同じ）、`--dry-run` で無変更、未公開なら中止。
- `validate.js` が `replaces` 付きの記事で落ちない。

既存テスト（`test-crawl-queue-cadence.js` の 02 R5 の節など）が壊れないこと。

## 変更してはいけないもの

- 選定時の重複判定・類似度フィルタ・cooldown・カテゴリ配分。
- 品質ゲート（禁止表現、出典必須、本文短縮ガード、`selfCheckContent`）。
- 承認・公開の手順。`apply-replaces.js` を公開ワークフローから呼ばない。
- `content/posts/*.md`（この段階では 1 ファイルも変更しない。旧記事の `merged` 化は公開後に Claude が
  `apply-replaces.js` で行う）。
- `replaces` の無いトピックの生成結果（プロンプト・frontmatter とも差分ゼロ）。
