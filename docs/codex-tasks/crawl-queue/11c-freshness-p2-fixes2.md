# 11c 鮮度 第 2 段階: 2 回目のレビュー指摘の修正（2026-10-02）

`11b` の修正に対する 2 回目のレビュー（Claude Opus 5.5 xhigh）で見つかった問題を直す。作業ツリーの今の実装の上に重ねる。11・11b の「変更してはいけないもの」はそのまま有効。

`.github/workflows/regenerate-draft.yml` は Claude が main の版に戻した（範囲外の変更だったため）。**このファイルは触らないこと**。`test-workflow-change-detection.js` が記事系ワークフローの変更を見張っている。

## G1 承認前の基準本文の確認と、処理済みの判定（N3・N4・N6）

### 基準本文の印

`runRefresh`（`--refresh`）で、枝の frontmatter に `refresh_base_hash` を足す。中身は、元の本文（main の本文）を「CRLF を LF にそろえ、前後の空白を除いた」ものの sha256（16 進）。

- 差し戻しの再生成では frontmatter を保つので、この値は残る。
- main に書く内容は main の frontmatter を使うので、この印が main に入ることはない。

### 承認の判定順（更新案の経路）

main を読むたびに（sha 競合でやり直すときも）、次の順で判定する。

1. **枝と記事の組み合わせ**: `ref` が `draft/refresh-<main の frontmatter の slug>` と一致しなければ断る（`refresh_approve_failed`、理由「更新案の枝と記事が一致しません」）。
2. **基準本文の印**: 枝に `refresh_base_hash` が無ければ断る（理由「更新案の作成時の情報がありません。管理画面から作り直してください」）。
3. **main の本文と枝の本文が同じ場合**（NFKC 正規化と空白除去のあとで比べる）:
   - main の本文の hash が `refresh_base_hash` と同じなら、AI が何も変えていない。今までの「反映する変更がありません」で断る。
   - 違えば、すでに反映済み。`refresh_processed` を送り、PR が開いていれば閉じ、枝を消して、成功として終える（失敗の通知は送らない）。
4. **main の本文の hash が `refresh_base_hash` と違う場合**: 更新案の作成後に公開中の記事が変わっている。何も書かずに断る（理由「更新案の作成後に公開中の記事が変わりました。管理画面から更新案を作り直してください」）。
5. **それ以外**: 今のとおり書き込む。

## G2 管理画面の「作業中」の判定（N1・N5）

- `admin-freshness-action.js` の「作業中」の判定から、**枝があるかどうか（`getRef`）を外す**。承認はマージをしなくなったので、枝だけが残っていても「確認済み」とぶつからない。残す判定は次の 2 つ。
  - head を指定して見た、開いている PR
  - 実行中のワークフロー
- **実行中のワークフローの絞り込み**:
  - `refresh-article.yml` に `run-name: 記事の更新案 ${{ inputs.slug }}` を付ける（`run-name` での式の展開は `run:` ではないので許す）。
  - 管理画面では `display_title` がその slug で終わる実行だけを数える。
  - 数える状態は `queued`・`in_progress`・`requested`・`pending`・`waiting` とする。
- **見送り時の枝の削除**: `review-skip.js` で、`ref` が `draft/refresh-` で始まるときだけ、PR を閉じたあとに `deleteBranch(ref)` で枝も消す。通常の下書きの見送りは今までどおり（枝を消さない）。

## G3 更新案の差し戻しで落ちない（N2）

- 更新案の差し戻しで、分類が `add_section` なら targeted に回す。
- `spliceChangedSections` の結果が `ok: false`（章の数や見出しの並びが変わった）のときは**例外にしない**。元の本文のまま、次を書いて返す。
  - `review_status: "needs_revision"`
  - `review_comment: "自動再生成の警告: 更新案では章の追加・見出しの変更はできません。本文の中で補う形の指示にして差し戻してください。"`

  こうすれば既存の `regenerate_not_applied` の通知に乗る。`regenerate-draft.yml` は変えない。
- このほか、更新案の差し戻しで、それまで例外になっていた経路（見出しが見つからない等）も同じ警告の形で返す。ジョブを落とさない。

## G4 警告の見落とし（1 回目の #7、未対応だったもの）

`runRefresh` で、再生成の出力の `review_status` が `needs_revision` なら、`review_comment` の行が無くても `failed` にする。テストは、`review_comment` の行が無い記事で行う。

## G5 文言と細かい修正

1. **承認後の表示**: `review-page.js` の更新案の承認後の表示を「公開中の記事へ反映しています。数分後にサイトに出ます。」にする（「PR の自動マージ」の文言を出さない）。
2. **承認時の失敗の通知**: 新しいイベント `refresh_approve_failed` を作り、文面は「更新案を反映できませんでした」＋理由＋「レビュー画面から承認し直すか、管理画面から更新案を作り直してください。」とする。`refresh_failed` は、更新案の作成の失敗だけに使う。
3. **段落の比べ方**: `paragraphs()`（比べる用の段落分け）で、段落の中の `\r\n` も `\n` にそろえてから比べる。差し込む文字列は元のまま。CRLF で、表や箇条書きのある記事でテストする。

## テスト（追加・書き換え）

### 承認

- 枝と記事が一致しないと断る。`refresh_base_hash` が無いと断る。
- main が作成後に変わっていると断り、何も書かない。
- 反映済み（main の本文が枝と同じで、基準本文と違う）なら、`refresh_processed` を送って PR を閉じ、失敗の通知は送らない。
- sha 競合のあと、相手が同じ更新案を反映していた場合も処理済みになる。
- AI の変更なし（3 つとも同じ）は、今までどおり断る。

### 管理画面

- 枝だけが残っていて PR も実行中も無ければ、「確認済み」と「更新案を作る」が通る。
- 別の slug の実行中は数えない。`requested` などの状態は数える。

### 見送り

- 更新案の枝は消える。通常の下書きの枝は消えない。

### 差し戻し

- `add_section` が targeted になる。
- 章の数が変わった出力では例外にならず、警告と `needs_revision` が付く。本文は元のまま。

### そのほか

- `runRefresh`: `review_comment` の行が無い記事で、`needs_revision` を `failed` にする。`refresh_base_hash` が付く。
- 通知: `refresh_approve_failed` の文面。
- 段落: CRLF で、表や箇条書きのある節が、変わっていなければ変更に数えられない。
- ワークフロー: `run-name` に slug が入る。`run:` の中に `${{ }}` が無いことの検査は今のまま通る。
