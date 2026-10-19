# ワークフローのコマンドに、外から入る文字列を直接埋め込まない

## 背景

GitHub Actions の `${{ … }}` は、シェルが動く**前に**文字列としてそのまま差し込まれる。`run:` の中に `"${{ steps.prep.outputs.title1 }}"` と書くと、題名に `"` が入れば引数が壊れ、`` ` `` や `$(…)` が入ればその部分が**コマンドとして実行される**。実行環境には API の鍵（Anthropic・OpenAI・Vercel AI Gateway・Chatwork・Netlify）と、リポジトリへの書き込み権限がある。

GitHub の推奨は、値をいったん手順の `env:` に入れ、`run:` では `"$TITLE"` のようにシェルの変数として使うこと。シェルの変数の中身は、展開されてもコマンドとしては読み直されない。

経緯:

- `fact-grounding/backlog.md` の B15（差し戻しのコメント・ファイル名・枝名が `regenerate-draft.yml` の `run:` に直接）→ **#692（2026-10-19 マージ）で env 経由に直っていた**。
- `generation-cost/README.md` の L9（AI が作った題名・要約が `daily-draft.yml` の通知、`regenerate-draft.yml` の「Notify via Netlify」に直接）→ `regenerate-draft.yml` は直っているが、**`daily-draft.yml` は残っている**。

2026-10-20 に Claude が全ワークフローを調べた結果（`run:` の中の `${{ inputs.* }}`・`${{ github.event.* }}`・`${{ steps.*.outputs.* }}`）: **10 本・87 か所**。

| ワークフロー | か所 | 入ってくる文字列 | 危険度 |
|---|---|---|---|
| `daily-draft.yml` | 39 | **AI が作った題名・要約・読者・カテゴリ**、ファイル名、日付、PR の URL | 高（題名・要約は AI の出力で、国税庁のページ・検索候補・Search Console の語に影響される） |
| `publish-scheduled.yml` | 5 | **公開する記事の題名**（AI が作り人が承認）・slug・カテゴリ | 高 |
| `check-tax-reform.yml` | 9 | **外部のサイト（税制改正の大綱）から作った報告文**、手動入力の年度 | 高 |
| `check-tax-simulator-masters.yml` | 9 | 点検の報告文・件数、手動入力の基準日、PR 番号 | 中 |
| `crawl-nta-tsutatsu.yml` | 6 | 件数、手動入力の `only` | 低 |
| `crawl-nta-sources.yml` | 15 | 件数・モード・PR の URL、手動入力の `mode`・`max_pages` | 低 |
| `crawl-law-sources.yml`・`refresh-nta-qa.yml` | 各 1 | 手動入力の `only` | 低 |
| `check-existing-posts.yml` | 1 | 予定時刻 | 低 |
| `fetch-search-console.yml` | 1 | PR の URL | 低 |

危険度が低いものも同じ形に直す（「この値は安全」と 1 つずつ判断すると、値の出どころが変わったときに抜ける。全部を env 経由にし、試験で見張る方が確実）。

## 方針

- 全ワークフローの `run:`（と `actions/github-script` の `script:`）に、`${{ inputs.* }}`・`${{ github.event.* }}`・`${{ steps.*.outputs.* }}`・`${{ needs.*.outputs.* }}`・`${{ github.head_ref }}` を書かない。手順の `env:` に入れ、`run:` では二重引用符つきのシェル変数で使う。
- 手動入力（`workflow_dispatch` の入力）のうち、コマンドの引数や `$GITHUB_OUTPUT` に入るものは、形を確かめ、合わなければその手順を失敗させる（fail-closed）。
- 動き（呼ぶコマンド・引数の中身・通知の文面・条件・順番）は変えない。
- 新しい試験で、今後この形が入り込まないよう見張る。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-env-only.md` | 87 か所を env 経由に・手動入力の形の確認・見張りの試験 |

作業ブランチは `fix/workflow-run-injection`（main の上）。

## 元に戻す方法

- 該当のコミットを戻す（ワークフローだけの変更）。

## 受け入れ確認（Claude が行う）

1. 全テスト（前からの 4 本だけが落ちる）・`npm run validate`。新しい見張りの試験が、今の main（直す前）では落ち、直した後は通ること。
2. 差分を 1 か所ずつ読み、値の置き換え以外の変化（コマンド・引数の順番・文面・`if:`・`with:`）が無いこと。
3. マージ後の最初の日次生成（通知の題名・要約・PR 本文）と予約公開（Chatwork の通知）が今までどおり届くこと。手動で動かせるもの（`check-tax-reform.yml`・`check-tax-simulator-masters.yml` の手動実行）は 1 回ずつ動かして確かめる。
4. Opus 5.5 xhigh で差分レビュー（ワークフローは本番の送信・公開に関わるため）。
