あなたはこのリポジトリ（hp-vlog、税理士事務所サイト mori-zeirishi.net の生成元）の実装担当です。指示書は `docs/codex-tasks/workflow-injection/`（`README.md`・`01-env-only.md`）です。GitHub Actions のワークフローの `run:` に、外から入る文字列（AI が作った題名、外部サイトから作った報告文、手動入力など）が `${{ … }}` で直接埋め込まれている 87 か所を、env 経由に直してください（R1〜R3）。

## 進め方

- 作業ブランチは現在チェックアウト済みの `fix/workflow-run-injection` です。ブランチを切り替えないでください。
- この環境では git にコミットできません。実装とテストまで行い、コミットはしないでください。
- まず R3 の試験 1 を書き、今の状態で 87 か所が見つかって落ちることを確かめてから、ワークフローを直してください。
- 変更は値の渡し方だけです。呼ぶコマンド・引数・文面・条件・手順の順番を変えないでください（01 の「変更してはいけないもの」）。
- `test-workflow-change-detection.js` の「記事系ワークフローは作業ツリーで変更されていない」は、`daily-draft.yml`・`publish-scheduled.yml` に未コミットの変更があると必ず落ちる見張りです。この 1 件の失敗は最終報告に「未コミットのため」と書くだけにし、この試験は変えないでください。同じファイルの残りの項目は通してください。
- 作業用のファイルはリポジトリの外（`%TEMP%`）に置いてください。リポジトリ内に作った場合は最後に消してください。
- Windows です。Git Bash が落ちる場合は PowerShell か cmd を使ってください。ファイルは LF で書いてください。子プロセスで `bash`・`node` を起動する試験が EPERM で落ちる場合は、落ちた試験名だけ報告してください（Claude が隔離の外で流します）。作業前の時点で落ちている試験（`test-check-master-freshness.js`・`test-nta-source-body.js`・`test-gsc-topics.js`・`test-nta-qa.js`）は対象外です。
- ネットワークは使えません。依存関係は追加しないでください。

## 厳守

- 鍵・トークンを試験・ログ・ファイルに書かない（試験の偽の値も、鍵の形の文字列にしない。`sk-`・`ghp_` などで始めない）。
- `content/posts/*.md`・`data/`・`scripts/` のコード（試験の追加を除く）を触らない。説明・コメント・最終報告は日本語。

## 完了時に実行して結果を報告するもの

```
npm run validate
node scripts/lib/__tests__/test-workflow-run-injection.js
node scripts/lib/__tests__/test-workflow-change-detection.js
git status --short
git diff --stat
```

あわせて `scripts/lib/__tests__/` の全テストを実行し、対象外と EPERM 以外に失敗が無いことを確かめてください。

## 最終報告（日本語で）

1. R1〜R3 ごとに「何を変えたか」「触ったファイル」「試験の結果（PASS/FAIL の数）」
2. 直す前の main で試験 1 が見つけた件数（ワークフローごと）
3. 値の置き換え以外に変えた行があれば、その行と理由（無ければ「無し」）
4. R2 で足した形の確認と、`only` に許した文字
5. 全テストの結果（対象外と EPERM は名前だけ）
6. 【要判断】【要確認】として残した点
