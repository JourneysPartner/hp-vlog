# 実装指示書: Netlify ビルドの要否判定（段階1）【着手可】

作成: 2026-09-05（設計: Claude ／ 実装: Codex）
前提: `README.md` の共通厳守事項。

## 背景と目的

本番の表示を変えない push で走っているビルド（本番 31/120、試し 約67/177）を、ビルド開始直後に判定して飛ばす。
仕組みは Netlify の `[build] ignore`（終了コード 0 で飛ばす、それ以外で続ける）。
判定は「迷ったら必ずビルドする」。誤って飛ばす方が重い事故。

## 変更してはいけないもの（厳守）

`README.md` に同じ。特に `netlify/functions/*`、`.github/workflows/*`、`scripts/build.js`、`content/posts/*.md` は触らない。

## 実装要件

### R1. 判定ロジック `scripts/lib/netlify-ignore.js`

テストしやすいよう、外部との接点をすべて引数で受け取る純粋な関数にする。

```
decide({ env, git }) → { skip: boolean, reason: string }
```

- `env`: `process.env` 相当。使うのは `COMMIT_REF` `CACHED_COMMIT_REF` `CONTEXT` `HEAD` `BRANCH`
  `INCOMING_HOOK_URL` `INCOMING_HOOK_TITLE`。
- `git`: 差し替え可能な薄い包み。
  - `changedFiles(base, head)` → 変更ファイルのパス配列（`git diff --name-only --no-renames base head` 相当。
    名前変更は「削除＋追加」として両方のパスが出ること）
  - `show(ref, path)` → その版のファイル内容。無ければ `null`
  - `hasCommit(sha)` → ローカルにそのコミットがあるか
  - `fetchCommit(sha)` → 取得を1回試みて成否を返す

判定は上から順に見て、最初に当たった規則を採用する。

| # | 条件 | 結果 | 理由文（ログに出す） |
|---|---|---|---|
| 1 | `COMMIT_REF` または `CACHED_COMMIT_REF` が無い | ビルド | 比較対象のコミットが無い |
| 2 | `COMMIT_REF === CACHED_COMMIT_REF` | ビルド | キャッシュ無し・手動デプロイ・初回のため常にビルド |
| 3 | `INCOMING_HOOK_URL` か `INCOMING_HOOK_TITLE` がある | ビルド | ビルドフック経由 |
| 4 | `CONTEXT` が `production` `deploy-preview` `branch-deploy` のどれでもない | ビルド | 想定外の文脈 |
| 5 | `CONTEXT` が `deploy-preview` か `branch-deploy` で、ブランチ名（`HEAD`、無ければ `BRANCH`）が `draft/` で始まる | **飛ばす** | 下書きブランチの試しビルドは使われない |
| 6 | `CACHED_COMMIT_REF` がローカルに無く、`fetchCommit` でも取れない | ビルド | 比較対象のコミットを取得できない |
| 7 | `changedFiles` が例外 | ビルド | 差分の取得に失敗 |
| 8 | 変更ファイルが 0 件 | **飛ばす** | 変更なし（Netlify 標準と同じ） |
| 9 | 変更ファイルの**すべて**が下の (a) か (b) に当てはまる | **飛ばす** | 変更はすべて表示に影響しない（件数と代表例を添える） |
| 10 | それ以外 | ビルド | 表示に影響する変更あり（当てはまらなかったファイル名を先頭3件まで添える） |

規則 2 の補足: Netlify は「キャッシュ無し」「Trigger deploy（手動）」「初回」のとき両者を同じ値にする。
ここを飛ばすと手動デプロイが効かなくなる既知の落とし穴があるので、必ずビルドする。

規則 9 の (a)(b):

- (a) 表示に影響しない場所。パスが次のいずれかで始まる、または一致する。
  `docs/` `.github/` `scripts/lib/__tests__/` `.claude/` `.codex/`、および ルート直下の `README.md` `CLAUDE.md` `AGENTS.md`。
  （`docs/` などは `publish = "."` の都合で静的ファイルとして配信はされるが、サイト内から参照されない内部文書。
  「影響しない」と扱う）
- (b) `content/posts/` 配下の `.md` で、**新旧どちらの版でも** `review_status` が `published` でない。
  - 新版（`COMMIT_REF`）で `published` → 影響あり（公開）
  - 旧版（`CACHED_COMMIT_REF`）で `published` → 影響あり（非公開化・本文修正・削除を含む）
  - 旧版に無い（新規追加）→ 新版だけで判定
  - 新版に無い（削除）→ 旧版だけで判定
  - `review_status` が読めない（frontmatter が無い・壊れている・値が空）→ 影響あり（安全側）
  - 読み方: ファイル先頭の `---` 行から次の `---` 行までのブロック内にある `review_status:` 行。
    値の前後の引用符（`"` `'`）と空白は外す。`scripts/build.js` 97〜104行の判定と同じ意味になること。
    frontmatter の解析に外部パッケージや `scripts/lib` の他モジュールを使わない（ignore 実行時は依存が未取得）。

規則 9 に当てはまらないパス（`templates/` `assets/` `scripts/`（テスト以外）`netlify/` `data/` `content/`（posts 以外）
`package.json` `netlify.toml` `.gitignore` など）はすべて「影響あり」。迷う場所を新たに (a) に足さない。

### R2. 入口 `scripts/netlify-ignore-build.js`

- `child_process.execFileSync('git', [...])` で R1 の `git` 包みを実装し、`decide` を呼ぶ。
- `fetchCommit(sha)`: `git fetch --quiet --no-tags origin <sha>` を1回だけ試す。失敗は `false`。
- 出力は1行: `[netlify-ignore] 飛ばす: <理由>` または `[netlify-ignore] ビルド: <理由>`。
- `process.exitCode = skip ? 0 : 1`。
- 全体を try/catch で包む。例外時は `[netlify-ignore] ビルド: 判定中に例外 (<message>)` を出して exitCode 1。
- Node 18 で動く書き方にする（CommonJS、標準モジュールのみ。`fetch`・依存パッケージ・`scripts/lib` の他モジュールは使わない）。

### R3. `netlify.toml`

`[build]` に次を足す。日本語のコメントで「何を飛ばすか（下書きの試しビルド・表示に影響しない変更）」と
「元に戻すにはこの1行を消す」を書く。

```toml
  ignore = "node scripts/netlify-ignore-build.js"
```

### R4. テスト `scripts/lib/__tests__/test-netlify-ignore.js`

既存テスト（例: `test-performance-basics.js`）の書き方に合わせる。`git` 包みを偽物に差し替えて `decide` を検証する。

1. `COMMIT_REF` 無し → ビルド
2. 同一 SHA → ビルド
3. ビルドフック（`INCOMING_HOOK_URL`）→ ビルド
4. `CONTEXT=dev` → ビルド
5. `deploy-preview` × `HEAD=draft/2026-09-05-xxx` → 飛ばす（`changedFiles` を呼ばずに決まること）
6. `branch-deploy` × `HEAD=draft/...` → 飛ばす
7. `production` × `HEAD=main`、変更が `docs/` と `.github/` と `README.md` だけ → 飛ばす
8. 記事 `approved` → `approved`（本文だけ変更）→ 飛ばす
9. 記事 新規追加で `draft` → 飛ばす
10. 記事 `approved` → `published` → ビルド（理由にファイル名）
11. 記事 `published` → `unpublished` → ビルド
12. 記事 `published` の削除 → ビルド
13. 記事 `approved` → `approved` ＋ `templates/blog-post.html` 変更 → ビルド（理由に `templates/...`）
14. `review_status` の値が `"approved"`（引用符あり）→ `approved` と同じ扱い
15. frontmatter が読めない記事 → ビルド
16. `CACHED_COMMIT_REF` がローカルに無く `fetchCommit` も失敗 → ビルド
17. `changedFiles` が例外 → ビルド
18. 変更 0 件 → 飛ばす
19. `data/hub-config.json` だけの変更 → ビルド（(a) に無い場所は影響あり）

加えて、本物の git を使う確認を 2 件: 一時ディレクトリに `git init` し、記事ファイルを `approved` で追加 → `published` に
変更の 2 コミットを作り、R2 の包みを通した `decide` が「1つ目=飛ばす、2つ目=ビルド」になること。

### R5. 動作確認の記録

PR 本文に次を書く。

- テスト結果（PASS/FAIL の件数、失敗があればその名前）
- `node scripts/netlify-ignore-build.js` をローカルで環境変数を与えて実行した出力例（飛ばす・ビルド 各1行）
- R 番号ごとに「何をどのファイルでやったか」を1行ずつ

## 受け入れ確認（Claude が実施）

`README.md` の「受け入れ確認」のとおり。

## 参考: コードの入口

| 場所 | 何があるか |
|---|---|
| `netlify.toml` `[build]` | `command` `publish` `functions` の並び。`ignore` はここに足す |
| `scripts/build.js` 97〜104行 | 記事を出力する条件。(b) の判定はこれと同じ意味にする |
| `netlify/functions/review-approve-background.js` | 承認時の流れ（読むだけ。変更しない） |
| `.github/workflows/daily-draft.yml` 197・265行 | 下書きブランチの命名 |
| `scripts/lib/__tests__/test-performance-basics.js` | テストの書き方の例 |
