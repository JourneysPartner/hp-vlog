# 実装の依頼文（OpenCode に渡す）

あなたはこのリポジトリ（税理士事務所のサイト hp-vlog）の実装担当です。`docs/codex-tasks/manual-edit-review/README.md` と `01-review-flow.md` を最初に全部読み、その R1〜R9 を実装してください。

- 作業ブランチ: `feat/manual-edit-review`（この worktree はすでにその枝です）。コミット・push・インストールはしないでください（司令役の Claude がします）。
- 変えてよいもの: 01-review-flow.md の R1〜R9 に書いたファイルと、新しく作るファイル（`netlify/functions/lib/manual-edit.js`、新しい試験、`.github/workflows/manual-edit-ready.yml`）、`package.json` の `masters:test` の一覧への追加だけ。
- 「変更してはいけないもの」（01-review-flow.md の最後）と README の厳守事項 1〜8 を必ず守る。迷ったら、変えずに報告に書く。
- 試験は `sbx` を通して動かす。少なくとも次がすべて失敗 0 で通ること:
  - 新しい試験ファイル
  - `scripts/lib/__tests__/test-review-approve-refresh.js`、`test-review-skip-refresh.js`、`test-review-page.js`、`test-fact-check-override.js`、`test-draft-branch-hygiene.js`、`test-notify-message.js`、`test-freshness-refresh.js`、`test-review-auth.js`
  - `npm run masters:test`（`sbx npm run masters:test`）。これは `assets/js/tax-simulator.*.js` などの公開用ファイルを書き換えることがある。書き換わったら、そのファイルは元に戻して（`git checkout` は使えないので、報告に「書き換わった」と書くだけでよい）、報告に載せる。
- 鍵の形の文字列（長い英数字のトークンなど）を試験に書かない。偽の値は `test-secret` のような短い語にする。

最後の報告に書くこと:
1. 変えたファイルと、それぞれの要点（R の番号付き）
2. 足した試験の名前と件数、上の試験の結果（ファイルごとの通過・失敗の件数）
3. 01-review-flow.md と違うやり方にしたところと、その理由
4. 迷って変えなかったところ
