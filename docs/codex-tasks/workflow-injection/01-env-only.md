# 01 ワークフローの `run:` に外から入る文字列を直接書かない

## R1 87 か所を env 経由にする

対象: `.github/workflows/` の全ワークフロー。README の表の 10 本（`daily-draft.yml`・`publish-scheduled.yml`・`check-tax-reform.yml`・`check-tax-simulator-masters.yml`・`crawl-nta-tsutatsu.yml`・`crawl-nta-sources.yml`・`crawl-law-sources.yml`・`refresh-nta-qa.yml`・`check-existing-posts.yml`・`fetch-search-console.yml`）。

- `run:` の中の `${{ inputs.* }}`・`${{ github.event.* }}`・`${{ steps.<id>.outputs.* }}`・`${{ needs.<job>.outputs.* }}`・`${{ github.head_ref }}` を、その手順の `env:` に移す（`TITLE1: ${{ steps.prep.outputs.title1 }}` の形）。`run:` では `"$TITLE1"` のように**二重引用符つき**で使う。
  - 変数名は英大文字と `_`。手順の中で既に同じ名前のシェル変数（`TITLE` など）を作っている場合は、`TITLE="$PREP_TITLE1"` のように env の変数から代入するか、env の名前を同じにして代入の行を消す。どちらでもよいが、手順の中の後の行が見る名前と中身は変えない。
  - ヒアドキュメント（`cat <<EOF … EOF`）の中の `${{ … }}` も同じ。`${PAIR_INFO:+| ペア記事 | ${{ steps.prep.outputs.title2 }} |}` は `${PAIR_INFO:+| ペア記事 | $TITLE2 |}` の形。引用符の付かない `<<EOF` の中でも、変数の中身はコマンドとして読み直されない（`$(…)` は実行されない）。
  - `<<< "${{ … }}"`（`publish-scheduled.yml` の `read -r -a`）も `<<< "$PUBLISHED_TITLES"` の形。
  - 件数・`true`/`false` のような、今は安全な値も同じ形にする（R3 の見張りで例外を作らない）。
- `if:`・`with:`・`env:`・`run-name:`・`concurrency:` の中の `${{ … }}` はシェルを通らないので**変えない**。`${{ secrets.* }}`・`${{ vars.* }}`・`${{ github.run_id }}`・`${{ runner.temp }}`・`${{ steps.<id>.outcome }}` など R3 の対象外のものは、`run:` に残っていても変えなくてよい（変えてもよい）。
- 呼ぶコマンド・引数の順番・通知と PR とコミットの文面・`$GITHUB_OUTPUT` に書く名前は変えない。手順の追加・削除・順番の入れ替えもしない。

## R2 手動入力の形を確かめる（fail-closed）

`workflow_dispatch` の入力で、コマンドの引数・枝名・`$GITHUB_OUTPUT` に入るものは、env 経由にしたうえで形を確かめ、合わなければ `::error::` を出してその手順を失敗させる（空のときの既定の動きは今のまま）。既に確かめているものはそのままでよい。

| ワークフロー | 入力 | 許す形 |
|---|---|---|
| `check-tax-reform.yml` | `year` | 空、または 4 桁の数字 |
| `check-tax-simulator-masters.yml` | `as_of` | 空、または `YYYY-MM-DD` |
| `crawl-nta-sources.yml` | `mode` | `incremental`・`full`・`backfill-figures`（今の選択肢） |
| `crawl-nta-sources.yml` | `max_pages` | 空、または 1 以上の整数 |
| `crawl-law-sources.yml`・`crawl-nta-tsutatsu.yml`・`refresh-nta-qa.yml` | `only` | 空、または英数字と `_`・`-`・`.`・`,`・`:`・`/` だけ（今の使い方を確かめて、必要な文字が他にあれば足して報告する） |

- `crawl-nta-sources.yml` の `node scripts/crawl-nta-sources.js ${{ steps.mode.outputs.args }}` は、引数をわざと空白で分けている。env 経由にした後も同じ分け方で渡す（`$CRAWL_ARGS` を引用符なしで使うなら、R2 で値を確かめていることをコメントに書く。配列で組み立て直してもよい）。
- `only` を引数にするところ（`ARGS="--only ${{ github.event.inputs.only }}"`）は、引数が 1 つの文字列として渡るようにする（配列 `ARGS=(--only "$ONLY")` と `"${ARGS[@]}"` など）。

## R3 見張りの試験

新しい試験 `scripts/lib/__tests__/test-workflow-run-injection.js`（依存は今ある `js-yaml` だけ）。

1. `.github/workflows/*.yml` を全部読み、各ジョブの各手順の `run:` と、`actions/github-script` の `with.script` に、`${{` の後に（空白を挟んで）`inputs.`・`github.event.`・`steps.<id>.outputs.`・`needs.<job>.outputs.`・`github.head_ref` が続く式が 1 つも無い。見つかったらファイル名・手順名・行を全部出して落ちる。
2. 全部の `run:` について、残った `${{ … }}` を無害な語に置き換えてから `bash -n` で構文を確かめる（`shell:` が bash 以外の手順は除く）。
3. 実際に動かして確かめる（`bash` で `run:` の中身を実行する。外に出るコマンドは偽物の関数に置き換える）:
   - `daily-draft.yml` の「Notify article 1」: env の題名・要約に `"`・`` ` ``・`$(touch <一時フォルダ>/pwned)`・改行を入れて実行すると、`node scripts/notify.js` に渡る `--title`・`--summary` の値が入れた文字列そのままで、`pwned` のファイルができない。
   - `daily-draft.yml` の「Create branch & PR for article 1」の PR 本文の部分（ヒアドキュメント）: 同じ題名で、本文に題名がそのまま入り、`pwned` ができない（`git`・`gh` は偽物の関数）。
   - `publish-scheduled.yml` の「Notify Chatwork (per article)」: `published_titles` に同じ文字を入れ、通知に渡る題名がそのままで、`pwned` ができない。
   - `check-tax-reform.yml` の「Notify」: 報告文に同じ文字を入れ、`--comment` に渡る値がそのままで、`pwned` ができない。
   - R2 の各入力: 許さない形（例: `year=2026; touch pwned`、`only=a b`、`max_pages=1 --evil`）でその手順が 0 以外で終わり、`pwned` ができない。許す形・空のときは今と同じ引数になる。
4. 直す前の main で 1 が落ちることを、最終報告に件数で書く（今は 87 か所）。

偽物の関数の作り方・一時フォルダの扱いは任せる。Windows の Git Bash でも GitHub の ubuntu でも動くこと（`bash` が見つからない環境では 2・3 を飛ばした旨を出して通すのではなく、落とす）。

## 試験の扱い

- 既存の試験はすべて通ったままにする。`test-workflow-change-detection.js` の期待は変えない。そのうち「記事系ワークフローは作業ツリーで変更されていない」は、`daily-draft.yml`・`publish-scheduled.yml` を変えるため、コミット前の作業ツリーでは落ちる（コミット後に Claude が流して確かめる）。同じファイルの残りの項目（`has-substantive-change.js` の呼び方・`changed` 出力を見る PR 作成条件・旧 `has_changes` の参照ゼロ）は通す。

## 変更してはいけないもの

- トリガー（`on:`）・予定時刻・`permissions:`・`concurrency:`・`if:` の条件・`with:` の値・ジョブ名と手順名（ほかの試験やワークフローが名前で参照している）。
- 呼ぶスクリプトと引数の中身、通知・PR・コミットの文面、`$GITHUB_OUTPUT` に書く名前と値。
- `regenerate-draft.yml`・`refresh-article.yml`（直っている。見張りの試験で確かめるだけ）。`scripts/` のコード（試験の追加を除く）、`content/posts/*.md`・`data/`。
