あなたはこのリポジトリ（hp-vlog）の実装担当です。前回あなたが実装した `docs/codex-tasks/draft-supply/` の変更（コミット 197f5833・fb115362・f5e1612a）にレビュー指摘が付きました。`docs/codex-tasks/draft-supply/01b-review-fixes.md` の F1〜F5 を直し、「記録だけするもの」を README に 1 行足してください。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/draft-supply` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。修正とテストまで行い、コミットはしないでください。
- `docs/codex-tasks/fact-grounding/` は別の作業の未追跡ファイルです。触らないでください。
- ネットワークは使えません。Windows です。Git Bash が落ちたら PowerShell か cmd を使ってください。ファイルは LF。
- 子プロセスで node を起動するテストが EPERM で落ちたら、名前だけ報告してください。
- `test-workflow-change-detection.js` の「記事系ワークフローは作業ツリーで変更されていない」は、`daily-draft.yml` を変えるのでコミット前は落ちます。直さないでください。
- main で既に落ちている `test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js` は対象外です。

## 完了時に実行して結果を報告するもの

```
node scripts/lib/__tests__/test-withdrawn-topics.js
node scripts/lib/__tests__/test-draft-schedule.js
node scripts/lib/__tests__/test-title-refresh.js
node scripts/lib/__tests__/test-netlify-ignore.js
node scripts/lib/__tests__/test-selector.js
node scripts/lib/__tests__/test-notify-message.js
npm run validate
git status --short
git diff --stat
```

## 最終報告（日本語）

1. F1〜F5 ごとに「何を変えたか」「触ったファイル」「追加したテストと結果（PASS/FAIL の数）」
2. 上のコマンドの結果
3. 【要判断】【要確認】として残した点
