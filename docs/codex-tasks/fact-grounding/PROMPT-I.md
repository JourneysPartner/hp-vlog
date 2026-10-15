あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/fact-grounding/` にあります。01〜05・03b〜03g は実装済み・コミット済みです。03h は不採用です（理由は `03i-pages-once.md` の背景）。今回は **`03i-pages-once.md`（I1〜I9）だけ**を実装してください。照合で同じ資料を何十回も送り直している無駄をなくし（資料はページ単位で 1 回だけ）、AI には文を書き写させず番号で答えさせます。各主張に渡る資料の中身は今以上にし、精度に関わる歯止め（止める範囲・引用の実在・数字の確認）は変えません。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/fact-grounding` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- 03h の実装は手元の枝 `wip/03h-narrow-evidence` にあります。I5（同じ事実）・I6（修正は置き換え文だけ）・I9（記録）は、`git show wip/03h-narrow-evidence:<ファイル>` で読んで参考にしてかまいません。根拠の絞り込み（N1）・日付の文の一覧（N2）・広い再判定（N4）・抜き出しの先分割（N6）は使わないでください。
- 試験データは `docs/codex-tasks/fact-grounding/fixtures/real-run-3/`（実際の照合 3 本の主張・判定の記録と下書き本文）です。変更しないでください。
- テストは新しいファイル `scripts/lib/__tests__/test-fact-pages.js` に足してください（T1〜T10）。既存のテストの期待は、入力と出力の形（番号）・候補の載せ方・1 回の件数・差し戻しの差分照合によって変わるものだけ最小限に直し、どのテストのどの期待をなぜ変えたかを最終報告に書いてください。
- T1・T2 は実データで通すことが目的です。数値を合わせるために、特定の記事・資料・主張だけを特別扱いする分岐を入れないでください。目標に届かない場合は、届かないまま数値と原因を報告してください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- ネットワークは使えません。依存関係を追加しないでください。LLM 呼び出しはテストで偽の関数に置き換えてください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。
- 子プロセスで node を起動するテストが EPERM で落ちる場合は、落ちたテスト名だけ報告してください。作業前の時点で落ちているテスト（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。

## 厳守

- 03i の「変更してはいけないもの」を守る。特に案 2 の止める範囲、承認の差し止めの 3 経路、fail-closed、引用の実在確認、数字の歯止め（H1・G3・H2・03g）、候補の出し方、照合のモデルと呼び出し設定。
- 指示文は 03i に書いた変更だけ。
- `content/posts/*.md`・`data/`・`fixtures/` を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-fact-pages.js
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

1. I1〜I9 ごとに「何を変えたか」「触ったファイルと行」「テスト結果（PASS/FAIL の数）」
2. T1 の 3 本それぞれの入力・出力の字数（呼び出しの種類ごと、今の作りの記録と並べて）と、資料の塊の字数・ページ数
3. T2 の既知の誤り 8 件それぞれの結果（候補に入ったか・塊に切れずに含まれたか・何番から何番で指せたか）
4. 既存テストの期待を変えた箇所とその理由
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点
