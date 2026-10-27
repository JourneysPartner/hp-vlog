# 01 `masters:test` を最後まで流す

背景は `README.md`。いまの `masters:test` は `node a.js && node b.js && …` なので、3 本目が落ちると後ろの 65 本は CI で一度も走らない。

## 実装要件

### R1 実行役 `scripts/run-test-files.js`（新規）

- 引数で受け取った試験ファイルを、**書かれた順に 1 本ずつ**、`process.execPath`（いま動いている node）で実行する。並列にしない（試験どうしが一時フォルダや作業ツリーを使うため）。
- 子の標準出力・標準エラーはそのまま流す（`stdio: 'inherit'`）。作業ディレクトリは親と同じ。
- 1 本が落ちても次へ進む。
- 全部終わったら、最後に要約を出す。
  - 全部通ったとき: `試験ファイル N 本: すべて通過`
  - 落ちたとき: `試験ファイル N 本中 M 本が失敗` と、失敗したファイルを 1 行ずつ（終了コード、またはシグナル名を添える）。
- 1 本でも落ちたら終了コード 1、全部通れば 0。
- 次は「失敗」として扱い、要約に含める。
  - 存在しないファイル（実行する前に確かめ、`見つかりません` と出す。子は起動しない）
  - 子を起動できなかった（`spawnSync` の `error`）
  - シグナルで止まった（`status` が null）
- 引数が 0 本なら、何も実行せずエラーを出して終了コード 1（指定を誤って「0 本で全部通過」になるのを防ぐ）。
- 同じファイルが 2 回指定されていたら、エラーを出して終了コード 1（登録の重複を見つけるため。何も実行しない）。

### R2 `package.json` の `masters:test` を実行役に切り替える

- `"masters:test": "node scripts/run-test-files.js <試験ファイル> <試験ファイル> …"` にする。
- **試験ファイルの一覧と順番は、いまの `&&` の並びと完全に同じ**にする（68 本）。最後に R4 の試験を足す。
- 他の npm スクリプトは変えない。
- 既存の試験のうち 3 本（`test-draft-branch-hygiene.js`・`test-page-structure.js`・`test-replaces.js`）が `packageJson.scripts['masters:test'].includes('<ファイル名>')` で登録を確かめている。この形のままで通ることを確かめる。

### R3 CI の起動条件

- `.github/workflows/check-tax-simulator-masters.yml` の `on.pull_request.paths` に `'scripts/run-test-files.js'` を 1 行足す（実行役だけを変えた PR でも CI が動くように）。その他の行は変えない。

### R4 実行役の試験 `scripts/lib/__tests__/test-run-test-files.js`（新規）

一時フォルダに小さな試験ファイルを作り、実行役を子プロセスで動かして確かめる。後片付けは `finally` で。

- 通る・落ちる・通るの 3 本 → 3 本とも実行される（3 本目の出力が出る）、終了コード 1、要約に落ちた 1 本だけが載る。
- 全部通る 2 本 → 終了コード 0、要約は「すべて通過」。
- 存在しないファイルを含む → そのファイルを失敗として要約に載せ、他は実行され、終了コード 1。
- 引数 0 本 → 終了コード 1。
- 同じファイルを 2 回 → 終了コード 1、何も実行されない。
- 実際の `package.json` の `masters:test`: 実行役を使う形であること、一覧に重複が無いこと、一覧の全ファイルが存在すること、`test-run-test-files.js` 自身を含むこと。
- 他の試験と同じ書き方（`✓`/`✗` と最後の `N passed, M failed`、失敗があれば終了コード 1）。

## テスト

- `node scripts/lib/__tests__/test-run-test-files.js`
- `npm run masters:test`（02 を入れた後なら全部通る。02 の前なら 2 本だけ落ち、残りは全部流れて要約に 2 本だけ載ることを確かめる）
- `node scripts/lib/__tests__/test-draft-branch-hygiene.js`、`test-page-structure.js`、`test-replaces.js`
- `node scripts/lib/__tests__/test-workflow-change-detection.js`、`test-workflow-run-injection.js`

## 変更してはいけないもの

- 既存の試験ファイルの中身（02 で名指ししたものを除く）。
- `masters:test` 以外の npm スクリプト。
- ワークフローの段の中身・順番・`if` 条件（R3 の `paths` 1 行だけ）。
