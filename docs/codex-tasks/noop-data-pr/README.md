# 中身が変わっていないデータ更新で PR を立てない

## 何が起きているか

データ更新のワークフローが、**中身が1文字も変わっていないのに毎回 PR を立てている**。

2026-09-14 に溜まっていた自動生成 PR の中身を確認したところ、8本中**7本が実質差分0行**だった。

| PR | 中身 |
|---|---|
| #589 通達カタログ | `fetched_at` だけ |
| #592 国税庁Q&A | `fetched_at` だけ |
| #582 / #515 問い合わせ遷移 | `updated_at` だけ |
| #533 国税庁ソースDB | `fetched_at`・`last_crawl_*` だけ |
| #570 税制改正の大綱 | `checked_at` だけ |

原因は変更判定。たとえば `crawl-nta-sources.yml`:

```bash
if git diff --quiet data/nta-sources/ 2>/dev/null; then
```

`meta.json` の `last_crawl_started_at` は**実行のたびに必ず変わる**ので、この判定は常に
「変更あり」になる。他のワークフローも同じ書き方をしている。

## なぜ困るか

- 中身の無い PR が毎月・毎週積み上がり、**本当に変更があった回が埋もれる**
- 承認は人の手でやる運用なので、確認のコストがそのまま無駄になる
- Netlify のデプロイプレビューが PR ごとに走り、クレジットを消費する

## やること

変更判定から**時刻だけの差分を除く**。中身が変わっていなければ PR を立てず、
実行ログに「変更なし」と残す。

詳細は [01-detect.md](01-detect.md)、テストは [02-tests.md](02-tests.md)。

## 対象のワークフロー

| ファイル | データ | 時刻のフィールド |
|---|---|---|
| `crawl-nta-sources.yml` | `data/nta-sources/` | `fetched_at` `generated_at` `last_crawl_started_at` `last_crawl_finished_at` `last_crawl_duration_seconds` `next_scheduled_at` `last_checked_at` `figures_checked_at` |
| `crawl-nta-tsutatsu.yml` | `data/nta-tsutatsu/` | `fetched_at` |
| `refresh-nta-qa.yml` | `data/nta-qa/` | `fetched_at` `generated_at` |
| `crawl-law-sources.yml` | `data/law-sources/` | `fetched_at` `generated_at` |
| `export-contact-transitions.yml` | `data/contact-transitions.json` | `updated_at` |
| `update-suggest-topics.yml` | `data/search-suggest-topics.json` | `updated_at` |
| `check-tax-reform.yml` | `data/tax-reform-outline.json` | `checked_at` |

## やってはいけないこと

- **時刻の更新そのものを止めない。** いつ取得したかの記録は必要。
  止めるのは「時刻しか変わっていないときに PR を立てること」だけ
- 記事の生成・承認・公開のワークフロー（`daily-draft` `publish-scheduled` `regenerate-draft`）に触らない
- データの中身を書き換えない
