# 税シミュレーターのマスター鮮度の通知を、実際に届く経路に乗せ替える

PR #713（2026-10-27 マージ）で `masters:test` の常時の赤は直った。マージ後に `workflow_dispatch` で 1 回動かして通知が届くか確かめたところ、**通知の段は「成功」のまま何も送っていなかった**。毛利さんの指示（2026-10-27「やって」）で、通知が実際に届くようにする。

## 背景と数字

- 実行 40525643588（main、2026-10-27）の「Notify Chatwork」の段のログ: `::notice::Chatwork 環境変数が未設定 → 通知スキップ`。段の結果は success。
- この段は Chatwork の API を直接呼び、`secrets.CHATWORK_API_TOKEN`・`secrets.CHATWORK_ROOM_ID` を使う。この 2 つは GitHub に設定されていない。`crawl-nta-sources.yml`（10/01 の実行）も同じ理由で送っていない。**マスターの出典改訂の通知は、これまで一度も届いていなかったと考えられる。**
- 実際に届いている通知（記事の下書き・公開・税制改正の確認など）は、`scripts/notify.js` → Netlify の `notify-dispatch` 関数 → Chatwork／LINE WORKS の経路を使っている。CI 側の設定は `vars.NETLIFY_NOTIFY_URL` と `secrets.NOTIFY_WEBHOOK_SECRET`（`daily-draft.yml`・`publish-scheduled.yml`・`check-tax-reform.yml`・`crawl-nta-tsutatsu.yml`・`check-existing-posts.yml` が使用）。文面は `netlify/functions/lib/notify/message.js` の `buildMessage(event, data)` がイベントの種類ごとに組み立てる。
- さらに、`Run master tests` が落ちると後ろの段は飛ばされる。10/08〜10/27 の赤の間は、鮮度チェック自体が動いていなかった。
- 鮮度チェックのレポートは全文で約 3.5 万文字（620 行）ある。通知にはそのまま載せられないので、短い要約を作り、全文は実行結果のページ（ジョブの要約）で読んでもらう。

## 方針

- 鮮度の通知は、他の通知と同じ `scripts/notify.js` の経路で送る。Chatwork の API を直接呼ぶ段はやめる。
- 通知の本文は、件数と出典ページごとの 1 行の短い要約（上限あり）＋実行結果のページへのリンク。
- 試験（`masters:test`）や入力型の検査が落ちても、マスターの形が正しければ鮮度チェックと通知は動く。ジョブは試験の失敗で赤のまま残る。
- 鮮度チェックが動かなかったとき、または出力を書く前に落ちたときは、空の通知を送らない。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-notify-route.md` | 通知の文面（新しいイベント）、要約の組み立て、ワークフローの条件と起動条件、試験 |

作業ブランチは `fix/masters-notify`。

## 全段階共通の厳守事項

- 既存のイベントの文面と、`notify-dispatch.js`・`notify.js`・プロバイダ（`chatwork.js`・`lineworks.js`）の動きを変えない。足すのは新しいイベント 1 つだけ。
- `check-master-freshness.js` の判定（`check()`）と既存のレポート（`buildReport()`）と既存の出力（`GITHUB_OUTPUT` の各項目）を変えない。足すのは要約の関数と出力 1 つだけ。
- `crawl-nta-sources.yml`・`check-existing-posts.yml` の Chatwork 直呼びの段は、この作業では変えない（別作業として PR 本文に書く）。
- ワークフローの `run:` の中に `${{ }}` を書かない（値は `env:` で渡す。`test-workflow-run-injection.js` の規則）。
- マスター・国税庁データ・記事は変えない。
- 鍵の形の文字列をファイルに直書きしない。
- ネットワークは使えない。通知の送信は試験で行わない。

## 元に戻す方法

- `check-tax-simulator-masters.yml` を PR #713 の版（668ea0a4）に戻す。新しいイベントと要約の関数は使われなくなるだけで害は無い。

## 受け入れ確認（Claude が行う）

- `npm run masters:test` が全部通る（新しい試験を含む）。`test-workflow-run-injection.js`・`test-workflow-change-detection.js` も通る。
- 実データで要約を作り、長さと中身（148 件・出典 30 枚の内訳、対象期間のレコード無し 3 件）を確かめる。
- マージ後（Netlify への反映後）に `workflow_dispatch` で 1 回動かし、Chatwork に届いたことと、通知の段のログの「送信完了」を確かめる。

## コードの入口

- ワークフロー: `.github/workflows/check-tax-simulator-masters.yml`
- 通知: `scripts/notify.js`、`netlify/functions/notify-dispatch.js`、`netlify/functions/lib/notify/message.js`（`freshness_candidates` の書き方が手本）、試験 `scripts/lib/__tests__/test-notify-message.js`
- 鮮度: `scripts/check-master-freshness.js`（`check()`・`buildReport()`・`main()` の `GITHUB_OUTPUT`）、試験 `scripts/lib/__tests__/test-check-master-freshness.js`
- 他の通知の呼び方の例: `.github/workflows/check-tax-reform.yml`・`publish-scheduled.yml`
