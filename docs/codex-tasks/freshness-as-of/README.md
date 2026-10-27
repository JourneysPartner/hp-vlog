# 鮮度の判定を「内容の改訂あり」と「基準日の改訂あり」の 2 段に分ける

2026-10-27 毛利決定。国税庁の資料の改訂のうち、**基準日（「令和7年4月1日現在法令等」→「令和8年…」）・空白・問い合わせ先の定型文だけ**が変わったものを、内容の改訂と分けて扱う。

- 内容が変わった → 「内容の改訂あり」。今までどおり更新案（書き直し）の候補。
- 基準日だけ変わった → 「基準日の改訂あり」。更新案は作らず、記事を確かめて「確認済み（変更なし）」（`/admin/freshness` の既存のボタン、`reviewed_at` を付ける）で受ける。

## 数字（Claude が 2026-10-27 に main の data で確認）

- 10/1 の月次取り込み（4b7f8986）で `content_changed_at` が付いたタックスアンサーは 530 件（`content_change_kind` が `law_version` 525・`body` 5）。
- 1 つ前の版（`4b7f8986^`）と比べ、基準日・空白・「お問い合わせ先」以降の定型文を除くと同じものが **225 件**（`law_version` 221・`body` 4）。残り 305 件は内容の変更（防衛特別所得税の追加、期限の延長、経過措置など。「又は→または」程度の表記の変更も少し混じるが、機械では分けず内容の改訂として扱う＝安全側）。
- `data/freshness/candidates.json`（10/25 作成）の候補 30 件は全部が `source_updated`（出典の改訂）を理由に持つ。基準日だけの改訂が候補を埋めている。
- 例（`fixtures/`）: No.2200 は基準日と問い合わせ先の文だけ（`ta-2200-r7.json` → `ta-2200-r8.json`）。No.6501 は内容の変更あり（「その登録日からその課税期間の末日までに」→「その登録日以後に…経過措置」など、`ta-6501-r7.json` → `ta-6501-r8.json`）。

## 今の作り

- `scripts/lib/nta-content-change.js` の `detectContentChange(existing, next, fetchedAt)`: `html_hash` が同じなら前の値を引き継ぐ。違えば、`law_version` が変わったら `content_change_kind: 'law_version'`、本文（空白を除いて NFKC）が変わったら `'body'` として `content_changed_at = fetchedAt`。**基準日だけの変更も `law_version` として改訂扱い**になる。
- 取り込み（`scripts/crawl-nta-sources.js` 270・370 行付近）が結果を記録に広げて保存。`scripts/lib/nta-index-builder.js` が `index.json` に `content_changed_at`・`content_change_kind` を写す。
- `scripts/backfill-nta-content-changed.js` は git の履歴から前の版を探して `detectContentChange` をやり直す補正スクリプト（9/28 に一度実行）。
- `scripts/lib/freshness-candidates.js` の `sourceReason` が、記事の出典のうち `content_changed_at` が公開日（または `reviewed_at`）より後のものを `kind: 'source_updated'`（重み 3）の理由にする。`freshness-refresh.js` の `buildRefreshPlan` は `source_updated` を更新案の段にする。
- `netlify/functions/admin-freshness-page.js` が理由の `detail` を並べ、`refreshable` なら「更新案を作る」、いつも「確認済み（変更なし）」を出す。

## 方針

- 記録に `as_of_changed_at`（基準日だけが変わった日時）を足す。`content_changed_at` / `content_change_kind` は**内容が変わったときだけ**更新する（意味は今と同じ: `law_version` は「内容の変更と同時に基準日も変わった」、`body` は「内容だけ」）。
- 候補の理由を 2 つにする: `source_updated`（内容の改訂あり、今のまま）と `source_as_of_updated`（基準日の改訂あり、新設・重み 1・更新案は作らない）。
- 既存の記録は、補正スクリプトを新しい判定で流し直して付け直す（Claude が隔離の外で実行し、データの変更は別のコミットにする）。

## 段階

| 段 | 指示書 | 内容 |
|---|---|---|
| 1 | `01-as-of-split.md` | R1 判定・R2 索引・R3 補正スクリプト・R4 候補の理由・R5 管理画面 |

## 全段階共通の厳守事項

- 本文が内容として変わったものを「基準日だけ」と判定しない（迷う変更は内容の改訂に倒す）。除いてよいのは R1 に書いた 3 つだけ。
- `html_hash`・`fetched_at`・`first_fetched_at`・本文そのものは変えない。シミュレーターのマスタ（`source_hash` の照合、`check-master-freshness.js`）には触れない（別の作業 hp-lp の CI 赤の修正が扱っている）。
- `source_updated` の `detail` の文・重み・更新案の作り方は変えない。

## 元に戻す方法

PR を revert する。記録の `as_of_changed_at` は読まれなくなるだけで害は無い。補正で `content_changed_at` を消した 225 件は、revert 後に旧版の補正スクリプトを流せば戻る（または 4b7f8986 の値を git から戻す）。

## 受け入れ確認（Claude）

- 試験が全部通る。既存の `test-nta-content-change.js`・`test-freshness-candidates.js`・`test-freshness-refresh.js`・`test-admin-freshness.js` が通る。
- 補正スクリプトを流すと、10/1 の 530 件が「内容 305・基準日 221・変更なし 4」前後に分かれる（R1 の除き方による数の違いは理由を説明できること）。
- `build-freshness-candidates.js` を流し直すと、基準日だけの候補は「基準日の改訂あり」と表示され、「更新案を作る」が出ない。

## コードの入口

- `scripts/lib/nta-content-change.js`・`scripts/lib/nta-index-builder.js`（60 行付近）・`scripts/backfill-nta-content-changed.js`
- `scripts/lib/freshness-candidates.js`（`SIGNAL_WEIGHTS`・`sourceReason`・`buildCandidates`）・`scripts/lib/freshness-refresh.js`（`buildRefreshPlan`）
- `netlify/functions/admin-freshness-page.js`（`renderPage`）
