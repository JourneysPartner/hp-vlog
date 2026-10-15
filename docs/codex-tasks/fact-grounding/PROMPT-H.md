あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。01〜05・03b〜03g は実装済み・コミット済みです。今回は **`03h-cost.md`（N1〜N7）だけ**を実装してください。照合で AI に渡す量を減らす修正で、根拠は資料の全文ではなく、こちらで選んだ数百字の文だけを渡します。精度に関わる歯止め（止める範囲・引用の実在・数字の確認）は変えません。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-grounding` です（最新の main を取り込み済み）。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- 試験データは `docs/codex-tasks/fact-grounding/fixtures/real-run-3/`（実際の照合 3 本の主張・判定の記録と下書き本文）です。変更しないでください。
- テストは新しいファイル `scripts/lib/__tests__/test-fact-cost.js` に足してください（T1〜T9）。既存のテストの期待は、候補の数・抜粋の長さ・判定と修正の入力と出力の形・1 回の件数が変わることで変わるものだけ最小限に直し、どのテストのどの期待をなぜ変えたかを最終報告に書いてください。
- T1・T2 は実データで通すことが目的です。数値を合わせるために、特定の記事・資料・主張だけを特別扱いする分岐を入れないでください。目標に届かない場合は、届かないまま数値と原因（どの呼び出しの何が多いか）を報告してください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- ネットワークは使えません。依存関係を追加しないでください。LLM 呼び出しはテストで偽の関数に置き換えてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。main で既に落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js` ほか、作業前の時点で落ちているもの）は対象外です。

## 厳守

- 03h の「変更してはいけないもの」を守る。特に案 2 の止める範囲、承認の差し止めの 3 経路、fail-closed、引用の実在確認、数字の歯止め（H1・G3・H2・03g）、照合のモデルと呼び出し設定、抜き出しの指示文。
- 判定と修正の指示文は 03h に書いた変更だけ。
- `content/posts/*.md`・`data/`・`fixtures/` を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-cost.js
node scripts/lib/__tests__/test-fact-number-guard.js
node scripts/lib/__tests__/test-fact-real-run-2-fixes.js
node scripts/lib/__tests__/test-fact-real-run-fixes.js
node scripts/lib/__tests__/test-fact-check.js
node scripts/lib/__tests__/test-fact-check-diagnostic.js
node scripts/lib/__tests__/test-fact-review-fixes.js
node scripts/lib/__tests__/test-fact-review-fixes-2.js
node scripts/lib/__tests__/test-fact-review-fixes-3.js
node scripts/lib/__tests__/test-published-facts-audit.js
node scripts/lib/__tests__/test-review-page.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. N1〜N7 ごとに「何を変えたか」「触ったファイルと行」「テスト結果（PASS/FAIL の数）」
2. T1 の 3 本それぞれの入力量（呼び出しの種類ごと、今の作りの記録と並べて）と、出力量の見込み
3. T2 の既知の誤りごとに、狭い根拠で通ったか・広い根拠で通ったか
4. 既存テストの期待を変えた箇所とその理由
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点
