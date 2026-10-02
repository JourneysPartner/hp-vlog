# 11 記事の鮮度: 第 2 段階（更新案の作成・承認・日付の扱い）

設計は `docs/seo/freshness-design.md`。第 1 段階（`10-freshness-p1.md`、#650）と、出典の「内容が変わった日」（`docs/codex-tasks/weekly-signal-fixes/01-freshness-source-change.md`、#660）は実装済み。

毛利の判断（2026-09-27）: ページに出す日付は更新日だけ（「内容を確認: 日付」は出さない）／更新は必ず承認を通す（勝手に本文を書き換えない）／日付を動かすのは実際に内容を更新したときだけ。

毛利の判断（2026-10-01）: 出典確認の仕組みができる前の古い記事（`source_guard_version` 無し、公開中 268 本のうち 159 本）も更新案の対象にする。承認時の出典チェックは公開中の記事と同じ扱いにし、レビュー画面に警告を出す（R3・R4）。

## この段階でやること・やらないこと

- **やる**:
  1. 管理画面の更新候補から、その記事の「更新案」（本文の該当箇所だけを直した下書き PR）を作る。
  2. 毛利が通常のレビュー画面で変更箇所を見て承認すると、公開中の記事にすぐ反映する。このとき公開日は変えず、更新日だけを付ける。
  3. 「確認したが変更なし」を記録し、確認済みの理由を候補から外す。
- **やらない**:
  - 承認なしの公開。
  - 題名・要約の変更（題名は別の作業）。
  - 年度の一括切り替え（第 3 段階）。
  - 検索の反応だけが理由の候補の書き直し。

## 今の仕組みのまま作ると起きる問題（実装前に必ず読む）

1. 承認処理（`netlify/functions/review-approve-background.js`）は、`review_status` を `approved` にし、`publish_at` を翌日の公開枠の時刻に書き換える。ところがページの公開日（表示の日付と構造化データの `datePublished`）は `publish_at` から作られる（`scripts/build.js` 824 行付近）。そのため、更新しただけで公開日が承認日に変わってしまう。
2. サイトは `review_status` が `published` の記事しか載せない（`build.js` の `isPublished`）。`approved` のまま main に入ると、予約公開（`scripts/publish-due.js`、12:00／18:00）が動くまで記事がサイトから消える。
3. `publish-due.js` は公開時に `published_at` と `updated_at` を上書きする。
4. 公開中の 268 本のうち 159 本は `source_guard_version` が無い（出典確認の仕組みができる前の記事）。
   - 承認時の出典チェック（`evaluateSourceGuard`、stage `approve`）は、下書き状態で version が無い記事を必ず止める。
   - 差し戻し再生成の `restoreSourceGuardFields` は version を付けるので、以後その記事は出典一致の判定を受ける。
5. 差し戻し再生成の targeted 経路は、本文を直したあとに題名・要約まで書き換えることがある（`scripts/generate-draft.js` 2488 行付近）。

→ 更新案は**本文だけを変える**。承認は**専用の経路**を通し、公開日に触らず即時に反映する。

## R1 候補データの追加（`scripts/lib/freshness-candidates.js`）

- 各候補に次の 2 項目を末尾に足す。既存の項目と並び順は変えない。
  - `file`: `content/posts/` のファイル名
  - `refreshable`: 理由に `source_updated` / `tax_reform` / `fiscal_year` のどれかがあれば `true`
- 記事の frontmatter の `reviewed_at`（確認した日時。R4・R5 で書く）を使い、確認済みの理由を外す。

| 理由 | 外す条件 |
|---|---|
| `source_updated` | `content_changed_at` が `max(記事の日付, reviewed_at)` 以前 |
| `tax_reform` | `currentTaxYear(reviewed_at)` が改正一覧の `year` と同じ |
| `fiscal_year` | `currentTaxYear(reviewed_at)` が `currentTaxYear(now)` と同じ |
| `search_decline` / `seo_growable` | `reviewed_at` が `now` から 28 日以内 |

- 理由が全部外れた記事は候補にしない。`reviewed_at` が無い記事・日付として読めない記事は今までどおり扱う。
- 週次の Chatwork 通知（`buildFreshnessNotification`）の末尾に `管理画面: https://mori-zeirishi.net/admin/freshness` を 1 行足す。0 件なら送らない動きは変えない。

## R2 更新案を作る

新規: `scripts/lib/freshness-refresh.js`、`.github/workflows/refresh-article.yml`。変更: `scripts/generate-draft.js` に `--refresh` を追加。

### 計画: `buildRefreshPlan(post, reasons, { taxYear })`（freshness-refresh.js の純粋関数）

- `fiscal_year`・`tax_reform` のうち、`where` が見出し（`## …`）のもの → その節だけを書き直す（section）。
  - 同じ見出しは 1 回だけ。上限は 3 節（理由の並び順で先のものから採用）。
- `source_updated`（`where` は「出典欄」）→ 最後に 1 回、本文全体を最小限に直す（targeted）。
- `search_decline` / `seo_growable` → 計画に入れない。
- 計画が空なら「更新の対象になる理由が無い」として終える（結果 `failed`）。

各手順には、差し戻しコメントの代わりに次の指示文を渡す。文面は変えないこと。`{detail}` には理由の `detail` をそのまま入れる。

- **source_updated**（targeted）:
  「{detail}。添付の出典本文が最新版です。本文のうち、添付の出典本文と食い違う記述（金額・税率・期限・要件・適用範囲・年分）だけを、出典本文に合わせて直してください。食い違いの無い箇所は一字も変えないでください。食い違いが見つからなければ、本文をそのまま返してください。」
- **fiscal_year**（section）:
  「この節には年分の記述があります（{detail}）。いまは {taxYear} 年分（令和 {taxYear − 2018} 年分）を基準に読まれます。過去の年分の事実として正しい記述（改正の経緯・適用開始の時期など）はそのまま残し、読者が今年の手続きに当てはめると誤解する記述だけを直してください。直す数字・期限は添付の出典本文に書かれているものだけを使い、根拠が無ければ変えないでください。直す所が無ければ、この節をそのまま返してください。」
- **tax_reform**（section）:
  「この節の制度に関係する税制改正があります（{detail}）。添付の改正論点に照らして、改正後の扱いと食い違う記述だけを直してください。改正前の扱いがまだ当てはまる読者がいる場合は、「◯年◯月◯日以後は…」のように適用時期を明記して両方を残してください。直す所が無ければ、この節をそのまま返してください。」

### 実行: `node scripts/generate-draft.js --refresh --filename <file> --reasons-file <json>`

`--regenerate` の部品を流用する。出典本文・論点別ルール・改正論点・法令の添付（`buildRegenSourceBlocks`）は今のまま効かせる。

- 計画の順に、既存の `regenerateSection`（classification は `{ type: 'section_only', scope: 'section', sectionHint: 見出し }`）と `regenerateTargeted` を呼ぶ。
- 各手順の出力からは**本文だけ**を取り出して、次の手順へ渡す。
- frontmatter は元の記事のものを一字も変えずに使い、最後に次の 5 項目だけを変える（無ければ足す）。
  - `review_status: "draft"`
  - `review_comment: ""`
  - `refresh_of: "published"`
  - `refresh_requested_at`: 実行時刻（JST）
  - `refresh_note`: 理由の要約 1 行（`reasonText` と同じ形）
- 次の項目は変えない（`source_guard_version` は、無ければ無いまま）。
  - 日付: `updated_at`・`publish_at`・`published_at`
  - 内容: `title`・`summary`
  - 出典の項目すべてと `source_guard_version`
- テーマ禁止の判定（denylist・期限切れ）はしない。新しく記事を作るのではなく、公開中の記事の手入れのため。ただし期限切れ（`valid_to` を過ぎた、または `historical_only`）の記事なら、PR 本文とレビュー画面に「期限切れのテーマです。更新ではなく公開停止も検討してください」と出す。
- PR を作らずに終える条件:
  - 本文が変わらなかった（NFKC 正規化と空白除去のあとで同じ）→ 結果 `no_change`
  - 次のどれかに当たった → 結果 `failed`（理由をつける）
    - 再生成側が警告を付けた（`review_comment` に「自動再生成の警告」または「自動反映は一部のみ」）
    - h2 見出しの並びが変わった
    - 本文の長さが元の 85% 未満、または 130% 超
    - 作業語が混ざった（`findInternalProcessWords`）
  - 警告つきで元の本文が返ってきた場合を `no_change` と取り違えないこと。
- 結果は `GITHUB_OUTPUT` に `refresh_result=changed|no_change|failed` と `refresh_reason=…` で出す。`changed` のときは、変わった節の一覧（`diffSections`）を一時ファイルに書き、PR 本文に使う。

### 変更箇所: `diffSections(beforeBody, afterBody)`（freshness-refresh.js）

- h2 単位で比べ、変わった節だけを `{ heading, before, after, changedParagraphs }` で返す。導入部の見出しは「（導入）」とする。
- 段落（空行区切り）ごとに比べ、相手側に無い段落に印を付ける。
- R3 のレビュー画面と PR 本文の両方で使う。

### ワークフロー: `.github/workflows/refresh-article.yml`

- 起動は `workflow_dispatch` のみ。入力は `slug` だけ。
- `slug` は `^[a-z0-9_-]+$` で検査する。`run:` の中では `${{ inputs.slug }}` を直接展開せず、`env:` 経由で使う。
- `concurrency` はグループ `refresh-<slug>` にし、同じ記事の同時実行を止める。
- 手順:
  1. main を取得する。
  2. `data/freshness/candidates.json` から slug の候補を探す。見つからない、または `refreshable` でなければ、失敗として通知して終える。
  3. 記事が main で `published` であることを確かめる。
  4. 作業枝は `draft/refresh-<slug>` とする。開いている PR があれば「作成済み」と通知して終える。枝だけが残っていて PR が閉じている（またはマージ済み）なら、枝を消してから作り直す。
  5. `generate-draft.js --refresh` を実行する。環境変数は `regenerate-draft.yml` の Regenerate draft と同じものを渡す。
  6. `changed` のとき:
     - `node scripts/validate.js content/posts/<file>` で対象ファイルだけを検証する。
     - 記事ファイルだけをコミットする（ほかのファイルが混ざったら失敗）。
     - push して PR を作る。作り方とトークンは `daily-draft.yml` の下書き PR と同じにする。
     - PR の題名は「【更新】<記事の題名>（マージしない）」（2026-10-02 のレビューで変更。本文の先頭にも「マージしないでください」の注意を入れる）。
     - PR の本文には次を入れる。
       - 理由
       - 変わった節（見出しと、変更前後の段落。1 節あたり 600 字で切る）
       - レビュー URL（`https://mori-zeirishi.net/review?file=<file>&ref=draft/refresh-<slug>`）
       - 「承認すると公開中の記事にすぐ反映されます。公開日は変わらず、更新日が付きます。」
- 通知には `scripts/notify.js` を使う。新しいイベントを 3 つ作り、文面を `netlify/functions/lib/notify/message.js` に足す。
  - `refresh_ready`: 題名・理由・レビュー URL
  - `refresh_no_change`: 「AI が見た範囲では直す所がありませんでした。問題なければ管理画面で『確認済み』を押してください。」と管理画面の URL
  - `refresh_failed`: 理由

## R3 レビュー画面（`netlify/functions/review-page.js`）

`refresh_of: "published"` の記事のときだけ、次のようにする。通常の下書きの画面は一切変えない。

- 上部に「公開中の記事の更新案です。承認すると、すぐに公開中の記事へ反映されます（公開日は変わらず、更新日が付きます）。」と書き、`refresh_note` を添える。
- 「変更箇所」の欄:
  - main の同じファイルを取得し、`diffSections` の結果を節ごとに変更前・変更後で並べる。変わった段落には色を付ける。
  - main から取得できない場合はその旨を出し、承認ボタンを押せないようにする。
- `source_guard_version` が無い記事には「出典確認の仕組みができる前の記事です（出典: …）。出典との食い違いが無いかを特に見てください。」と出す。
- 承認ボタンの文言は「更新を反映する」にする。「このテーマを今後生成しない」ボタンは出さない。差し戻し・見送りのボタンは今のまま。

## R4 承認（`netlify/functions/review-approve-background.js`）

> 2026-10-01 のレビューを受けて、承認の作りは `11b-freshness-p2-fixes.md` の F1 に改めた（main に直接書き、PR は閉じる）。下の 3〜5 は F1 が優先する。

`refresh_of: "published"` の記事は専用の経路で処理する。通常の経路は変えない。

1. **前提の確認**: `ref` が無ければ 400 で断る。main の同じファイルを取得し、`review_status` が `published` でなければ 400（「公開中ではなくなった記事です」）。
2. **出典チェック**: `review_status` を `published` とみなし、stage `approve` で `evaluateSourceGuard` を呼ぶ。
   - version が無い記事は、いま公開中の記事と同じ扱いで通る。
   - version がある記事は出典一致を判定する。止まった場合は 400 を返し、既存の `source_blocked` 通知を送る。
   - 仮置き題名の判定と、recommendation・スコアの判定は通常と同じ。
3. **下書き枝のファイルを書き換える**:
   - `review_status: "published"`
   - `updated_at` と `reviewed_at`: 現在時刻（JST）
   - `review_comment: ""`
   - `refresh_of`・`refresh_requested_at`・`refresh_note` の行を消す
   - `publish_at`・`published_at`・`publish_slot`・`approved_at` には触らない。
   - 公開枠の決定（`publishAtForSlot`・`findApprovedArticlesForDate`）と、枠の再調整は呼ばない。
4. **マージ**: PR をマージして枝を消す（既存の `waitForMergeable` / `mergePR` / `deleteBranch`）。
5. **失敗の判定**: 通常経路の「main が published なら二度押し」という判定は使えない（更新の場合、main は最初から published のため）。PR の状態が merged か、main のファイルの本文が下書き枝の本文と同じときだけ「処理済み」とみなす。それ以外は `merge_failed` を通知する。
6. **成功時**: `refresh_published` を通知する（題名・記事 URL・理由の 1 行）。

frontmatter の行を消す小さな関数を `netlify/functions/lib/github-api.js` に足す（`updateFrontmatter` と同じ書き方で）。

## R5 「確認済み（変更なし）」と管理画面（新規 `/admin/freshness`）

- **新規ファイルと配線**:
  - `netlify/functions/admin-freshness-page.js`（一覧）と `admin-freshness-action.js`（操作）を作る。
  - 認証は既存の `requireBasicAuth` を使う。
  - `netlify/functions/lib/admin-nav.js` に「更新候補」を足す。
  - `netlify.toml` に `/admin/freshness` の振り分けを足す（`/admin/candidates` と同じ書き方）。
- **一覧**:
  - main の `data/freshness/candidates.json` を GitHub API で読む（関数に同梱しない）。
  - 題名（記事へのリンク）・スコア・表示回数・理由を出す。
  - 開いている PR の一覧は 1 回だけ取得する。head が `draft/refresh-<slug>` の PR があれば「更新案あり」と出し、レビュー URL を付ける。
- **操作**:
  - 「更新案を作る」: `refreshable` で、更新案がまだ無いときだけ出す。押すと `triggerWorkflow('refresh-article.yml', 'main', { slug })` を呼び、「数分後に Chatwork に届きます」と表示する。
  - 「確認済み（変更なし）」: main の記事の frontmatter に `reviewed_at`（現在時刻、JST）だけを書く。ほかの行・本文・`updated_at` は変えない。更新案の PR が開いているときは 409 で断る。
  - どちらも、`slug` を `^[a-z0-9_-]+$` で検査し、現在の `candidates.json` にある `slug` と `file` の組だけを受け付ける。`putFile` が sha の競合で失敗したら、1 回だけ読み直してやり直す。
- **本番ビルドを走らせない**: 「確認済み」のたびに本番ビルドが走らないよう、`scripts/lib/netlify-ignore.js` を変える。公開中の記事の差分が `reviewed_at` の行だけなら、表示に影響しない変更として扱う。ほかの差分が 1 つでもあれば、今までどおりビルドする。

## R6 差し戻し再生成との整合（`generate-draft.js --regenerate`）

`refresh_of: "published"` の記事が差し戻されたときは、次のようにする。

- テーマ禁止の判定をしない。
- `restoreSourceGuardFields` のあと、元の記事に `source_guard_version` が無かった場合は付けない（足された行を消す）。ほかの出典項目の復元は今のまま。
- `refresh_of` などの印は残す。`rebuildWithBody` は frontmatter を保つので、消えないことをテストで確かめる。

## テスト

新規 `scripts/lib/__tests__/test-freshness-refresh.js` を作り、`package.json` の `masters:test` の連鎖の末尾に登録する。既存の `test-freshness-candidates.js`・`test-netlify-ignore.js`・`test-notify-message.js`・`test-review-page.js` にも追加する。承認経路は `github-api` を差し替えてテストする（新規 `test-review-approve-refresh.js` に分けてもよい。分けた場合も `masters:test` に登録）。LLM の呼び出しはすべて偽物に差し替える。

- **計画**: 理由の組み合わせごとの手順、同じ見出しの重複排除、上限 3 節、検索の理由だけなら空。
- **本文だけの合成**:
  - LLM 側が題名・要約・`updated_at`・出典項目を変えても、元のまま残る。
  - 印 3 つが付く。
  - version が無い記事は無いまま。
- **PR を作らない条件**: 5 種類それぞれ。警告つきで元の本文が返った場合が `no_change` ではなく `failed` になる。
- **`diffSections`**: 変わった節だけが返る、段落の印、導入部の扱い。
- **承認**:
  - 公開日の 3 項目（`publish_at`・`published_at`・`publish_slot`）が変わらない。
  - `updated_at` と `reviewed_at` が付き、印が消える。
  - main が published でなければ 400。
  - version が無い記事でも通る。version があり出典が一致しない記事は 400。
  - 公開枠の関数を呼ばない。
  - マージに失敗したとき、main が published でも `merge_failed` になる。
  - 通常の下書きの承認が今までと同じ（既存の挙動の回帰テスト）。
- **候補**: `reviewed_at` による除外 4 種類、`file` と `refreshable`。
- **管理画面**:
  - 不正な slug と、候補に無い slug を断る。
  - 更新案があるときの「確認済み」が 409。
  - 「確認済み」で `reviewed_at` の行だけが変わる。
- **netlify-ignore**: `reviewed_at` だけの差分 → 飛ばす。`reviewed_at` と本文の差分 → ビルド。下書きの記事 → 今までどおり。
- **レビュー画面**: 更新案のときの表示要素がそろう。通常の下書きの HTML は変わらない。
- **ワークフロー**: `slug` を `env:` 経由で使っていること（YAML の文字列を検査）。

## 変更してはいけないもの

- `content/posts/*.md`（1 ファイルも変えない）。
- 通常の下書きの、生成・差し戻し・承認・見送り・予約公開の挙動。
- `publish-due.js` と、`build.js` の日付の出し方。`updated_at` が公開日と違えば「更新日：」・`dateModified`・sitemap の `lastmod` に出る今の仕組みを、そのまま使う。
- 鮮度の信号の判定・重み・上位件数（R1 の除外を足すだけ）。
- 第 3 段階（年度の一括切り替え）は含めない。

## 元に戻す方法

PR を戻せば元に戻る。記事データの形式は変えないので、`reviewed_at` は使われなくなるだけ。更新案は普通の PR なので、閉じれば公開中の記事には何も起きない。

## 受け入れ確認（Claude が行う）

- 全テスト、`npm run validate`、`npm run build`。
- 差分を読み、承認経路で公開日の 3 項目に触れていないこと、通常経路が変わっていないことを確かめる。
- マージ後、毛利の了承を得て候補 1 件で `refresh-article` を動かし、PR とレビュー画面の「変更箇所」を確かめる（承認するかどうかは毛利が決める）。
