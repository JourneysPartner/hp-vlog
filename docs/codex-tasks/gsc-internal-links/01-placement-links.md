# 01 指定リンクの仕組み

## R1 指定ファイル data/internal-link-placements.json（新規）

```json
{
  "_note": "検索データをもとに人が承認した内部リンク。source の本文に出る anchor をビルド時に target へのリンクにする。記事の Markdown は変えない。止めるときは enabled を false にする。",
  "placements": []
}
```

1 件の形:

| 項目 | 必須 | 意味 |
|---|---|---|
| id | ○ | 一意の文字列（例 `20261108-01`） |
| source | ○ | リンク元の記事の slug |
| anchor | ○ | リンク元の本文に**そのまま**出る文字列（1〜40 字）。これがリンクの文字になる |
| target | ○ | 行き先の記事の slug |
| occurrence | | リンクできる出現のうち何番目に付けるか（1 始まり、既定 1） |
| enabled | | false なら使わない（既定 true） |
| added_at | ○ | 追加日 `YYYY-MM-DD` |
| reason | | 追加の理由（人が読むための文） |
| baseline | | 追加時の行き先の検索の数字 `{ "range_end": "YYYY-MM-DD", "position": 9.7, "impressions": 656, "clicks": 9 }`（02 の「その後」で使う） |

初期状態は `placements: []` で作る（中身は承認後に Claude が足す）。

## R2 指定リンクを付ける関数（internal-linker.js）

`linkPlacements(markdown, { placements, post, postsMap, isPublished })` を足す。規則:

1. `source === post.slug` かつ `enabled !== false` の行だけを、ファイルの順に使う。
2. 行き先が postsMap に無い・未公開 → 付けない（stats.skipped.unpublished、build は警告）。
3. `target === post.slug` → 付けない（self）。
4. anchor は**リンクできる場所**だけで探す。リンクできない場所 = 今の protectedRanges（frontmatter・コード・見出し行・表の行・既存のリンク・画像・インラインコード・HTML タグ）＋ R5 の冒頭の段落。occurrence 番目のリンクできる出現に付ける。見つからなければ付けない（notFound、build は警告に slug と id を出す）。
5. 1 記事に付ける指定リンクは**最大 3 本**（limit）。
6. **同じ行き先は 1 記事 1 回**（R4）。
7. リンクの形は今の文脈リンクと同じ `[anchor](/blog/<target>/)`。
8. 戻り値は `{ markdown, stats: { linked, skipped: {...}, linkedTargets: Set } }`。

## R3 build への組み込み

- generatePost で、`normalizeBold` の後に **指定リンク → 文脈リンク（辞書）** の順で付ける。
- 指定リンクと文脈リンクを合わせて **1 記事最大 5 本**。辞書の上限 4 本は今のまま（= 辞書は `min(4, 5 − 指定リンクの本数)`）。
- 指定ファイルが無い・壊れている場合は、今の辞書と同じく警告して 0 件で続ける。
- 今のログ `文脈リンク N 件` に指定リンクの件数も出す。
- build と 02 の週次レポートが同じ規則を使えるよう、両方を順に呼ぶ関数（例 `linkInternal(markdown, opts)`）を internal-linker.js から出し、build はそれを使う。

## R4 全体の規則 1: 同じ行き先は 1 記事 1 回

- 辞書の 2 つの語が同じ記事を指す場合（例「修繕費」と「資本的支出」、「2割特例」と「3割特例」）、今は 2 本付く。**最初の 1 本だけ**にする（stats.skipped.duplicateTarget）。
- 本文に**元から**その行き先へのリンク（`/blog/<slug>/` を含む Markdown リンクか HTML の href）がある場合も付けない。
- 指定リンクで付けた行き先には、辞書のリンクを付けない。

## R5 全体の規則 2: 冒頭の段落にはリンクしない

- 本文の**最初の `## ` 見出しより前**（リード文・その下の箇条書き）を、指定リンクと辞書の両方でリンクできない場所にする。
- 本文が `## ` で始まる記事は、この規則で守る範囲は無い。
- 実装は protectedRanges に足すか、別の範囲として足すか任せる。ただし protectedRanges を使っている他の呼び出し元の動きが変わる場合は報告する。

## R6 validate.js の点検

誤り（validate を失敗させる）:
- placements が配列でない、必須項目の欠け、id の重複、source と target が同じ、anchor が空か 40 字超、occurrence が 1 以上の整数でない。
- source・target が content/posts のどの記事の slug でもない。
- 同じ source に同じ target が 2 行以上（enabled の行どうし）。
- 同じ source に enabled の行が 4 行以上。

警告（失敗させない）:
- source か target が未公開・統合済み（merged）・取り下げ。
- anchor が source の本文のリンクできる場所に見つからない。

validate.js に誤りと警告の区別が既にあればそれに合わせる。無ければ既存の書き方に合わせて最小限で足し、どう区別したかを報告する。

## R7 試験

新しい試験ファイル `scripts/lib/__tests__/test-internal-placements.js` を作り、package.json の masters:test の一覧の**末尾**に足す。確かめること:

1. 指定どおり 1 本付く。occurrence 2 で 2 番目の出現に付く。
2. 見出し・表・既存リンク・コード・冒頭の段落（最初の `## ` より前）の中の anchor には付かない。冒頭にしか無ければ notFound。
3. self・未公開・enabled false・別の記事向けの行は使わない。
4. 1 記事 3 本まで。指定と辞書を合わせて 5 本まで、辞書は 4 本まで。
5. 同じ行き先は 1 回（指定どうし・指定と辞書・辞書どうし・本文に元からあるリンク）。
6. 指定ファイルが空なら、R4・R5 の場合を除き、今の linkTerms と同じ結果になる。
7. validate の誤りと警告の各場合。

既存の試験（test-page-structure.js の R4 など）の期待を変えてよいのは、R4・R5 の規則で結果が変わる場合だけ。変えたら、どの確かめをなぜ変えたかを報告する。試験を消したり弱めたりしない。

## 変更してはいけないもの

- content/posts/*.md、data/internal-link-terms.json、data/pickup-posts.json
- 関連記事・pickup・出典リンク（citation-linker）の動き
- .github/workflows/ 以下（02 でも変えない）
