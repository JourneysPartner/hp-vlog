# 記事の書き手の AI を Claude Sonnet 5.5 に替える

2026-10-13 毛利指示: 記事を書く AI を `claude-sonnet-4-6` から `claude-sonnet-5-5` に替える。

## 背景（モデル ID を替えるだけでは壊れる理由）

本文生成・差し戻し再生成・題名の再生成などは `scripts/lib/content-model.js`（`generateContent` / `generateSimple`）を通り、
モデルは GitHub のリポジトリ変数 `CONTENT_MODEL`（現在 `claude-sonnet-4-6`）で決まる。
変数だけ `claude-sonnet-5-5` に替えると、次の 3 つで記事が途中で切れる・空になる。

1. **考える工程が既定で入る。** Sonnet 4.6 は `thinking` を送らなければ考えずに書いた。Sonnet 5.5 は送らないと
   adaptive thinking（既定 effort `high`）が動き、その分も `max_tokens` を食う。本文の `max_tokens` は
   「受入上限の文字数ぎりぎり」に絞ってあり（`article-prompt-static.js` の `maxTokensFor`）、題名の再生成などは
   200〜600 トークンしかないので、考える分で本文が切れる・何も返らない。
   Sonnet 5.5 は `thinking: {type: "disabled"}` を 400 で断る。考える工程を外すには
   `thinking: {type: "between_tools"}`（Sonnet 5.5 だけが受け付ける。effort は `high` 以下）を送る。
   **他のモデル（Sonnet 4.6・照合で使う Opus 5.5 など）に送ると 400** なので、`claude-sonnet-5-5` のときだけ送る。
2. **文字の数え方（トークナイザ）が変わる。** 同じ文章が約 3 割多いトークンになる。`maxTokensFor` の
   `TOKENS_PER_CHAR = 0.8739` は 2026-08-15 に Sonnet 4.6 で測った値なので、そのままだと上限の 7 割台で切れる。
3. **断り（`stop_reason: "refusal"`）がある。** HTTP 200 で本文が空・途中のまま返る。今のコードは
   HTTP エラーなら OpenAI（gpt-5.4）に切り替えるが、200 の断りは素通りして空の記事になる。

ほかの移行の注意点は今のコードに当たらない（`temperature` 等・prefill・`budget_tokens`・tool_choice は送っていない）。
料金は Sonnet 4.6 の $3/$15 → $2/$10（100 万トークンあたり）。トークンが約 3 割増えるので実質は同じか少し安い。

## 方針

- Sonnet 4.6 と同じく「考えずに書く」で揃える（`between_tools`、effort `high`）。考える工程を入れるかは
  品質と費用を測ってから別に決める（今回は範囲外）。
- 文字→トークンの比はモデル別にする。Sonnet 5.5 は**仮置き**（4.6 の 1.3 倍）で始め、初回の実行記録
  （`[content-model] … usage(out=N)` と本文の文字数）から測り直して、別のコミットで実測値に置き換える。
- 断りは「Anthropic の失敗」として扱い、今ある OpenAI への切り替えに乗せる。
- `CONTENT_MODEL` 変数の切り替えは、この変更が main に入った後に Claude が行う（この作業では触らない）。

## 段階

| 段階 | 内容 | 指示書 |
|---|---|---|
| 1 | モデル別の送り方・出力上限・断りの扱い・既定モデルの更新 | `01-switch.md` |

## 元に戻す方法

リポジトリ変数 `CONTENT_MODEL` を `claude-sonnet-4-6` に戻す。4.6 のときは送り方も比も今と同じになるよう作るので、
コードを戻さなくても以前の動きに戻る。

## 受け入れ確認（Claude）

- 変更ファイルが指示書の範囲だけであること（`git status`）。
- `claude-sonnet-5-5` のときだけ `thinking: {type: "between_tools"}` と `output_config: {effort: "high"}` が付き、
  `claude-sonnet-4-6` と `claude-opus-5-5` では付かないこと（本文生成・`generateSimple` の両方）。
- `maxTokensFor` が、モデル未指定かつ環境変数なしのとき今と同じ値を返すこと。
- 全テスト（`%TEMP%\hpstatus\run-all-tests.ps1`）。main の既存の失敗 4 本以外が通ること。
- main に入れた後、`CONTENT_MODEL` を替えて実際の生成 1 回で、切れずに書けること・比の実測。

## コードの入口

- `scripts/lib/content-model.js` … `callAnthropic`・`generateSimple`・`callOpenAI`・`ANTHROPIC_DEFAULT_MODEL`
- `scripts/lib/article-prompt-builder.js` … `toAnthropicRequest`
- `scripts/lib/article-prompt-static.js` … `TOKENS_PER_CHAR`・`FRONTMATTER_TOKENS`・`maxTokensFor`
- `scripts/generate-draft.js` … `stopReason` を読んで「末尾途切れの疑い」を出す（1870 行付近。**今は Anthropic が
  `stopReason` を返していないので、この判定の①は効いていない**）
