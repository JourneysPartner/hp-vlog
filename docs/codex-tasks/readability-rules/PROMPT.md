あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/readability-rules/` にあります。`README.md` を読んでから、`01-writing-rules.md`（R1〜R5）を実装してください。日次の記事を書く AI への指示に、読みやすい日本語の決まりを足す変更です。

## 進め方

- 作業ブランチは現在チェックアウト済みの `feat/readability-rules` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- 決まりの本文と、リード文の例の変更後の文は、指示書のとおり 1 字も変えずに入れてください。
- 既存の試験の期待は、変更によって変わるものだけ最小限に直し、どの試験のどの期待をなぜ変えたかを最終報告に書いてください。
- ネットワークは使えません。AI はすべて偽の関数で試験してください。依存関係を追加しないでください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動する試験が EPERM で落ちる場合は、落ちた試験名だけ報告してください。

## 厳守

- `01-writing-rules.md` の「変更してはいけないもの」を守る。特に、ほかの固定ルールの文、論点別ルール、免責の文、字数の表、部分の書き直しの指示、事実照合、モデルの設定、ワークフロー。
- `content/posts/*.md`・`data/` を触らない。
- 説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
npm run build
node scripts/lib/__tests__/test-readability-rules.js
node scripts/lib/__tests__/test-prompt-builder.js
node scripts/lib/__tests__/test-conditional-rules.js
node scripts/lib/__tests__/test-consumption-tax-rate-notation.js
node scripts/lib/__tests__/test-current-tax-period.js
node scripts/lib/__tests__/test-banned-phrases.js
node scripts/lib/__tests__/test-word-count-by-intent.js
node scripts/lib/__tests__/test-generate-draft-output-normalization.js
node scripts/lib/__tests__/test-generation-review-fixes.js
node scripts/lib/__tests__/test-generation-review-fixes-2.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、失敗があれば名前と、今回の変更と関係があるかの見立てを書いてください。

## 最終報告（日本語で）

1. R1〜R5 ごとに「何を変えたか」「触ったファイルと行」「試験の結果（PASS/FAIL の数）」
2. R3 で `READABILITY_RULES` の外に「——」「―」がほかに見つかったか
3. R5 の 7 を書けたか（書けなかった場合は理由）
4. 既存の試験の期待を変えた箇所とその理由
5. 全テストの結果（失敗は名前と見立て、EPERM は名前だけ）
6. 【要判断】【要確認】として残した点
