# お問い合わせページの LINE 相談をつなぐ（contact-line）

## 背景（2026-10-27）

お問い合わせページ（`templates/pages/contact.html`）の左下の緑の枠「LINEでのご相談も受付中」は、
ボタン「LINEで相談する」のリンク先が `href="#"` のままで、押しても LINE は開かない。
事務所の LINE 公式アカウントは開設済みで、友だち追加の URL は次のとおり（毛利さんから受領）。

    https://lin.ee/u1IDDuS

毛利さんの要望は次の 3 点。

1. お客様が LINE 相談を選んだら、事務所の公式 LINE を友だち追加でき、メッセージを受け取れるようにする。
2. 緑の枠のどこにカーソルを当ててもクリックできるようにする（ボタンの上だけでなく枠全体）。
3. LINE のボタンが押された回数を数え、管理画面のアクセス解析で見られるようにする。

LINE 側の設定（チャットを受け付ける・新着の通知）は毛利さんが済ませた。

## 方針

1. 緑の枠全体を 1 つのリンク（`<a>`）にする。中の「LINEで相談する」はリンクの中の飾り（`<span>`）にする
   （リンクの中にリンクは置けないため）。ホバーで枠を少し浮かせ、キーボードで選んだときは枠に輪郭を出す。
2. リンクは LINE の公式の「友だち追加ボタン」のコードと同じく、同じタブで開く（`target` を付けない）。
   スマホでは LINE アプリの友だち追加画面、パソコンでは QR コードの画面が出る。
3. 押された回数は、既存の自前アクセス解析（`/track` のビーコン）に「LINE が押された」という種類の送信を足して数える。
   閲覧数（PV）・訪問者数（UU）には混ぜない。
4. 問い合わせページの前に見ていたページ（既存の `mz_contact_from`）が分かる場合は、それも記録する。
   管理画面に「LINE 相談につながったページ」として出す（既存の「問い合わせにつながったページ」「送信完了につながったページ」と同じ形）。

## 段階

| 段階 | 指示書 | 内容 |
|---|---|---|
| 01 | `01-line-link-and-count.md` | 上の 1〜4 すべて（1 PR） |

## 全段階共通の厳守事項

- `/track` は誰でも送れる公開の受け口。**許可リスト方式を崩さない**。新しく受け付けるのは `e` が文字列 `"line"` の場合だけ。
  それ以外の `e`、知らないキー、大きすぎる本文は今までどおり捨てる。Origin・sec-fetch-site・ボット判定・1 分あたりの重複除外はそのまま。
- 既存の送信（`{p}`、`{p, r}`）の扱いは 1 文字も変えない（数え方・保存先・戻り値の意味）。
- LINE の送信では閲覧数（`daily/`）・訪問者（`uniq/`）・問い合わせ遷移（`transitions/`）・送信完了（`submissions/`）を増やさない。
- 計測の失敗で公開ページの表示やリンクの移動を止めない（クリックの既定動作を `preventDefault` しない）。
- 記事本文（`content/`）、他のテンプレート、`/tools/*` は変えない。
- 鍵の形の文字列をリポジトリに置かない（試験の偽の値も。`publish = "."` のため Netlify の秘密情報検出でビルドが止まる）。

## 元に戻す方法

この PR を revert する。Netlify Blobs に保存された `line/<日付>` は残るが、revert 後は誰も読まなくなるだけで害はない。

## 受け入れ確認（Claude）

- 01 の試験項目がすべて通る。`npm run build`・`npm run validate`・関係する試験が通る。
- `git status` で指示書に無いファイルが変わっていない。
- 作ったページをブラウザで開き、枠のどこでも指のカーソルになりクリックで `https://lin.ee/u1IDDuS` に移ること、
  Tab キーで選ぶと枠に輪郭が出ることを確かめる。
- マージ・本番反映の後、毛利さんがスマホで「お問い合わせ → 緑の枠」を押し、LINE の友だち追加画面が開くこと、
  その後に管理画面のアクセス解析で LINE の回数が 1 増えていることを確かめる（反映まで 1 分ほどかかることがある）。

## コードの入口

- `templates/pages/contact.html`（`<!-- LINE -->` の枠）
- `assets/css/style.css`（`.line-cta-box`・`.btn-line`、1384 行付近）
- `scripts/build.js`（`ANALYTICS_BEACON`）
- `netlify/functions/lib/analytics-store.js`（`parseBeaconPayload`・`incrementFrom`・`transitionKey`・`submissionKey`）
- `netlify/functions/track-visit.js`
- `netlify/functions/admin-list-analytics.js`、`netlify/functions/admin-analytics-page.js`
- 試験: `scripts/lib/__tests__/test-analytics-store.js`、`test-track-visit.js`、`test-contact-transition.js`
