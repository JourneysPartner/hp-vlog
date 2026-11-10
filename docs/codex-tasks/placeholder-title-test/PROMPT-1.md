# 依頼: 前から落ちている試験 test-placeholder-title.js を直す

あなたは実装担当です。このリポジトリ（税理士事務所のサイト hp-vlog）で、指示書どおりに試験を直してください。コミット・push・パッケージの追加はしないでください（司令役の Claude が行います）。

## まず読むもの

1. `docs/codex-tasks/placeholder-title-test/README.md`（この依頼の指示書。原因、要件 P1〜P5、変えてよいファイル、変えてはいけないもの）
2. `scripts/lib/__tests__/test-placeholder-title.js`（直す試験。「4. 承認・公開で止まる」の最後の確かめ）
3. `netlify/functions/review-approve-background.js` の `refreshQualityFailure`（92 行〜）・`handleManualEditApproval`（474 行〜）・`handler`（792 行〜）。読むだけで、変えない。

## 変えてよいファイル

- `scripts/lib/__tests__/test-placeholder-title.js` だけ。承認の関数ほか、ほかのファイルは変えないでください。

## 必ず守ること

- 試験を消さない・弱めない。1〜3 と 5 の確かめ、4 のほかの確かめはそのまま。
- 置き換えた 3 つの確かめは、探す文字列が見つからないときに通らないこと（P3）。

## 試験の動かし方

このシェルでは `sbx` だけが使えます。1 本ずつ次の形で動かしてください（中は cmd.exe。`>`・`$`・バッククォートは使えません）。

```
sbx node scripts/lib/__tests__/test-placeholder-title.js
```

次も動かして結果を報告してください: test-manual-edit-review.js、test-fact-check-override.js、test-review-approve-refresh.js。

## 最後の報告の形（日本語）

1. 何を変えたか（P1〜P5 のどれに当たるか）
2. 置き換えた確かめのコード（そのまま）
3. 試験の結果（ファイルごとの通過数・失敗数。落ちたものは名前とエラー）
4. 指示書と違うやり方をした所と、その理由
5. 【要確認】迷った点
