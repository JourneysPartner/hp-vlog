最後の再レビュー（`review-01c.md`）の結論は「マージ可（Critical・High 0）」でした。Low のうち 3 件を直してください（Low-2 は記録だけにします）。

## H1（Low-1）1 回間違えた直後の「もう一度お試しください」の連続と、IP の枠の空減り

- 読み込みが eventual のため、全体の記録（`global`）の古い版を読むと全体の書き込みが 412 になる。そのとき IP の書き込みは通っているので、照合をしないまま IP の数だけ 1 つ増える。何度か重なると IP の上限（5 回）に届き 15 分止まる。
- 直し方:
  - 全体の書き込みが 412 になったら、直前の IP の書き込みの戻り値の `etag` を `onlyIfMatch` に付けて、IP の記録を書き込みの前の中身に戻す（前の記録が無かったときは、同じ `etag` の条件で消すか、件数 0 の記録に戻す。ライブラリの `delete` に条件が付けられない場合は、`set` で前の中身に戻す）。戻しが 412 なら何もしない（ほかの要求が先に書いた＝数え漏れは起きない）。戻しが 200・412 以外なら今の例外の扱い（503）。
  - 競合の文言を「1 分ほど待ってからもう一度お試しください」にする（上限の「しばらくしてからお試しください」とは分けたまま）。
- 試験（本物のライブラリ＋偽の `fetch`）: 全体の書き込みだけ 412 → IP の記録が元の中身に戻り、照合 0 回・429・新しい文言。戻しのときにほかの要求が先に書いていた（412）→ そのまま 429。1 回間違えた後、全体の古い版を 3 回続けて読む → IP の数が増えず、その後の正しいパスワードで 303。

## H2（Low-3）レビュー画面の表の見た目を公開サイトに揃える

- 表の `display: block` をやめ、除去処理が表を開くときに `<div class="table-wrapper">`、閉じるときに `</div>` を出す（表の入れ子を捨てているので、本文の枠は抜けない）。`div` は除去処理が出すこの包みだけで、本文の `div` は今どおり認めない。
- CSS は、公開サイトの表（`assets/css/blog.css` 537〜547 行付近：幅いっぱい・最小幅 480px）とレビュー画面の今までの `.table-wrapper`（横スクロール）の見た目に揃える。
- 試験: 本文の表が `<div class="table-wrapper"><table>…</table></div>` で出る。`<table><table></table></table>外の文` などの G2 の試験が全部通り、本文のカードの開閉が揃う。

## H3（Low-4）「戻る」で戻ったときのボタン

- ログイン画面のスクリプトで、`pageshow` の `event.persisted` が真なら、ボタンを押せる状態と元の文言に戻す。
- 試験: スクリプトに `pageshow` の扱いがある（偽の DOM で、`persisted: true` のときにボタンが戻る）。

## 記録だけ（直さない）

- Low-2: 書き込みが 4xx で失敗したとき、SDK のやり直しのため 503 の画面ではなく関数の時間切れになりうる。照合には進まない（安全側）。

前回と同じ条件で作業してください（ブランチ `fix/review-auth` のまま、コミットしない、ネットワーク不可、依存関係を足さない、01〜01c・G4 の期待を緩めない）。終わったら次を実行して、結果を日本語で短く報告してください。

```
node scripts/lib/__tests__/test-review-auth.js
node scripts/lib/__tests__/test-review-page.js
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-review-approve-refresh.js
node scripts/lib/__tests__/test-review-skip-refresh.js
git status --short
git diff --stat
```
