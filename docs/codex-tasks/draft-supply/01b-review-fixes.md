# 01b レビュー指摘の修正（2026-10-09、Opus 5.5 xhigh のレビュー）

対象はコミット 197f5833・fb115362・f5e1612a。総合判定「修正してからマージ」。

## F1（High）取り下げ記録のテストが本番データの件数に縛られている

- `scripts/lib/__tests__/test-withdrawn-topics.js` の初期データの確認（182 行付近）が、`data/withdrawn-topics.json` がちょうど 8 件であることを求めている。本番で取り下げが 1 件でも記録されると落ち、`masters:test`（`&&` つなぎ）の後続と月次の「Check master freshness」・通知まで止まる。
- 直し方: 「先頭 8 件が指示書の表どおり（topic_id・stage・date・similar_to・url_slug・target_query）」を確かめる形にする。9 件目以降があっても通る。件数の完全一致は確かめない。
- テスト: 偽の 9 件目を足したデータでも通ること、先頭 8 件のどれかを変えると落ちることを確かめる（実ファイルは書き換えず、読み込んだデータを複製して検査関数に渡す）。

## F2（Medium）壊れた記録ファイルで、それまでの記録が全部消える

- 今は、main の `data/withdrawn-topics.json` が壊れた JSON だと、追記が「空」として読み、今回分だけで上書きし、終了コード 0 で main に push する。
- 直し方:
  - 追記（`record-withdrawn-topics.js` と、手元実行で `data/withdrawn-topics.json` に直接書く経路の両方）は、**ファイルがあるのに読めない・形が違う（`entries` が配列でない）ときは例外を出して書かない**。`record-withdrawn-topics.js` は終了コード 1 で終わる（ワークフローの記録ステップは `::warning::` を出して成功で終える）。
  - 選定時の読み込みは今までどおり空として扱って生成を止めない。ただし GitHub Actions 上（`GITHUB_ACTIONS=true`）では `::warning::取り下げ記録が読めないため、記録による除外をせずに選定します` を出す。
- テスト: 壊れた JSON・`entries` が配列でない JSON で、追記が例外になりファイルが変わらないこと。`record-withdrawn-topics.js` の終了コードが 1。選定は空扱いで続き、警告が出ること。ファイルが無いときは従来どおり新規作成。

## F3（Low）main への push の再試行が rebase の失敗で諦める

- `.github/workflows/daily-draft.yml` の記録ステップ（464 行付近）。`git pull --rebase` が rebase を始める前に失敗すると、続く `git rebase --abort` も失敗して再適用せずに終わる。
- 直し方: pull と rebase をやめ、失敗のたびに「`git fetch origin main` → `git checkout -B withdrawn-record origin/main` → `node scripts/record-withdrawn-topics.js /tmp/withdrawn-new.json` → `git add data/withdrawn-topics.json` → コミット → push」をやり直す（追記は重複をまとめるので何度やっても結果は同じ）。最大 4 回。全部失敗したら `::warning::` を出して成功で終える。
- ステップの最初に `/tmp/withdrawn-new.json` の中身をログに出す（保存に失敗したときに手で戻せるように）。中身は題材の ID と理由だけで秘密情報は無い。
- 変更してよいのはこの記録ステップだけ。

## F4（Low）0 本のときの理由の文面

- `scripts/generate-draft.js`（2613・2650・3168 行付近）。最初の選定で候補が 0 件のとき、理由が「/ 候補が尽きたため…」と区切りから始まり、従来は載っていた選定側の理由（関連性ゲートで全候補を除外など、`lastSelectionWarnings` / `explanation.warnings`）が消える。
- 直し方: 試した候補が 0 件なら区切りを付けない。最後に呼んだ選定の警告文を理由に含める（600 文字の上限は維持）。
- テスト: 初回の選定で 0 件 → 理由が区切りで始まらず、選定側の警告文を含む。試行がある場合の文面は変えない。

## F5（Low）題名差し替えテストの偽データが将来の鮮度更新で誤って落ちる

- `scripts/lib/__tests__/test-title-refresh.js`（176 行付近）が、偽データの検証で 1 本目（塗料の記事）を「鮮度更新されていない記事」として固定で使っている。
- 直し方: 対象 10 本の中から「鮮度更新済みでない記事」を探して使う。全部が鮮度更新済みなら、その検証は偽データの記事を 1 本作って行う。

## 記録だけするもの（直さない）

- 未マージ下書きとの重複で外れた題材は、その下書きを見送っても選定に戻らない（指示書どおり。毛利さんの「二度と選ばない」）。戻したいときは `data/withdrawn-topics.json` の項目を手で消す。README の「元に戻す方法」に 1 行足す。

## 変更してはいけないもの

- 01・02・03 で実装した挙動のうち、上の F1〜F5 以外。
- 既存の選定フィルタ・判定・プロンプト、`--force-slug`・2 本モード。
