# 01 差し戻しの指摘を分けて全部直す・作業の説明を本文に残さない・古い下書きの再生成

README の背景を先に読むこと。試験データは `fixtures/`:

- `644-before.md` … #644 の 1 回目の差し戻し前の記事（a094e03d）
- `644-comment-1.txt` … 1 回目の差し戻しコメント（3 点の番号付き）
- `644-after-run-40484642578.md` … 1 回目の再生成の結果。108 行目に LLM が書き足した「※差し戻しコメントの2・3は、この対象セクション内に該当する回答文・節が含まれていないため、変更していません。」がある

## R1 指摘の分割（`scripts/lib/revision-classifier.js` に `splitRevisionPoints(comment)` を追加・export）

- 生のコメント（改行を残したまま）を行に分け、**行頭の番号**で指摘を分ける。番号として扱うのは次だけ:
  - 半角・全角の数字＋`.` `．` `)` `）` `、`（例 `1.` `１．` `2)` `3、`）
  - `(1)` `（1）` `（１）`
  - `①`〜`⑳`
- 番号の前の空白は許す。**箇条書きの記号（`・` `-` `*` `●` など）では分けない**（「次の表を直して」＋行の列挙のように、1 つの指摘の中身の列挙であることが多いため）。
- 1 つ目の番号より前の行は「前置き」（`preface`）。番号の行から次の番号の行の前までが 1 つの指摘（続きの行・空行を含む。前後の空白は取る）。
- 番号は 1 から順に 1 ずつ増えるときだけ分ける（`1.` `2.` `3.` / `①②③`。同じ種類の番号で揃っていること）。順になっていない・指摘が 2 つ未満なら分けない。
- 戻り値: `{ preface, points: [{ no, text }] }`。分けないときは `points: []`。

## R2 指摘ごとの分類と段の組み立て（`scripts/lib/partial-revise.js` に `planRevisionSteps(split, sections)` を追加・export）

- 各指摘を `classifyRevision(point.text)` で分類する（前置きは分類に使わない）。
  - 例外: `full_regenerate` の理由が `コメントが長く広範囲の修正と判断（120文字以上）` の長さの決まりだけで、`denySuppression` でなく、`RULES` のどのパターンにも当たっていない場合は、段を組むときだけ `{ type: 'factual_correction', scope: 'targeted', sectionHint: extractSectionHint(point.text), reason: '指摘が長い（複数の指摘の 1 つなので全文の最小修正）' }` として扱う。番号付きの 1 点が長いのは具体的に書かれているためで、コメント全体が長く抽象的な場合の全文再生成とは分ける。`classifyRevision` 自体や単独コメントの分類は変えない。
- 次のどれかなら `{ fallback: true, reason }` を返し、呼び出し側は**今までどおりコメント全体を 1 つとして**処理する:
  - どれかの指摘が、上記の長さだけの例外を除く `full_regenerate`（`denySuppression` を含む）。`RULES` の全文再生成パターン（「全体的に書き直し」など）に当たる場合は今までどおり `fallback`。
- 段（step）の作り方:
  - `title_only` の指摘 → `title` の段（全部まとめて 1 つ）
  - `add_section` の指摘 → 1 つずつ `add_section` の段
  - scope が `section` の残りの指摘（`table_fix` `section_only` `intro_conclusion_fix`）→ `findTargetSectionIndex(sections, sectionHint, type)` で章を決め、**同じ章に当たる指摘は 1 つの `section` の段にまとめる**。章が決まらない指摘は `targeted` の段へ
  - scope が `targeted` の指摘（`factual_correction`）→ 全部まとめて 1 つの `targeted` の段
- 段の順: `section`（本文の章の順）→ `add_section`（指摘の番号順）→ `targeted` → `title`。
- 各段には、その段で直す指摘の番号と、LLM に渡す指示文 `instruction` を持たせる。`instruction` は次の形:

```
（この段では、次の指摘だけを直します。ほかの指摘は別の段で直すので触れないでください。作業の説明・注記・「変更していません」などの断り書きを本文に書かないでください。）
<前置き（あれば）>

<その段の指摘を、元の番号のまま元の文で並べたもの>
```

- 戻り値の例: `{ fallback: false, steps: [{ kind: 'section', sectionIndex, heading, points: [1], classification, instruction }, { kind: 'targeted', points: [2, 3], instruction }] }`

## R3 章の見つけ方の補強（`partial-revise.js` / `revision-classifier.js`）

1. `revision-classifier.js` の `section_only` の「引用＋章」のパターンと `extractSectionHint` の `about` のパターンに **「節」** を足す（`「…」の節` を章の指定として扱う）。
2. `findTargetSectionIndex`: 今の 3 段（完全一致・表記揺れ・fuzzy）で h2 が見つからないとき、**各 h2 の章の本文の中の h3 見出し（`^###\s+`）** でも同じ 3 段で探し、当たった h3 を含む h2 の index を返す。h2 で見つかる場合の結果は今と変えない。

この 2 つは指摘が 1 つの差し戻しにも効く（意図した変更）。

## R4 作業の説明を本文に残さない（`partial-revise.js` に `removeNewInternalNotes(before, after)` を追加・export）

LLM の出力（`after`）を入力（`before`。章の差し替えならその章、全文なら本文）と比べる:

1. `after` の行のうち、`before` に同じ行（前後の空白を除いて完全一致）が無い行を「新しい行」とする。
2. 新しい行が次の両方を満たすなら「作業の注記」:
   - (a) 差し戻し・指示そのものを指す語を含む: `差し戻し` `コメント` `ご指摘` `ご依頼` `ご指示` `指示どおり` `指示通り` `指示に従` `点目` `指摘の[0-9０-９①-⑳]` `指摘[0-9０-９①-⑳]`
   - (b) 作業の結果を述べる語を含む: `変更` `修正` `反映` `対応` `対象外` `触れ` `直し` `そのまま`
3. 作業の注記の行が `※` `＊` `*` `注:` `注：` `（※` `(※` `【注` で始まるなら、その行を取り除く（前後の空行が 2 つ続くなら 1 つにする）。
4. 取り除いたあと、`INTERNAL_PROCESS_WORDS` のどれかの出現回数が `before` より多い、または 3 で取り除けなかった作業の注記の行が残る → **混入**（`contaminated: true`）。
5. 戻り値: `{ body, removed: [取り除いた行], contaminated, words: [混入の語] }`。

使う場所（全部）:

- `regenerateSection` の差し替え（LLM の章の出力に対して、元の章と比べる）と `add_section`（`before` は空として扱い、(a)(b) を満たす行は 3 の形なら除去、そうでなければ混入）
- `regenerateTargeted` の 1 回目・再試行（`sanitizeRevisedBody` の後、短縮ガードの前）
- R5 の各段

混入したとき:

- 指摘が 1 つの差し戻し（今までの経路）: その LLM の出力を捨てて元の本文を保ち、`rebuildWithBodyAndWarning` で `review_comment` に `【自動再生成の警告】このコメントを自動で本文に反映できませんでした（LLM が作業の説明を本文に書いたため）。…` を付ける（今の短縮ガードの失敗と同じ扱い。通知は `regenerate_not_applied` になる）。
- 複数の指摘（R5）: その段だけ捨てて（入力を保つ）、その段の指摘を「反映できなかった」に入れる。

取り除いた行・混入はログに出す（`console.warn`、取り除いた行の文字数と先頭 40 字まで）。

## R5 複数の指摘の再生成（`scripts/generate-draft.js`）

`--regenerate` の分岐（`isRefreshRegeneration` が偽のとき）で:

1. `ENABLE_MULTI_POINT_REVISE` が `false` でなく（既定は有効）、部分再生成が有効（`ENABLE_PARTIAL_REVISE` が `false` でない）で、`splitRevisionPoints(comment).points.length >= 2` かつ `planRevisionSteps` が `fallback` でないとき、新しい関数（例 `regenerateMultiPoint(existing, comment, plan)`）で処理する。それ以外は今までの経路のまま。
2. 出典の資料（`buildRegenSourceBlocks`）と `recordMaterialMetadata` は**最初に 1 回だけ**作り、各段で使い回す。
3. 段を順に実行する。各段の入力は、前の段までを反映した本文:
   - `section`: その章だけを `buildSectionPrompt(meta, step.instruction, section, step.classification, srcBlock)` で直し、`postProcessBodyOnly` → `stripAnalysisPreamble`（章の元の文と比べる）→ `removeNewInternalNotes`。出力が章として読めない・混入・章の文字数が元の 60% 未満（`isBodyShrinkageSuspicious` を章に使う）なら、その段は失敗（章を元のまま）。
   - `add_section`: 今の `regenerateSection` の追加と同じ（まとめの前に入れる）＋ `removeNewInternalNotes`。
   - `targeted`: 今の `regenerateTargeted` と同じ手順（1 回目→短縮なら再試行、`sanitizeRevisedBody`、`removeNewInternalNotes`）。再試行後も短縮・混入なら、その段は失敗（本文はその段の入力のまま）。禁止表現の置換だけ適用する今の救済（`sanitizeBannedPhrases`）は、段が失敗したときの本文にも適用してよい。
   - `title`: 本文の段が全部終わった後に `regenerateTitleOnly(現在の内容, 前置き＋その段の指摘)`。
   - `targeted` の段があり、どれかの段が成功したときは、最後に `maybeUpdateTitleForTargeted(結果, targeted の段の instruction, meta)` を今と同じ条件で呼ぶ（`title` の段があるときは呼ばない）。
   - LLM の呼び出しが例外を投げたときは今と同じく例外のまま（ジョブは失敗通知へ）。ただし `contentBodyTruncated` 以外の例外で、すでに成功した段がある場合も、例外にしてよい（途中の本文は保存しない）。
4. 反映の確かめ: 各指摘の文から「`「旧」を（、）「新」に` / `「旧」を（、）「新」という内容に` / `「旧」を（削除|消し|取り除）`」の形の **旧** を取り出す（`「」` `『』` の両方。旧が 6 文字以上で、再生成前の本文にそのまま含まれるものだけ）。全段の後、本文の中の旧の出現回数が再生成前より減っていなければ、その指摘は「反映できなかった」（理由: 指定の文が残っている）。旧が取り出せない指摘は、段が成功していれば反映できたとみなす。
5. 結果:
   - 全部の指摘を反映できた → `rebuildWithBody`（今と同じ。`review_status: draft`・`review_comment` を空に）。
   - 一部だけ → 反映できた分の本文で `rebuildWithBodyAndWarning(existing, 本文, comment + 注記)`。注記は
     `\n\n【自動反映は一部のみ】差し戻しの指摘 N 点のうち、M 点目（理由）を自動で反映できませんでした。該当箇所を手動で直すか、その指摘だけで再度差し戻してください。`（複数なら `M 点目（理由）・K 点目（理由）`）
   - どれも反映できなかった → 元の本文のまま `【自動再生成の警告】差し戻しの指摘を自動で本文に反映できませんでした（理由）。…`
   - どの場合も、本文が変わっていれば後段の `finalizeRegeneration`（照合）は今までどおり走る。
6. `GITHUB_OUTPUT` の `revision_type` は `multi_point`、`revision_scope` は段の種類を `+` でつないだもの（例 `section+targeted`）。
7. ログ: 分けた指摘の数、各指摘の分類（type・scope・sectionHint）、段の一覧（種類・章の見出し・指摘の番号）、各段の成否と理由。

## R6 `ENABLE_MULTI_POINT_REVISE`

- `generate-draft.js` が読む。`false`（大文字小文字を問わない）のときだけ R5 を使わない。
- `.github/workflows/regenerate-draft.yml` の「Regenerate draft」の `env` に `ENABLE_MULTI_POINT_REVISE: ${{ vars.ENABLE_MULTI_POINT_REVISE }}` を足す（`ENABLE_PARTIAL_REVISE` の次の行）。

## R7 古い下書きでも再生成できるようにする（`.github/workflows/regenerate-draft.yml`）

「Use latest scripts, deps and moderation data from main」の `git checkout origin/main -- …` を次の形にする:

```
git fetch origin main --depth=1
# scripts/ が読み込むデータは scripts/ と同じ版でないと動かない（下書きの枝が古いと
# 後から足されたデータが無く MODULE_NOT_FOUND になる。2026-10-27 run 40483979382）。
# data/ ごと main で上書きし、記事ごとの照合記録 data/fact-check/ だけ枝のものに戻す。
git checkout origin/main -- scripts/ package.json package-lock.json data/
git checkout HEAD -- data/fact-check/ 2>/dev/null || true
git reset -q
```

- 既存のコメント（index を空にする理由）と `echo` の 2 行は残す。ステップ名は「Use latest scripts, deps and data from main」に変えてよい（試験がステップ名を見ていないか確かめること）。
- 記事・照合記録以外がステージされていないかの確認、`git add` の対象は変えない。

## 試験（新しく `scripts/lib/__tests__/test-revise-multi-point.js`。偽の LLM で、ネットワークを使わない）

1. `splitRevisionPoints`: `644-comment-1.txt` → 前置き 1 行・指摘 3 つ（no 1〜3、本文が各指摘の文と一致）。`①②` の 2 点、`（1）（2）`、全角 `１．２．` も分かれる。`1.` `3.`（飛び番）・指摘 1 つ・箇条書き `・` だけ・前置きだけ、は分けない。
2. `planRevisionSteps`（`644-before.md` の本文の章で）: 1 点目 → `section`（見出し「贈与税の非課税制度 一覧比較」）、3 点目 → `section`（R3 により h3「配偶者への居住用不動産の贈与（配偶者控除）」を含む h2「各制度の詳細と判断ポイント」）、2 点目 → `targeted`。段の順は section（一覧比較）→ section（各制度の詳細）→ targeted。各段の instruction にほかの段の指摘の文が含まれない。
3. どれかの指摘が `full_regenerate`（例 `2. 全体的に書き直してください`）→ `fallback: true`。加えて、120 字を超える具体的な置換の指摘が長さの決まりだけで `full_regenerate` になる場合、複数指摘の計画内では R2 の例外により `targeted` になることを確かめる。単独コメントの既存分類は変えない。
4. `removeNewInternalNotes`: `644-after-run-40484642578.md` の本文を `after`、`644-before.md` の本文を `before` として → 108 行目の「※差し戻しコメントの2・3は…」の行が取り除かれ、`contaminated: false`。`※` で始まらない「差し戻しコメントの2は対象外のため変更していません。」が段落の中に新しく現れる → `contaminated: true`。試験用に `before` に足した「税務署からの指摘で修正申告をしました。」の行（`after` にもそのまま残る）・`after` に新しく足された「税務調査で指摘を受けたら修正申告を検討します。」の行は取り除かない・混入にしない。
5. R5 の通し（R5 の関数を `module.exports` に足し、偽の LLM で呼ぶ。`test-generation-review-fixes.js` の F1 のように `fetch` を差し替える方法に合わせる。出典ブロックが要るなら偽のものを渡せるようにしてよい）: `644-before.md`＋`644-comment-1.txt` → 本文の LLM の呼び出しが 3 回（一覧比較の章・各制度の詳細の章・全文）で、本文の各呼び出しの入力にその段の指摘の文だけが入る。タイトル・要約の見直しは `maybeUpdateTitleForTargeted` の今の条件で別途呼び出し、その応答では本文を変えないことを確かめる。偽の LLM が指定どおり直した出力を返すと、3 つの旧の文がすべて消え、`review_comment` は空・`review_status: draft`。
6. 5 で、偽の LLM が 1 段目の出力の末尾に「※差し戻しコメントの2・3は…変更していません。」を足して返す → その行は最終の本文に無い。
7. 5 で、偽の LLM が 3 点目の章の段と 2 点目の全文の段で、それぞれその段の入力をそのまま返す → 1 点目は反映され、`review_status: needs_revision`、`review_comment` に `【自動反映は一部のみ】` と「2 点目」「3 点目」が入る。
8. `ENABLE_MULTI_POINT_REVISE=false` → 5 と同じ入力で、今までどおり 1 回の分類（`table_fix`）・1 回の LLM 呼び出しになる。
9. 指摘 1 つの差し戻しで、`regenerateTargeted` の出力に `※差し戻しコメントは…変更していません。` の行が新しく入る → その行は取り除かれ、本文は採用される。段落の中に混入 → 元の本文のまま `【自動再生成の警告】`。
10. ワークフロー: `regenerate-draft.yml` の上書きの行が `data/` を含み、`git checkout HEAD -- data/fact-check/` がその後・`git reset -q` の前にある。`ENABLE_MULTI_POINT_REVISE: ${{ vars.ENABLE_MULTI_POINT_REVISE }}` が「Regenerate draft」の env にある。`run:` の中に `${{` が無い（既存の試験の決まり）。
11. R7 の実地（一時フォルダに git の枝を作る試験。シェルの `git` が使えない環境なら、この試験は理由を出して飛ばしてよい）: 「main」の枝に `scripts/x.js`（`require('../data/new.json')`）と `data/new.json`・`data/fact-check/a.json`（中身 main）を置き、「draft」の枝は古い main から作って `data/fact-check/a.json`（中身 draft）を足す → draft を取り出して R7 の手順（`origin/main` の代わりに `main`）を流すと、`node scripts/x.js` が動き、`data/fact-check/a.json` は draft の中身、`git diff --cached` は空。

既存の試験（全部通すこと）: `test-revision-classifier.js`・`test-partial-revise.js`・`test-freshness-refresh.js`・`test-generation-review-fixes.js`・`test-generation-review-fixes-2.js`・`test-workflow-change-detection.js`・`test-env-resolution.js`・`test-openai-models.js`。既存の試験の期待を変える必要が出たら、変える前に最終報告に【要判断】で理由を書く（R3 の「節」・h3 で期待が変わるものは、変更してよいが一覧にする）。

ただし `test-workflow-change-detection.js` は作業ツリーの未コミット変更と比べる作りのため、隔離の中では省略してよい。試験の期待は変えず、コミット後に Claude が隔離の外で実行する。

## 変更してはいけないもの

- `scripts/lib/fact-check.js` とその試験、照合の記録の形
- `freshness-refresh.js`（更新案）の動き。`findInternalProcessWords` / `INTERNAL_PROCESS_WORDS` の今の語（足すのはよいが消さない）
- `review-revise.js` など Netlify 側の関数
- `regenerate-draft.yml` のうち R6・R7 以外（通知・push の再試行・ステージの確認）
- `classifyRevision` の今の分類の結果（R3 の「節」で変わるものを除く）
- 指摘が 1 つの差し戻しの LLM の呼び出し回数・プロンプト（R4 の除去・混入の扱いを除く）
