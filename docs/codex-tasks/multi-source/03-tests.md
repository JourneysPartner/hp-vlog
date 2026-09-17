# 03 — テスト

既存のテストは `scripts/lib/__tests__/` に125本あり、`assert` を自前で数えて最後に `PASS / FAIL` を出す素の Node スクリプト。新しいテストも**同じ形に揃える**こと。フレームワークは足さない。

参考にする既存テスト:

- `scripts/lib/__tests__/test-llm-auto-trust.js` — 承認ガードの確信度判定（今回いちばん近い）
- `scripts/lib/__tests__/test-law-changes-injection.js` — 注入条件

## A. 新規テスト `test-topic-sources.js`

論点ごとの選定ロジック（`scripts/lib/topic-sources.js`）。**LLM は呼ばない。** `resolveSource` を偽の関数として注入する。

### A-1. 論点を絞る

- `narrowTopicToTerm` が `tax_terms` / `pain_point` / `title` を論点語にすること
- `search_intent` / `reader_problem` / `primary_question` / `subcluster` が空になること
- `tax_domain` と `customer_segment` は**残る**こと（候補プールの決定に要る）
- **元の `topic` オブジェクトが書き換わっていないこと**（破壊的変更をしていない）

### A-2. 論点ごとの選定

- 論点4語を渡すと4回 `resolveSource` が呼ばれること
- 1論点が `null` を返しても、残り3論点の結果が返ること
- 1論点が例外を投げても、残りの結果が返ること（全体が落ちない）
- 同じ URL が2論点から返ったとき、確信度の高いほうだけが残ること
- 結果が確信度の降順に並ぶこと

### A-3. 正本と補助の切り分け

- 最も確信度の高いものが `primary` になること
- 同点なら渡した論点語の順で先のものが `primary` になること
- `supplements` が**最大3件**に切られること（論点が5つ以上あっても4件目以降は落ちる）
- 結果が空配列なら `primary` が `null` になること

## B. 新規テスト `test-multi-source-guard.js`

承認ガード（`source-alignment.js`）。

### B-1. 既存の挙動が変わらないこと（回帰）

**このテストが最重要。**

- 補助出典が無く、正本が確信度0.98・カタログ収録 → 通る（今までどおり）
- 補助出典が無く、正本が確信度0.62 → 要修正（今までどおり）
- 補助出典が無く、正本がカタログ未収録 → 要修正（今までどおり）
- `LLM_AUTO_MIN_CONFIDENCE` が **0.9 のままである**こと（定数を直接読んで確認する）

### B-2. 補助出典は承認をブロックしない

- 正本0.97 ＋ 補助出典に0.62が混ざる → **通る**（ブロックしない）
- 上記で注意書きが出ること、かつ**その文言に弱い論点の語が入っている**こと
- 正本0.62 ＋ 補助出典が全て0.95 → **要修正**（補助が良くても正本が弱ければ止まる）

### B-3. 補助出典があっても正本の判定規則は同じ

- 正本がカタログ未収録 → 補助出典の有無に関わらず要修正

## C. 新規テスト `test-multi-source-frontmatter.js`

frontmatter の書き出しと、再生成での保全。

### C-1. 書き出し（`draft-normalizer.js`）

- 補助出典2件を渡すと `source_2_*` と `source_3_*` が出ること
- **`source_4_*` の行が出ないこと**（使わない枠は書かない）
- 補助出典が0件なら `source_2_*` が1行も出ないこと
- 論点語が無い経路では `source_term: ""` になること
- 出力が **gray-matter で解析できる**こと（`matter(out).data` が投げない）
- 出力の全行が `^[a-zA-Z_0-9]+:` で始まること（**ネストした行が無い**こと。素朴な解析器6つが読めるための条件）
- タイトルに `"` を含む出典を渡しても壊れないこと

### C-2. 素朴な解析器で読めること

`netlify/functions/review-page.js:35` と同じ正規表現をテスト内に写して、`source_2_url` が正しく読めることを確認する。

```js
const m = line.match(/^(\w[\w_]*):\s*"?([^"]*)"?\s*$/);
```

### C-3. 再生成で消えないこと（`source-guard.js`）

- `restoreMissingSystemFields` — 再生成後に `source_2_url` が欠けていたら、元記事から復元されること
- `restoreSourceGuardFields` — 元記事に `source_2_*` が**無い**とき、空文字のキーを**作らないこと**（既存265本を再生成しても空行が生えない）
- 復元後の出力が gray-matter で解析できること

## D. ビルド結果が変わらないことの確認（手で実施）

**自動テストではなく、実際にビルドして差分を取る。** これをやらずに完了としないこと。

`scripts/build.js` はリポジトリ直下に**その場で**書き出す（`blog/` 配下、`sitemap.xml` など。`BLOG_OUT = path.join(ROOT, 'blog')`）。生成物はリポジトリに入っているので、`git diff` がそのまま差分になる。

```bash
# 作業前の状態がきれいであることを確認（build 済みの差分が残っていないこと）
git status --short

npm run build
git status --short blog/
git diff --stat blog/
```

期待する結果:

- **`blog/` 配下に差分が1件も出ないこと。** 既存265本はすべて補助出典を持たないので、HTML は1バイトも変わらないはず
- 差分が出た場合は `02-guard-and-render.md` の B-3 を読み直して直すこと。「`<p class="blog-source">` の中の改行・空白が変わった」程度でも直すこと（差分ゼロが条件）
- ビルドで生じた差分は**コミットしない**。確認が済んだら `git checkout -- blog/` で戻す

## E. 既存テストの回帰

次を実行して、すべて通ることを確認する。

```bash
node scripts/lib/__tests__/test-llm-auto-trust.js
node scripts/lib/__tests__/test-law-changes-injection.js
node scripts/lib/__tests__/test-generate-draft-output-normalization.js
node scripts/lib/__tests__/test-demand-driven-selection.js
node scripts/validate.js
npm run build
```

`scripts/lib/__tests__/` に出典・frontmatter に関係する他のテストがあれば、それも実行すること（`grep -l "source_url\|source_confidence\|frontmatter" scripts/lib/__tests__/*.js` で探せる）。

## F. 実測の報告

実装後、次を数えて報告すること。

```bash
grep -c "^source_2_url:" content/posts/*.md | grep -v ":0" | wc -l
```

既存記事は0件のはず（マイグレーションしていないため）。0件でないなら、既存記事を書き換えてしまっている。
