# Codex に渡す文面

段階ごとに、次の文面をそのまま Codex に渡す。`{N}` と `{ファイル名}` を置き換える。

---

`docs/codex-tasks/seo/README.md` を先に読み、次に `docs/codex-tasks/seo/{ファイル名}` を読んで、
実装要件 R1〜Rn をすべて実装してください。

厳守事項:
- README の「全段階に共通の厳守事項」に従う。特に `content/posts/*.md` は一切変更しない
- 指示書の日本語の文章はそのまま使う。言い回しを変えない
- 【要確認】【要用意】とある値は作らない。該当箇所は指示書の代替案どおりにする
- この段階の範囲外の指示書（他の番号）は実装しない
- 作業ブランチは `seo/{N}-{短い英語名}`。1つの PR にまとめる。自動マージはしない
- 完了時に `npm run build` `npm run validate` と `scripts/lib/__tests__/*.js` を実行し、
  結果（PASS/FAIL の件数と、失敗があればその名前）を PR 本文に書く
- PR 本文には、指示書の R 番号ごとに「何をどのファイルでやったか」を1行ずつ書く

---

## 段階ごとの置き換え

| 段階 | `{N}` | `{ファイル名}` | ブランチ名の例 |
|---|---|---|---|
| 1 | 1 | `01-technical-basics.md` | `seo/1-technical-basics` |
| 2 | 2 | `02-service-pages.md` | `seo/2-service-pages` |
| 3 | 3 | `03-industry-hubs-and-links.md` | `seo/3-industry-hubs` |
| 4 | 4 | `04-homepage-and-area.md` | `seo/4-homepage-area` |
| 並行A | a | `05-search-console-ingest.md` | `seo/a-search-console` |
| 並行B | b | `06-performance.md` | `seo/b-performance` |

着手できる順: 1・2・並行A・並行B は今すぐ。3 は 1 のマージ後。4 は 2・3 のマージ後。
