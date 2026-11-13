# 法令の版が施行済みかを e-Gov で確かめる道具

## 目的

令和8年度改正の所得税の部分は 2026-12-01 に施行される（令和8年法律第12号 附則1条4号イ）。施行を確かめてから段 6（`legal_status` を `enacted` → `effective`）に進むため、e-Gov 法令 API で「指定した法令の版が施行済みか」を確かめるコマンドを作る。Orca の自動化の「事前チェック」から呼ぶので、**終了コードだけで結果が分かる**ことが大事。

2027-01-01 の住民税（地方税法）の切替えでも同じ道具を使う。

## 作るもの

### `scripts/check-law-revisions-enforced.js`

- 使い方: `node scripts/check-law-revisions-enforced.js [--json] <法令の版の ID> [<法令の版の ID> ...]`
  - 版の ID の例: `340AC0000000033_20261201_508AC0000000012`（所得税法・令和8年12月1日の版・令和8年法律第12号）。形は `^[0-9A-Z]+_\d{8}_[0-9A-Z]+$`。先頭の `_` までが法令 ID。
- 版ごとに `https://laws.e-gov.go.jp/api/2/law_revisions/<法令 ID>?response_format=json` を取得し、`revisions` の中から `law_revision_id` が一致する 1 件を探す。同じ法令 ID の版が複数あっても、取得は法令 ID ごとに 1 回にする。
- 施行済みの判定（すべて満たすときだけ施行済み）:
  1. 一致する版がちょうど 1 件ある。
  2. `current_revision_status` が `CurrentEnforced` か `PreviousEnforced`。
  3. `amendment_enforcement_date`（`YYYY-MM-DD`）が、日本時間の今日以前。
- 終了コード:
  - `0`: 指定したすべての版が施行済み。
  - `1`: 1 件でも未施行（`UnEnforced`、版が無い・2 件以上ある、知らない状態、施行日が未来、施行日が無い）。
  - `2`: 引数の誤り、通信の失敗、HTTP が 200 でない、JSON が読めない、応答に `revisions` の配列が無い。
- 出力（標準出力）: 版ごとに 1 行 `<版の ID>\t<current_revision_status または「なし」>\t<施行日>\t施行済み|未施行`。最後に `結果: 施行済み` か `結果: 未施行` か `結果: 確認できない（理由）`。`--json` のときは `{ "ok": true|false, "results": [...] }` を 1 つだけ出す。エラーの説明は標準エラー出力へ。
- 通信: Node の組み込みの `fetch` を使う（依存を足さない）。1 回の取得に 20 秒の時間切れ（`AbortController`）。失敗したら 1 回だけやり直す（5 秒待つ）。
- 試験のため、本体は関数として公開する: `checkRevisions(ids, { fetchImpl, now })` が `{ exitCode, results, reason }` を返す。`fetchImpl` の既定は `globalThis.fetch`、`now` の既定は `() => new Date()`。日本時間の今日は `now()` から UTC+9 で求める（`Intl` に頼らない）。`require.main === module` のときだけ引数を読んで実行し、`process.exitCode` を設定する。
- 書き込みはしない（ファイル・ネットワークへの送信なし）。秘密情報は使わない。

### `scripts/lib/__tests__/test-check-law-revisions-enforced.js`

偽の `fetchImpl` で確かめる（ネットワークを使わない）。既存の試験と同じく、`✓`／`✗` を出して最後に `N passed, M failed`、失敗があれば終了コード 1。

1. 2 つの法令の版がどちらも `CurrentEnforced`・施行日が今日以前 → `exitCode` 0。
2. `PreviousEnforced` → 施行済み扱い。
3. 1 件が `UnEnforced` → 1。
4. 施行日が日本時間の明日（状態は `CurrentEnforced`）→ 1。日本時間の境目: `now` が `2026-11-30T15:00:00Z`（日本時間 12/1 0:00）なら施行日 2026-12-01 は今日、`2026-11-30T14:59:59Z` なら明日。
5. 版が見つからない／同じ ID の版が 2 件 → 1。
6. 知らない状態の文字列 → 1。施行日が無い → 1。
7. HTTP 500、`fetch` が例外、JSON が壊れている、`revisions` が無い → 2。1 回目だけ失敗して 2 回目が成功するときは成功の結果になり、取得は 2 回。
8. ID の形が誤り・ID が 0 個 → 2。
9. 同じ法令 ID の版を 2 つ渡しても取得は 1 回。
10. コマンドとして動かしたときの終了コードと出力の最後の行（子プロセスで起動する試験は、既存の試験と同じ書き方にする。起動できない環境なら、その旨を出して飛ばしてよい）。

### `package.json`

`masters:test` の一覧の末尾に `scripts/lib/__tests__/test-check-law-revisions-enforced.js` を足す。ほかは変えない。

## 変えてはいけないもの

- 上の 3 ファイル以外。特に `data/`・`src/`・`assets/`・ほかの試験。
- 依存（`package.json` の `dependencies`・`devDependencies`、`package-lock.json`）。

## 確かめること

1. 新しい試験ファイルを単独で実行して全部通る。
2. `node --check scripts/check-law-revisions-enforced.js`。
3. `git status --short` に上の 3 ファイル以外が無い。

## 最後の報告

変えたファイルと要約、試験の件数と結果、判断に迷った点。日本語で。
