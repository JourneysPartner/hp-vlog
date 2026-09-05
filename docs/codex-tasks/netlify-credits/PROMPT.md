# Codex に渡す文面

次の文面をそのまま Codex に渡す。

---

`docs/codex-tasks/netlify-credits/README.md` を先に読み、次に `docs/codex-tasks/netlify-credits/01-ignore-builds.md` を読んで、
実装要件 R1〜R5 をすべて実装してください。

厳守事項:
- README の「全段階に共通の厳守事項」に従う。特に `content/posts/*.md`、`netlify/functions/*`、
  `.github/workflows/*`、`scripts/build.js` は一切変更しない
- 判定は「迷ったら必ずビルドする」。指示書の表に無い条件で飛ばさない。(a) の場所一覧に勝手に足さない
- 判定スクリプトは Node.js 18・標準モジュールのみで動くこと。`scripts/lib` の他モジュールも require しない
- 指示書の日本語の理由文・ログ文はそのまま使う。言い回しを変えない
- 【要確認】【要判断】とある項目は実装しない（毛利が判断する）
- 作業ブランチは `chore/netlify-ignore-builds`。1つの PR にまとめる。自動マージはしない
- 完了時に `npm run build` `npm run validate` と `scripts/lib/__tests__/*.js` を実行し、
  結果（PASS/FAIL の件数と、失敗があればその名前）を PR 本文に書く
- PR 本文には、指示書の R 番号ごとに「何をどのファイルでやったか」を1行ずつ書き、
  R5 の実行出力例（飛ばす・ビルド 各1行）を載せる
