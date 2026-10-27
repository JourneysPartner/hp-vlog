# レビュー画面と承認などの処理にパスワードをかける（2026-10-16）

## 背景

- レビュー画面（`/review` → `netlify/functions/review-page.js`）と、承認・差し戻し・見送りの処理（`review-approve-background.js`・`review-revise.js`・`review-skip.js`）に、**認証が無い**。管理画面（`/admin`、`lib/admin-auth.js` の Basic 認証）とは別の扱いになっている。
  - 10/16、ログインせずに本番のレビュー画面を取得できた（HTTP 200、下書きの本文と照合の記録が出る）。
  - 承認は、ファイル名と枝の名前を POST するだけで、PR のマージ（＝公開）まで進む。
  - GitHub のリポジトリは公開設定で、下書きの枝名・ファイル名・関数のコードは誰でも見られる。
- 毛利さんの指示（10/16）:
  - パスワードを必要にする。
  - 最近は AI エージェントを使った攻撃が流行っている。セキュリティを意識し、攻撃のリスクを最小限にする。
  - **毛利さんがレビュー画面に入るまでの操作は「Chatwork のリンクを押す → パスワードを入れる」だけ**にする（手間を増やさない）。

## 方針

1. パスワードだけのログイン画面 → 署名つきのセッション Cookie（短時間・HttpOnly・Secure・SameSite=Lax）。Basic 認証（ID とパスワードの 2 欄）にはしない。
2. レビュー画面と 3 つの処理は、有効なセッションが無ければ何も出さない・何もしない（失敗時は安全側）。
3. 他のサイトからの操作の乗っ取り（CSRF）を、SameSite・送り元の確認・画面ごとの合言葉（トークン）の 3 重で防ぐ。
4. 画面への悪いスクリプトの埋め込み（XSS）を、Content-Security-Policy（CSP）と表示時のエスケープで防ぐ。**AI が書いた本文・題名などを画面に出すので、外から入った文が AI を経由してスクリプトになる経路（プロンプトインジェクション）を想定する。**
5. パスワードの総当たりを、失敗回数の上限で防ぐ（Netlify Blobs に数える）。
6. 承認などの処理はプレビュー（deploy preview・branch deploy）では動かさない。本番のサイトだけで動く。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-review-auth.md` | ログイン・セッション・処理の保護・CSRF・CSP・エスケープ・失敗回数の上限・プレビューでの停止 |

## 全段階共通の厳守事項

- 失敗時は安全側: 設定が無い・短い、Blobs が使えない、Cookie が壊れている、などは全部「入れない・処理しない」。
- パスワード・Cookie・署名の鍵をログ・画面・応答に出さない。
- 依存関係を足さない（`crypto`・`@netlify/blobs` は導入済み）。
- 承認の判定（照合の差し止め・`recommendation`）と、承認・差し戻し・見送りの中身の処理は変えない。入口に認証を足すだけ。
- 管理画面の Basic 認証（`lib/admin-auth.js`）は変えない。
- `data/`・`content/posts/*.md` を触らない。

## 毛利さんにお願いすること（マージの前）

Netlify の管理画面で、環境変数 `REVIEW_PASSWORD` を作る（本番、関数から読めるもの、「秘密」の印をつける）。

- 12 文字以上。推奨は 16 文字以上で、英大文字・小文字・数字・記号を混ぜたもの。ブラウザに保存すれば、入力は最初の 1 回だけ。
- 他のサービスと同じパスワードにしない。
- **これが無いままマージすると、レビュー画面が開けなくなる**（安全側に倒すため）。Claude はマージ前に、設定があることを Netlify で確かめる（値は見ない）。

署名の鍵は、既にある GitHub App の秘密鍵から用途別に作るので、毛利さんの追加の設定は要らない（`01-review-auth.md` R2）。

## 元に戻す方法

この PR を revert すると、今の（認証の無い）状態に戻る。セッション Cookie は残るが、使われないだけで害は無い。

## 受け入れ確認（Claude）

1. 試験（`01-review-auth.md` の試験 1〜15）と、既存のレビュー・承認・差し戻し・見送りの試験が通る。
2. 独立したレビュー（Opus 5.5、xhigh）で、認証の抜け・CSRF・XSS・総当たり・失敗時の扱いを見る（認証・セキュリティの境界の変更のため）。
3. デプロイ後、本番で次を確かめる:
   - ログインせずに `/review?...` を開くとログイン画面だけが出て、下書きの本文が HTML に含まれない。
   - ログインせずに 3 つの処理へ POST すると 401。
   - 間違ったパスワードで 5 回失敗すると、しばらく入れない（本番の上限を毛利さんの IP で踏まないよう、確認はプレビューか試験で行う）。
   - 毛利さんが Chatwork のリンクから「リンク → パスワード」で入れる。
4. プレビューでは承認などのボタンが動かない（403）。

## 【要確認】（今回は直さない）

- 時刻で動く関数（`scheduler-daily-draft`・`scheduler-publish`・`scheduler-publish-evening`・`analytics-cleanup`）を、外から URL で起動できるかどうか。日次生成は同じ日に二重に動かない作りなので、起動できても被害は小さい。Netlify の仕様の裏付けを取ってから判断する。
- リポジトリを非公開にするか（下書き・照合の記録・関数のコードが外から見えなくなる。GitHub Actions の無料枠などへの影響を確かめてから毛利さんが判断）。
- 公開サイトの記事も、AI が書いた本文を HTML のまま出している（`scripts/build.js`）。公開サイトにはログインが無いので被害の形は違うが、同じ CSP・除去を公開サイトにも足すかは別に判断する。

## コードの入口

- `netlify/functions/review-page.js`（画面。`renderReviewPage` の HTML、末尾の `<script>`、`handler`）
- `netlify/functions/review-approve-background.js`（`handler` 305 行付近）・`review-revise.js`・`review-skip.js`
- `netlify/functions/lib/admin-auth.js`（`safeEqual` の書き方の参考）
- `netlify/functions/track-visit.js`（Blobs の開き方 `connectLambda` → `getStore`、試験での差し替え `getStoreFn`）
- `netlify.toml`（`/review` のリダイレクト 119 行付近）
- 既存の試験: `test-review-page.js`・`test-review-page-fact-layout.js`・`test-review-approve-refresh.js`・`test-review-skip-refresh.js`・`test-fact-check.js`・`test-fact-real-run-fixes.js`・`test-fact-review-fixes.js`・`test-fact-review-fixes-2.js`・`test-fact-review-fixes-4.js`・`test-multi-source-frontmatter.js`・`test-visual-review-fixes.js`（ほかにレビューの関数を呼ぶ試験があれば全部）
