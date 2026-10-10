# 05 公開済み記事の一括照合（直さない。怪しい箇所の一覧を作るだけ）

背景は `README.md`。公開中の 269 本は、03 の照合が無い状態で書かれている。主出典が汎用ページの記事も多い。どの記事のどの文が資料と食い違うかの一覧を作り、毛利さんが直す順番を決められるようにする。**記事は書き換えない。実行するかどうか・いつ実行するかは毛利さんが決める（【要判断】4）。**

## R1 スクリプト `scripts/audit-published-facts.js`

- 引数: `--limit N`（既定 10）、`--offset N`、`--slug a,b,c`（指定した記事だけ）、`--since YYYY-MM-DD`（公開日）、`--dry-run`（LLM を呼ばずに、抜き出しの見積もり件数と費用の目安だけ出す）。
- 対象: `review_status: published` の記事。`merged`（統合済み）・下書きは除く。
- 各記事に 03 の R1〜R3（抜き出し・根拠検索・判定）を行う。R4（修正）は行わない。
- 出力:
  - `data/fact-check/audit/<YYYY-MM-DD>/<slug>.json`（03 と同じ形式）
  - `data/fact-check/audit/<YYYY-MM-DD>/report.md`: 記事ごとの「食い違い」「期限の書き漏れ」「資料なし（要件・金額・期限）」の件数と、食い違いの文・根拠の抜粋・根拠へのリンク。並びは食い違いの多い順。冒頭に全体の件数と、照合した記事数・飛ばした記事数。
- 途中で止まっても、終わった記事の結果は残る（次の実行で `--offset` か、既に結果のある記事を飛ばす `--resume`）。

## R2 手動ワークフロー `.github/workflows/audit-published-facts.yml`

- `workflow_dispatch` のみ（定期実行しない）。入力: limit・offset・since・dry_run。
- 結果を枝 `audit/facts-<日付>` にコミットし、PR を作る（本文に report.md の冒頭）。main には直接入れない。
- 鍵は既存の Secrets。照合のモデルは 03 の `FACT_CHECK_PROVIDER` / `FACT_CHECK_MODEL`。

## R3 鮮度の更新候補への接続

- `data/fact-check/audit/` の最新の結果で「食い違い」がある公開記事を、鮮度の更新候補（`scripts/lib/freshness-candidates.js`）の新しい理由「事実の照合で食い違い N 件」として加える。重みは既存の最上位の理由と同じにする【要判断】。
- 更新案を作るとき（`runRefreshMode`）、その記事の照合結果を差し戻しコメントと同じ扱いで渡す（どの文をどう直すべきかの根拠つき）。

## テスト

1. 対象の絞り込み（published だけ、merged・下書きを除く、limit・offset・since・slug）。
2. `--dry-run` は LLM を呼ばない。
3. 偽の LLM で report.md の並びと件数。`--resume` で既存の結果を飛ばす。
4. 鮮度候補に新しい理由が入り、既存の理由の重みと並びは変わらない。
5. 更新案の経路に照合結果が渡る。

## 変更してはいけないもの

- `content/posts/*.md`。
- 鮮度の既存の信号と重み。
