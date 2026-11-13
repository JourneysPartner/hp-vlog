# 03 レビューの指摘の直し（2026-11-13 Opus 5.5 xhigh）

01・02 の実装（コミット a1ee65e7）へのレビューで Critical・High は 0 件。次の Medium 1 件・Low 5 件を直す。README の「方針（全段階共通の厳守事項）」はそのまま守る。

## R12（Medium 1）食い違いの日は期間の中のものだけを「除いた日」に出す

今は `window.conflicting_dates` に、traffic の全期間（約 6 か月）と crawl の食い違いがまとめて入り、期間外の日や、traffic では使っている日までレポートに「除いた日」と出る。

- **end の決め方**: traffic の **全部の行**（食い違いの日も含む）の最新の日付を end にする（最新の日が食い違っても期間がずれないように）。traffic が 0 行のときの代わりの決め方は今のまま。
- `window.conflicting_dates`: traffic の食い違いの日のうち、start〜end に入るものだけ。
- `sections.traffic.conflicting_dates`: traffic の食い違いの日を全部（期間の外も。latest.json での記録用）。
- `sections.crawl.conflicting_dates`: crawl の食い違いの日のうち、start〜end に入るものだけ。
- `days_reported` は今のまま（期間内で使った traffic の日数）。最新の日が食い違えば 27/28 になり、その日が `window.conflicting_dates` に出る。
- レポート（02 の R10）: 期間の行の後ろの「Bing の数字が食い違ったため除いた日」は `window.conflicting_dates` だけを使う（今のまま）。「巡回とサイトマップ」の箇条書きの最後に、`sections.crawl.conflicting_dates` があれば「巡回の数字が食い違ったため除いた日: <日付をカンマ区切り>」を足す。
- 試験: (1) 期間外の traffic の食い違いは `window.conflicting_dates` に入らず、`sections.traffic.conflicting_dates` には入る。(2) crawl だけの食い違いは `window.conflicting_dates` に入らず、`sections.crawl.conflicting_dates` に入り、レポートの巡回の節に出る。(3) 最新の日が食い違うと end はその日のまま、`days_reported` が 27、その日が `window.conflicting_dates` に出る。

## R13（Low 1）保存する JSON の確かめは鍵そのものだけにする

今は保存する JSON に `apikey` の文字があると止まるため、Bing の検索語・ページの URL に偶然 `apikey` が入ると、その週の取り込みが止まり、途中まで書いた日付フォルダが残る。

- `writeJsonFile` の確かめは、鍵そのものと `encodeURIComponent(鍵)` だけにする（`apikey` の文字では止めない）。
- ログの文（`emit`）と、コマンドとしての `console.error` の確かめは今のまま（鍵・`encodeURIComponent(鍵)`・`apikey`）。失敗の理由の文はログにも出るので、そこで `apikey` を含めば止まる。
- 書く前に、保存するファイル全部の JSON 文字列を先に作って確かめ、全部が通ってから書き始める（途中まで書いて止まらないように）。
- 試験: 今の「9 (d)」（feeds の URL に `apikey=x`）は、止まらず保存される期待に変える。代わりに、feeds の URL に **偽の鍵そのもの** が入ると止まり、日付フォルダも latest.json も書かれないことを確かめる。

## R14（Low 2）Bing の手順に時間の上限

`.github/workflows/fetch-search-console.yml` の「Fetch from Bing Webmaster Tools」に `timeout-minutes: 10` と `continue-on-error: true` を足す（手順の時間切れは `||` では拾えないため）。`run:` の中身は変えない。01 の R8-12 のワークフローの試験に、この 2 つを確かめる項目を足す。

## R15（Low 3）レポートの Bing の節の例外を閉じ込める

`buildReport` の中で `buildBingSection` を try/catch で包む。例外のときは `['## Bing の数字（Bing Webmaster Tools）', '', '（Bing の数字を読めませんでした。data/bing-webmaster/ の中身を確かめてください）']` にする（例外の文は出さない）。試験: rows に `null` が混ざる・`latest.sections` が文字列、などの壊れた形で `buildReport` が止まらず、その 1 行が出る。

## R16（Low 4）形の記録の項目名を絞る

`shapeLine` の「項目」は `/^[A-Za-z0-9_]{1,40}$/` に合うキーだけを並べ、合わないものがあれば最後に「他 <数> 個」と足す（改行などの入ったキーを Actions の記録にそのまま出さない）。試験: 改行と `::stop-commands::` を含むキーがログに出ず、「他 1 個」と出る。

## R17（Low 5）成功の応答で本文を読む途中の時間切れも再試行する

`callEndpoint` で `response.ok` のときの `response.json()` が `TimeoutError` か `AbortError` の名前の例外を投げたら、時間切れ（理由 `<窓口>: 時間切れ`、再試行の対象）として扱う。それ以外の例外は今のまま「応答の形が違います」（再試行しない）。試験: 1 回目は本文を読む途中で TimeoutError、2 回目は成功 → 成功する。

## 直さないもの（記録だけ）

- Low 6: コマンドとして動かしたときの `console.error` の道を、子プロセスで試す試験。隔離の中では子プロセスを起動できず落ちるため、今回は足さない（コードは読んで確かめ済み）。

## 変更してはいけないもの

01・02 と同じ。加えて、01・02 の試験の期待は R13 の「9 (d)」を除いて変えない。
