あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。今回は **`docs/codex-tasks/generation-cost/06-test-date-and-eol.md`（T1・T2）だけ**を実装してください。小さな直しです。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/test-time-bomb-eol` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装と試験まで行い、コミットはしないでください。git に書き込む操作（`git checkout`・`git add` など）もしないでください。
- ネットワークは使えません。依存関係を追加しないでください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。

## 厳守

- 06 の「変更してはいけないもの」を守る。触ってよいのは `scripts/lib/__tests__/test-generation-review-fixes.js`（T1 の数行）と `.gitattributes`（T2 の 1 行）だけ。
- 本番のコード（`scripts/lib/withdrawn-topics.js`・`scripts/record-withdrawn-topics.js`）とデータ、`.github/workflows/` の中身は変えない。
- `content/posts/*.md` を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
node scripts/lib/__tests__/test-generation-review-fixes.js
node scripts/lib/__tests__/test-withdrawn-topics.js
node scripts/lib/__tests__/test-fact-check-03o.js
node scripts/lib/__tests__/test-fact-cost-03n.js
git status --short
git diff
```

03o・03n が作業フォルダの CRLF のせいで落ちるのは想定どおりです（06 の T2）。落ちた場合は試験名と落ちた箇所だけ報告してください。

## 最終報告（日本語で）

1. T1・T2 ごとに「何を変えたか」「触ったファイルと行」「試験の結果（PASS/FAIL の数）」
2. 指示書に無い変更をしていないこと
