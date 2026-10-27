あなたの前回の報告の【要確認・重要】は正しかったので、直してください（G4）。

## G4（本番で誰もログインできない）

- Claude が `node_modules/@netlify/blobs/dist/main.cjs`（10.7.9）で確かめた事実: `connectLambda`（72 行付近）が作る接続は `edgeURL`・`siteID`・`token`・`deployID` だけで、`uncachedEdgeURL` を入れない。`consistency: 'strong'` の読み込みは `uncachedEdgeURL` が無いと `BlobsConsistencyError` を投げる（256 行付近）。**今の作り（`getStore({ name: 'review-auth', consistency: 'strong', … })`）は、本番では読み込みのたびに例外 → ログインが毎回 503 になる。**
- 直し方: `review-auth` のストアを普通の読み方（`consistency` を指定しない＝eventual）にする。
  - 守りは条件付きの書き込み（`if-match`・`if-none-match: *`）で保つ。古い記録を読んだ要求は、書き込みが 412 になり、今どおり照合せずに 429（競合の文言「もう一度お試しください」）。
  - 古い記録で「止められていない」と読めても、書き込みが 412 で通らないので照合に進まない。この順番（書き込みが通ってから照合）を変えない。
  - 成功時の IP の記録の削除は今のまま。
- 試験:
  - 前回足した「`uncachedEdgeURL` が無いと 503」の試験を、**`connectLambda` と同じ形の接続情報（`uncachedEdgeURL` 無し）でログインが成功し、誤ったパスワードは 401 になる**試験に置き換える（本物のライブラリ＋偽の `fetch`）。読み込みが `edgeURL` 側へ行くことも確かめる。
  - 古い記録（偽の `fetch` の読み込みが 1 つ前の etag と中身を返す）→ 書き込みが 412 → 429・照合 0 回。
  - 古い記録が「止められていない」中身でも、照合 0 回で 429。
  - 同時 200 件（同じ IP・ばらばらの IP）で照合の回数の上限（5 以下・30 以下）が保たれる。
- `getStore` の引数の期待（`consistency: 'strong'`）を変える試験は、理由を報告する。

前回と同じ条件で作業してください（ブランチ `fix/review-auth` のまま、コミットしない、ネットワーク不可、依存関係を足さない、01〜01c の期待を緩めない）。終わったら次を実行して、結果を日本語で短く報告してください。

```
node scripts/lib/__tests__/test-review-auth.js
node scripts/lib/__tests__/test-review-page.js
node scripts/lib/__tests__/test-review-page-fact-layout.js
node scripts/lib/__tests__/test-review-approve-refresh.js
node scripts/lib/__tests__/test-review-skip-refresh.js
git status --short
git diff --stat
```
