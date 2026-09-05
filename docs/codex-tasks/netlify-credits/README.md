# Netlify クレジット消費の削減（全体計画）

作成: 2026-09-05（設計・文章: Claude ／ 実装: Codex ／ 判断・検収: 毛利）

## 背景

2026-09-04 に Netlify から「月 3,000 クレジットの 50% を消費した」通知が届いた（請求期間 8/26〜9/25）。
10日で半分なので、このままだと 9/14 前後で上限に達する。

Netlify を使っているのは `hp-vlog`（mori-zeirishi.net）の1サイトだけ。クレジットの主な消費源は
ビルド回数で、8/26〜9/5 の10日間を調べた結果は次のとおり。

| ビルドの種類 | 回数 | うち本番の表示を変えないもの |
|---|---|---|
| 本番ビルド（main への push ごと） | 120 | 31（承認マージ 19 ＋ 文書・テスト・ワークフローだけの変更 12） |
| 試しビルド（Deploy Preview: PR ブランチへの push ごと）※上限値 | 177 | 下書き `draft/*` 49 ＋ 文書だけの PR 10 ＋ bot が開く PR 約8 |

つまり約300回のうち約100回（3分の1）は、走っても本番サイトの生成物が直前と同じ。

### なぜ「表示を変えないビルド」が走るのか

記事1本は「下書き作成 → 承認 → 予約公開」で最大4回ビルドされるが、本番の表示が変わるのは予約公開の1回だけ。

1. 日次生成が `draft/日付-slug` ブランチに push して PR を開く → 試しビルド
2. 承認すると同じブランチに frontmatter を書き込む（`review-approve-background.js` の `putFile`）→ 試しビルド
3. 直後に PR を main にマージ（同 `mergePR`、コミット名 `publish: <記事名>`）→ 本番ビルド。
   ところが `scripts/build.js` は `review_status` が `published` の記事しか出力しない（97〜104行）。
   承認直後は `approved` なので、このビルドの生成物は直前と完全に同じ
4. 予約公開ワークフロー（`publish-scheduled.yml`）が期限の来た記事をまとめて `published` に昇格
   （コミット名 `publish: N 件の予約記事を公開`）→ 本番ビルド。**これだけが必要**

レビュー画面 `/review?file=…&ref=<下書きブランチ>` は本番サイトの関数が GitHub から下書きを直接読む。
試しビルドの URL は記事の確認に使われていない。

### Netlify 側でできること・できないこと

- 「新しい push が来たら走行中のビルドを自動で止める」機能は**無い**（公式フォーラムの回答: 2019・2020・2023 年いずれも「無い」、機能要望のまま）。
- 待ち行列に溜まった未着手のビルドは Netlify が「最初と最後だけ残して途中を飛ばす」。ここは既に手当てされている。
- 使えるのは `[build] ignore`。ビルド開始直後（依存パッケージの取得より前）に自作の判定コマンドを走らせ、
  終了コード 0 なら「飛ばす」、それ以外なら「続ける」。
- コミットメッセージに `[skip netlify]` を入れて飛ばす方法もあるが、承認関数と公開ワークフローに手を入れる
  必要があり、下書きの試しビルドや文書だけの push には効かない。判定スクリプト1つで全部を扱う方が安全。

## 方針（Claude の提案。4 は毛利が 2026-09-05 に決定済み）

1. 対処は `[build] ignore` の判定スクリプトで行う。承認・公開の流れ（関数・ワークフロー・`build.js`）は変えない。
2. 判定は「迷ったら必ずビルドする」。誤って飛ばす（記事が出ない）方が、無駄に走るより重い事故。
3. 試しビルドは `draft/*` ブランチだけ止める。
4. 開発 PR（feat/fix/seo）の試しビルドは**残す**（毛利・2026-09-05 決定）。Netlify の Deploy Previews 設定は変えない。

## 段階と順序

| 段階 | 指示書 | 状態 | 内容 |
|---|---|---|---|
| 1 | `01-ignore-builds.md` | 着手可 | 判定スクリプト・`netlify.toml` の1行・テスト |
| 設定 | 本 README「Netlify 画面の設定」 | 完了（2026-09-05 確認済み） | Branch deploys は本番だけ・Deploy Previews は PR 全部。変更不要 |

1つの段階＝1つの PR。

## 全段階に共通の厳守事項

- `content/posts/*.md`（記事本文・frontmatter）は一切変更しない。
- `netlify/functions/*`、`.github/workflows/*`、`scripts/build.js`、`scripts/generate-draft.js`、
  `scripts/publish-due.js` は変更しない。
- 判定スクリプトは **Node.js 18** で動くこと。Netlify の ignore は Node 18 固定で、`package.json` の依存パッケージは
  まだ取得されていない段階で走る。標準モジュールだけを使い、`scripts/lib` の他のモジュールも require しない。
- どんな例外・想定外でも終了コード 1（＝ビルドする）。判定スクリプトが原因でビルドが止まることがあってはならない。
- ログに判定理由を日本語で1行出す。Netlify のデプロイログで「なぜ飛ばした／なぜ続けた」が読めるようにする。
- `npm run build` `npm run validate` と `scripts/lib/__tests__/*.js` が通ること
  （`test-simulator-ui-foundation.js` は既知の失敗）。

## 元に戻す方法

`netlify.toml` の `ignore = …` の1行を消すだけ。Netlify 標準の判定（base directory に変更が無ければ飛ばす）に即座に戻る。
スクリプトとテストは残っていても害はない。

## Netlify 画面の設定（2026-09-05 毛利が確認済み・変更不要）

Project configuration → Build & deploy → Continuous deployment → Branches and deploy contexts

- Production branch: `main`
- Branch deploys: **Deploy only the production branch**（他ブランチへの push で余計なビルドは走らない）
- Deploy Previews: **Any pull request against your production branch / branch deploy branches**
  （PR ごとの試しビルドは有効。`draft/*` は判定スクリプトが止め、開発 PR は残す）

## 既存の記事フローへの影響（2026-09-05 コードで確認済み）

「下書き生成 → Chatwork 通知（確認用 URL 付き）→ 毛利が確認して承認 or 修正依頼 → 承認 → 予約公開」の各手順は、
GitHub 上のファイルを直接読み書きする仕組みで動いていて、Netlify のビルドに依存していない。

| 手順 | 今の動き | 判定を入れた後 | 根拠 |
|---|---|---|---|
| 下書き生成（`daily-draft.yml`） | `draft/…` に push → 試しビルド | 試しビルドを飛ばす（規則 5） | 試しビルドの URL を参照するコードは無い（`deploy-preview` `DEPLOY_PRIME_URL` `netlify.app` の参照ゼロ） |
| Chatwork の確認用 URL | `https://mori-zeirishi.net/review?file=…&ref=draft/…` | 変わらない | URL は本番サイト固定（`daily-draft.yml` 319・341行、`regenerate-draft.yml` 160行）。本番の `review-page` 関数が GitHub API で下書きを読む（`review-page.js` 46行） |
| 確認画面の「プレビューURL」欄 | `preview_url` は生成側が常に空（`generate-draft.js`）→「（未設定）」 | 変わらない | 試しビルドとは無関係 |
| 修正依頼（`review-revise` → `regenerate-draft.yml`） | 同じ `draft/…` に push → 試しビルド → 再通知 | 試しビルドだけ飛ぶ。通知・画面は変わらない | 通知 URL は上と同じ（`review-revise.js` 158〜165行） |
| 承認①（`review-approve-background.js` の `putFile`） | `draft/…` に frontmatter 書き込み → 試しビルド | 飛ばす（規則 5） | — |
| 承認②（同 `mergePR`、squash） | main にマージ → 本番ビルド（生成物は直前と同一） | 飛ばす（規則 9(b)） | main にブランチ保護・ルールセット無し。`waitForMergeable` は `unstable`（チェック失敗中）も許容（`github-api.js` 261行）→ Netlify のチェックが「中止」でもマージは通る |
| 承認の Chatwork 通知 | 関数が直接送る | 変わらない | — |
| 管理画面（記事一覧・非公開化） | GitHub API で main を読む（`admin-list-articles.js` 60行） | 変わらない。非公開化は `published` → 非公開なので規則 9(b) でビルドされる | — |
| 予約公開（`publish-scheduled.yml` 12:00 / 18:00） | GitHub Actions が main を取得 → `published` に昇格 → push → 本番ビルド | **ビルドする**（規則 9(b): 新版が `published`） | 記事が本番に出る唯一のビルド |
| 公開の Chatwork 通知 | push 直後に送る（ビルド完了の 2〜3 分前。今もそう） | 変わらない | — |
| 公開時刻の揺れ | 承認時に `publish_at` へ 0〜50 分のランダムを乗せる（`review-approve-background.js` 47〜57行: morning 11:05〜11:55 / evening 17:05〜17:55）。予約公開は `publish_at` を書き換えず `published_at` `updated_at` だけ現在時刻にする（`publish-due.js` 128〜131行）。表示日時・構造化データは `publish_at`（`build.js` 399〜401行） | 変わらない。判定スクリプトは時刻を決める処理にも予約公開の起動時刻にも関与しない | 揺れているのは表示上の公開時刻。実際にページが見えるのは 12:00 / 18:00 の起動＋ビルド後（2〜3 分）で、2026-06-25 に GitHub Actions の待ち時間を外した時点からの動き。本作業で変わらない |

目に見える変化: 下書き PR の GitHub 画面で Netlify のチェック（`netlify/…/deploy-preview`）が緑ではなく「中止」表示になる。
必須チェックではないので実害なし。

保守上の注意: 規則 9(b) は `scripts/build.js` 97〜104行（`published` だけ出力）と対になっている。
将来 build.js が `approved` の記事も何かに出すよう変わったら、規則 9(b) も見直す。

## 受け入れ確認（Claude が実施）

マージ後 3〜5 日の Netlify デプロイ一覧と GitHub の履歴を突き合わせる。

- Chatwork の確認用 URL（`/review?file=…&ref=draft/…`）が今までどおり開き、承認・修正依頼が動く。
- 承認マージ（`publish: <記事名>`）の本番ビルドが「飛ばした」になっている。
- 予約公開（`publish: N 件の予約記事を公開`）は通常どおりビルドされ、記事が本番に出ている。
- `draft/*` PR の試しビルドが止まっている。feat/fix の試しビルドは動いている。
- 管理画面からの非公開化（unpublish）でビルドが走り、記事が消えている。
- Netlify の「Trigger deploy」（手動デプロイ）が飛ばされずに動く。
- クレジット消費のペース（Team → Usage）が落ちている。ignore で飛ばしたビルドが課金されないことは公式に明記が
  無いので、ここで実測する。

## 参考: コードの入口

| 場所 | 何があるか |
|---|---|
| `netlify.toml` `[build]` | ビルドコマンド。`ignore` はここに足す |
| `scripts/build.js` 97〜104行 | 記事を出力する条件（`review_status === 'published'` かつ `publish_at` が現在以前） |
| `netlify/functions/review-approve-background.js` | 承認時の `putFile`（下書きブランチへ書き込み）→ `mergePR`（main へマージ）。変更しない |
| `netlify/functions/lib/github-api.js` 260〜300行 | `waitForMergeable` / `mergePR`。変更しない |
| `.github/workflows/daily-draft.yml` 197・265・319・341行 | 下書きブランチの命名 `draft/${DATE}-${SLUG}` と確認用 URL |
| `.github/workflows/publish-scheduled.yml` | 予約公開。`content/posts/` だけを1コミットで push |
| `scripts/lib/__tests__/test-performance-basics.js` | テストの書き方の例 |
