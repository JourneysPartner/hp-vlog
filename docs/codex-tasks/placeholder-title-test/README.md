# 前から落ちている試験 test-placeholder-title.js を直す（placeholder-title-test）

2026-11-10 利用者依頼「前から落ちている試験 test-placeholder-title.js を直す」。

## 何が起きているか

`scripts/lib/__tests__/test-placeholder-title.js` の「4. 承認・公開で止まる」の最後の確かめ「判定スコアの有無に関係なく先に止める」が、main（3dbcd179）で落ちる（28 通過・1 失敗）。

- この確かめは、承認の関数 `netlify/functions/review-approve-background.js` の**ファイル全体**で、`isPlaceholderTitle(fmTitle)` が最初に出る位置が、`if (recommendation) {` が最初に出る位置より前かを、文字の位置で比べている。
- 2026-11-09 の #759（公開中の記事の手直し PR の承認、commit ba4e316b）で、手直しの承認 `handleManualEditApproval` に品質ゲートの `if (recommendation) {`（608 行）が増えた。これがファイルで最初の `if (recommendation) {` になった。そのため、本番の承認 `handler` の仮置きタイトルの確かめ（967 行）と、別の関数の行を比べて落ちている。
- **動きの不具合ではない**。承認の 3 つの道は、どれも仮置きタイトルを品質ゲート（`recommendation` の確かめ）より前に止めている。

| 承認の道 | 関数 | 仮置きタイトルの確かめ | 品質ゲート |
|---|---|---|---|
| 更新案の承認 | `refreshQualityFailure` | 97 行 `isPlaceholderTitle(meta.title)` | 101 行 `if (meta.recommendation) {` |
| 手直し PR の承認 | `handleManualEditApproval` | 597 行 `isPlaceholderTitle(branchMeta.title)` | 608 行 `if (recommendation) {` |
| 下書きの承認 | `handler` | 967 行 `isPlaceholderTitle(fmTitle)` | 982 行 `if (recommendation) {` |

- 動きの試験は別にある（`test-fact-check-override.js` の S3 は下書きと更新案、`test-manual-edit-review.js` 892 行は手直し PR で、仮置きタイトルなら承認しないことを確かめている）。この確かめが守るのは、「`recommendation` が無い記事でも止まる（仮置きの確かめが品質ゲートの中に入っていない）」こと。

## 方針

試験だけを直す。承認の関数は変えない。

- 比べる範囲を**関数ごと**にする。上の 3 つの道それぞれで、その関数の中だけを切り出し、仮置きタイトルの確かめが、その関数の品質ゲートより前にあることを確かめる。
- 3 つの道を 1 つずつ別の確かめにする（名前に道の名前を入れ、落ちたときにどの道か分かるようにする）。
- 確かめる文字列が見つからない（関数の名前や書き方が変わった）ときは、通さずに落とす（位置が -1 のまま比べて通らないようにする）。

## 段階

| 段 | 内容 | 状態 |
|---|---|---|
| 01（このファイルの「要件」） | 試験の確かめを関数ごとにする | 指示書（2026-11-10） |

## 要件

- **P1** 「4. 承認・公開で止まる」の最後の確かめ（`approve.indexOf('isPlaceholderTitle(fmTitle)') < approve.indexOf('if (recommendation) {')`）を、次の 3 つの確かめに置き換える。
  - 更新案の承認: `function refreshQualityFailure(` から次の関数の始まりまでの中で、`isPlaceholderTitle(meta.title)` が `if (meta.recommendation) {` より前。
  - 手直し PR の承認: `async function handleManualEditApproval(` から次の関数の始まりまでの中で、`isPlaceholderTitle(branchMeta.title)` が `if (recommendation) {` より前。
  - 下書きの承認: `async function handler(` から次の関数の始まり（無ければファイルの終わり）までの中で、`isPlaceholderTitle(fmTitle)` が `if (recommendation) {` より前。
- **P2** 「次の関数の始まり」は、行の頭の `function `・`async function `・`exports.` のどれか（その関数の始まりより後で最初のもの）とする。小さな関数（例: `functionBody(src, header)`）を試験の中に書いてよい。
- **P3** 3 つとも、関数の始まり・仮置きの確かめ・品質ゲートの 3 つの文字列が見つかること（位置が 0 以上）も確かめる。見つからなければ落とす。
- **P4** その上の確かめ「承認ゲートが仮置きを見ている」（`/isPlaceholderTitle\(fmTitle\)/.test(approve)`）はそのまま残す。
- **P5** ファイルの頭の注記の「検証」の 3. に、3 つの道を関数ごとに確かめること、と 1 行足してよい。

## 試験（受け入れ）

- `test-placeholder-title.js` が全部通る（今の 28 通過＋置き換えた確かめ。失敗 0）。
- 落ちることの確かめ（司令役が行う）: 承認の関数の写しで、どれか 1 つの道の仮置きの確かめを品質ゲートの後ろへ動かすと、その道の確かめだけが落ちる。
- 関係する試験も通る: `test-manual-edit-review.js`、`test-fact-check-override.js`、`test-review-approve-refresh.js`。

## 変えてよいファイル

- `scripts/lib/__tests__/test-placeholder-title.js` だけ。

## 変えてはいけないもの

- `netlify/functions/review-approve-background.js`、`scripts/lib/draft-normalizer.js`、`scripts/validate.js` ほか、このファイルの外の全部。
- このファイルの 1〜3 と 5 の確かめ、4 のほかの確かめ。

## 元に戻す方法

- PR を戻す（試験のファイル 1 本だけの変更）。
